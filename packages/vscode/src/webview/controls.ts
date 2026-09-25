import { fuzzyFilter } from "../../../tui/src/fuzzy.ts";
import type {
	Attachment,
	MenuItem,
	MenuQuery,
	PanelCommand,
	PanelMenu,
	PanelMeta,
	WebviewMessage,
} from "../chat-types.ts";
import { type TokenRules, tokenEndingAt } from "../text-tokens.ts";
import { Menu, type MenuOptions } from "./menu.ts";
import { renderTokens } from "./tokens.ts";

type Post = (message: WebviewMessage) => void;
type ComposerMode = "commands" | "files" | "picker";

interface BuiltinCommand {
	name: string;
	description: string;
	/** Runs the command; `arg` is the text after the command name. */
	run(arg: string): void;
}

const KIND_LABELS: Record<Attachment["kind"], string> = {
	selection: "Selection",
	file: "File",
	diagnostics: "Problems",
};

/** Header, composer and in-panel menus. The transcript is rendered by main.ts. */
export class Controls {
	private readonly post: Post;
	private readonly headerMenu: Menu;
	private readonly composerMenu: Menu;
	private readonly builtins: BuiltinCommand[];
	private readonly queries = new Map<number, (items: MenuItem[]) => void>();
	private nextQuery = 0;
	private meta: PanelMeta = { started: false, thinkingLevels: [], tabs: [], approvalMode: "ask" };
	private running = false;
	private draft: Attachment[] = [];
	/** pi's own slash commands, fetched once per `/` menu. */
	private piCommands: MenuItem[] | undefined;
	private fileQueryTimer = 0;
	/** Which composer menu is open: `/` and `@` menus follow the typed text, others own the keyboard. */
	private composerMode: ComposerMode | undefined;

	private readonly form = element<HTMLFormElement>("composer");
	private readonly input = element<HTMLTextAreaElement>("input");
	private readonly sendButton = element<HTMLButtonElement>("send");
	private readonly statusLine = element<HTMLElement>("status");
	private readonly draftList = element<HTMLElement>("draft");
	private readonly tabs = element<HTMLElement>("tabs");
	private readonly renameInput = element<HTMLInputElement>("rename");
	private readonly modelLabel = element<HTMLElement>("model-label");
	private readonly approvalLabel = element<HTMLElement>("approval-label");
	private readonly highlight = element<HTMLElement>("input-highlight");
	/** The token that the first Backspace selected; a second Backspace deletes it. */
	private selectedToken: { start: number; end: number } | undefined;
	private readonly tabScroll = element<HTMLElement>("tab-scroll");
	private readonly tabScrollThumb = element<HTMLElement>("tab-scroll-thumb");
	private shownTabId: string | undefined;
	private readonly effort = element<HTMLElement>("effort");
	private readonly effortRange = element<HTMLInputElement>("effort-range");

	constructor(post: Post) {
		this.post = post;
		this.headerMenu = new Menu(element("header-menu"));
		this.composerMenu = new Menu(element("composer-menu"));
		this.builtins = [
			{ name: "new", description: "Start a new session", run: () => this.command("newSession") },
			{ name: "resume", description: "Resume a different session", run: () => this.openSessions() },
			{
				name: "model",
				description: "Select model, or /model <provider/model>",
				run: (arg) => (arg ? this.command("setModel", arg) : this.openModels()),
			},
			{
				name: "thinking",
				description: "Set thinking level, or /thinking <level>",
				run: (arg) => (arg ? this.command("setThinking", arg) : this.openEffort()),
			},
			{ name: "fork", description: "Create a new fork from a previous user message", run: () => this.openForks() },
			{ name: "clone", description: "Duplicate the current session", run: () => this.command("clone") },
			{
				name: "name",
				description: "Set session display name, or /name <name>",
				run: (arg) => (arg ? this.command("rename", arg) : this.startRename()),
			},
			{
				name: "compact",
				description: "Compact the session context, optionally with instructions",
				run: (arg) => this.command("compact", arg || undefined),
			},
			{ name: "copy", description: "Copy the last agent message", run: () => this.command("copyLast") },
		];
		this.bindEvents();
	}

	/** Paths picked from the `@` menu; they stay one token even when text is typed right after them. */
	private readonly knownMentions = new Set<string>();
	/** Which `/name` and `@path` words are highlighted as tokens. */
	readonly tokenRules: TokenRules = {
		isCommand: (name) =>
			this.builtins.some((command) => command.name === name) ||
			(this.piCommands ?? []).some((item) => item.value === `pi:${name}`),
		isMention: (path) => this.knownMentions.has(path),
	};

