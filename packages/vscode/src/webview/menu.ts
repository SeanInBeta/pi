import type { MenuItem } from "../chat-types.ts";

export interface MenuSection {
	title?: string;
	items: MenuItem[];
}

export interface MenuOptions {
	/** Sections to show, or undefined while they load. */
	sections: MenuSection[] | undefined;
	onSelect: (item: MenuItem) => void;
	/** Show a filter box and take keyboard focus (header and toolbar menus). */
	searchable?: boolean;
	placeholder?: string;
	emptyText?: string;
	onClose?: () => void;
}

/**
 * Popup list rendered inside the panel. Searchable menus own the keyboard through their filter box;
 * the composer drives `/` and `@` menus through move(), choose() and close().
 */
export class Menu {
	private readonly host: HTMLElement;
	private options: MenuOptions | undefined;
	private visible: MenuItem[] = [];
	private active = 0;
	private filterText = "";
	private list: HTMLElement | undefined;

	constructor(host: HTMLElement) {
		this.host = host;
		host.hidden = true;
		document.addEventListener("mousedown", (event) => {
			const target = event.target as Node;
			if (this.isOpen && !host.contains(target) && !(target as HTMLElement).closest?.("[data-menu-trigger]")) {
				this.close();
			}
		});
	}

	get isOpen(): boolean {
		return this.options !== undefined;
	}

	open(options: MenuOptions): void {
		this.options = options;
		this.filterText = "";
		this.active = 0;
		this.host.hidden = false;
		this.host.replaceChildren();
		if (options.searchable) {
			const filter = document.createElement("input");
			filter.className = "menu-filter";
			filter.placeholder = options.placeholder ?? "Filter";
			filter.addEventListener("input", () => {
				this.filterText = filter.value.trim().toLowerCase();
				this.active = 0;
				this.renderList();
			});
			filter.addEventListener("keydown", (event) => {
				if (this.handleKey(event)) event.preventDefault();
			});
			this.host.append(filter);
			queueMicrotask(() => filter.focus());
		}
		this.list = document.createElement("div");
		this.list.className = "menu-list";
		this.host.append(this.list);
		this.renderList();
	}

	/** Replace the sections of the open menu, for example when a query returns. */
	update(sections: MenuSection[]): void {
		if (!this.options) return;
		this.options = { ...this.options, sections };
		this.active = Math.min(this.active, Math.max(0, this.countVisible(sections) - 1));
		this.renderList();
	}

	close(): void {
		if (!this.options) return;
		const onClose = this.options.onClose;
		this.options = undefined;
		this.host.hidden = true;
		this.host.replaceChildren();
		onClose?.();
	}

	/** Keyboard handling shared by the filter box and the composer. Returns true when the key was used. */
	handleKey(event: KeyboardEvent): boolean {
		if (!this.options) return false;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			const count = this.visible.length;
			if (count > 0) this.active = (this.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
			this.renderList();
			return true;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			const item = this.visible[this.active];
			if (!item) return event.key === "Enter" && this.options.searchable === true;
			this.select(item);
			return true;
		}
		if (event.key === "Escape") {
			this.close();
			return true;
		}
		return false;
	}

	private select(item: MenuItem): void {
		const onSelect = this.options?.onSelect;
		this.close();
		onSelect?.(item);
	}

	private renderList(): void {
		const list = this.list;
		const options = this.options;
		if (!list || !options) return;
		list.replaceChildren();
		this.visible = [];
		if (!options.sections) {
			list.append(text("div", "menu-empty", "Loading..."));
			return;
		}
		for (const section of options.sections) {
			const items = section.items.filter((item) => this.matches(item));
			if (items.length === 0) continue;
			if (section.title) list.append(text("div", "menu-section", section.title));
			for (const item of items) {
				const index = this.visible.length;
				this.visible.push(item);
				list.append(this.renderItem(item, index));
			}
		}
		if (this.visible.length === 0) list.append(text("div", "menu-empty", options.emptyText ?? "No matches"));
		list.querySelector(".menu-item.active")?.scrollIntoView({ block: "nearest" });
	}

	private renderItem(item: MenuItem, index: number): HTMLElement {
		const row = document.createElement("div");
		row.className = `menu-item${index === this.active ? " active" : ""}`;
		const head = text("div", "menu-item-head", "");
		head.append(text("span", "menu-check", item.current ? "✓" : ""), text("span", "menu-label", item.label));
		if (item.description) head.append(text("span", "menu-description", item.description));
		row.append(head);
		if (item.detail) row.append(text("div", "menu-detail", item.detail));
		row.addEventListener("mouseenter", () => {
			if (this.active === index) return;
			this.active = index;
			for (const other of this.host.querySelectorAll(".menu-item.active")) other.classList.remove("active");
			row.classList.add("active");
		});
		// mousedown keeps focus in the composer for / and @ menus.
		row.addEventListener("mousedown", (event) => {
			event.preventDefault();
			this.select(item);
		});
		return row;
	}

	private matches(item: MenuItem): boolean {
		if (!this.filterText) return true;
		return [item.label, item.description, item.detail].some((part) => part?.toLowerCase().includes(this.filterText));
	}

	private countVisible(sections: MenuSection[]): number {
		return sections.reduce((sum, section) => sum + section.items.filter((item) => this.matches(item)).length, 0);
	}
}

function text(tag: string, className: string, content: string): HTMLElement {
	const node = document.createElement(tag);
	node.className = className;
	node.textContent = content;
	return node;
}
