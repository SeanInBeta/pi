/**
 * Menu items for sessions, models, forks, commands and files. Used by the in-panel menus and the
 * command palette QuickPicks; kept free of the vscode module so they can be tested.
 */
import type { ModelInfo } from "../../coding-agent/src/modes/rpc/rpc-client.ts";
import type { RpcSessionSummary, RpcSlashCommand } from "../../coding-agent/src/modes/rpc/rpc-types.ts";
import { fuzzyFilter } from "../../tui/src/fuzzy.ts";
import type { MenuItem } from "./chat-types.ts";

const MAX_FILES = 50;

/** Most recently modified first. */
export function sessionItems(sessions: readonly RpcSessionSummary[], currentPath: string | undefined): MenuItem[] {
	return [...sessions]
		.sort((a, b) => b.modified.localeCompare(a.modified))
		.map((session) => ({
			label: sessionTitle(session) ?? "(no messages)",
			detail: `${session.messageCount} messages · ${formatDate(session.modified)}`,
			value: session.path,
			current: session.path === currentPath,
		}));
}

/** A session's name, or the first line of its first message. */
export function sessionTitle(session: Pick<RpcSessionSummary, "name" | "firstMessage">): string | undefined {
	return session.name ?? firstLine(session.firstMessage);
}

/** The current model first, then the others in pi's order. Values are `{ provider, id }` as JSON. */
export function modelItems(
	models: readonly ModelInfo[],
	current: { provider: string; id: string } | undefined,
): MenuItem[] {
	const isCurrent = (model: ModelInfo) => model.provider === current?.provider && model.id === current?.id;
	return [...models.filter(isCurrent), ...models.filter((model) => !isCurrent(model))].map((model) => ({
		label: model.id,
		description: model.provider,
		detail: `${Math.round(model.contextWindow / 1000)}k context${model.reasoning ? " · reasoning" : ""}`,
		value: JSON.stringify({ provider: model.provider, id: model.id }),
		current: isCurrent(model),
	}));
}

export function thinkingLevelItems(levels: readonly string[], current: string | undefined): MenuItem[] {
	return levels.map((level) => ({ label: level, value: level, current: level === current }));
}

/** Newest user message first. Forking starts a new session from before the picked message. */
export function forkItems(messages: readonly { entryId: string; text: string }[]): MenuItem[] {
	return [...messages].reverse().map((message) => {
		const [first, ...rest] = message.text.split("\n");
		return {
			label: truncate(first ?? ""),
			detail: rest.length > 0 ? truncate(rest.join(" ")) : undefined,
			value: message.entryId,
		};
	});
}

/** pi's extension, prompt template and skill commands. The value is the command name. */
export function commandItems(commands: readonly RpcSlashCommand[]): MenuItem[] {
	return commands.map((command) => ({
		label: `/${command.name}`,
		description: command.description,
		detail: command.source,
		value: command.name,
	}));
}

/** Best fuzzy matches for an @ mention, using the same matcher as pi's terminal UI. */
export function fileItems(paths: readonly string[], query: string): MenuItem[] {
	const matches = query
		? fuzzyFilter([...paths], query, (path) => path)
		: [...paths].sort((a, b) => a.length - b.length);
	return matches.slice(0, MAX_FILES).map((path) => {
		const slash = path.lastIndexOf("/");
		return {
			label: path.slice(slash + 1),
			description: slash === -1 ? undefined : path.slice(0, slash),
			value: path,
		};
	});
}

function firstLine(text: string): string | undefined {
	const line = text.split("\n").find((part) => part.trim().length > 0);
	return line ? truncate(line.trim()) : undefined;
}

function truncate(text: string, max = 80): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