	setMeta(meta: PanelMeta): void {
		this.meta = meta;
		this.renderTabs();
		this.approvalLabel.textContent = meta.approvalMode === "auto" ? "Auto edit" : "Ask for approval";
		const thinking = meta.thinkingLevel && meta.thinkingLevel !== "off" ? ` · ${capitalize(meta.thinkingLevel)}` : "";
		this.modelLabel.textContent = meta.model
			? `${meta.model.id}${thinking}`
			: meta.started
				? "No model"
				: "Loading model...";
		if (!this.effort.hidden) this.renderEffort();
	}

	/** Terminal-style tabs: one pi process each; click to switch, trash to stop and remove. */
	private renderTabs(): void {
		this.tabs.replaceChildren(
			...this.meta.tabs.map((tab) => {
				const wrapper = create("div", `tab state-${tab.state}${tab.active ? " active" : ""}`);
				wrapper.setAttribute("role", "tab");
				wrapper.setAttribute("aria-selected", String(tab.active));
				const main = create("button", "tab-main") as HTMLButtonElement;
				main.type = "button";
				main.title = tab.active ? `${tab.title} (session menu)` : tab.title;
				main.append(create("span", "tab-dot"), create("span", "tab-label", tab.title));
				if (tab.active) {
					main.dataset.menuTrigger = "";
					main.addEventListener("click", () => this.toggle(this.headerMenu, () => this.openSessions()));
				} else {
					main.addEventListener("click", () => this.command("switchTab", tab.id));
				}
				const close = create("button", "tab-close") as HTMLButtonElement;
				close.type = "button";
				close.title = tab.state === "running" ? "Stop and close this tab" : "Close this tab";
				// The last tab stays: there is always a chat to type into.
				close.hidden = this.meta.tabs.length === 1;
				close.append(trashIcon());
				close.addEventListener("click", () => this.command("closeTab", tab.id));
				wrapper.append(main, close);
				// Right-click opens the session menu for that tab, like a terminal tab's context menu.
				wrapper.addEventListener("contextmenu", (event) => {
					event.preventDefault();
					if (!tab.active) this.command("switchTab", tab.id);
					this.openSessions();
				});
				return wrapper;
			}),
		);
		// Scroll only when another tab became active, so status updates do not undo the user's scrolling.
		const activeId = this.activeTabId();
		if (activeId !== this.shownTabId) {
			this.shownTabId = activeId;
			this.tabs.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
		}
		this.updateTabScroll();
	}

	/** Size and place the navigation bar under the tabs; it shows only when the tabs overflow. */
	private updateTabScroll(): void {
		const { scrollWidth, clientWidth, scrollLeft } = this.tabs;
		const overflowing = scrollWidth > clientWidth + 1 && !this.tabs.hidden;
		this.tabScroll.hidden = !overflowing;
		if (!overflowing) return;
		this.tabScrollThumb.style.width = `${(clientWidth / scrollWidth) * 100}%`;
		this.tabScrollThumb.style.left = `${(scrollLeft / scrollWidth) * 100}%`;
	}

