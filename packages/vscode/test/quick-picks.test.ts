import { describe, expect, it } from "vitest";
import { forkItems, modelItems, sessionItems, thinkingLevelItems } from "../src/quick-picks.ts";

describe("quick picks", () => {
	it("lists sessions newest first and marks the current one", () => {
		const base = { id: "x", cwd: "/w", created: "2026-01-01T00:00:00.000Z", messageCount: 2 };
		const items = sessionItems(
			[
				{
					...base,
					path: "/s/old.jsonl",
					modified: "2026-01-01T10:00:00.000Z",
					firstMessage: "\nfirst question\nmore",
				},
				{
					...base,
					path: "/s/new.jsonl",
					name: "Named",
					modified: "2026-01-02T10:00:00.000Z",
					firstMessage: "hello",
				},
				{ ...base, path: "/s/empty.jsonl", modified: "2025-12-31T10:00:00.000Z", firstMessage: "" },
			],
			"/s/old.jsonl",
		);
		expect(items.map((item) => [item.label, item.detail, item.value])).toEqual([
			["Named", "hello", "/s/new.jsonl"],
			["$(check) first question", undefined, "/s/old.jsonl"],
			["(no messages)", undefined, "/s/empty.jsonl"],
		]);
		expect(items[0]?.description).toMatch(/^2 messages · /);
	});

	it("puts the current model first", () => {
		const items = modelItems(
			[
				{ provider: "a", id: "m1", contextWindow: 200_000, reasoning: true },
				{ provider: "b", id: "m2", contextWindow: 128_000, reasoning: false },
			],
			{ provider: "b", id: "m2" },
		);
		expect(items).toEqual([
			{ label: "$(check) m2", description: "b", detail: "128k context", value: { provider: "b", id: "m2" } },
			{ label: "m1", description: "a", detail: "200k context · reasoning", value: { provider: "a", id: "m1" } },
		]);
	});

	it("marks the current thinking level and lists fork points newest first", () => {
		expect(thinkingLevelItems(["off", "low", "high"], "low").map((item) => item.label)).toEqual([
			"off",
			"$(check) low",
			"high",
		]);
		expect(
			forkItems([
				{ entryId: "e1", text: "first" },
				{ entryId: "e2", text: "second\nwith details" },
			]),
		).toEqual([
			{ label: "second", detail: "with details", value: "e2" },
			{ label: "first", detail: undefined, value: "e1" },
		]);
	});
});
