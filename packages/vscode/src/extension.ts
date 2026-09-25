import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as vscode from "vscode";
import type { RpcAuthEvent } from "../../coding-agent/src/modes/rpc/rpc-types.ts";
import type {
	ApprovalMode,
	Attachment,
	LoginRequest,
	MenuItem,
	MenuQuery,
	PanelCommand,
	PanelMenu,
	PanelMeta,
	SetupState,
} from "./chat-types.ts";
import { ChatViewProvider } from "./chat-view.ts";
import { diagnosticsAttachment, fileAttachment, selectionAttachments } from "./editor-context.ts";
import { ExtensionUIBridge, type UITarget } from "./extension-ui.ts";
import { ACCEPT, REJECT } from "./file-change.ts";
import { bundledRuntime, devRuntime, type PiRuntime } from "./pi-launch.ts";
import { hasModel, PiSession, type PiSessionHost } from "./pi-session.ts";
import { fileItems, providerItems } from "./quick-picks.ts";

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
	private readonly extensionPath: string;
	private readonly extensionId: string;
	/** Installed from a VSIX: run the bundled pi; in the Extension Development Host: pi from source. */
	private readonly bundled: boolean;
	private readonly output = vscode.window.createOutputChannel("Pi");
	private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	private readonly modelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	private readonly workspaceState: vscode.Memento;
	private readonly disposables: vscode.Disposable[] = [];
	private sessions: PiSession[] = [];
	private active: PiSession;
	private lastMeta = "";
	private files: { at: number; paths: string[] } | undefined;
	/** The running sign-in, shown in the panel instead of the chat. */
	private login: Extract<SetupState, { kind: "login" }> | undefined;
	/** The sign-in's pending code prompt, answered from the card. */
	private loginPrompt: { id: string; session: PiSession } | undefined;

	constructor(extensionUri: vscode.Uri, extensionId: string, workspaceState: vscode.Memento, bundled: boolean) {
		this.extensionPath = extensionUri.fsPath;
		this.extensionId = extensionId;
		this.bundled = bundled;
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
			// The shown tab starts with the panel, so a restored session loads its history and a missing
			// folder, Node.js or model shows up before the first message.
			ready: () => void this.startActive(),
			review: (id, choice) => this.ui.resolveReview(choice, id),
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
				// A changed runtime setting may fix a failed start.
				const runtimeSetting = ["pi.nodePath", "pi.cliPath", "pi.args"].some((key) =>
					event.affectsConfiguration(key),
				);
				if (runtimeSetting && this.active.startError) void this.retryStart();
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => void this.startActive()),
			vscode.workspace.onDidSaveTextDocument((document) => void this.agentFileSaved(document)),
		);
		this.publishMeta();
	}

	// PiSessionHost

	runtime(): PiRuntime {
		const config = vscode.workspace.getConfiguration("pi");
		const nodePath = config.get<string>("nodePath") || undefined;
		const runtime = this.bundled
			? bundledRuntime(
					this.extensionPath,
					{ execPath: process.execPath, nodeVersion: process.versions.node },
					nodePath,
				)
			: { ...devRuntime(this.extensionPath), command: nodePath ?? "node" };
		// pi.cliPath points at another pi entry point, run with node.
		const cliPath = config.get<string>("cliPath");
		return cliPath ? { ...runtime, command: nodePath ?? "node", cliPath, env: {} } : runtime;
	}

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
		const metadata = "metadata" in request ? request.metadata : undefined;
		if (
			this.login &&
			request.method === "input" &&
			metadata?.kind === "pi.auth" &&
			metadata.promptType === "manual_code"
		) {
			this.loginPrompt = { id: request.id, session };
			this.login = { ...this.login, prompt: { message: request.title, placeholder: request.placeholder } };
			this.publishMeta();
			return;
		}
		this.ui.handle(request, this.uiTarget(session));
	}

	settled(session: PiSession): void {
		this.ui.cancel(session.id);
	}

	setInput(session: PiSession, text: string): void {
		if (session === this.active) this.chat.setInput(text);
	}

	authEvent(_session: PiSession, event: RpcAuthEvent["event"]): void {
		const login = this.login;
		if (!login) return;
		if (event.type === "auth_url") {
			this.login = {
				...login,
				url: event.url,
				message: event.instructions ?? "Finish signing in in your browser.",
			};
			void vscode.env.openExternal(vscode.Uri.parse(event.url));
		} else if (event.type === "device_code") {
			this.login = {
				...login,
				url: event.verificationUri,
				code: event.userCode,
				message: "Enter this code on the sign-in page.",
			};
			void vscode.env.openExternal(vscode.Uri.parse(event.verificationUri));
		} else {
			this.login = { ...login, message: event.message };
		}
		this.publishMeta();
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

	/**
	 * Start the shown tab when the panel opens or folders change. Failures are shown in the panel
	 * (see {@link setupState}), so they are only logged here.
	 */
	private async startActive(): Promise<void> {
		this.publishMeta();
		if (!workspaceFolder()) return;
		try {
			await this.active.start();
		} catch (error) {
			this.output.appendLine(`start failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.publishMeta();
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
		if (query === "providers") {
			const method = text === "oauth" || text === "api_key" || text === "stored" ? text : undefined;
			return providerItems(await this.active.authProviders(), method);
		}
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
			case "openFolder":
				await vscode.commands.executeCommand("vscode.openFolder");
				return;
			case "retryStart":
				return this.retryStart();
			case "login":
				return this.signIn(JSON.parse(arg ?? "{}") as LoginRequest);
			case "cancelLogin":
				return this.active.abortLogin();
			case "loginCode":
				return this.answerLoginPrompt(arg ?? "");
			case "openLoginUrl":
				if (this.login?.url) await vscode.env.openExternal(vscode.Uri.parse(this.login.url));
				return;
			case "logout":
				return this.signOut(arg);
			case "openSettings":
				await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${this.extensionId}`);
				return;
			case "openPiSettings":
				return this.openAgentFile("settings.json", "{}\n");
			case "openModelsFile":
				return this.openAgentFile("models.json", MODELS_TEMPLATE);
			case "showLog":
				return this.showLog();
			default:
				return this.withActive((session) => session.serial(() => session.command(command, arg)));
		}
	}

	/** Try again after fixing a start failure, for example after installing Node.js. */
	private async retryStart(): Promise<void> {
		this.active.startError = undefined;
		await this.startActive();
	}

	/** Sign in to a provider in the shown tab's pi. The panel shows progress until it finishes. */
	private async signIn(request: LoginRequest): Promise<void> {
		if (this.login) throw new Error("A sign-in is already running.");
		const session = this.active;
		this.login = {
			kind: "login",
			name: request.name,
			method: request.method,
			message:
				request.method === "api_key"
					? `Enter your ${request.name} API key in the box at the top of the window.`
					: `Starting the ${request.name} sign-in...`,
		};
		this.publishMeta();
		try {
			const result = await session.login(request.provider, request.method);
			const model = hasModel(session.info) ? session.info.model : undefined;
			if (result.warning) void vscode.window.showWarningMessage(`Pi: ${result.warning}`);
			else
				void vscode.window.showInformationMessage(
					`Pi: signed in to ${request.name}${model ? `. Using ${model.id}.` : "."}`,
				);
			await this.reloadOtherTabs(session);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Closing the prompt or pressing Cancel is not an error.
			if (!/Login cancelled|aborted/i.test(message)) throw error;
		} finally {
			this.login = undefined;
			this.loginPrompt = undefined;
			this.publishMeta();
		}
	}

	private answerLoginPrompt(value: string): void {
		const prompt = this.loginPrompt;
		if (!prompt || !value.trim() || !this.login) return;
		this.loginPrompt = undefined;
		this.login = { ...this.login, prompt: undefined, message: "Checking the code..." };
		this.publishMeta();
		prompt.session.respondToUI({ type: "extension_ui_response", id: prompt.id, value: value.trim() });
	}

	private async signOut(provider: string | undefined): Promise<void> {
		if (!provider) return;
		const choice = await vscode.window.showWarningMessage(
			`Sign out of ${provider}?`,
			{
				modal: true,
				detail: "Stored credentials for this provider are removed. Environment variables are not affected.",
			},
			"Sign Out",
		);
		if (choice !== "Sign Out") return;
		await this.active.logout(provider);
		await this.reloadOtherTabs(this.active);
	}

	/** Other tabs' pi processes loaded credentials at start; idle ones restart when next shown. */
	private async reloadOtherTabs(current: PiSession): Promise<void> {
		await Promise.all(
			this.sessions
				.filter((session) => session !== current && session.status === "idle")
				.map((session) => session.stop()),
		);
	}

	/** A file in pi's agent directory (shared with pi in the terminal), created from `template` when missing. */
	private async openAgentFile(name: string, template: string): Promise<void> {
		const file = join(piAgentDir(), name);
		if (!existsSync(file)) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, template);
		}
		await vscode.window.showTextDocument(vscode.Uri.file(file));
	}

	/**
	 * pi reads settings.json, models.json and auth.json when it starts. After one is saved, idle tabs restart
	 * (the shown one right away, others when next shown) so the model menu reflects the change.
	 */
	private async agentFileSaved(document: vscode.TextDocument): Promise<void> {
		const file = document.uri.fsPath;
		if (dirname(file) !== piAgentDir() || !AGENT_FILES.has(basename(file))) return;
		const active = this.active;
		await this.reloadOtherTabs(active);
		if (active.status !== "idle") return;
		await active.stop();
		await this.startActive();
		this.output.appendLine(`reloaded pi after ${basename(file)} changed`);
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
			startReview: (review, location) => {
				session.dispatch({ type: "review_start", review, ...location });
				session.setReviewing(true);
			},
			endReview: (id) => {
				session.dispatch({ type: "review_end", id });
				session.setReviewing(false);
			},
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

	/** What blocks chatting, most basic first: a folder, a runnable pi, a sign-in in progress, a model. */
	private setupState(): SetupState | undefined {
		if (!workspaceFolder()) return { kind: "noFolder" };
		if (this.login) return this.login;
		const error = this.active.startError;
		if (error) return { kind: "startFailed", ...error };
		if (this.active.info.started && !hasModel(this.active.info)) return { kind: "noModel" };
		return undefined;
	}

	/** Header tabs plus the active tab's settings; posted only when something visible changed. */
	private publishMeta(): void {
		const info = this.active.info;
		const meta: PanelMeta = {
			...info,
			model: hasModel(info) ? info.model : undefined,
			setup: this.setupState(),
			approvalMode: this.approvalMode(),
			tabs: this.sessions.map((session) => ({
				id: session.id,
				title: session.title,
				active: session === this.active,
				state: session.tabState,
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
			this.modelItem.text = `$(sparkle) ${meta.model?.id ?? "no model"}${thinking}`;
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

/** pi's configuration files whose changes need a pi restart. */
const AGENT_FILES = new Set(["settings.json", "models.json", "auth.json"]);

/** Starting point for custom providers and models; see pi's docs/models.md. */
const MODELS_TEMPLATE = `{
	"providers": {
		"ollama": {
			"baseUrl": "http://localhost:11434/v1",
			"api": "openai-completions",
			"apiKey": "ollama",
			"models": [{ "id": "qwen2.5-coder:7b" }]
		}
	}
}
`;

function workspaceFolder(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** pi's agent directory: PI_CODING_AGENT_DIR, which the pi child process inherits, or ~/.pi/agent. */
function piAgentDir(): string {
	const dir = process.env.PI_CODING_AGENT_DIR;
	if (!dir) return join(homedir(), ".pi", "agent");
	return dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir;
}

let controller: PiController | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const pi = new PiController(
		context.extensionUri,
		context.extension.id,
		context.workspaceState,
		context.extensionMode === vscode.ExtensionMode.Production,
	);
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
		vscode.commands.registerCommand("pi.openSettings", () => pi.run(() => pi.openMenu("settings"))),
		vscode.commands.registerCommand("pi.signIn", () => pi.run(() => pi.openMenu("providers"))),
	);
}

export async function deactivate(): Promise<void> {
	await controller?.stopAll();
	controller = undefined;
}
