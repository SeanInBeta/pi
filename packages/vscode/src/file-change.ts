/** Dialog metadata the review-changes pi extension attaches to a file change review. Shared by both sides. */

export const FILE_CHANGE_KIND = "pi-vscode.fileChange";
export const ACCEPT = "Accept";
export const REJECT = "Reject";

export interface FileChangeMetadata {
	kind: typeof FILE_CHANGE_KIND;
	tool: "edit" | "write";
	/** Absolute path of the file pi wants to write. */
	path: string;
	/** The complete new file content. */
	content: string;
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
