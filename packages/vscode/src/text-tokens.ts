/** Tokenizing for `@path` mentions and `/command` tokens; shared by the webview and tests, so free of DOM APIs. */

export interface TextPart {
	text: string;
	kind?: "mention" | "command";
}

/**
 * Split text into plain runs, `@path` mentions and `/command` tokens. A `/word` counts as a command
 * when `isCommand` knows it (skills always count), so paths such as `/usr/bin` stay plain.
 */
export function splitTokens(text: string, isCommand: (name: string) => boolean): TextPart[] {
	const parts: TextPart[] = [];
	const pattern = /(^|\s)(@[^\s@]+|\/[^\s/]+)/g;
	let last = 0;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		const token = match[2]!;
		const start = match.index + match[1]!.length;
		const name = token.slice(1);
		const kind = token.startsWith("@")
			? "mention"
			: name.startsWith("skill:") || isCommand(name)
				? "command"
				: undefined;
		if (!kind) continue;
		if (start > last) parts.push({ text: text.slice(last, start) });
		parts.push({ text: token, kind });
		last = start + token.length;
	}
	if (last < text.length) parts.push({ text: text.slice(last) });
	return parts;
}
