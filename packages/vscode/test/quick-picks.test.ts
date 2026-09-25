import { describe, expect, it } from "vitest";
import {
	commandItems,
	fileItems,
	forkItems,
	modelItems,
	providerItems,
	sessionItems,
	thinkingLevelItems,
} from "../src/quick-picks.ts";

describe("menu items", () => {
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
		expect(items.map((item) => [item.label, item.value, item.current])).toEqual([
			["Named", "/s/new.jsonl", false],
			["first question", "/s/old.jsonl", true],
			["(no messages)", "/s/empty.jsonl", false],
		]);
		expect(items[0]?.detail).toMatch(/^2 messages · /);
	});

	it("puts the current model first and encodes provider and id", () => {
		const items = modelItems(
			[
				{ provider: "a", id: "m1", contextWindow: 200_000, reasoning: true },
				{ provider: "b", id: "org/m2", contextWindow: 128_000, reasoning: false },
			],
			{ provider: "b", id: "org/m2" },
		);
		expect(items).toEqual([
			{
				label: "org/m2",
				description: "b",
				detail: "128k context",
				value: '{"provider":"b","id":"org/m2"}',
				current: true,
			},
			{
				label: "m1",
				description: "a",
				detail: "200k context · reasoning",
				value: '{"provider":"a","id":"m1"}',
				current: false,
			},
		]);
	});

	it("marks the current thinking level and lists fork points newest first", () => {
		expect(thinkingLevelItems(["off", "low"], "low").map((item) => item.current)).toEqual([false, true]);
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

	it("lists pi commands by name", () => {
		const sourceInfo = { path: "/x", source: "local", scope: "project", origin: "top-level" } as const;
		expect(commandItems([{ name: "review", description: "Review code", source: "prompt", sourceInfo }])).toEqual([
			{ label: "/review", description: "Review code", detail: "prompt", value: "review" },
		]);
	});

	it("fuzzy-matches files for @ mentions", () => {
		const paths = ["README.md", "src/chat/view.ts", "src/extension.ts", "test/extension.test.ts"];
		expect(fileItems(paths, "").map((item) => item.value)).toEqual([
			"README.md",
			"src/chat/view.ts",
			"src/extension.ts",
			"test/extension.test.ts",
		]);
		expect(fileItems(paths, "ext")[0]).toEqual({
			label: "extension.ts",
			description: "src",
			value: "src/extension.ts",
		});
		expect(fileItems(paths, "zzz")).toEqual([]);
	});

	it("lists providers for a login method, configured ones first", () => {
		const providers = [
			{
				id: "anthropic",
				name: "Anthropic",
				oauth: { label: "Sign in to Anthropic" },
				apiKey: true,
				configured: false,
			},
			{ id: "bedrock", name: "Amazon Bedrock", apiKey: false, configured: false },
			{ id: "openai", name: "OpenAI", apiKey: true, configured: true, source: "OPENAI_API_KEY" },
		];

		const apiKey = providerItems(providers, "api_key");
		expect(apiKey.map((item) => item.label)).toEqual(["OpenAI", "Anthropic"]);
		expect(apiKey[0]).toMatchObject({ description: "Configured (OPENAI_API_KEY)", current: true });
		expect(providerItems(providers, "oauth").map((item) => item.label)).toEqual(["Anthropic"]);

		const all = providerItems(providers, undefined);
		expect(all.map((item) => item.label)).toEqual(["OpenAI", "Anthropic"]);
		expect(all[1]?.detail).toBe("Sign in with account or API key");
		expect(JSON.parse(all[1]!.value)).toEqual({
			id: "anthropic",
			name: "Anthropic",
			oauth: "Sign in to Anthropic",
			apiKey: true,
			configured: false,
		});
	});
});
