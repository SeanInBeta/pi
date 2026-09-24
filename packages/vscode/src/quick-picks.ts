/**
 * QuickPick items for sessions, models, forks and thinking levels. Plain objects compatible with
 * vscode.QuickPickItem, kept free of the vscode module so they can be tested.
 */
import type { ModelInfo } from "../../coding-agent/src/modes/rpc/rpc-client.ts";
import type { RpcSessionSummary } from "../../coding-agent/src/modes/rpc/rpc-types.ts";

export interface PickItem<T> {
	label: string;
	description?: string;
	detail?: string;
	value: T;
}

const CURRENT = "$(check) ";

/** Most recently modified first; the current session is marked. */
export function sessionItems(
	sessions: readonly RpcSessionSummary[],
	currentPath: string | undefined,
): PickItem<string>[] {
	return [...sessions]
		.sort((a, b) => b.modified.localeCompare(a.modified))
		.map((session) => ({
			label: `${session.path === currentPath ? CURRENT : ""}${session.name ?? firstLine(session.firstMessage) ?? "(no messages)"}`,
			description: `${session.messageCount} messages · ${formatDate(session.modified)}`,
			detail: session.name ? firstLine(session.firstMessage) : undefined,
			value: session.path,
		}));
}

/** The current model first, then the others in pi's order. */
export function modelItems(
	models: readonly ModelInfo[],
	current: { provider: string; id: string } | undefined,
): PickItem<{ provider: string; id: string }>[] {
	const isCurrent = (model: ModelInfo) => model.provider === current?.provider && model.id === current?.id;
	return [...models.filter(isCurrent), ...models.filter((model) => !isCurrent(model))].map((model) => ({
		label: `${isCurrent(model) ? CURRENT : ""}${model.id}`,
		description: model.provider,
		detail: `${Math.round(model.contextWindow / 1000)}k context${model.reasoning ? " · reasoning" : ""}`,
		value: { provider: model.provider, id: model.id },
	}));
}

export function thinkingLevelItems<T extends string>(levels: readonly T[], current: T): PickItem<T>[] {
	return levels.map((level) => ({ label: `${level === current ? CURRENT : ""}${level}`, value: level }));
}

/** Newest user message first. Forking starts a new session from before the picked message. */
export function forkItems(messages: readonly { entryId: string; text: string }[]): PickItem<string>[] {
	return [...messages].reverse().map((message) => {
		const [first, ...rest] = message.text.split("\n");
		return {
			label: truncate(first ?? ""),
			detail: rest.length > 0 ? truncate(rest.join(" ")) : undefined,
			value: message.entryId,
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
