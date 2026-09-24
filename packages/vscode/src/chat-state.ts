import type { JsonAgentSessionEvent } from "../../coding-agent/src/modes/json-event.ts";
import type {
	AssistantBlock,
	Attachment,
	ChatItem,
	ChatState,
	HostMessage,
	SentPrompt,
	ToolRun,
} from "./chat-types.ts";

/** A pi RPC event, or an action raised by the extension itself. */
export type ChatAction =
	| JsonAgentSessionEvent
	/** An error outside pi's event stream, for example a rejected prompt. */
	| { type: "ui_error"; message: string }
	/** Transient status from the extension, for example a pending change review. */
	| { type: "ui_status"; status: string | undefined }
	/** A new pi session started. The transcript clears; the composer draft survives. */
	| { type: "session_reset" }
	| { type: "draft_add"; attachments: Attachment[] }
	| { type: "draft_remove"; ids: string[] }
	| ({ type: "prompt_sent" } & SentPrompt)
	/** Replace the transcript with a session's message history, for example after switching sessions. */
	| { type: "load_messages"; messages: AgentMessage[] };

export type AgentMessage = Extract<JsonAgentSessionEvent, { type: "message_start" }>["message"];
type AssistantMessageEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];
type AssistantItem = Extract<ChatItem, { kind: "assistant" }>;

export function createChatState(): ChatState {
	return { items: [], running: false, queued: 0, draft: [], sent: [] };
}

/** Fold one action into the transcript. Unchanged items keep their identity so diffChat() can skip them. */
export function reduceChat(state: ChatState, action: ChatAction): ChatState {
	switch (action.type) {
		case "ui_error":
			return appendItem(state, { kind: "error", text: action.message });
		case "ui_status":
			return { ...state, status: action.status };
		case "session_reset":
			return { ...createChatState(), draft: state.draft, sent: state.sent };
		case "draft_add":
			return { ...state, draft: [...state.draft, ...action.attachments] };
		case "draft_remove":
			return { ...state, draft: state.draft.filter((attachment) => !action.ids.includes(attachment.id)) };
		case "load_messages":
			return action.messages.reduce(loadMessage, { ...createChatState(), draft: state.draft, sent: state.sent });
		case "prompt_sent":
			return {
				...state,
				sent: [...state.sent, { prompt: action.prompt, text: action.text, attachments: action.attachments }],
			};
		case "agent_start":
			return { ...state, running: true };
		case "agent_settled":
			return state.running || state.status ? { ...state, running: false, status: undefined } : state;
		case "queue_update":
			return { ...state, queued: action.steering.length + action.followUp.length };
		case "message_start":
			return startMessage(state, action.message);
		case "message_update":
			return updateLastAssistant(state, (item) => applyAssistantEvent(item, action.assistantMessageEvent));
		case "message_end": {
			const message = action.message;
			if (message.role !== "assistant") return state;
			return updateLastAssistant(state, (item) => ({
				...item,
				blocks: message.content.map(toBlock),
				streaming: false,
				error: assistantError(message),
			}));
		}
		case "tool_execution_start":
			return updateTool(state, action.toolCallId, { status: "running", output: "" });
		case "tool_execution_update":
			return updateTool(state, action.toolCallId, {
				status: "running",
				output: toolResultText(action.partialResult),
			});
		case "tool_execution_end":
			return updateTool(state, action.toolCallId, {
				status: action.isError ? "error" : "done",
				output: toolResultText(action.result),
			});
		case "auto_retry_start":
			return {
				...state,
				status: `Retrying (${action.attempt}/${action.maxAttempts}): ${action.errorMessage}`,
			};
		case "auto_retry_end": {
			const next = { ...state, status: undefined };
			return action.success || !action.finalError
				? next
				: appendItem(next, { kind: "error", text: action.finalError });
		}
		case "compaction_start":
			return { ...state, status: "Compacting context" };
		case "compaction_end": {
			const next = { ...state, status: undefined };
			return action.errorMessage ? appendItem(next, { kind: "error", text: action.errorMessage }) : next;
		}
		default:
			return state;
	}
}

/** Describe the change from `prev` to `next` as a webview update with only the replaced items. */
export function diffChat(prev: ChatState, next: ChatState): HostMessage {
	const changed: { index: number; item: ChatItem }[] = [];
	next.items.forEach((item, index) => {
		if (prev.items[index] !== item) changed.push({ index, item });
	});
	return {
		type: "update",
		length: next.items.length,
		changed,
		running: next.running,
		status: next.status,
		queued: next.queued,
		draft: next.draft,
	};
}

function appendItem(state: ChatState, item: ChatItem): ChatState {
	return { ...state, items: [...state.items, item] };
}

