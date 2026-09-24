import * as vscode from "vscode";
import type {
	ApprovalMode,
	Attachment,
	MenuItem,
	MenuQuery,
	PanelCommand,
	PanelMenu,
	PanelMeta,
} from "./chat-types.ts";
import { ChatViewProvider } from "./chat-view.ts";
import { diagnosticsAttachment, fileAttachment, selectionAttachments } from "./editor-context.ts";
import { ExtensionUIBridge, type UITarget } from "./extension-ui.ts";
import { ACCEPT, REJECT } from "./file-change.ts";
import { PiSession, type PiSessionHost } from "./pi-session.ts";
import { fileItems } from "./quick-picks.ts";

/** Session files of the open tabs and the active one, restored when the window reloads. */
const TABS_KEY = "pi.chatTabs";

interface SavedTabs {
	tabs: { file: string; title: string }[];
	active?: string;
}

/** Owns the chat tabs (one pi process each), routes panel actions to the active tab, and logs. */
class PiController implements vscode.Disposable, PiSessionHost {
	readonly chat: ChatViewProvider;
	readonly ui: ExtensionUIBridge;
	readonly extensionPath: string;
	private readonly output = vscode.window.createOutputChannel("Pi");
	private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	private readonly modelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	private readonly workspaceState: vscode.Memento;
	private readonly disposables: vscode.Disposable[] = [];
	private sessions: PiSession[] = [];
	private active: PiSession;
	private lastMeta = "";
	private files: { at: number; paths: string[] } | undefined;

