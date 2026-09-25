import { describe, expect, it } from "vitest";
import { splitTokens, tokenEndingAt } from "../src/text-tokens.ts";

const known = (name: string) => name === "model" || name === "review";

describe("splitTokens", () => {
	it("marks @mentions, skills and known commands", () => {
		expect(splitTokens("@天气.txt what is /skill:awe-review and /review now", known)).toEqual([
			{ text: "@天气.txt", kind: "mention" },
			{ text: " what is " },
			{ text: "/skill:awe-review", kind: "command" },
			{ text: " and " },
			{ text: "/review", kind: "command" },
			{ text: " now" },
		]);
	});

	it("leaves paths, e-mail addresses and unknown commands plain", () => {
		expect(splitTokens("see /usr/bin and me@example.com /nope", known)).toEqual([
			{ text: "see /usr/bin and me@example.com /nope" },
		]);
	});
});

describe("tokenEndingAt", () => {
	const known = (name: string) => name === "review";
	const text = "see @src/a.ts and /skill:x /review /usr/bin";

	it("finds the token that ends at the offset", () => {
		expect(tokenEndingAt(text, 13, known)).toEqual({ start: 4, end: 13 });
		expect(tokenEndingAt(text, 26, known)).toEqual({ start: 18, end: 26 });
		expect(tokenEndingAt(text, 34, known)).toEqual({ start: 27, end: 34 });
	});

	it("ignores offsets inside or after a token and plain paths", () => {
		expect(tokenEndingAt(text, 12, known)).toBeUndefined();
		expect(tokenEndingAt(text, 14, known)).toBeUndefined();
		expect(tokenEndingAt(text, text.length, known)).toBeUndefined();
		expect(tokenEndingAt("", 0, known)).toBeUndefined();
	});
});
