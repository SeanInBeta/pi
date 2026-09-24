import { splitTokens } from "../text-tokens.ts";

/** Render text with highlighted tokens into `target`. */
export function renderTokens(target: HTMLElement, text: string, isCommand: (name: string) => boolean): void {
	target.replaceChildren(
		...splitTokens(text, isCommand).map((part) => {
			if (!part.kind) return document.createTextNode(part.text);
			const span = document.createElement("span");
			span.className = `token token-${part.kind}`;
			span.textContent = part.text;
			return span;
		}),
	);
}
