import type {
	AssistantBlock,
	Attachment,
	ChatItem,
	HostMessage,
	PendingReview,
	ToolRun,
	WebviewMessage,
} from "../chat-types.ts";
import { Controls, element } from "./controls.ts";
import { renderMarkdown } from "./markdown.ts";
import { renderTokens } from "./tokens.ts";

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const MAX_TOOL_OUTPUT = 10_000;
const KIND_LABELS: Record<Attachment["kind"], string> = {
	selection: "Selection",
	file: "File",
	diagnostics: "Problems",
};

const vscode = acquireVsCodeApi();
const transcript = element<HTMLElement>("transcript");
const controls = new Controls((message) => vscode.postMessage(message));

/** Rendered element per transcript item, in transcript order. */
let rendered: HTMLElement[] = [];
/** Items waiting for the next animation frame, so a burst of deltas renders once. */
let pending = new Map<number, ChatItem>();
let pendingLength = 0;
let frame = 0;

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
	const message = event.data;
	if (message.type === "setInput") {
		controls.setInput(message.text);
		return;
	}
	if (message.type === "meta") {
		controls.setMeta(message.meta);
		return;
	}
	if (message.type === "queryResult") {
		controls.queryResult(message.id, message.items);
		return;
	}
	if (message.type === "openMenu") {
		controls.openMenu(message.menu);
		return;
	}
	if (message.type === "reset") {
		cancelAnimationFrame(frame);
		frame = 0;
		pending = new Map();
		rendered = [];
		transcript.replaceChildren();
		queueItems(
			message.state.items.map((item, index) => ({ index, item })),
			message.state.items.length,
		);
		controls.setActivity(message.state.running, message.state.status, message.state.queued);
		controls.setDraft(message.state.draft);
	} else {
		queueItems(message.changed, message.length);
		controls.setActivity(message.running, message.status, message.queued);
		controls.setDraft(message.draft);
	}
});

vscode.postMessage({ type: "ready" });

function queueItems(changed: { index: number; item: ChatItem }[], length: number): void {
	for (const { index, item } of changed) pending.set(index, item);
	pendingLength = length;
	if (!frame) frame = requestAnimationFrame(flush);
}

function flush(): void {
	frame = 0;
	const stickToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
	for (const [index, item] of [...pending].sort(([a], [b]) => a - b)) {
		const next = renderItem(item);
		const previous = rendered[index];
		if (previous) {
			keepOpenDetails(previous, next);
			previous.replaceWith(next);
		} else {
			transcript.append(next);
		}
		rendered[index] = next;
	}
	for (const extra of rendered.splice(pendingLength)) extra.remove();
	pending.clear();
	if (stickToBottom) transcript.scrollTop = transcript.scrollHeight;
}

function renderItem(item: ChatItem): HTMLElement {
	if (item.kind === "user") {
		const container = create("div", "message user");
		if (item.attachments?.length) {
			const list = create("div", "attachments");
			list.append(...item.attachments.map(renderAttachment));
			container.append(list);
		}
		if (item.text) {
			const text = create("div", "text");
			renderTokens(text, item.text, controls.isCommand);
			container.append(text);
		}
		return container;
	}
	if (item.kind === "error") return create("div", "message error", item.text);

	const container = create("div", "message assistant");
	item.blocks.forEach((block, index) => {
		if (block) container.append(renderBlock(block, index, item.tools));
	});
	if (item.streaming && item.blocks.every((block) => !block)) container.append(create("div", "muted", "..."));
	if (item.error) container.append(create("div", "error", item.error));
	if (item.done && !item.streaming) container.append(renderDoneFooter(item.blocks));
	return container;
}

/** End-of-answer marker: a smile says pi has finished; the button copies the answer text. */
function renderDoneFooter(blocks: (AssistantBlock | null)[]): HTMLElement {
	const footer = create("div", "message-footer");
	const done = svgIcon(ICON_PATHS.smile);
	done.classList.add("done-icon");
	const doneLabel = create("span", "done-label");
	doneLabel.title = "pi finished";
	doneLabel.append(done);
	const text = blocks
		.filter((block): block is Extract<AssistantBlock, { type: "text" }> => block?.type === "text")
		.map((block) => block.text)
		.join("\n\n");
	footer.append(doneLabel);
	if (text) {
		const copy = create("button", "icon-button copy-button") as HTMLButtonElement;
		copy.type = "button";
		copy.title = "Copy";
		copy.append(svgIcon(ICON_PATHS.copy));
		copy.addEventListener("click", () => {
			vscode.postMessage({ type: "copyText", text });
			copy.replaceChildren(svgIcon(ICON_PATHS.check));
			copy.title = "Copied";
			setTimeout(() => {
				copy.replaceChildren(svgIcon(ICON_PATHS.copy));
				copy.title = "Copy";
			}, 1500);
		});
		footer.append(copy);
	}
	return footer;
}

