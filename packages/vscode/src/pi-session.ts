import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { RpcClient } from "../../coding-agent/src/modes/rpc/rpc-client.ts";
import type {
	RpcAuthEvent,
	RpcAuthProvider,
	RpcExtensionUIRequest,
	RpcLoginResult,
} from "../../coding-agent/src/modes/rpc/rpc-types.ts";
import { type ChatAction, createChatState, reduceChat } from "./chat-state.ts";
import type { ChatState, MenuItem, MenuQuery, PanelCommand, TabState } from "./chat-types.ts";
import { checkRuntime, createPiClient, NodeVersionError, type PiRuntime } from "./pi-launch.ts";
import { buildPrompt } from "./prompt-context.ts";
import { commandItems, forkItems, modelItems, sessionItems } from "./quick-picks.ts";

export type PiStatus = "stopped" | "starting" | "idle" | "working";

/** Session and model settings of one pi process. */
export interface SessionInfo {
	started: boolean;
	sessionFile?: string;
	sessionName?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	thinkingLevels: string[];
	/** Thinking level when pi started, the target of the reset button. */
	defaultThinkingLevel?: string;
}

export interface PiSessionHost {
	/** How to start pi: from source in development, the bundled runtime when installed. */
	runtime(): PiRuntime;
	log(session: PiSession, line: string): void;
	/** The transcript changed; `prev` is the state before the change. */
	stateChanged(session: PiSession, prev: ChatState): void;
	/** Status or session info changed. */
	infoChanged(session: PiSession): void;
	uiRequest(session: PiSession, request: RpcExtensionUIRequest): void;
	/** A run ended; dialogs it opened are already resolved by pi. */
	settled(session: PiSession): void;
	/** Put text in the composer if this session is shown. */
	setInput(session: PiSession, text: string): void;
	/** Progress of a running login: a browser URL, a device code, or a status message. */
	authEvent(session: PiSession, event: RpcAuthEvent["event"]): void;
}

/** Whether pi reported a real model; without credentials it reports a placeholder with provider "unknown". */
export function hasModel(info: SessionInfo): boolean {
	return !!info.model && info.model.provider !== "unknown";
}

/**
 * One chat tab: its own pi process, transcript and session. Tabs run independently,
 * so switching tabs never interrupts a run.
 */
export class PiSession {
	readonly id = randomUUID();
	state: ChatState = createChatState();
	info: SessionInfo;
	status: PiStatus = "stopped";
	/** Why the last start failed; cleared by the next successful start. */
	startError: { message: string; node: boolean } | undefined;
	/** How the last run ended; the tab dot turns green or red. */
	private outcome: "none" | "done" | "failed" = "none";
	/** A file change of this tab waits for Accept or Reject. */
	private reviewing = false;
	private readonly host: PiSessionHost;
	private client: RpcClient | undefined;
	private starting: Promise<RpcClient> | undefined;
	/** Actions and sends run one at a time, so a session change cannot clear a reply that already started. */
	private queue: Promise<unknown> = Promise.resolve();

	/** Title saved with a restored tab, shown until its process starts. */
	private readonly savedTitle: string | undefined;

	/** `sessionFile` resumes a saved session when the process starts. */
	constructor(host: PiSessionHost, sessionFile?: string, savedTitle?: string) {
		this.host = host;
		this.info = { started: false, sessionFile, thinkingLevels: [] };
		this.savedTitle = savedTitle;
	}

	/** Tab title: the session name, else the first message, else "New chat". */
	get title(): string {
		const firstUser = this.state.items.find((item) => item.kind === "user");
		const firstLine = firstUser?.kind === "user" ? firstUser.text.split("\n").find((line) => line.trim()) : undefined;
		return this.info.sessionName ?? firstLine?.trim() ?? this.savedTitle ?? "New chat";
	}

	/** Whether the tab holds nothing yet, so opening a saved session can reuse it. */
	/** Pulsing while pi works, red while a review waits or after a failed or aborted run, green when done. */
	get tabState(): TabState {
		if (this.reviewing) return "attention";
		if (this.status === "working") return "running";
		if (this.outcome === "failed") return "attention";
		return this.outcome === "done" ? "done" : "idle";
	}

	setReviewing(reviewing: boolean): void {
		this.reviewing = reviewing;
		this.host.infoChanged(this);
	}

	get isEmpty(): boolean {
		return this.status !== "working" && this.state.items.length === 0;
	}

	/** Start pi, or return the running client. Concurrent callers share one process. */
	start(): Promise<RpcClient> {
		if (this.client) return Promise.resolve(this.client);
		this.starting ??= this.spawn()
			.then(
				(client) => {
					this.startError = undefined;
					return client;
				},
				(error: unknown) => {
					this.startError = {
						message: error instanceof Error ? error.message : String(error),
						node: error instanceof NodeVersionError,
					};
					this.host.infoChanged(this);
					throw error;
				},
			)
			.finally(() => {
				this.starting = undefined;
			});
		return this.starting;
	}

