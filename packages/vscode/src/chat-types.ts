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

/** Host to webview. `update` carries only items whose identity changed since the last message. */
export type HostMessage =
	| { type: "reset"; state: ChatState }
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
	| { type: "removeAttachment"; id: string };
