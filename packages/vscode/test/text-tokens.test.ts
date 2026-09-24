import { describe, expect, it } from "vitest";
import { splitTokens } from "../src/text-tokens.ts";

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