	async stop(): Promise<void> {
		const client = this.client ?? (await this.starting?.catch(() => undefined));
		this.client = undefined;
		if (!client) return;
		if (this.status === "working") this.outcome = "failed";
		await client.stop();
		this.host.log(this, "pi stopped");
		this.info = { ...this.info, started: false };
		this.setStatus("stopped");
		// A run cut off by stopping never emits agent_settled.
		this.dispatch({ type: "agent_settled" });
	}

	dispatch(action: ChatAction): void {
		if (action.type === "ui_error") {
			this.outcome = "failed";
			this.host.infoChanged(this);
		}
		const prev = this.state;
		this.state = reduceChat(prev, action);
		if (this.state !== prev) this.host.stateChanged(this, prev);
	}

	serial<T>(action: () => Promise<T>): Promise<T> {
		const result = this.queue.then(action);
		this.queue = result.catch(() => undefined);
		return result;
	}

	/** Send typed text with the composer draft. The draft is kept if sending fails. */
	async submit(text: string): Promise<void> {
		const attachments = this.state.draft;
		const prompt = buildPrompt(text, attachments);
		if (!prompt) return;
		if (attachments.length > 0) this.dispatch({ type: "prompt_sent", prompt, text, attachments });
		const client = await this.start();
		// A new prompt while idle, a steering message while pi is working.
		if (this.status === "working") await client.steer(prompt);
		else await client.prompt(prompt);
		this.dispatch({ type: "draft_remove", ids: attachments.map((attachment) => attachment.id) });
	}

	async abort(): Promise<void> {
		await this.client?.abort();
	}

	/** Items for an in-panel menu. */
	async query(query: Exclude<MenuQuery, "files" | "providers">): Promise<MenuItem[]> {
		const client = await this.start();
		switch (query) {
			case "sessions":
				return sessionItems(await client.listSessions(), this.info.sessionFile);
			case "models":
				return modelItems(await client.getAvailableModels(), this.info.model);
			case "forks":
				return forkItems(await client.getForkMessages());
			case "commands":
				return commandItems(await client.getCommands());
		}
	}

	/** Actions that act on this tab's pi session. */
	async command(command: PanelCommand, arg: string | undefined): Promise<void> {
		switch (command) {
			case "newSession": {
				const client = await this.idleClient();
				if ((await client.newSession()).cancelled) return;
				this.dispatch({ type: "session_reset" });
				return this.refresh(client);
			}
			case "openSession": {
				const client = await this.idleClient();
				if (!arg || (await client.switchSession(arg)).cancelled) return;
				return this.reload(client);
			}
			case "fork": {
				// Forking starts a new session from before the chosen message and returns that message for editing.
				const client = await this.idleClient();
				if (!arg) return;
				const result = await client.fork(arg);
				if (result.cancelled) return;
				await this.reload(client);
				this.host.setInput(this, result.text);
				return;
			}
			case "clone": {
				const client = await this.idleClient();
				if ((await client.clone()).cancelled) return;
				return this.reload(client);
			}
			case "rename": {
				const client = await this.start();
				if (!arg?.trim()) return;
				await client.setSessionName(arg.trim());
				return this.refresh(client);
			}
			case "setModel": {
				const client = await this.start();
				const model = await resolveModel(client, arg ?? "");
				await client.setModel(model.provider, model.id);
				return this.refresh(client);
			}
			case "setThinking": {
				const client = await this.start();
				const level = this.info.thinkingLevels.find((candidate) => candidate === arg?.trim());
				if (!level) {
					throw new Error(
						`Unknown thinking level "${arg ?? ""}". Available: ${this.info.thinkingLevels.join(", ")}`,
					);
				}
				await client.setThinkingLevel(level as Parameters<RpcClient["setThinkingLevel"]>[0]);
				return this.refresh(client);
			}
			case "compact": {
				const client = await this.idleClient();
				await client.compact(arg?.trim() || undefined);
				return this.reload(client);
			}
			case "copyLast": {
				const text = await (await this.start()).getLastAssistantText();
				if (!text) throw new Error("No assistant message to copy yet.");
				await vscode.env.clipboard.writeText(text);
				void vscode.window.showInformationMessage("Pi: copied the last assistant message.");
				return;
			}
			default:
				throw new Error(`Unsupported session command: ${command}`);
		}
	}

	async authProviders(): Promise<RpcAuthProvider[]> {
		return (await this.start()).getAuthProviders();
	}

