import type { Attachment } from "./chat-types.ts";

/** One editor problem, decoupled from vscode.Diagnostic so formatting stays testable. */
export interface Problem {
	line: number;
	column: number;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	source?: string;
	code?: string;
	/** Text of the problem's first line, trimmed. */
	lineText?: string;
}

/** Build the prompt pi receives: each attachment as a labeled block, then the typed message. */
export function buildPrompt(text: string, attachments: readonly Attachment[]): string {
	if (attachments.length === 0) return text;
	return [...attachments.map(formatAttachment), text].filter((part) => part.length > 0).join("\n\n");
}

export function formatAttachment(attachment: Attachment): string {
	const note = attachment.note ? ` (${attachment.note})` : "";
	switch (attachment.kind) {
		case "selection": {
			const lines = attachment.lines ? ` lines ${attachment.lines.start}-${attachment.lines.end}` : "";
			return `Selected code from ${attachment.path}${lines}${note}:\n${fence(attachment.content, attachment.language)}`;
		}
		case "file":
			return `File ${attachment.path}${note}:\n${fence(attachment.content, attachment.language)}`;
		case "diagnostics":
			return `Problems reported by VS Code in ${attachment.path}${note}:\n${attachment.content}`;
	}
}

/** One problem per line: `path:line:col severity [source code]: message`, with the source line below. */
export function formatProblems(path: string, problems: readonly Problem[]): string {
	return problems
		.map((problem) => {
			const origin = [problem.source, problem.code].filter(Boolean).join(" ");
			const head = `- ${path}:${problem.line}:${problem.column} ${problem.severity}${origin ? ` [${origin}]` : ""}: ${problem.message}`;
			return problem.lineText ? `${head}\n  | ${problem.lineText}` : head;
		})
		.join("\n");
}

/** Wrap text in a code fence longer than any backtick run inside it. */
function fence(content: string, language = ""): string {
	const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
	const marker = "`".repeat(Math.max(3, longestRun + 1));
	return `${marker}${language}\n${content}${content.endsWith("\n") ? "" : "\n"}${marker}`;
}
