import { join } from "node:path";
import * as vscode from "vscode";
import type { RpcClient } from "../../coding-agent/src/modes/rpc/rpc-client.ts";
import type { Attachment, MenuItem, MenuQuery, PanelCommand, PanelMenu, PanelMeta } from "./chat-types.ts";
import { ChatViewProvider } from "./chat-view.ts";
import { diagnosticsAttachment, fileAttachment, selectionAttachments } from "./editor-context.ts";
import { ExtensionUIBridge } from "./extension-ui.ts";
import { ACCEPT, REJECT } from "./file-change.ts";
import { createPiClient } from "./pi-launch.ts";
import { buildPrompt } from "./prompt-context.ts";
import { commandItems, fileItems, forkItems, modelItems, sessionItems } from "./quick-picks.ts";

type PiStatus = "stopped" | "starting" | "idle" | "working";

/** Owns one pi RPC process for the first workspace folder, feeds its events to the chat view, and logs them. */
class PiController implements vscode.Disposable {
	readonly chat: ChatViewProvider;
	readonly ui: ExtensionUIBridge;
	private readonly extensionPath: string;
	private readonly output = vscode.window.createOutputChannel("Pi");
	private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	private readonly modelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	private meta: PanelMeta = { started: false, thinkingLevels: [] };
	private files: { at: number; paths: string[] } | undefined;
	private client: RpcClient | undefined;
	private starting: Promise<RpcClient> | undefined;
	private status: PiStatus = "stopped";

	constructor(extensionUri: vscode.Uri) {
		this.extensionPath = extensionUri.fsPath;
		this.chat = new ChatViewProvider(extensionUri, {
			submit: (text) => this.run(() => this.submit(text)),
			abort: () => this.run(() => this.abort()),
			query: async (query, text) => {
				try {
					return await this.query(query, text);
				} catch (error) {
					this.report(error);
					return [];
				}
			},
			command: (command, arg) => this.run(() => this.command(command, arg)),
		});
		this.ui = new ExtensionUIBridge({
			respond: (response) => this.client?.sendExtensionUIResponse(response),
			setInput: (text) => this.chat.setInput(text),
			setStatus: (status) => this.chat.dispatch({ type: "ui_status", status }),
			log: (line) => this.output.appendLine(line),
		});
		this.statusItem.command = "pi.showLog";
		this.setStatus("stopped");
		this.statusItem.show();
		this.modelItem.command = "pi.selectModel";
		this.modelItem.tooltip = "Select pi model";
	}

