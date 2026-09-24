import * as vscode from "vscode";
import type { RpcClient } from "../../coding-agent/src/modes/rpc/rpc-client.ts";
import type { Attachment } from "./chat-types.ts";
import { ChatViewProvider } from "./chat-view.ts";
import { diagnosticsAttachment, fileAttachment, selectionAttachments } from "./editor-context.ts";
import { createPiClient } from "./pi-launch.ts";
import { buildPrompt } from "./prompt-context.ts";

type PiStatus = "stopped" | "starting" | "idle" | "working";

/** Owns one pi RPC process for the first workspace folder, feeds its events to the chat view, and logs them. */
class PiController implements vscode.Disposable {
	readonly chat: ChatViewProvider;
	private readonly extensionPath: string;
	private readonly output = vscode.window.createOutputChannel("Pi");
	private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	private client: RpcClient | undefined;
	private starting: Promise<RpcClient> | undefined;
	private status: PiStatus = "stopped";

	constructor(extensionUri: vscode.Uri) {
		this.extensionPath = extensionUri.fsPath;
		this.chat = new ChatViewProvider(extensionUri, {
			submit: (text) => this.run(() => this.submit(text)),
			abort: () => this.run(() => this.abort()),
		});
		this.statusItem.command = "pi.showLog";
		this.setStatus("stopped");
		this.statusItem.show();
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
		await client.stop();
		this.output.appendLine("pi stopped");
		this.setStatus("stopped");
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
		this.statusItem.dispose();
		this.output.dispose();
	}

	private async spawn(): Promise<RpcClient> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) throw new Error("Open a folder before starting pi");

		const config = vscode.workspace.getConfiguration("pi");
		const client = createPiClient({
			extensionPath: this.extensionPath,
			cwd,
			cliPath: config.get<string>("cliPath") || undefined,
			args: config.get<string[]>("args"),
		});
		// A new process starts a new session, so the transcript starts empty.
		this.chat.reset();
		client.onEvent((event) => {
			this.output.appendLine(JSON.stringify(event));
			this.chat.dispatch(event);
			if (event.type === "agent_start") this.setStatus("working");
			if (event.type === "agent_settled") this.setStatus("idle");
		});

		this.setStatus("starting");
		try {
			await client.start();
			const state = await client.getState();
			const model = state.model ? `${state.model.provider}/${state.model.id}` : "none";
			this.output.appendLine(`pi started in ${cwd} (model: ${model})`);
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
	);
}

export async function deactivate(): Promise<void> {
	await controller?.stop();
	controller = undefined;
}