const ICON_PATHS = {
	smile: [
		"M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z",
		"M5.5 9.5c.6.9 1.5 1.4 2.5 1.4s1.9-.5 2.5-1.4",
		"M6 6.5h0M10 6.5h0",
	],
	copy: [
		"M5.5 5.5V3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-2.5",
		"M3 5.5h7.5V13a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 13Z",
	],
	check: ["M3.5 8.5 6.5 11.5 12.5 4.5"],
};

function svgIcon(paths: string[]): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", "icon");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	for (const d of paths) {
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

function renderBlock(block: AssistantBlock, index: number, tools: Record<string, ToolRun>): HTMLElement {
	if (block.type === "text") {
		const text = create("div", "text markdown");
		text.append(renderMarkdown(block.text));
		return text;
	}

	const details = document.createElement("details");
	details.dataset.key = String(index);
	if (block.type === "thinking") {
		details.className = "thinking";
		details.append(create("summary", "", "Thinking"), create("div", "body", block.text));
		return details;
	}

	const run = tools[block.id];
	details.className = `tool status-${run?.status ?? "pending"}`;
	const summary = create("summary", "");
	summary.append(create("span", "tool-name", block.name), create("span", "tool-target", summarizeArgs(block.args)));
	details.append(summary, create("pre", "args", block.args));
	if (run?.output) details.append(create("pre", "output", truncate(run.output)));
	if (!run?.review) return details;
	// A pending file change: decide right here, under the call that proposed it.
	const card = create("div", "tool-card");
	card.append(details, renderReviewPrompt(run.review));
	return card;
}

function renderReviewPrompt(review: PendingReview): HTMLElement {
	const prompt = create("div", "review-prompt");
	prompt.append(create("span", "review-text", `Apply this ${review.tool} to ${review.label}?`));
	const actions = create("span", "review-actions");
	for (const choice of ["Accept", "Reject"] as const) {
		const button = create("button", choice === "Accept" ? "review-accept" : "review-reject") as HTMLButtonElement;
		button.type = "button";
		button.textContent = choice;
		button.addEventListener("click", () => {
			for (const other of actions.querySelectorAll("button")) other.disabled = true;
			vscode.postMessage({ type: "review", id: review.id, choice });
		});
		actions.append(button);
	}
	prompt.append(actions);
	return prompt;
}

function renderAttachment(attachment: Attachment, index: number): HTMLElement {
	const details = document.createElement("details");
	details.className = "attachment";
	details.dataset.key = `attachment-${index}`;
	const summary = create("summary", "");
	summary.append(create("span", "chip-kind", KIND_LABELS[attachment.kind]), create("span", "", attachment.label));
	details.append(summary);
	if (attachment.note) details.append(create("div", "muted", attachment.note));
	if (attachment.content) details.append(create("pre", "", truncate(attachment.content)));
	return details;
}

/** Show the most telling argument (a command or a path) next to the tool name. */
function summarizeArgs(args: string): string {
	try {
		const parsed: unknown = JSON.parse(args);
		if (parsed && typeof parsed === "object") {
			for (const key of ["command", "path", "file_path", "pattern"]) {
				const value = (parsed as Record<string, unknown>)[key];
				if (typeof value === "string") return value;
			}
		}
	} catch {
		// Arguments are partial JSON while the call streams.
	}
	return "";
}

function truncate(text: string): string {
	return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n... (truncated)` : text;
}

/** Re-rendering replaces <details> elements, so carry over which ones the user expanded. */
function keepOpenDetails(previous: HTMLElement, next: HTMLElement): void {
	for (const open of previous.querySelectorAll<HTMLDetailsElement>("details[open]")) {
		const match = next.querySelector<HTMLDetailsElement>(`details[data-key="${open.dataset.key}"]`);
		if (match) match.open = true;
	}
}

function create(tag: string, className: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}