	/** Start pi, or return the running client. Concurrent callers share one process. */
	start(): Promise<RpcClient> {
		if (this.client) return Promise.resolve(this.client);
		this.starting ??= this.spawn().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async stop(): Promise<void> {
		const client = this.client ?? (await this.starting?.catch(() => undefined));
		this.client = undefined;
		if (!client) return;
		this.ui.cancelAll();
		await client.stop();
		this.output.appendLine("pi stopped");
		this.setStatus("stopped");
		this.setMeta({ ...this.meta, started: false });
		// A run cut off by stopping never emits agent_settled.
		this.chat.dispatch({ type: "agent_settled" });
	}

	/** Send a message: a new prompt while idle, a steering message while pi is working. */
	async send(text: string): Promise<void> {
		const client = await this.start();
		if (this.status === "working") {
			await client.steer(text);
		} else {
			await client.prompt(text);
		}
	}

	/** Send typed text with the composer draft. The draft is kept if sending fails. */
	async submit(text: string): Promise<void> {
		const attachments = this.chat.draft();
		const prompt = buildPrompt(text, attachments);
		if (!prompt) return;
		if (attachments.length > 0) this.chat.dispatch({ type: "prompt_sent", prompt, text, attachments });
		await this.send(prompt);
		this.chat.dispatch({ type: "draft_remove", ids: attachments.map((attachment) => attachment.id) });
	}

	async prompt(): Promise<void> {
		const message = await vscode.window.showInputBox({ prompt: "Message for pi" });
		if (!message) return;
		await this.focusChat();
		await this.submit(message);
	}

	async addSelection(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const attachments = editor ? selectionAttachments(editor) : [];
		if (attachments.length === 0) {
			void vscode.window.showInformationMessage("Pi: select some text first.");
			return;
		}
		await this.attach(attachments);
	}

	/** Attach the file from the explorer context menu, or the active editor's file. */
	async addFile(uri?: vscode.Uri): Promise<void> {
		const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
		if (!document) {
			void vscode.window.showInformationMessage("Pi: open a file first.");
			return;
		}
		await this.attach([fileAttachment(document)]);
	}

	/** Attach problems of the active file, or workspace errors when no file is open. */
	async addDiagnostics(): Promise<void> {
		const document = vscode.window.activeTextEditor?.document;
		const attachment = await diagnosticsAttachment(document);
		if (!attachment) {
			const scope = document ? vscode.workspace.asRelativePath(document.uri, false) : "the workspace";
			void vscode.window.showInformationMessage(`Pi: no problems in ${scope}.`);
			return;
		}
		await this.attach([attachment]);
	}

	async abort(): Promise<void> {
		await this.client?.abort();
	}

	async newSession(): Promise<void> {
		const client = await this.idleClient();
		if ((await client.newSession()).cancelled) return;
		this.chat.reset();
		await this.refreshState(client);
	}

	/** Items for an in-panel menu. */
	async query(query: MenuQuery, text: string): Promise<MenuItem[]> {
		if (query === "files") return fileItems(await this.workspaceFiles(), text);
		const client = await this.start();
		switch (query) {
			case "sessions": {
				const [sessions, state] = await Promise.all([client.listSessions(), client.getState()]);
				return sessionItems(sessions, state.sessionFile);
			}
			case "models":
				return modelItems(await client.getAvailableModels(), this.meta.model);
			case "forks":
				return forkItems(await client.getForkMessages());
			case "commands":
				return commandItems(await client.getCommands());
		}
	}

	/** Actions from the panel's menus, buttons and built-in slash commands. */
	async command(command: PanelCommand, arg: string | undefined): Promise<void> {
		switch (command) {
			case "newSession":
				return this.newSession();
			case "switchSession": {
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
				this.chat.setInput(result.text);
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
				return this.refreshState(client);
			}
			case "setModel": {
				const client = await this.start();
				const model = await this.resolveModel(client, arg ?? "");
				await client.setModel(model.provider, model.id);
				return this.refreshState(client);
			}
			case "setThinking": {
				const client = await this.start();
				const level = this.meta.thinkingLevels.find((candidate) => candidate === arg?.trim());
				if (!level)
					throw new Error(
						`Unknown thinking level "${arg ?? ""}". Available: ${this.meta.thinkingLevels.join(", ")}`,
					);
				await client.setThinkingLevel(level as Parameters<RpcClient["setThinkingLevel"]>[0]);
				return this.refreshState(client);
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
			case "attachSelection":
				return this.addSelection();
			case "attachFile":
				return this.addFile();
			case "attachProblems":
				return this.addDiagnostics();
		}
	}

	/** Open an in-panel menu, for palette commands and the status bar. */
	async openMenu(menu: PanelMenu): Promise<void> {
		await this.focusChat();
		this.chat.openMenu(menu);
	}

	/** Accept a menu value (`{"provider","id"}` JSON) or a typed `provider/id` or model id. */
	private async resolveModel(client: RpcClient, arg: string): Promise<{ provider: string; id: string }> {
		if (arg.startsWith("{")) return JSON.parse(arg) as { provider: string; id: string };
		const models = await client.getAvailableModels();
		const match =
			models.find((model) => `${model.provider}/${model.id}` === arg) ?? models.find((model) => model.id === arg);
		if (!match) throw new Error(`Unknown model "${arg}".`);
		return match;
	}

	/** Relative workspace paths for @ mentions, cached briefly while the user types. */
	private async workspaceFiles(): Promise<string[]> {
		if (this.files && Date.now() - this.files.at < 10_000) return this.files.paths;
		const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,out}/**", 20_000);
		const paths = uris.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort();
		this.files = { at: Date.now(), paths };
		return paths;
	}

	/** Session changes while a run streams would race with its events. */
	private async idleClient(): Promise<RpcClient> {
		const client = await this.start();
		if (this.status === "working") throw new Error("pi is working. Abort the current run first.");
		return client;
	}

	/** Show the active session's history and settings after it changed underneath the transcript. */
	private async reload(client: RpcClient): Promise<void> {
		this.chat.load(await client.getMessages());
		await this.refreshState(client);
	}

	private async refreshState(client: RpcClient): Promise<void> {
		const [state, thinkingLevels] = await Promise.all([client.getState(), client.getAvailableThinkingLevels()]);
		this.setMeta({
			started: true,
			sessionName: state.sessionName,
			model: state.model ? { provider: state.model.provider, id: state.model.id } : undefined,
			thinkingLevel: state.thinkingLevel,
			thinkingLevels,
		});
	}

	private setMeta(meta: PanelMeta): void {
		this.meta = meta;
		this.chat.setMeta(meta);
		if (!meta.started) {
			this.modelItem.hide();
			return;
		}
		const thinking = meta.thinkingLevel && meta.thinkingLevel !== "off" ? ` · ${meta.thinkingLevel}` : "";
		this.modelItem.text = `$(sparkle) ${meta.model?.id ?? "no model"}${thinking}`;
		this.modelItem.show();
	}

	private async attach(attachments: Attachment[]): Promise<void> {
		this.chat.dispatch({ type: "draft_add", attachments });
		await this.focusChat();
	}

	async focusChat(): Promise<void> {
		await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
	}

	showLog(): void {
		this.output.show();
	}

	/** Run a command handler and report failures instead of dropping them. */
	async run(action: () => Promise<unknown>): Promise<void> {
		try {
			await action();
		} catch (error) {
			this.report(error);
		}
	}

	private report(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.output.appendLine(`error: ${message}`);
		this.chat.dispatch({ type: "ui_error", message });
		void vscode.window.showErrorMessage(`Pi: ${message.split("\n")[0]}`);
	}

	/** The process is stopped by deactivate(), which VS Code awaits. */
	dispose(): void {
		this.ui.dispose();
		this.statusItem.dispose();
		this.modelItem.dispose();
		this.output.dispose();
	}

	private async spawn(): Promise<RpcClient> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) throw new Error("Open a folder before starting pi");

		const config = vscode.workspace.getConfiguration("pi");
		const reviewArgs = config.get<boolean>("reviewChanges", true)
			? ["--extension", join(this.extensionPath, "src", "pi-extension", "review-changes.ts")]
			: [];
		const client = createPiClient({
			extensionPath: this.extensionPath,
			cwd,
			cliPath: config.get<string>("cliPath") || undefined,
			args: [...reviewArgs, ...(config.get<string[]>("args") ?? [])],
		});
		client.onExtensionUIRequest((request) => {
			// Metadata can hold whole files; keep the log readable.
			this.output.appendLine(
				JSON.stringify({
					...request,
					metadata: "metadata" in request && request.metadata ? "[metadata]" : undefined,
				}),
			);
			this.ui.handle(request);
		});
		// A new process starts a new session, so the transcript starts empty.
		this.chat.reset();
		client.onEvent((event) => {
			this.output.appendLine(JSON.stringify(event));
			this.chat.dispatch(event);
			if (event.type === "agent_start") this.setStatus("working");
			if (event.type === "agent_settled") {
				this.setStatus("idle");
				// Dialogs of the finished run (for example a review cut off by Abort) are already resolved by pi.
				this.ui.cancelAll();
			}
			if (event.type === "session_info_changed") this.setMeta({ ...this.meta, sessionName: event.name });
			if (event.type === "thinking_level_changed") this.setMeta({ ...this.meta, thinkingLevel: event.level });
		});

		this.setStatus("starting");
		try {
			await client.start();
			const state = await client.getState();
			const model = state.model ? `${state.model.provider}/${state.model.id}` : "none";
			this.output.appendLine(`pi started in ${cwd} (model: ${model})`);
			// pi.args such as --continue or --session resume an existing session.
			if (state.messageCount > 0) this.chat.load(await client.getMessages());
			await this.refreshState(client);
		} catch (error) {
			await client.stop();
			this.setStatus("stopped");
			throw error;
		}
		this.client = client;
		this.setStatus("idle");
		return client;
	}

