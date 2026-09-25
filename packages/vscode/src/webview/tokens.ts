import { splitTokens, type TokenRules } from "../text-tokens.ts";

/** Render text with highlighted tokens into `target`; the token starting at `selectedStart` is marked selected. */
export function renderTokens(target: HTMLElement, text: string, rules: TokenRules, selectedStart?: number): void {
	let offset = 0;
	target.replaceChildren(
		...splitTokens(text, rules).map((part) => {
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