function startMessage(state: ChatState, message: AgentMessage): ChatState {
	if (message.role === "user") {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
		// A prompt built with attachments comes back as one text; show the typed text and the attachments instead.
		const sentIndex = state.sent.findIndex((sent) => sent.prompt === text);
		if (sentIndex === -1) return appendItem(state, { kind: "user", text });
		const sent = state.sent[sentIndex]!;
		return appendItem(
			{ ...state, sent: state.sent.filter((_, index) => index !== sentIndex) },
			{ kind: "user", text: sent.text, attachments: sent.attachments },
		);
	}
	if (message.role === "assistant") {
		return appendItem(state, {
			kind: "assistant",
			blocks: message.content.map(toBlock),
			tools: {},
			streaming: true,
		});
	}
	// Tool results arrive through tool_execution_* events; system and custom messages are not shown yet.
	return state;
}

function loadMessage(state: ChatState, message: AgentMessage): ChatState {
	if (message.role === "assistant") {
		return appendItem(state, {
			kind: "assistant",
			blocks: message.content.map(toBlock),
			tools: {},
			streaming: false,
			error: assistantError(message),
		});
	}
	if (message.role === "toolResult") {
		return updateTool(state, message.toolCallId, {
			status: message.isError ? "error" : "done",
			output: toolResultText(message),
		});
	}
	return startMessage(state, message);
}

function updateLastAssistant(state: ChatState, update: (item: AssistantItem) => AssistantItem): ChatState {
	const index = state.items.length - 1;
	const item = state.items[index];
	if (item?.kind !== "assistant") return state;
	const next = update(item);
	if (next === item) return state;
	const items = state.items.slice();
	items[index] = next;
	return { ...state, items };
}

function updateTool(state: ChatState, toolCallId: string, run: ToolRun): ChatState {
	for (let index = state.items.length - 1; index >= 0; index--) {
		const item = state.items[index]!;
		if (item.kind !== "assistant") continue;
		if (!item.blocks.some((block) => block?.type === "toolCall" && block.id === toolCallId)) continue;
		const items = state.items.slice();
		items[index] = { ...item, tools: { ...item.tools, [toolCallId]: run } };
		return { ...state, items };
	}
	return state;
}

function applyAssistantEvent(item: AssistantItem, event: AssistantMessageEvent): AssistantItem {
	switch (event.type) {
		case "text_start":
			return setBlock(item, event.contentIndex, { type: "text", text: "" });
		case "text_end":
			return setBlock(item, event.contentIndex, { type: "text", text: event.content });
		case "thinking_start":
			return setBlock(item, event.contentIndex, { type: "thinking", text: "" });
		case "thinking_end":
			return setBlock(item, event.contentIndex, { type: "thinking", text: event.content });
		case "text_delta":
		case "thinking_delta": {
			const block = item.blocks[event.contentIndex];
			if (block?.type !== "text" && block?.type !== "thinking") return item;
			return setBlock(item, event.contentIndex, { ...block, text: block.text + event.delta });
		}
		case "toolcall_start":
			return setBlock(item, event.contentIndex, { type: "toolCall", id: event.id, name: event.toolName, args: "" });
		case "toolcall_delta": {
			const block = item.blocks[event.contentIndex];
			if (block?.type !== "toolCall") return item;
			return setBlock(item, event.contentIndex, { ...block, args: block.args + event.delta });
		}
		case "toolcall_end":
			return setBlock(item, event.contentIndex, toBlock(event.toolCall));
		default:
			// start, done and error are covered by message_start and message_end.
			return item;
	}
}

function setBlock(item: AssistantItem, index: number, block: AssistantBlock): AssistantItem {
	const blocks = item.blocks.slice();
	while (blocks.length < index) blocks.push(null);
	blocks[index] = block;
	return { ...item, blocks };
}

function toBlock(content: Extract<AgentMessage, { role: "assistant" }>["content"][number]): AssistantBlock {
	switch (content.type) {
		case "text":
			return { type: "text", text: content.text };
		case "thinking":
			return { type: "thinking", text: content.thinking };
		case "toolCall":
			return { type: "toolCall", id: content.id, name: content.name, args: JSON.stringify(content.arguments) };
	}
}

function assistantError(message: Extract<AgentMessage, { role: "assistant" }>): string | undefined {
	if (message.stopReason === "error") return message.errorMessage ?? "Request failed";
	if (message.stopReason === "aborted") return "Aborted";
	return undefined;
}

/** Flatten a tool result ({ content: [...] }) to display text. */
function toolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result && typeof result === "object" && "content" in result && Array.isArray(result.content)) {
		return result.content
			.map((part: unknown) => {
				if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
				return "[image]";
			})
			.join("\n");
	}
	return result === undefined ? "" : JSON.stringify(result);
}
