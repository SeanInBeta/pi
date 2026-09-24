import { Lexer, type Token, type Tokens } from "marked";

/** Link schemes that may become clickable links. Everything else renders as text. */
const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * Render Markdown to DOM nodes. Only marked's lexer is used; every node is built with
 * createElement/textContent, so raw HTML in the source is shown as text and never parsed.
 */
export function renderMarkdown(source: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	appendBlocks(fragment, Lexer.lex(source, { gfm: true }));
	return fragment;
}

function appendBlocks(parent: Node, tokens: Token[]): void {
	for (const token of tokens) {
		const node = renderBlock(token);
		if (node) parent.appendChild(node);
	}
}

function renderBlock(token: Token): Node | undefined {
	switch (token.type) {
		case "space":
		case "def":
			return undefined;
		case "heading": {
			const heading = token as Tokens.Heading;
			return withInline(`h${Math.min(Math.max(heading.depth, 1), 6)}`, heading.tokens);
		}
		case "paragraph":
			return withInline("p", (token as Tokens.Paragraph).tokens);
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens ? withInline("span", text.tokens) : document.createTextNode(text.text);
		}
		case "code": {
			const code = token as Tokens.Code;
			const pre = document.createElement("pre");
			const element = document.createElement("code");
			if (code.lang) element.dataset.lang = code.lang.split(/\s/)[0];
			element.textContent = code.text;
			pre.appendChild(element);
			return pre;
		}
		case "blockquote": {
			const quote = document.createElement("blockquote");
			appendBlocks(quote, (token as Tokens.Blockquote).tokens);
			return quote;
		}
		case "list":
			return renderList(token as Tokens.List);
		case "table":
			return renderTable(token as Tokens.Table);
		case "hr":
			return document.createElement("hr");
		case "html": {
			const paragraph = document.createElement("p");
			paragraph.textContent = (token as Tokens.HTML).text;
			return paragraph;
		}
		default:
			return document.createTextNode(token.raw);
	}
}

function renderList(list: Tokens.List): HTMLElement {
	const element = document.createElement(list.ordered ? "ol" : "ul");
	if (list.ordered && typeof list.start === "number" && list.start !== 1)
		element.setAttribute("start", String(list.start));
	for (const item of list.items) {
		const li = document.createElement("li");
		for (const token of item.tokens) {
			if (token.type === "checkbox") {
				const box = document.createElement("input");
				box.type = "checkbox";
				box.checked = (token as Tokens.Checkbox).checked;
				box.disabled = true;
				li.appendChild(box);
				li.classList.add("task");
			} else {
				const node = renderBlock(token);
				if (node) li.appendChild(node);
			}
		}
		element.appendChild(li);
	}
	return element;
}

function renderTable(table: Tokens.Table): HTMLElement {
	const element = document.createElement("table");
	const head = element.createTHead().insertRow();
	for (const cell of table.header) head.appendChild(withInline("th", cell.tokens));
	const body = element.createTBody();
	for (const row of table.rows) {
		const tr = body.insertRow();
		for (const cell of row) tr.appendChild(withInline("td", cell.tokens));
	}
	return element;
}

function withInline(tag: string, tokens: Token[]): HTMLElement {
	const element = document.createElement(tag);
	appendInline(element, tokens);
	return element;
}

function appendInline(parent: Node, tokens: Token[]): void {
	for (const token of tokens) parent.appendChild(renderInline(token));
}

function renderInline(token: Token): Node {
	switch (token.type) {
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens ? withInline("span", text.tokens) : document.createTextNode(text.text);
		}
		case "escape":
			return document.createTextNode((token as Tokens.Escape).text);
		case "strong":
			return withInline("strong", (token as Tokens.Strong).tokens);
		case "em":
			return withInline("em", (token as Tokens.Em).tokens);
		case "del":
			return withInline("del", (token as Tokens.Del).tokens);
		case "codespan": {
			const code = document.createElement("code");
			code.textContent = (token as Tokens.Codespan).text;
			return code;
		}
		case "br":
			return document.createElement("br");
		case "link": {
			const link = token as Tokens.Link;
			if (!SAFE_LINK.test(link.href)) return withInline("span", link.tokens);
			const anchor = withInline("a", link.tokens) as HTMLAnchorElement;
			anchor.href = link.href;
			anchor.title = link.title ?? link.href;
			return anchor;
		}
		case "image": {
			// Remote images are blocked by the webview CSP; show the alt text, linked when the URL is safe.
			const image = token as Tokens.Image;
			const label = `[image: ${image.text || image.href}]`;
			if (!SAFE_LINK.test(image.href)) return document.createTextNode(label);
			const anchor = document.createElement("a");
			anchor.href = image.href;
			anchor.textContent = label;
			return anchor;
		}
		default:
			// Inline HTML and unknown tokens are shown as their source text.
			return document.createTextNode(token.raw);
	}
}