	/** Sign in, then show the model pi selected. Prompts arrive as UI requests, progress as auth events. */
	async login(provider: string, method: "oauth" | "api_key"): Promise<RpcLoginResult> {
		const client = await this.start();
		const result = await client.login(provider, method);
		await this.refresh(client);
		return result;
	}

	async abortLogin(): Promise<void> {
		await this.client?.abortLogin();
	}

	async logout(provider: string): Promise<void> {
		const client = await this.start();
		await client.logout(provider);
		await this.refresh(client);
	}

	respondToUI(...args: Parameters<RpcClient["sendExtensionUIResponse"]>): void {
		this.client?.sendExtensionUIResponse(...args);
	}

	/** Session changes while a run streams would race with its events. */
	private async idleClient(): Promise<RpcClient> {
		const client = await this.start();
		if (this.status === "working") throw new Error("pi is working in this tab. Stop the run or open a new tab.");
		return client;
	}

	/** Show the session's history and settings after it changed underneath the transcript. */
	private async reload(client: RpcClient): Promise<void> {
		this.dispatch({ type: "load_messages", messages: await client.getMessages() });
		await this.refresh(client);
	}

	private async refresh(client: RpcClient): Promise<void> {
		const [state, thinkingLevels] = await Promise.all([client.getState(), client.getAvailableThinkingLevels()]);
		this.info = {
			started: true,
			sessionFile: state.sessionFile,
			sessionName: state.sessionName,
			model: state.model ? { provider: state.model.provider, id: state.model.id } : undefined,
			thinkingLevel: state.thinkingLevel,
			thinkingLevels,
			defaultThinkingLevel: this.info.defaultThinkingLevel ?? state.thinkingLevel,
		};
		this.host.infoChanged(this);
	}

	private async spawn(): Promise<RpcClient> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) throw new Error("Open a folder before starting pi");

		const config = vscode.workspace.getConfiguration("pi");
		const sessionFile = this.info.sessionFile;
		const runtime = this.host.runtime();
		await checkRuntime(runtime, process.versions.node);
		const client = createPiClient({
			runtime,
			cwd,
			args: [
				// Reviews are always routed to VS Code; the approval mode decides whether they need a click.
				"--extension",
				runtime.reviewExtension,
				...(config.get<string[]>("args") ?? []),
				...(sessionFile ? ["--session", sessionFile] : []),
			],
		});
		client.onExtensionUIRequest((request) => {
			// Metadata can hold whole files; keep the log readable.
			const metadata = "metadata" in request && request.metadata ? "[metadata]" : undefined;
			this.host.log(this, JSON.stringify({ ...request, metadata }));
			this.host.uiRequest(this, request);
		});
		client.onAuthEvent((event) => {
			this.host.log(this, JSON.stringify(event));
			this.host.authEvent(this, event.event);
		});
		client.onEvent((event) => {
			this.host.log(this, JSON.stringify(event));
			this.dispatch(event);
			if (event.type === "agent_start") this.setStatus("working");
			if (event.type === "agent_settled") {
				const last = this.state.items.at(-1);
				this.outcome = last?.kind === "error" || (last?.kind === "assistant" && last.error) ? "failed" : "done";
				this.setStatus("idle");
				this.host.settled(this);
				// The session file and title exist once the first message is saved.
				void this.refresh(client).catch((error: unknown) =>
					this.host.log(this, `refresh failed: ${String(error)}`),
				);
			}
			if (event.type === "session_info_changed") {
				this.info = { ...this.info, sessionName: event.name };
				this.host.infoChanged(this);
			}
			if (event.type === "thinking_level_changed") {
				this.info = { ...this.info, thinkingLevel: event.level };
				this.host.infoChanged(this);
			}
		});

		this.setStatus("starting");
		try {
			await client.start();
			const state = await client.getState();
			const model = state.model ? `${state.model.provider}/${state.model.id}` : "none";
			this.host.log(this, `pi started in ${cwd} (model: ${model})`);
			if (state.messageCount > 0) this.dispatch({ type: "load_messages", messages: await client.getMessages() });
			this.client = client;
			await this.refresh(client);
		} catch (error) {
			this.client = undefined;
			await client.stop();
			this.setStatus("stopped");
			throw error;
		}
		this.setStatus("idle");
		return client;
	}

	private setStatus(status: PiStatus): void {
		this.status = status;
		this.host.infoChanged(this);
	}
}

/** Accept a menu value (`{"provider","id"}` JSON) or a typed `provider/id` or model id. */
async function resolveModel(client: RpcClient, arg: string): Promise<{ provider: string; id: string }> {
	if (arg.startsWith("{")) return JSON.parse(arg) as { provider: string; id: string };
	const models = await client.getAvailableModels();
	const match =
		models.find((model) => `${model.provider}/${model.id}` === arg) ?? models.find((model) => model.id === arg);
	if (!match) throw new Error(`Unknown model "${arg}".`);
	return match;
}
