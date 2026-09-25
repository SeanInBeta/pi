import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { createChatState, diffChat } from "./chat-state.ts";
import type {
	ChatState,
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
	removeAttachment(id: string): void;
	/** Items for an in-panel menu. Failures are reported by the handler and yield an empty menu. */
	query(query: MenuQuery, text: string): Promise<MenuItem[]>;
	command(command: PanelCommand, arg: string | undefined): Promise<void>;
	/** The webview loaded (or reloaded). */
	ready(): void;
	/** Accept or Reject clicked under a tool call. */
	review(id: string, choice: "Accept" | "Reject"): void;
}

/**
 * Sidebar chat webview. It shows the active tab's transcript; the last shown state is kept so a
 * webview that VS Code destroys while hidden is rebuilt from a full snapshot when it reports `ready`.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "pi.chat";

	private readonly extensionUri: vscode.Uri;
	private readonly handlers: ChatViewHandlers;
	private state: ChatState = createChatState();
	private view: vscode.WebviewView | undefined;
	private meta: PanelMeta = { started: false, thinkingLevels: [], tabs: [], approvalMode: "ask" };

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
				this.handlers.ready();
			} else if (message.type === "send") {
				void this.handlers.submit(message.text);
			} else if (message.type === "abort") {
				void this.handlers.abort();
			} else if (message.type === "removeAttachment") {
				this.handlers.removeAttachment(message.id);
			} else if (message.type === "query") {
				void this.handlers
					.query(message.query, message.text ?? "")
					.then((items) => this.post({ type: "queryResult", id: message.id, items }));
			} else if (message.type === "command") {
				void this.handlers.command(message.command, message.arg);
			} else if (message.type === "review") {
				this.handlers.review(message.id, message.choice);
			} else if (message.type === "copyText") {
				void vscode.env.clipboard.writeText(message.text);
			}
		});
		view.onDidDispose(() => {
			if (this.view === view) this.view = undefined;
		});
		this.view = view;
	}

	/** Show a transcript from scratch, for example after switching tabs. */
	show(state: ChatState): void {
		this.state = state;
		this.post({ type: "reset", state });
	}

	/** Send only what changed in the shown transcript. */
	update(prev: ChatState, next: ChatState): void {
		this.state = next;
		this.post(diffChat(prev, next));
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
		<div id="tabs" class="tabs" role="tablist" aria-label="Chat tabs"></div>
		<input id="rename" class="rename" hidden placeholder="Session name">
		<div class="header-actions">
			<button type="button" id="new-tab" class="icon-button" title="New chat tab">${ICONS.plus}</button>
			<button type="button" id="history" class="icon-button" title="Sessions" data-menu-trigger>${ICONS.history}</button>
			<button type="button" id="settings" class="icon-button" title="Settings" data-menu-trigger>${ICONS.gear}</button>
		</div>
	</header>
	<div id="tab-scroll" class="tab-scroll" hidden title="Scroll tabs"><div id="tab-scroll-thumb" class="tab-scroll-thumb"></div></div>
	<div id="header-menu" class="menu"></div>
	<section id="setup" class="setup" hidden></section>
	<main id="transcript"></main>
	<div id="status"></div>
	<div class="composer-wrap">
		<div id="composer-menu" class="menu"></div>
		<div id="effort" class="menu effort" hidden>
			<button type="button" id="effort-title" class="effort-title" title="Choose model"><span id="effort-level"></span>${ICONS.chevronRight}</button>
			<div id="effort-model" class="effort-model"></div>
			<div id="effort-slider" class="effort-slider">
				<div id="effort-dots" class="effort-dots"></div>
				<input id="effort-range" type="range" min="0" max="0" step="1" aria-label="Thinking level">
			</div>
			<div id="effort-none" class="effort-none" hidden>This model has no thinking levels.</div>
		</div>
		<form id="composer">
			<div id="draft" hidden></div>
			<div class="input-wrap">
				<div id="input-highlight" aria-hidden="true"></div>
				<textarea id="input" rows="2" placeholder="Ask pi anything. / for commands, @ for files"></textarea>
			</div>
			<div class="toolbar">
				<button type="button" id="attach" class="icon-button" title="Add context" data-menu-trigger>${ICONS.plus}</button>
				<button type="button" id="approval" class="chip-button" title="When pi may change files" data-menu-trigger>
					<span id="approval-label">Ask for approval</span>${ICONS.chevron}
				</button>
				<span class="spacer"></span>
				<button type="button" id="model" class="chip-button" title="Model and thinking level" data-menu-trigger>
					<span id="model-label">Model</span>
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
	gear: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M12.51 6.09 14.44 6.56v2.88l-1.93.47.03-.07 1.03 1.7-2.03 2.03-1.7-1.03.07-.03-.47 1.93H6.56l-.47-1.93.07.03-1.7 1.03-2.03-2.03 1.03-1.7.03.07-1.93-.47V6.56l1.93-.47-.03.07-1.03-1.7 2.03-2.03 1.7 1.03-.07.03.47-1.93h2.88l.47 1.93-.07-.03 1.7-1.03 2.03 2.03-1.03 1.7Z" /><circle cx="8" cy="8" r="2" /></svg>',
	chevron: '<svg class="icon small" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5" /></svg>',
	chevronRight:
		'<svg class="icon small" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 4.5 10 8l-3.5 3.5" /></svg>',
	arrowUp: '<svg class="icon send-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4" /></svg>',
	stop: '<svg class="icon stop-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1" /></svg>',
};
