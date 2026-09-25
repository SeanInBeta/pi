/**
 * pi extension loaded by the VS Code extension. It routes every file change through a client review:
 * - edit and write: the built-in tools are replaced with copies whose final write first sends the exact
 *   new content for review;
 * - bash and powershell: commands that may delete, move or modify files are reviewed before they run.
 * Rejecting, dismissing or aborting stops the change before any file is touched. In "Auto edit" mode
 * the client accepts every review at once.
 */
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fileChangeReason } from "../command-review.ts";
import {
	ACCEPT,
	COMMAND_KIND,
	type CommandReviewMetadata,
	FILE_CHANGE_KIND,
	type FileChangeMetadata,
	REJECT,
} from "../file-change.ts";

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		...createEditToolDefinition(process.cwd()),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = createEditToolDefinition(ctx.cwd, {
				operations: {
					readFile: (path) => readFile(path),
					access: (path) => access(path, constants.R_OK | constants.W_OK),
					writeFile: async (path, content) => {
						await review(ctx, "edit", path, content, toolCallId, signal);
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
						await review(ctx, "write", path, content, toolCallId, signal);
						await mkdir(dirname(path), { recursive: true });
						await writeFile(path, content, "utf-8");
					},
				},
			});
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return undefined;
		const reason = fileChangeReason(command);
		if (!reason) return undefined;
		const metadata: CommandReviewMetadata = {
			kind: COMMAND_KIND,
			tool: event.toolName,
			command,
			reason,
			toolCallId: event.toolCallId,
		};
		const choice = await ctx.ui.select(`Run this command? It ${reason}.`, [ACCEPT, REJECT], {
			signal: ctx.signal,
			metadata: { ...metadata },
		});
		if (choice === ACCEPT) return undefined;
		return {
			block: true,
			reason:
				choice === REJECT
					? `The user rejected this command because it ${reason}. Nothing was run.`
					: `This command ${reason} and was not reviewed. Nothing was run.`,
		};
	});
}

async function review(
	ctx: ExtensionContext,
	tool: FileChangeMetadata["tool"],
	path: string,
	content: string,
	toolCallId: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	const metadata: FileChangeMetadata = { kind: FILE_CHANGE_KIND, tool, path, content, toolCallId };
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
