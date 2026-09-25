/**
 * Scripted pi provider for trying the extension without an API key. Load it through `pi.args`:
 * ["--extension", "<repo>/packages/vscode/test/fixtures/smoke-provider.ts", "--provider", "smoke", "--model", "faux-1"]
 *
 * Every user message gets thinking, a text reply listing the attached context blocks, and a `bash ls` tool call.
 */
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../../coding-agent/src/core/extensions/types.ts";

const FINAL_REPLY = [
	"## Result",
	"The command finished. **Smoke test complete.**",
	"",
	"- Markdown *lists* with `inline code`",
	"- A [link](https://example.com)",
	"",
	"```ts",
	"const answer: number = 42;",
	"```",
].join("\n");
const CONTEXT_HEADER = /^(Selected code from|File |Problems reported)/;

const respond: FauxResponseFactory = (context) => {
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") {
		return last.isError
			? fauxAssistantMessage(
					`The tool failed: ${last.content.map((part) => (part.type === "text" ? part.text : "")).join(" ")}`,
				)
			: fauxAssistantMessage(FINAL_REPLY);
	}
	const content = last?.role === "user" ? last.content : "";
	const text =
		typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	// "smoke:write [path]", "smoke:edit" and "smoke:rm <path>" exercise the file tools, for example the VS Code change review.
	const write = /smoke:write(?:\s+(\S+))?/.exec(text);
	if (write) {
		const path = write[1] ?? "pi-smoke.txt";
		return fauxAssistantMessage(
			[fauxText(`Writing ${path}.`), fauxToolCall("write", { path, content: "Hello from pi\n" })],
			{ stopReason: "toolUse" },
		);
	}
	const remove = /smoke:rm\s+(\S+)/.exec(text);
	if (remove) {
		return fauxAssistantMessage(
			[fauxText(`Deleting ${remove[1]}.`), fauxToolCall("bash", { command: `rm ${remove[1]}` })],
			{
				stopReason: "toolUse",
			},
		);
	}
	if (text.includes("smoke:edit")) {
		return fauxAssistantMessage(
			[
				fauxText("Editing sample.ts."),
				fauxToolCall("edit", {
					path: "sample.ts",
					edits: [{ oldText: "return a + b;", newText: "return a + b; // reviewed" }],
				}),
			],
			{ stopReason: "toolUse" },
		);
	}
	const headers = text.split("\n").filter((line) => CONTEXT_HEADER.test(line));
	return fauxAssistantMessage(
		[
			fauxThinking(`The user sent ${text.length} characters. I will list the workspace.`),
			fauxText(
				`Received ${text.length} chars. Context blocks: ${headers.join(" | ") || "none"}. Last line: "${text.split("\n").at(-1)}". Running ls.`,
			),
			fauxToolCall("bash", { command: "ls" }),
		],
		{ stopReason: "toolUse" },
	);
};

export default function (pi: ExtensionAPI): void {
	const faux = fauxProvider({
		provider: "smoke",
		tokensPerSecond: 60,
		models: [
			{ id: "faux-1", name: "Smoke (reasoning)", reasoning: true },
			{ id: "faux-2", name: "Smoke (fast)" },
		],
	});
	faux.setResponses(Array.from({ length: 1000 }, () => respond));
	pi.registerProvider(faux.provider);

	// "/smoke-ui" exercises the generic extension UI dialogs.
	pi.registerCommand("smoke-ui", {
		description: "Show confirm, select and input dialogs and report the answers",
		handler: async (_args, ctx) => {
			const confirmed = await ctx.ui.confirm("Smoke confirm", "Continue with the smoke dialogs?");
			const color = await ctx.ui.select("Smoke select", ["red", "green", "blue"]);
			const text = await ctx.ui.input("Smoke input", "type something");
			ctx.ui.setStatus("smoke", `smoke: ${color ?? "none"}`);
			ctx.ui.notify(`confirm=${confirmed} select=${color} input=${text}`, "info");
		},
	});
}
