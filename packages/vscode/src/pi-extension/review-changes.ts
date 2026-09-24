/**
 * pi extension loaded by the VS Code extension (setting `pi.reviewChanges`). It replaces the built-in
 * edit and write tools with copies whose final write first asks the client to review the exact new
 * content. Rejecting, dismissing or aborting fails the tool call before the file is touched.
 */
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ACCEPT, FILE_CHANGE_KIND, type FileChangeMetadata, REJECT } from "../file-change.ts";

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		...createEditToolDefinition(process.cwd()),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = createEditToolDefinition(ctx.cwd, {
				operations: {
					readFile: (path) => readFile(path),
					access: (path) => access(path, constants.R_OK | constants.W_OK),
					writeFile: async (path, content) => {
						await review(ctx, "edit", path, content, signal);
						await writeFile(path, content, "utf-8");
					},
				},
			});
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...createWriteToolDefinition(process.cwd()),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = createWriteToolDefinition(ctx.cwd, {
				operations: {
					// Directories are created only after the change is accepted.
					mkdir: async () => {},
					writeFile: async (path, content) => {
						await review(ctx, "write", path, content, signal);
						await mkdir(dirname(path), { recursive: true });
						await writeFile(path, content, "utf-8");
					},
				},
			});
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}

async function review(
	ctx: ExtensionContext,
	tool: FileChangeMetadata["tool"],
	path: string,
	content: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	const metadata: FileChangeMetadata = { kind: FILE_CHANGE_KIND, tool, path, content };
	const choice = await ctx.ui.select(`Apply ${tool} to ${relative(ctx.cwd, path)}?`, [ACCEPT, REJECT], {
		signal,
		metadata: { ...metadata },
	});
	if (choice === ACCEPT) return;
	throw new Error(
		choice === REJECT
			? `The user rejected this change to ${path}. The file was not modified.`
			: `The change to ${path} was not reviewed. The file was not modified.`,
	);
}
