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
	if (last?.role === "toolResult") return fauxAssistantMessage(FINAL_REPLY);
	const content = last?.role === "user" ? last.content : "";
	const text =
		typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
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
}
