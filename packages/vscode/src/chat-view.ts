import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { type AgentMessage, type ChatAction, createChatState, diffChat, reduceChat } from "./chat-state.ts";
import type {
	Attachment,
	HostMessage,
	MenuItem,
	MenuQuery,
	PanelCommand,
	PanelMenu,
	PanelMeta,
	WebviewMessage,
} from "./chat-types.ts";

export interface ChatViewHandlers {
	/** Send the typed text together with the composer draft. */
	submit(text: string): Promise<void>;
	abort(): Promise<void>;
	/** Items for an in-panel menu. Failures are reported by the handler and yield an empty menu. */
	query(query: MenuQuery, text: string): Promise<MenuItem[]>;
	command(command: PanelCommand, arg: string | undefined): Promise<void>;
}

/**
 * Sidebar chat webview. The transcript state lives here, so a webview that VS Code
 * destroys while hidden is rebuilt from a full snapshot when it reports `ready`.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "pi.chat";

	private readonly extensionUri: vscode.Uri;
	private readonly handlers: ChatViewHandlers;
	private state = createChatState();
	private view: vscode.WebviewView | undefined;
	private meta: PanelMeta = { started: false, thinkingLevels: [], tabs: [] };

	constructor(extensionUri: vscode.Uri, handlers: ChatViewHandlers) {
		this.extensionUri = extensionUri;
		this.handlers = handlers;
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		const assets = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
		view.webview.options = { enableScripts: true, localResourceRoots: [assets] };
		view.webview.html = renderHtml(view.webview, assets);
		view.webview.onDidReceiveMessage((message: WebviewMessage) => {
			if (message.type === "ready") {
				this.post({ type: "reset", state: this.state });
				this.post({ type: "meta", meta: this.meta });
			} else if (message.type === "send") {
				void this.handlers.submit(message.text);
			} else if (message.type === "abort") {
				void this.handlers.abort();
			} else if (message.type === "removeAttachment") {
				this.dispatch({ type: "draft_remove", ids: [message.id] });
			} else if (message.type === "query") {
				void this.handlers
					.query(message.query, message.text ?? "")
					.then((items) => this.post({ type: "queryResult", id: message.id, items }));
			} else if (message.type === "command") {
				void this.handlers.command(message.command, message.arg);
			} else if (message.type === "copyText") {
				void vscode.env.clipboard.writeText(message.text);
			}
		});
		view.onDidDispose(() => {
			if (this.view === view) this.view = undefined;
		});
		this.view = view;
	}

	/** Clear the transcript, for example when a new pi process starts a new session. */
	reset(): void {
		this.state = reduceChat(this.state, { type: "session_reset" });
		this.post({ type: "reset", state: this.state });
	}

	/** Replace the transcript with a session's message history. */
	load(messages: AgentMessage[]): void {
		this.state = reduceChat(this.state, { type: "load_messages", messages });
		this.post({ type: "reset", state: this.state });
	}

	setInput(text: string): void {
		this.post({ type: "setInput", text });
	}

	setMeta(meta: PanelMeta): void {
		this.meta = meta;
		this.post({ type: "meta", meta });
	}

	openMenu(menu: PanelMenu): void {
		this.post({ type: "openMenu", menu });
	}

	/** Attachments waiting in the composer. */
	draft(): Attachment[] {
		return this.state.draft;
	}

	dispatch(action: ChatAction): void {
		const prev = this.state;
		this.state = reduceChat(prev, action);
		if (this.state !== prev) this.post(diffChat(prev, this.state));
	}

	private post(message: HostMessage): void {
		void this.view?.webview.postMessage(message);
	}
}

function renderHtml(webview: vscode.Webview, assets: vscode.Uri): string {
	const nonce = randomBytes(16).toString("base64");
	const script = webview.asWebviewUri(vscode.Uri.joinPath(assets, "main.js"));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(assets, "style.css"));
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
</head>
<body>
	<header id="header">
		<div id="tabs" class="tabs" role="tablist"></div>
		<input id="rename" class="rename" hidden placeholder="Session name">
		<div class="header-actions">
			<button type="button" id="new-session" class="icon-button" title="New session">${ICONS.plus}</button>
			<button type="button" id="history" class="icon-button" title="Sessions" data-menu-trigger>${ICONS.history}</button>
		</div>
	</header>
	<div id="header-menu" class="menu"></div>
	<main id="transcript"></main>
	<div id="status"></div>
	<div class="composer-wrap">
		<div id="composer-menu" class="menu"></div>
		<div id="effort" class="menu effort" hidden>
			<div class="effort-head">
				<span class="effort-side"></span>
				<button type="button" id="effort-title" class="effort-title" title="Choose model"><span id="effort-level"></span>${ICONS.chevronRight}</button>
				<button type="button" id="effort-reset" class="icon-button effort-side" title="Reset thinking level">${ICONS.reset}</button>
			</div>
			<div id="effort-model" class="effort-model"></div>
			<div id="effort-slider" class="effort-slider">
				<div id="effort-dots" class="effort-dots"></div>
				<input id="effort-range" type="range" min="0" max="0" step="1" aria-label="Thinking level">
			</div>
			<div id="effort-none" class="effort-none" hidden>This model has no thinking levels.</div>
		</div>
		<form id="composer">
			<div id="draft" hidden></div>
			<textarea id="input" rows="2" placeholder="Ask pi anything. / for commands, @ for files"></textarea>
			<div class="toolbar">
				<button type="button" id="attach" class="icon-button" title="Add context" data-menu-trigger>${ICONS.plus}</button>
				<span class="spacer"></span>
				<button type="button" id="model" class="chip-button" title="Model and thinking level" data-menu-trigger>
					${ICONS.brain}<span id="model-label">Model</span>
				</button>
				<button type="submit" id="send" class="round-button" title="Send (Enter)" disabled>${ICONS.arrowUp}${ICONS.stop}</button>
			</div>
		</form>
	</div>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

/** Inline SVG icons (static markup, drawn with currentColor). */
const ICONS = {
	plus: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>',
	history:
		'<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3l2 1.5" /></svg>',
	chevron: '<svg class="icon small" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5" /></svg>',
	chevronRight:
		'<svg class="icon small" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 4.5 10 8l-3.5 3.5" /></svg>',
	reset: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5" /></svg>',
	brain: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5a2 2 0 0 0-2 2 2 2 0 0 0-1.5 3.2A2 2 0 0 0 4 11a2 2 0 0 0 2 2.5V2.5ZM10 2.5a2 2 0 0 1 2 2 2 2 0 0 1 1.5 3.2A2 2 0 0 1 12 11a2 2 0 0 1-2 2.5V2.5ZM6 13.5h4M6 2.5h4" /></svg>',
	arrowUp: '<svg class="icon send-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4" /></svg>',
	stop: '<svg class="icon stop-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1" /></svg>',
};