	private bindTabScroll(): void {
		this.tabs.addEventListener("scroll", () => this.updateTabScroll());
		new ResizeObserver(() => this.updateTabScroll()).observe(this.tabs);
		// Drag the thumb to scroll; click the track to jump there.
		this.tabScrollThumb.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.tabScrollThumb.setPointerCapture(event.pointerId);
			const startX = event.clientX;
			const startLeft = this.tabs.scrollLeft;
			const ratio = this.tabs.scrollWidth / this.tabScroll.clientWidth;
			const move = (moveEvent: PointerEvent) => {
				this.tabs.scrollLeft = startLeft + (moveEvent.clientX - startX) * ratio;
			};
			const up = () => {
				this.tabScrollThumb.removeEventListener("pointermove", move);
				this.tabScrollThumb.removeEventListener("pointerup", up);
			};
			this.tabScrollThumb.addEventListener("pointermove", move);
			this.tabScrollThumb.addEventListener("pointerup", up);
		});
		this.tabScroll.addEventListener("pointerdown", (event) => {
			const rect = this.tabScroll.getBoundingClientRect();
			const fraction = (event.clientX - rect.left) / rect.width;
			this.tabs.scrollLeft = fraction * this.tabs.scrollWidth - this.tabs.clientWidth / 2;
		});
	}

	setActivity(running: boolean, status: string | undefined, queued: number): void {
		this.running = running;
		const parts = running ? [status ?? "Working..."] : status ? [status] : [];
		if (queued > 0) parts.push(`${queued} queued`);
		this.statusLine.textContent = parts.join(" · ");
		this.updateSendButton();
	}

	setDraft(next: Attachment[]): void {
		if (next === this.draft) return;
		this.draft = next;
		this.draftList.replaceChildren(
			...next.map((attachment) => {
				const chip = create("span", "chip");
				chip.title = attachment.note ? `${attachment.path} (${attachment.note})` : attachment.path;
				const remove = create("button", "chip-remove", "×") as HTMLButtonElement;
				remove.type = "button";
				remove.title = "Remove";
				remove.addEventListener("click", () => this.post({ type: "removeAttachment", id: attachment.id }));
				chip.append(
					create("span", "chip-kind", KIND_LABELS[attachment.kind]),
					create("span", "", attachment.label),
					remove,
				);
				return chip;
			}),
		);
		this.draftList.hidden = next.length === 0;
		this.updateSendButton();
	}

	setInput(text: string): void {
		this.input.value = text;
		this.input.focus();
		this.inputChanged();
	}

	/** Keep the highlight layer, height and send button in step with the input text. */
	private inputChanged(): void {
		this.autoResize();
		this.updateSendButton();
		// A trailing space keeps the layer as tall as the textarea when the text ends with a newline.
		renderTokens(this.highlight, `${this.input.value} `, this.tokenRules, this.selectedToken?.start);
		this.highlight.scrollTop = this.input.scrollTop;
	}

	/**
	 * First Backspace right after an `@path` or `/command` token selects the whole token instead of deleting a
	 * character; the second Backspace then deletes the selection like any other.
	 */
	private selectTokenBeforeCaret(event: KeyboardEvent): boolean {
		if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
		const { selectionStart, selectionEnd } = this.input;
		if (selectionStart !== selectionEnd) return false;
		const token = tokenEndingAt(this.input.value, selectionStart, this.tokenRules);
		if (!token) return false;
		this.selectedToken = token;
		this.input.setSelectionRange(token.start, token.end);
		if (this.composerMode === "commands" || this.composerMode === "files") this.composerMenu.close();
		this.inputChanged();
		return true;
	}

	openMenu(menu: PanelMenu): void {
		if (menu === "sessions") this.openSessions();
		else if (menu === "models") this.openModels();
		else if (menu === "thinking") this.openEffort();
		else if (menu === "forks") this.openForks();
		else this.startRename();
	}

	queryResult(id: number, items: MenuItem[]): void {
		this.queries.get(id)?.(items);
		this.queries.delete(id);
	}

	private bindEvents(): void {
		this.form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.submit();
		});
		this.input.addEventListener("keydown", (event) => {
			if (event.isComposing) return;
			if (this.composerMenu.isOpen && this.composerMenu.handleKey(event)) {
				event.preventDefault();
				return;
			}
			if (event.key === "Backspace" && this.selectTokenBeforeCaret(event)) {
				event.preventDefault();
			} else if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				this.submit();
			} else if (event.key === "Escape" && this.running) {
				event.preventDefault();
				this.post({ type: "abort" });
			}
		});
		this.input.addEventListener("input", (event) => {
			this.selectedToken = undefined;
			this.inputChanged();
			// Typing opens the `/` and `@` menus; deleting only updates one that is already open.
			const deleting = event instanceof InputEvent && event.inputType.startsWith("delete");
			if (!deleting || this.composerMode === "commands" || this.composerMode === "files") this.updateInlineMenu();
		});
		// Moving the caret or selection in any other way drops the token selection.
		document.addEventListener("selectionchange", () => {
			const token = this.selectedToken;
			if (!token || (this.input.selectionStart === token.start && this.input.selectionEnd === token.end)) return;
			this.selectedToken = undefined;
			this.inputChanged();
		});
		this.input.addEventListener("scroll", () => {
			this.highlight.scrollTop = this.input.scrollTop;
		});
		element("approval").addEventListener("click", () => this.toggle(this.composerMenu, () => this.openApproval()));
		this.input.addEventListener("blur", () => {
			if (this.composerMode === "commands" || this.composerMode === "files") this.composerMenu.close();
		});

		element("new-tab").addEventListener("click", () => this.command("newTab"));
		this.bindTabScroll();
		// A vertical mouse wheel scrolls the tab strip sideways.
		this.tabs.addEventListener(
			"wheel",
			(event) => {
				if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
				this.tabs.scrollLeft += event.deltaY;
				event.preventDefault();
			},
			{ passive: false },
		);
		element("history").addEventListener("click", () => this.toggle(this.headerMenu, () => this.openSessions()));
		element("model").addEventListener("click", () => (this.effort.hidden ? this.openEffort() : this.closeEffort()));
		element("effort-title").addEventListener("click", () => {
			this.closeEffort();
			this.openModels(true);
		});
		// Preview while dragging, apply on release or keyboard change.
		this.effortRange.addEventListener("input", () => this.renderEffort(Number(this.effortRange.value)));
		this.effortRange.addEventListener("change", () => {
			const level = this.meta.thinkingLevels[Number(this.effortRange.value)];
			if (level && level !== this.meta.thinkingLevel) this.command("setThinking", level);
		});
		this.effort.addEventListener("keydown", (event) => {
			if (event.key === "Escape") this.closeEffort();
		});
		document.addEventListener("mousedown", (event) => {
			// composedPath() still lists menu rows that a click removed, so picking a model from the
			// menu opened by the popover does not count as a click outside it.
			const path = event.composedPath();
			const inside = [this.effort, element("model"), element("composer-menu")].some((node) => path.includes(node));
			if (!this.effort.hidden && !inside) this.closeEffort();
		});
		element("attach").addEventListener("click", () => this.toggle(this.composerMenu, () => this.openAttach()));

		this.renameInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				const name = this.renameInput.value.trim();
				this.finishRename();
				if (name) this.command("rename", name);
			} else if (event.key === "Escape") {
				this.finishRename();
			}
		});
		this.renameInput.addEventListener("blur", () => this.finishRename());
	}

	private submit(): void {
		const text = this.input.value.trim();
		if (!text && this.draft.length === 0) {
			// The send button doubles as the stop button while pi works.
			if (this.running) this.post({ type: "abort" });
			return;
		}
		this.composerMenu.close();
		const builtin = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
		const command = builtin && this.builtins.find((candidate) => candidate.name === builtin[1]);
		if (command) {
			command.run(builtin[2]?.trim() ?? "");
		} else {
			this.post({ type: "send", text });
		}
		this.setInput("");
		this.input.focus();
	}

	/** Open `/` or `@` suggestions for the word before the caret. */
	private updateInlineMenu(): void {
		const before = this.input.value.slice(0, this.input.selectionStart);
		const slash = /(?:^|\s)\/([^\s/]*)$/.exec(before);
		if (slash) {
			// Built-ins act on the whole input, so they are offered only at its start.
			this.openCommands(slash[1] ?? "", before.startsWith("/"));
			return;
		}
		const mention = /(?:^|\s)@([^\s@]*)$/.exec(before);
		if (mention) {
			this.openFiles(mention[1] ?? "");
			return;
		}
		if (this.composerMode === "commands" || this.composerMode === "files") this.composerMenu.close();
	}

	private openCommands(query: string, atStart: boolean): void {
		const builtinItems: MenuItem[] = atStart
			? this.builtins.map((command) => ({
					label: `/${command.name}`,
					description: command.description,
					value: `builtin:${command.name}`,
				}))
			: [];
		// Fuzzy, like pi's terminal UI: "/awe" finds "/skill:awe".
		const filter = (items: MenuItem[]) => fuzzyFilter(items, query, (item) => item.label.slice(1));
		const sections = () => [
			{ items: filter(builtinItems) },
			{ title: "pi commands", items: filter(this.piCommands ?? []) },
		];
		const show = () => {
			const current = sections();
			if (current.every((section) => section.items.length === 0) && this.piCommands !== undefined) {
				if (this.composerMode === "commands") this.composerMenu.close();
				return;
			}
			if (this.composerMode === "commands") this.composerMenu.update(current);
			else this.openComposerMenu("commands", { sections: current, onSelect, emptyText: "Loading commands..." });
		};
		const onSelect = (item: MenuItem) => {
			const [kind, name] = splitValue(item.value);
			if (kind === "builtin") {
				this.setInput("");
				this.builtins.find((command) => command.name === name)?.run("");
			} else {
				this.replaceBeforeCaret(/\/[^\s/]*$/, `/${name} `);
			}
		};
		if (!this.piCommands) {
			this.query("commands", "", (items) => {
				this.piCommands = items.map((item) => ({ ...item, value: `pi:${item.value}` }));
				this.inputChanged();
				if (this.composerMode === "commands" || this.inlineSlashPending()) show();
			});
		}
		show();
	}

	/** Whether the caret still follows a `/word`, so late command results should open the menu. */
	private inlineSlashPending(): boolean {
		return /(?:^|\s)\/[^\s/]*$/.test(this.input.value.slice(0, this.input.selectionStart));
	}

	private openFiles(query: string): void {
		const onSelect = (item: MenuItem) => this.insertMention(item.value);
		if (this.composerMode !== "files") {
			this.openComposerMenu("files", { sections: undefined, onSelect, emptyText: "No matching files" });
		}
		clearTimeout(this.fileQueryTimer);
		this.fileQueryTimer = window.setTimeout(() => {
			this.query("files", query, (items) => {
				if (this.composerMode === "files") this.composerMenu.update([{ items }]);
			});
		}, 80);
	}

	private openComposerMenu(mode: ComposerMode, options: MenuOptions): void {
		this.composerMenu.close();
		this.composerMode = mode;
		this.composerMenu.open({
			...options,
			onClose: () => {
				this.composerMode = undefined;
			},
		});
	}

	/** Replace the `@partial` before the caret with `@path `. */
	private insertMention(path: string): void {
		this.knownMentions.add(path);
		this.replaceBeforeCaret(/@[^\s@]*$/, `@${path} `);
	}

	private replaceBeforeCaret(pattern: RegExp, replacement: string): void {
		const caret = this.input.selectionStart;
		const before = this.input.value.slice(0, caret).replace(pattern, replacement);
		this.input.value = before + this.input.value.slice(caret);
		this.input.setSelectionRange(before.length, before.length);
		this.input.focus();
		this.inputChanged();
	}

	private openSessions(): void {
		const actions: MenuItem[] = [
			{ label: "New session", description: "Open a new tab", value: "action:new" },
			{ label: "Rename session...", value: "action:rename" },
			{ label: "Fork from an earlier message...", value: "action:fork" },
			...(this.meta.tabs.length > 1
				? [
						{
							label: "Close tab",
							description: "Stop this tab's pi; the session stays saved",
							value: "action:close",
						},
					]
				: []),
			{
				label: "Delete session...",
				description: "Close the tab and move the session file to the trash",
				value: "action:delete",
			},
		];
		this.headerMenu.open({
			sections: [{ items: actions }, { title: "Recent sessions (open in a tab)", items: [] }],
			searchable: true,
			placeholder: "Search sessions",
			emptyText: "No sessions",
			onSelect: (item) => {
				const [kind, value] = splitValue(item.value);
				if (kind === "session") this.command("openSession", value);
				else if (value === "new") this.command("newTab");
				else if (value === "fork") this.openForks();
				else if (value === "close") this.command("closeTab", this.activeTabId());
				else if (value === "delete") this.command("deleteSession", this.activeTabId());
				else this.startRename();
			},
		});
		this.query("sessions", "", (items) =>
			this.headerMenu.update([
				{ items: actions },
				{
					title: "Recent sessions (open in a tab)",
					items: items.map((item) => ({ ...item, value: `session:${item.value}` })),
				},
			]),
		);
	}

	private activeTabId(): string | undefined {
		return this.meta.tabs.find((tab) => tab.active)?.id;
	}

	private openForks(): void {
		this.headerMenu.open({
			sections: undefined,
			searchable: true,
			placeholder: "Fork from before which message?",
			emptyText: "No messages to fork from yet",
			onSelect: (item) => this.command("fork", item.value),
		});
		this.query("forks", "", (items) => this.headerMenu.update([{ items }]));
	}

	/** `backToEffort`: reopen the effort popover after a model is picked from it. */
	private openModels(backToEffort = false): void {
		this.closeEffort();
		this.openComposerMenu("picker", {
			sections: undefined,
			searchable: true,
			placeholder: "Search models",
			emptyText: "No models. Log in to a provider with the pi CLI first.",
			onSelect: (item) => {
				this.command("setModel", item.value);
				if (backToEffort) this.openEffort();
				else this.input.focus();
			},
		});
		this.query("models", "", (items) => this.composerMenu.update([{ items }]));
	}

	/** Codex-style popover: thinking level on a slider, the model name below the level. */
	private openEffort(): void {
		this.composerMenu.close();
		this.headerMenu.close();
		this.effort.hidden = false;
		this.renderEffort();
		this.effortRange.focus();
	}

	private closeEffort(): void {
		this.effort.hidden = true;
	}

	/** `preview` is a slider position while dragging; otherwise the current level is shown. */
	private renderEffort(preview?: number): void {
		const levels = this.meta.thinkingLevels;
		const index = preview ?? Math.max(0, levels.indexOf(this.meta.thinkingLevel ?? ""));
		const level = levels[index] ?? this.meta.thinkingLevel ?? "off";
		element("effort-level").textContent = capitalize(level);
		element("effort-model").textContent = this.meta.model
			? `${this.meta.model.id} · ${this.meta.model.provider}`
			: "No model selected";
		const slidable = levels.length > 1;
		element("effort-slider").hidden = !slidable;
		element("effort-none").hidden = slidable;
		if (!slidable) return;
		this.effortRange.max = String(levels.length - 1);
		this.effortRange.value = String(index);
		this.effortRange.setAttribute("aria-valuetext", level);
		element("effort-slider").style.setProperty("--fill", String(index / (levels.length - 1)));
		const dots = element("effort-dots");
		if (dots.childElementCount !== levels.length) {
			dots.replaceChildren(...levels.map(() => create("span", "effort-dot")));
		}
	}

	private openApproval(): void {
		const items: MenuItem[] = [
			{
				label: "Ask for approval",
				description: "Review every edit in the diff editor first",
				value: "ask",
				current: this.meta.approvalMode === "ask",
			},
			{
				label: "Auto edit",
				description: "Apply edits without asking",
				value: "auto",
				current: this.meta.approvalMode === "auto",
			},
		];
		this.openComposerMenu("picker", {
			sections: [{ items }],
			onSelect: (item) => this.command("setApprovalMode", item.value),
		});
	}

	private openAttach(): void {
		const items: MenuItem[] = [
			{ label: "Selection", description: "Current editor selection", value: "attachSelection" },
			{ label: "Current file", description: "Active editor, including unsaved edits", value: "attachFile" },
			{ label: "Problems", description: "Errors and warnings of the active file", value: "attachProblems" },
			{ label: "Mention a file", description: "Insert @path", value: "mention" },
		];
		this.openComposerMenu("picker", {
			sections: [{ items }],
			onSelect: (item) => {
				if (item.value === "mention") {
					const separator = this.input.value && !/\s$/.test(this.input.value) ? " " : "";
					this.setInput(`${this.input.value}${separator}@`);
					this.updateInlineMenu();
				} else {
					this.command(item.value as PanelCommand);
				}
			},
		});
	}

	private startRename(): void {
		this.headerMenu.close();
		this.renameInput.value = this.meta.sessionName ?? "";
		this.tabs.hidden = true;
		this.updateTabScroll();
		this.renameInput.hidden = false;
		this.renameInput.focus();
		this.renameInput.select();
	}

	private finishRename(): void {
		this.renameInput.hidden = true;
		this.tabs.hidden = false;
		this.updateTabScroll();
	}

	private toggle(menu: Menu, open: () => void): void {
		if (menu.isOpen) menu.close();
		else open();
	}

	private command(command: PanelCommand, arg?: string): void {
		this.post({ type: "command", command, arg });
	}

	private query(query: MenuQuery, text: string, onItems: (items: MenuItem[]) => void): void {
		const id = ++this.nextQuery;
		this.queries.set(id, onItems);
		this.post({ type: "query", id, query, text });
	}

	/** Send with an arrow; with nothing to send while pi works, the same button stops the run. */
	private updateSendButton(): void {
		const hasContent = this.input.value.trim().length > 0 || this.draft.length > 0;
		const stop = this.running && !hasContent;
		this.sendButton.classList.toggle("stop", stop);
		this.sendButton.disabled = !stop && !hasContent;
		this.sendButton.title = stop ? "Stop (Esc)" : this.running ? "Steer (Enter)" : "Send (Enter)";
	}

	private autoResize(): void {
		this.input.style.height = "auto";
		this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`;
	}
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function trashIcon(): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", "icon small");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4");
	svg.append(path);
	return svg;
}

/** Split a `kind:value` menu value at the first colon. */
function splitValue(value: string): [string, string] {
	const index = value.indexOf(":");
	return index === -1 ? [value, ""] : [value.slice(0, index), value.slice(index + 1)];
}

function create(tag: string, className: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function element<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id);
	if (!node) throw new Error(`Missing #${id}`);
	return node as T;
}
