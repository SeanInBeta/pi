/** Tokenizing for `@path` mentions and `/command` tokens; shared by the webview and tests, so free of DOM APIs. */

export interface TextPart {
	text: string;
	kind?: "mention" | "command";
}

export interface TokenRules {
	/** Whether `/name` is a known command. */
	isCommand(name: string): boolean;
	/** Whether `@path` is a known file, such as one picked from the `@` menu. */
	isMention?(path: string): boolean;
}

/**
 * Split text into plain runs, `@path` mentions and `/command` tokens. A `/word` counts as a command
 * when `isCommand` knows it (skills always count), so paths such as `/usr/bin` stay plain.
 *
 * A token runs to the next whitespace, so text typed right after it would join it (`@1.txt改成`). When the
 * token starts with a known path or command and the rest cannot continue a name, only the known part is the
 * token: `@1.txt` + `改成`.
 */
export function splitTokens(text: string, rules: TokenRules): TextPart[] {
	const parts: TextPart[] = [];
	const pattern = /(^|\s)(@[^\s@]+|\/[^\s/]+)/g;
	let last = 0;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		const start = match.index + match[1]!.length;
		const token = recognize(match[2]!, rules);
		if (!token) continue;
		if (start > last) parts.push({ text: text.slice(last, start) });
		parts.push(token);
		last = start + token.text.length;
	}
	if (last < text.length) parts.push({ text: text.slice(last) });
	return parts;
}

function recognize(token: string, rules: TokenRules): Required<TextPart> | undefined {
	const name = token.slice(1);
	if (token.startsWith("@")) {
		const known = rules.isMention && !rules.isMention(name) ? knownPrefix(name, rules.isMention) : undefined;
		return { text: known ? `@${known}` : token, kind: "mention" };
	}
	if (rules.isCommand(name)) return { text: token, kind: "command" };
	const known = knownPrefix(name, rules.isCommand);
	if (known) return { text: `/${known}`, kind: "command" };
	return name.startsWith("skill:") ? { text: token, kind: "command" } : undefined;
}

/** The longest known prefix of `name` whose remainder cannot continue a name or path (`1.txt` in `1.txt改成`). */
function knownPrefix(name: string, isKnown: (name: string) => boolean): string | undefined {
	for (let end = name.length - 1; end > 0; end--) {
		if (!/[\w.\-/:]/.test(name[end]!) && isKnown(name.slice(0, end))) return name.slice(0, end);
	}
	return undefined;
}

/** The `@path` or `/command` token that ends exactly at `offset`, as a `[start, end)` range. */
export function tokenEndingAt(
	text: string,
	offset: number,
	rules: TokenRules,
): { start: number; end: number } | undefined {
	let start = 0;
	for (const part of splitTokens(text, rules)) {
		const end = start + part.text.length;
		if (part.kind && end === offset) return { start, end };
		if (end >= offset) return undefined;
		start = end;
	}
	return undefined;
}
