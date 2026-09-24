import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { type ChatAction, createChatState, diffChat, reduceChat } from "./chat-state.ts";
import type { HostMessage, WebviewMessage } from "./chat-types.ts";

export interface ChatViewHandlers {
	send(text: string): Promise<void>;
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
				void this.handlers.send(message.text);
			} else if (message.type === "abort") {
				void this.handlers.abort();
			}
		});
		view.onDidDispose(() => {
			if (this.view === view) this.view = undefined;
		});
		this.view = view;
	}

	/** Clear the transcript, for example when a new pi process starts a new session. */
	reset(): void {
		this.state = createChatState();
		this.post({ type: "reset", state: this.state });
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
