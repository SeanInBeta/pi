import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../coding-agent/src/modes/json-event.ts";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { type ChatAction, createChatState, diffChat, reduceChat } from "../src/chat-state.ts";
import type { ChatItem, ChatState } from "../src/chat-types.ts";

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_toolCallId, params) => {
		const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
		return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
	},
};

/** Replay events the way the extension does: reduce, diff, and apply each diff to a webview-side copy. */
function replay(actions: ChatAction[]): { state: ChatState; webviewItems: ChatItem[]; updates: number } {
	let state = createChatState();
	let webviewItems: ChatItem[] = [];
	let updates = 0;
	for (const action of actions) {
		const next = reduceChat(state, action);
		if (next === state) continue;
		const message = diffChat(state, next);
		if (message.type === "update") {
			webviewItems = webviewItems.slice(0, message.length);
			for (const { index, item } of message.changed) webviewItems[index] = item;
		}
		state = next;
		updates++;
	}
	return { state, webviewItems, updates };
}

function sessionActions(harness: Harness): ChatAction[] {
	return harness.events.map((event) => toJsonEvent(event));
}

describe("chat state", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("builds a transcript from a streamed tool turn", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxThinking("Plan the call"), fauxText("Calling echo"), fauxToolCall("echo", { text: "hi" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("Done"),
		]);

		await harness.session.prompt("say hi");

		expect(harness.eventsOfType("message_update").length).toBeGreaterThan(0);
		const { state, webviewItems } = replay(sessionActions(harness));
		const [user, toolTurn, finalTurn, ...rest] = state.items;
		expect(rest).toEqual([]);
		expect(user).toEqual({ kind: "user", text: "say hi" });
		expect(toolTurn).toMatchObject({
			kind: "assistant",
			streaming: false,
			blocks: [
				{ type: "thinking", text: "Plan the call" },
				{ type: "text", text: "Calling echo" },
				{ type: "toolCall", name: "echo", args: '{"text":"hi"}' },
			],
		});
		expect(Object.values(toolTurn?.kind === "assistant" ? toolTurn.tools : {})).toEqual([
			{ status: "done", output: "echo:hi" },
		]);
		expect(finalTurn).toMatchObject({ kind: "assistant", blocks: [{ type: "text", text: "Done" }] });
		expect(webviewItems).toEqual(state.items);
	});

	it("tracks running state and shows assistant errors", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.prompt("hello").catch(() => undefined);

		const actions = sessionActions(harness);
		const started = replay(actions.slice(0, actions.findIndex((action) => action.type === "agent_start") + 1));
		expect(started.state.running).toBe(true);
		const { state } = replay(actions);
		expect(state.running).toBe(false);
		expect(state.items.at(-1)).toMatchObject({ kind: "assistant", error: "invalid_api_key" });
	});

	it("appends extension errors and skips updates for ignored events", () => {
		const { state, updates } = replay([
			{ type: "ui_error", message: "No API key found" },
			{ type: "session_info_changed", name: "ignored" },
		]);
		expect(state.items).toEqual([{ kind: "error", text: "No API key found" }]);
		expect(updates).toBe(1);
	});
});
