import { splitTokens } from "../text-tokens.ts";

/** Render text with highlighted tokens into `target`; the token starting at `selectedStart` is marked selected. */
export function renderTokens(
	target: HTMLElement,
	text: string,
	isCommand: (name: string) => boolean,
	selectedStart?: number,
): void {
	let offset = 0;
	target.replaceChildren(
		...splitTokens(text, isCommand).map((part) => {
			const start = offset;
			offset += part.text.length;
			if (!part.kind) return document.createTextNode(part.text);
			const span = document.createElement("span");
			span.className = `token token-${part.kind}${start === selectedStart ? " token-selected" : ""}`;
			span.textContent = part.text;
			return span;
		}),
	);
}
