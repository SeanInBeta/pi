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

export type ChatItem =
	| { kind: "user"; text: string }
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
	  };

/** Webview to host. */
export type WebviewMessage = { type: "ready" } | { type: "send"; text: string } | { type: "abort" };
