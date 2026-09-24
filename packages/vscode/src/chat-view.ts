import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { type AgentMessage, type ChatAction, createChatState, diffChat, reduceChat } from "./chat-state.ts";
import type { Attachment, HostMessage, WebviewMessage } from "./chat-types.ts";

export interface ChatViewHandlers {
	/** Send the typed text together with the composer draft. */
	submit(text: string): Promise<void>;
	abort(): Promise<void>;
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
	private description: string | undefined;

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
			} else if (message.type === "send") {
				void this.handlers.submit(message.text);
			} else if (message.type === "abort") {
				void this.handlers.abort();
			} else if (message.type === "removeAttachment") {
				this.dispatch({ type: "draft_remove", ids: [message.id] });
			}
		});
		view.description = this.description;
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

	/** Text next to the view title, used for the session name. */
	setDescription(description: string | undefined): void {
		this.description = description;
		if (this.view) this.view.description = description;
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
	<main id="transcript"></main>
	<div id="status"></div>
	<form id="composer">
		<div id="draft" hidden></div>
		<textarea id="input" rows="3" placeholder="Ask pi (Enter to send, Shift+Enter for a new line)"></textarea>
		<div class="actions">
			<button type="button" id="abort" class="secondary" hidden>Abort</button>
			<button type="submit" id="send">Send</button>
		</div>
	</form>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
