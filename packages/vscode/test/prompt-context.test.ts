import { describe, expect, it } from "vitest";
import type { Attachment } from "../src/chat-types.ts";
import { buildPrompt, formatProblems } from "../src/prompt-context.ts";

const selection: Attachment = {
	id: "a1",
	kind: "selection",
	label: "src/a.ts:2-3",
	path: "src/a.ts",
	lines: { start: 2, end: 3 },
	language: "typescript",
	content: "const a = 1;\nconst b = 2;",
};

describe("buildPrompt", () => {
	it("returns the text unchanged without attachments", () => {
		expect(buildPrompt("hello", [])).toBe("hello");
	});

	it("puts labeled context blocks before the message", () => {
		const file: Attachment = {
			id: "a2",
			kind: "file",
			label: "README.md",
			path: "README.md",
			language: "markdown",
			content: "# Title\n",
			note: "unsaved changes",
		};
		expect(buildPrompt("Explain this", [selection, file])).toBe(
			[
				"Selected code from src/a.ts lines 2-3:",
				"```typescript",
				"const a = 1;",
				"const b = 2;",
				"```",
				"",
				"File README.md (unsaved changes):",
				"```markdown",
				"# Title",
				"```",
				"",
				"Explain this",
			].join("\n"),
		);
	});

	it("uses a longer fence when the content contains backticks", () => {
		const prompt = buildPrompt("", [{ ...selection, content: "```js\nx\n```" }]);
		expect(prompt).toBe("Selected code from src/a.ts lines 2-3:\n````typescript\n```js\nx\n```\n````");
	});

	it("formats diagnostics as a problem list", () => {
		const content = formatProblems("src/a.ts", [
			{
				line: 1,
				column: 7,
				severity: "error",
				source: "ts",
				code: "2322",
				message: "Type 'string' is not assignable to type 'number'.",
				lineText: 'const x: number = "oops";',
			},
			{ line: 4, column: 1, severity: "warning", message: "Unused variable" },
		]);
		expect(
			buildPrompt("Fix these", [{ id: "d", kind: "diagnostics", label: "Problems", path: "src/a.ts", content }]),
		).toBe(
			[
				"Problems reported by VS Code in src/a.ts:",
				"- src/a.ts:1:7 error [ts 2322]: Type 'string' is not assignable to type 'number'.",
				'  | const x: number = "oops";',
				"- src/a.ts:4:1 warning: Unused variable",
				"",
				"Fix these",
			].join("\n"),
		);
	});
});
