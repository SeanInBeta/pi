/**
 * Chat transcript data and webview messages. Shared by the extension host and the webview,
 * so this file must stay free of imports.
 */

export type AssistantBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	/** `args` is the raw argument JSON, which is partial while the call streams. */
	| { type: "toolCall"; id: string; name: string; args: string };

export interface ToolRun {
	status: "running" | "done" | "error";
	output: string;
	/** A file change of this call waiting for Accept or Reject. */
	review?: PendingReview;
}

export interface PendingReview {
	id: string;
	tool: "edit" | "write" | "bash" | "powershell";
	/** Workspace-relative path of the file, or for a command why it needs review ("deletes files (rm)"). */
	label: string;
}

/** Editor context attached to a message. `content` is exactly what the prompt includes. */
export interface Attachment {
	id: string;
	kind: "selection" | "file" | "diagnostics";
	/** Short chip label, for example `src/a.ts:10-20`. */
	label: string;
	/** Workspace-relative path, or absolute for files outside the workspace. */
	path: string;
	/** 1-based inclusive line range of a selection. */
	lines?: { start: number; end: number };
	/** Editor language id, used as the code fence language. */
	language?: string;
	content: string;
	/** Caveat shown to the user and the model, for example unsaved changes. */
	note?: string;
}

/** A prompt sent with attachments, remembered until pi echoes it back as a user message. */
export interface SentPrompt {
	prompt: string;
	text: string;
	attachments: Attachment[];
}

export type ChatItem =
	| { kind: "user"; text: string; attachments?: Attachment[] }
	| {
			kind: "assistant";
			/** Indexed by provider content index; gaps are null. */
			blocks: (AssistantBlock | null)[];
			/** Tool execution state keyed by tool call id. */
			tools: Record<string, ToolRun>;
			streaming: boolean;
			error?: string;
			/** Last assistant message of a finished run: shows the done marker and copy button. */
			done?: boolean;
	  }
	| { kind: "error"; text: string };

export interface ChatState {
	items: ChatItem[];
	running: boolean;
	/** Transient activity such as a retry or compaction. */
	status?: string;
	/** Number of queued steering and follow-up messages. */
	queued: number;
	/** Attachments waiting in the composer for the next message. */
	draft: Attachment[];
	sent: SentPrompt[];
}

/** One entry of an in-panel menu: sessions, models, commands, files. */
export interface MenuItem {
	label: string;
	description?: string;
	detail?: string;
	/** Opaque value sent back when the item is chosen. */
	value: string;
	current?: boolean;
}

/** `providers` lists model providers; its text filters: `oauth`, `api_key`, `stored` (credentials pi saved, which sign-out can remove), or empty for all. */
export type MenuQuery = "sessions" | "models" | "forks" | "commands" | "files" | "providers";

/** Menus the host can open in the panel, for palette commands and the status bar. */
export type PanelMenu = "sessions" | "models" | "thinking" | "forks" | "rename" | "settings" | "providers";

/** Actions the panel asks the host to perform. `arg` is the chosen menu value or typed argument. */
export type PanelCommand =
	| "newTab"
	| "closeTab"
	| "deleteSession"
	| "switchTab"
	| "setApprovalMode"
	| "newSession"
	| "openSession"
	| "fork"
	| "clone"
	| "rename"
	| "setModel"
	| "setThinking"
	| "compact"
	| "copyLast"
	| "attachSelection"
	| "attachFile"
	| "attachProblems"
	| "openFolder"
	| "retryStart"
	/** `arg`: {@link LoginRequest} as JSON. */
	| "login"
	| "cancelLogin"
	/** Answer the sign-in card's code prompt; `arg`: the pasted code or redirect URL. */
	| "loginCode"
	| "openLoginUrl"
	/** `arg`: provider id. */
	| "logout"
	| "openSettings"
	| "openPiSettings"
	| "openModelsFile"
	| "showLog";

/** A provider in the providers menu; the menu item's value is this object as JSON. */
export interface ProviderChoice {
	id: string;
	name: string;
	/** Label of the account sign-in, when the provider supports it. */
	oauth?: string;
	apiKey: boolean;
	configured: boolean;
}

export interface LoginRequest {
	provider: string;
	name: string;
	method: "oauth" | "api_key";
}

/**
 * Shown in place of the chat until resolved: no folder is open, pi cannot start, no model is configured,
 * or a sign-in is running.
 */
export type SetupState =
	| { kind: "noFolder" }
	| { kind: "startFailed"; message: string /** The failure is a missing or too old Node.js. */; node: boolean }
	| { kind: "noModel" }
	| {
			kind: "login";
			name: string;
			method: "oauth" | "api_key";
			message: string;
			/** Sign-in page to open in the browser. */
			url?: string;
			/** Device code to enter on the sign-in page. */
			code?: string;
			/**
			 * pi waits for a pasted code or redirect URL, alongside the browser callback. Asked in the card:
			 * an input box would close when VS Code confirms opening the browser.
			 */
			prompt?: { message: string; placeholder?: string };
	  };

/** A chat tab in the panel header. Every tab runs its own pi process. */
export interface SessionTab {
	id: string;
	title: string;
	active: boolean;
	/** Dot color: pulsing while working, green when finished, red when it needs attention or failed. */
	state: TabState;
}

export type TabState = "idle" | "running" | "done" | "attention";

/** "ask": every edit and write waits for Accept in the diff editor. "auto": they are applied directly. */
export type ApprovalMode = "ask" | "auto";

/** Session and model state shown in the panel header and composer. */
export interface PanelMeta {
	started: boolean;
	sessionName?: string;
	tabs: SessionTab[];
	approvalMode: ApprovalMode;
	/** Thinking level when pi started, the target of the reset button. */
	defaultThinkingLevel?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	/** Levels the current model supports. */
	thinkingLevels: string[];
	setup?: SetupState;
}

/** Host to webview. `update` carries only items whose identity changed since the last message. */
export type HostMessage =
	| { type: "reset"; state: ChatState }
	/** Replace the composer text, for example with the message a fork started from. */
	| { type: "setInput"; text: string }
	| { type: "meta"; meta: PanelMeta }
	| { type: "queryResult"; id: number; items: MenuItem[] }
	| { type: "openMenu"; menu: PanelMenu }
	| {
			type: "update";
			length: number;
			changed: { index: number; item: ChatItem }[];
			running: boolean;
			status?: string;
			queued: number;
			draft: Attachment[];
	  };

/** Webview to host. */
export type WebviewMessage =
	| { type: "ready" }
	| { type: "send"; text: string }
	| { type: "abort" }
	| { type: "removeAttachment"; id: string }
	| { type: "query"; id: number; query: MenuQuery; text?: string }
	| { type: "command"; command: PanelCommand; arg?: string }
	| { type: "copyText"; text: string }
	| { type: "review"; id: string; choice: "Accept" | "Reject" };
