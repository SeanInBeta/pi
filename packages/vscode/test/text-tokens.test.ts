import { describe, expect, it } from "vitest";
import { splitTokens, tokenEndingAt } from "../src/text-tokens.ts";

const rules = { isCommand: (name: string) => name === "model" || name === "review" };

describe("splitTokens", () => {
	it("marks @mentions, skills and known commands", () => {
		expect(splitTokens("@天气.txt what is /skill:awe-review and /review now", rules)).toEqual([
			{ text: "@天气.txt", kind: "mention" },
			{ text: " what is " },
			{ text: "/skill:awe-review", kind: "command" },
			{ text: " and " },
			{ text: "/review", kind: "command" },
			{ text: " now" },
		]);
	});

	it("leaves paths, e-mail addresses and unknown commands plain", () => {
		expect(splitTokens("see /usr/bin and me@example.com /nope", rules)).toEqual([
			{ text: "see /usr/bin and me@example.com /nope" },
		]);
	});

	it("ends a known path or command where text was typed right after it", () => {
		const withFiles = { ...rules, isMention: (path: string) => path === "1.txt" };
		expect(splitTokens("文件 @1.txt改成天气 /review请看", withFiles)).toEqual([
			{ text: "文件 " },
			{ text: "@1.txt", kind: "mention" },
			{ text: "改成天气 " },
			{ text: "/review", kind: "command" },
			{ text: "请看" },
		]);
		// A longer name is a different token, not a known one with a suffix.
		expect(splitTokens("@1.txtx /reviewer", withFiles)).toEqual([
			{ text: "@1.txtx", kind: "mention" },
			{ text: " /reviewer" },
		]);
	});
});

describe("tokenEndingAt", () => {
	const text = "see @src/a.ts and /skill:x /review /usr/bin";

	it("finds the token that ends at the offset", () => {
		expect(tokenEndingAt(text, 13, rules)).toEqual({ start: 4, end: 13 });
		expect(tokenEndingAt(text, 26, rules)).toEqual({ start: 18, end: 26 });
		expect(tokenEndingAt(text, 34, rules)).toEqual({ start: 27, end: 34 });
	});

	it("ignores offsets inside or after a token and plain paths", () => {
		expect(tokenEndingAt(text, 12, rules)).toBeUndefined();
		expect(tokenEndingAt(text, 14, rules)).toBeUndefined();
		expect(tokenEndingAt(text, text.length, rules)).toBeUndefined();
		expect(tokenEndingAt("", 0, rules)).toBeUndefined();
	});

	it("finds a known path followed directly by text", () => {
		const withFiles = { ...rules, isMention: (path: string) => path === "1.txt" };
		expect(tokenEndingAt("文件 @1.txt改成天气", 9, withFiles)).toEqual({ start: 3, end: 9 });
	});
});
