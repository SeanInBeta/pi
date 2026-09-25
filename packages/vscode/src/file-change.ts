/** Dialog metadata the review-changes pi extension attaches to a file change review. Shared by both sides. */

export const FILE_CHANGE_KIND = "pi-vscode.fileChange";
export const COMMAND_KIND = "pi-vscode.command";
export const ACCEPT = "Accept";
export const REJECT = "Reject";

export interface FileChangeMetadata {
	kind: typeof FILE_CHANGE_KIND;
	tool: "edit" | "write";
	/** Absolute path of the file pi wants to write. */
	path: string;
	/** The complete new file content. */
	content: string;
	/** The edit or write call, so the chat shows the review under it. */
	toolCallId?: string;
}

/** A shell command that may delete, move or modify files. */
export interface CommandReviewMetadata {
	kind: typeof COMMAND_KIND;
	tool: "bash" | "powershell";
	command: string;
	/** Why it needs review, for example "deletes files (rm)". */
	reason: string;
	toolCallId: string;
}

export function isCommandReviewMetadata(value: unknown): value is CommandReviewMetadata {
	if (!value || typeof value !== "object") return false;
	const metadata = value as Record<string, unknown>;
	return (
		metadata.kind === COMMAND_KIND &&
		(metadata.tool === "bash" || metadata.tool === "powershell") &&
		typeof metadata.command === "string" &&
		typeof metadata.reason === "string" &&
		typeof metadata.toolCallId === "string"
	);
}

export function isFileChangeMetadata(value: unknown): value is FileChangeMetadata {
	if (!value || typeof value !== "object") return false;
	const metadata = value as Record<string, unknown>;
	return (
		metadata.kind === FILE_CHANGE_KIND &&
		(metadata.tool === "edit" || metadata.tool === "write") &&
		typeof metadata.path === "string" &&
		typeof metadata.content === "string"
	);
}