	constructor(extensionUri: vscode.Uri, workspaceState: vscode.Memento) {
		this.extensionPath = extensionUri.fsPath;
		this.workspaceState = workspaceState;
		this.chat = new ChatViewProvider(extensionUri, {
			submit: (text) => this.run(() => this.withActive((session) => session.serial(() => session.submit(text)))),
			abort: () => this.run(() => this.active.abort()),
			removeAttachment: (id) => this.active.dispatch({ type: "draft_remove", ids: [id] }),
			query: async (query, text) => {
				try {
					return await this.query(query, text);
				} catch (error) {
					this.report(error);
					return [];
				}
			},
			command: (command, arg) => this.run(() => this.command(command, arg)),
			// The shown tab starts with the panel, so a restored session loads its history right away.
			ready: () => this.run(() => this.active.start()),
		});
		this.ui = new ExtensionUIBridge({
			log: (line) => this.output.appendLine(line),
			autoApprove: () => this.approvalMode() === "auto",
		});
		this.statusItem.command = "pi.showLog";
		this.statusItem.show();
		this.modelItem.command = "pi.selectModel";
		this.modelItem.tooltip = "Select pi model";

		const saved = workspaceState.get<SavedTabs>(TABS_KEY, { tabs: [] });
		this.sessions = (saved.tabs ?? []).map((tab) => new PiSession(this, tab.file, tab.title));
		if (this.sessions.length === 0) this.sessions.push(new PiSession(this));
		this.active = this.sessions.find((session) => session.info.sessionFile === saved.active) ?? this.sessions[0]!;
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("pi.approvalMode")) this.publishMeta();
			}),
		);
		this.publishMeta();
	}

	// PiSessionHost

	log(session: PiSession, line: string): void {
		this.output.appendLine(this.sessions.length > 1 ? `[${session.title}] ${line}` : line);
	}

	stateChanged(session: PiSession, prev: PiSession["state"]): void {
		if (session === this.active) this.chat.update(prev, session.state);
		// A first user message renames the tab.
		this.publishMeta();
	}

	infoChanged(): void {
		this.publishMeta();
		this.saveTabs();
	}

	uiRequest(session: PiSession, request: Parameters<ExtensionUIBridge["handle"]>[0]): void {
		this.ui.handle(request, this.uiTarget(session));
	}

	settled(session: PiSession): void {
		this.ui.cancel(session.id);
	}

	setInput(session: PiSession, text: string): void {
		if (session === this.active) this.chat.setInput(text);
	}

	// Tabs

	async newTab(): Promise<void> {
		const session = new PiSession(this);
		this.sessions.push(session);
		await this.activate(session);
	}

	/** Stop the tab's pi process and remove it. The last tab is replaced by a new empty one. */
	async closeTab(id: string | undefined): Promise<void> {
		const session = this.sessions.find((candidate) => candidate.id === id) ?? this.active;
		const index = this.sessions.indexOf(session);
		this.sessions.splice(index, 1);
		this.ui.cancel(session.id);
		if (this.sessions.length === 0) this.sessions.push(new PiSession(this));
		if (session === this.active) await this.activate(this.sessions[Math.min(index, this.sessions.length - 1)]!);
		else this.publishMeta();
		this.saveTabs();
		await session.stop();
	}

	/** Close the tab and move its session file to the trash, after confirmation. */
	async deleteSession(id: string | undefined): Promise<void> {
		const session = this.sessions.find((candidate) => candidate.id === id) ?? this.active;
		const file = session.info.sessionFile;
		const choice = await vscode.window.showWarningMessage(
			`Delete the session "${session.title}"?`,
			{
				modal: true,
				detail: file ? `The session file is moved to the trash:\n${file}` : "This session has not been saved yet.",
			},
			"Delete",
		);
		if (choice !== "Delete") return;
		await this.closeTab(session.id);
		if (!file) return;
		const uri = vscode.Uri.file(file);
		try {
			await vscode.workspace.fs.delete(uri, { useTrash: true });
			return;
		} catch (error) {
			this.output.appendLine(`trash unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
		// Remote file systems may have no trash; a permanent delete needs its own confirmation.
		const permanent = await vscode.window.showWarningMessage(
			"The trash is not available here. Delete the session file permanently?",
			{ modal: true, detail: file },
			"Delete Permanently",
		);
		if (permanent === "Delete Permanently") await vscode.workspace.fs.delete(uri);
	}

	async switchTab(id: string | undefined): Promise<void> {
		const session = this.sessions.find((candidate) => candidate.id === id);
		if (session) await this.activate(session);
	}

	/** Open a saved session: focus its tab, reuse an empty active tab, or open a new tab. */
	async openSession(path: string | undefined): Promise<void> {
		if (!path) return;
		const open = this.sessions.find((session) => session.info.sessionFile === path);
		if (open) return this.activate(open);
		if (this.active.isEmpty && this.active.status !== "stopped") {
			return this.active.serial(() => this.active.command("openSession", path));
		}
		const session = new PiSession(this, path);
		this.sessions.push(session);
		await this.activate(session);
	}

	private async activate(session: PiSession): Promise<void> {
		this.active = session;
		this.chat.show(session.state);
		this.publishMeta();
		this.saveTabs();
		// Tabs restored from a previous window start their process when first shown.
		await session.start();
	}

	/** Start the active tab if needed; used by the panel and palette commands. */
	start(): Promise<unknown> {
		return this.active.start();
	}

	async stop(): Promise<void> {
		await this.active.stop();
	}

	async stopAll(): Promise<void> {
		await Promise.all(this.sessions.map((session) => session.stop()));
	}

	// Panel

	async query(query: MenuQuery, text: string): Promise<MenuItem[]> {
		if (query === "files") return fileItems(await this.workspaceFiles(), text);
		return this.active.query(query);
	}

	async command(command: PanelCommand, arg: string | undefined): Promise<void> {
		switch (command) {
			case "newTab":
				return this.newTab();
			case "closeTab":
				return this.closeTab(arg);
			case "deleteSession":
				return this.deleteSession(arg);
			case "switchTab":
				return this.switchTab(arg);
			case "openSession":
				return this.openSession(arg);
			case "setApprovalMode":
				return this.setApprovalMode(arg === "auto" ? "auto" : "ask");
			case "attachSelection":
				return this.addSelection();
			case "attachFile":
				return this.addFile();
			case "attachProblems":
				return this.addDiagnostics();
			default:
				return this.withActive((session) => session.serial(() => session.command(command, arg)));
		}
	}

	async prompt(): Promise<void> {
		const message = await vscode.window.showInputBox({ prompt: "Message for pi" });
		if (!message) return;
		await this.focusChat();
		await this.withActive((session) => session.serial(() => session.submit(message)));
	}

	async abort(): Promise<void> {
		await this.active.abort();
	}

	async newSession(): Promise<void> {
		await this.command("newSession", undefined);
	}

	/** Open an in-panel menu, for palette commands and the status bar. */
	async openMenu(menu: PanelMenu): Promise<void> {
		await this.focusChat();
		this.chat.openMenu(menu);
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

	dispose(): void {
		this.ui.dispose();
		this.statusItem.dispose();
		this.modelItem.dispose();
		this.output.dispose();
		for (const disposable of this.disposables) disposable.dispose();
	}

	private async withActive(action: (session: PiSession) => Promise<unknown>): Promise<void> {
		await action(this.active);
	}

	private approvalMode(): ApprovalMode {
		return vscode.workspace.getConfiguration("pi").get<ApprovalMode>("approvalMode", "ask") === "auto"
			? "auto"
			: "ask";
	}

	private async setApprovalMode(mode: ApprovalMode): Promise<void> {
		await vscode.workspace.getConfiguration("pi").update("approvalMode", mode, vscode.ConfigurationTarget.Global);
		this.publishMeta();
	}

	private uiTarget(session: PiSession): UITarget {
		return {
			id: session.id,
			label: () => session.title,
			respond: (response) => session.respondToUI(response),
			setInput: (text) => this.setInput(session, text),
			setStatus: (status) => session.dispatch({ type: "ui_status", status }),
		};
	}

	private async attach(attachments: Attachment[]): Promise<void> {
		this.active.dispatch({ type: "draft_add", attachments });
		await this.focusChat();
	}

	/** Relative workspace paths for @ mentions, cached briefly while the user types. */
	private async workspaceFiles(): Promise<string[]> {
		if (this.files && Date.now() - this.files.at < 10_000) return this.files.paths;
		const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,out}/**", 20_000);
		const paths = uris.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort();
		this.files = { at: Date.now(), paths };
		return paths;
	}

	/** Header tabs plus the active tab's settings; posted only when something visible changed. */
	private publishMeta(): void {
		const info = this.active.info;
		const meta: PanelMeta = {
			...info,
			approvalMode: this.approvalMode(),
			tabs: this.sessions.map((session) => ({
				id: session.id,
				title: session.title,
				active: session === this.active,
				running: session.status === "working" || session.status === "starting",
			})),
		};
		const serialized = JSON.stringify(meta);
		if (serialized !== this.lastMeta) {
			this.lastMeta = serialized;
			this.chat.setMeta(meta);
		}
		const status = this.active.status;
		const working = this.sessions.filter((session) => session.status === "working").length;
		const icon = status === "working" || status === "starting" ? "$(loading~spin)" : "$(hubot)";
		this.statusItem.text = `${icon} pi: ${status}${working > 1 ? ` (${working} tabs working)` : ""}`;
		this.statusItem.tooltip = "Show pi log";
		if (info.started) {
			const thinking = info.thinkingLevel && info.thinkingLevel !== "off" ? ` · ${info.thinkingLevel}` : "";
			this.modelItem.text = `$(sparkle) ${info.model?.id ?? "no model"}${thinking}`;
			this.modelItem.show();
		} else {
			this.modelItem.hide();
		}
	}

	private saveTabs(): void {
		const tabs = this.sessions.flatMap((session) =>
			session.info.sessionFile ? [{ file: session.info.sessionFile, title: session.title }] : [],
		);
		void this.workspaceState.update(TABS_KEY, { tabs, active: this.active.info.sessionFile } satisfies SavedTabs);
	}

	private report(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.output.appendLine(`error: ${message}`);
		this.active.dispatch({ type: "ui_error", message });
		void vscode.window.showErrorMessage(`Pi: ${message.split("\n")[0]}`);
	}
}

let controller: PiController | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const pi = new PiController(context.extensionUri, context.workspaceState);
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
		vscode.commands.registerCommand("pi.newTab", () => pi.run(() => pi.newTab())),
		vscode.commands.registerCommand("pi.newSession", () => pi.run(() => pi.newSession())),
		vscode.commands.registerCommand("pi.switchSession", () => pi.run(() => pi.openMenu("sessions"))),
		vscode.commands.registerCommand("pi.forkSession", () => pi.run(() => pi.openMenu("forks"))),
		vscode.commands.registerCommand("pi.renameSession", () => pi.run(() => pi.openMenu("rename"))),
		vscode.commands.registerCommand("pi.selectModel", () => pi.run(() => pi.openMenu("models"))),
		vscode.commands.registerCommand("pi.selectThinkingLevel", () => pi.run(() => pi.openMenu("thinking"))),
	);
}

export async function deactivate(): Promise<void> {
	await controller?.stopAll();
	controller = undefined;
}
