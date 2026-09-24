import type { AssistantBlock, Attachment, ChatItem, HostMessage, ToolRun, WebviewMessage } from "../chat-types.ts";
import { Controls, element } from "./controls.ts";
import { renderMarkdown } from "./markdown.ts";

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
/** Current transcript items, for the session title fallback. */
const items: ChatItem[] = [];
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
	for (const { index, item } of changed) {
		pending.set(index, item);
		items[index] = item;
	}
	items.length = length;
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
	const firstUser = items.find((item) => item.kind === "user");
	controls.setFallbackTitle(firstUser?.kind === "user" ? firstUser.text : undefined);
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
		if (item.text) container.append(create("div", "text", item.text));
		return container;
	}
	if (item.kind === "error") return create("div", "message error", item.text);

	const container = create("div", "message assistant");
	item.blocks.forEach((block, index) => {
		if (block) container.append(renderBlock(block, index, item.tools));
	});
	if (item.streaming && item.blocks.every((block) => !block)) container.append(create("div", "muted", "..."));
	if (item.error) container.append(create("div", "error", item.error));
	return container;
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
	return details;
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