	private setStatus(status: PiStatus): void {
		this.status = status;
		const icon = status === "working" || status === "starting" ? "$(loading~spin)" : "$(hubot)";
		this.statusItem.text = `${icon} pi: ${status}`;
		this.statusItem.tooltip = "Show pi log";
	}
}

let controller: PiController | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const pi = new PiController(context.extensionUri);
	controller = pi;
	context.subscriptions.push(
		pi,
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, pi.chat),
		vscode.commands.registerCommand("pi.start", () => pi.run(() => pi.start())),
		vscode.commands.registerCommand("pi.stop", () => pi.run(() => pi.stop())),
		vscode.commands.registerCommand("pi.prompt", () => pi.run(() => pi.prompt())),
		vscode.commands.registerCommand("pi.abort", () => pi.run(() => pi.abort())),
		vscode.commands.registerCommand("pi.showLog", () => pi.showLog()),
		vscode.commands.registerCommand("pi.addSelection", () => pi.run(() => pi.addSelection())),
		vscode.commands.registerCommand("pi.addFile", (uri?: vscode.Uri) => pi.run(() => pi.addFile(uri))),
		vscode.commands.registerCommand("pi.addDiagnostics", () => pi.run(() => pi.addDiagnostics())),
		vscode.commands.registerCommand("pi.acceptChange", () => pi.ui.resolveReview(ACCEPT)),
		vscode.commands.registerCommand("pi.rejectChange", () => pi.ui.resolveReview(REJECT)),
		vscode.commands.registerCommand("pi.newSession", () => pi.run(() => pi.newSession())),
		vscode.commands.registerCommand("pi.switchSession", () => pi.run(() => pi.openMenu("sessions"))),
		vscode.commands.registerCommand("pi.forkSession", () => pi.run(() => pi.openMenu("forks"))),
		vscode.commands.registerCommand("pi.renameSession", () => pi.run(() => pi.openMenu("rename"))),
		vscode.commands.registerCommand("pi.selectModel", () => pi.run(() => pi.openMenu("models"))),
		vscode.commands.registerCommand("pi.selectThinkingLevel", () => pi.run(() => pi.openMenu("thinking"))),
	);
}

export async function deactivate(): Promise<void> {
	await controller?.stop();
	controller = undefined;
}
