import { join } from "node:path";
import * as vscode from "vscode";
import type { RpcClient } from "../../coding-agent/src/modes/rpc/rpc-client.ts";
import type { Attachment } from "./chat-types.ts";
import { ChatViewProvider } from "./chat-view.ts";
import { diagnosticsAttachment, fileAttachment, selectionAttachments } from "./editor-context.ts";
import { ExtensionUIBridge } from "./extension-ui.ts";
import { ACCEPT, REJECT } from "./file-change.ts";
import { createPiClient } from "./pi-launch.ts";
import { buildPrompt } from "./prompt-context.ts";
import { forkItems, modelItems, type PickItem, sessionItems, thinkingLevelItems } from "./quick-picks.ts";

type PiStatus = "stopped" | "starting" | "idle" | "working";

/** Owns one pi RPC process for the first workspace folder, feeds its events to the chat view, and logs them. */
class PiController implements vscode.Disposable {
	readonly chat: ChatViewProvider;
	readonly ui: ExtensionUIBridge;
	private readonly extensionPath: string;
	private readonly output = vscode.window.createOutputChannel("Pi");
	private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	private readonly modelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	private model: { provider: string; id: string } | undefined;
	private thinkingLevel = "";
	private client: RpcClient | undefined;
	private starting: Promise<RpcClient> | undefined;
	private status: PiStatus = "stopped";

	constructor(extensionUri: vscode.Uri) {
		this.extensionPath = extensionUri.fsPath;
		this.chat = new ChatViewProvider(extensionUri, {
			submit: (text) => this.run(() => this.submit(text)),
			abort: () => this.run(() => this.abort()),
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
		this.modelItem.hide();
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

	async switchSession(): Promise<void> {
		const client = await this.idleClient();
		const [sessions, state] = await Promise.all([client.listSessions(), client.getState()]);
		if (sessions.length === 0) {
			void vscode.window.showInformationMessage("Pi: no saved sessions for this folder yet.");
			return;
		}
		const pick = await this.pick(sessionItems(sessions, state.sessionFile), "Switch to a session");
		if (!pick || pick.value === state.sessionFile) return;
		if ((await client.switchSession(pick.value)).cancelled) return;
		await this.reload(client);
	}

	/** Start a new session from before an earlier user message, and put that message back in the composer. */
	async forkSession(): Promise<void> {
		const client = await this.idleClient();
		const messages = await client.getForkMessages();
		if (messages.length === 0) {
			void vscode.window.showInformationMessage("Pi: no messages to fork from yet.");
			return;
		}
		const pick = await this.pick(forkItems(messages), "Fork from before this message");
		if (!pick) return;
		const result = await client.fork(pick.value);
		if (result.cancelled) return;
		await this.reload(client);
		await this.focusChat();
		this.chat.setInput(result.text);
	}

	async renameSession(): Promise<void> {
		const client = await this.start();
		const state = await client.getState();
		const name = await vscode.window.showInputBox({ prompt: "Session name", value: state.sessionName ?? "" });
		if (!name?.trim()) return;
		await client.setSessionName(name);
		await this.refreshState(client);
	}

	async selectModel(): Promise<void> {
		const client = await this.start();
		const models = await client.getAvailableModels();
		if (models.length === 0) {
			void vscode.window.showInformationMessage(
				"Pi: no models available. Log in to a provider with the pi CLI first.",
			);
			return;
		}
		const pick = await this.pick(modelItems(models, this.model), "Select a model");
		if (!pick) return;
		await client.setModel(pick.value.provider, pick.value.id);
		await this.refreshState(client);
	}

	async selectThinkingLevel(): Promise<void> {
		const client = await this.start();
		const [levels, state] = await Promise.all([client.getAvailableThinkingLevels(), client.getState()]);
		const pick = await this.pick(thinkingLevelItems(levels, state.thinkingLevel), "Select a thinking level");
		if (!pick) return;
		await client.setThinkingLevel(pick.value);
		await this.refreshState(client);
	}

	/** Session changes while a run streams would race with its events. */
	private async idleClient(): Promise<RpcClient> {
		const client = await this.start();
		if (this.status === "working") throw new Error("pi is working. Abort the current run first.");
		return client;
	}

	private pick<T>(items: PickItem<T>[], placeHolder: string): Thenable<PickItem<T> | undefined> {
		return vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
	}

	/** Show the active session's history and settings after it changed underneath the transcript. */
	private async reload(client: RpcClient): Promise<void> {
		this.chat.load(await client.getMessages());
		await this.refreshState(client);
	}

	private async refreshState(client: RpcClient): Promise<void> {
		const state = await client.getState();
		this.model = state.model ? { provider: state.model.provider, id: state.model.id } : undefined;
		this.thinkingLevel = state.thinkingLevel;
		this.chat.setDescription(state.sessionName);
		this.updateModelItem();
	}

	private updateModelItem(): void {
		this.modelItem.text = `$(sparkle) ${this.model?.id ?? "no model"}${this.thinkingLevel && this.thinkingLevel !== "off" ? ` · ${this.thinkingLevel}` : ""}`;
		this.modelItem.show();
	}

	private async attach(attachments: Attachment[]): Promise<void> {
		this.chat.dispatch({ type: "draft_add", attachments });
		await this.focusChat();
	}

	private async focusChat(): Promise<void> {
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
			const message = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`error: ${message}`);
			this.chat.dispatch({ type: "ui_error", message });
			void vscode.window.showErrorMessage(`Pi: ${message.split("\n")[0]}`);
		}
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
			if (event.type === "session_info_changed") this.chat.setDescription(event.name);
			if (event.type === "thinking_level_changed") {
				this.thinkingLevel = event.level;
				this.updateModelItem();
			}
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
		vscode.commands.registerCommand("pi.switchSession", () => pi.run(() => pi.switchSession())),
		vscode.commands.registerCommand("pi.forkSession", () => pi.run(() => pi.forkSession())),
		vscode.commands.registerCommand("pi.renameSession", () => pi.run(() => pi.renameSession())),
		vscode.commands.registerCommand("pi.selectModel", () => pi.run(() => pi.selectModel())),
		vscode.commands.registerCommand("pi.selectThinkingLevel", () => pi.run(() => pi.selectThinkingLevel())),
	);
}

export async function deactivate(): Promise<void> {
	await controller?.stop();
	controller = undefined;
}
