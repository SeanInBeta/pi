import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcClient } from "../../coding-agent/src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest } from "../../coding-agent/src/modes/rpc/rpc-types.ts";
import { ACCEPT, isCommandReviewMetadata, isFileChangeMetadata, REJECT } from "../src/file-change.ts";
import { createPiClient } from "../src/pi-launch.ts";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));
const reviewExtension = fileURLToPath(new URL("../src/pi-extension/review-changes.ts", import.meta.url));
const smokeProvider = fileURLToPath(new URL("./fixtures/smoke-provider.ts", import.meta.url));

describe("review-changes pi extension", () => {
	let cwd: string | undefined;
	let client: RpcClient | undefined;

	afterEach(async () => {
		await client?.stop();
		if (cwd) rmSync(cwd, { recursive: true, force: true });
		client = undefined;
		cwd = undefined;
	});

	async function start(answer: string): Promise<RpcExtensionUIRequest[]> {
		cwd = mkdtempSync(join(tmpdir(), "pi-vscode-review-"));
		writeFileSync(join(cwd, "sample.ts"), "export function add(a: number, b: number) {\n\treturn a + b;\n}\n");
		const requests: RpcExtensionUIRequest[] = [];
		const started = createPiClient({
			extensionPath,
			cwd,
			args: [
				"--no-session",
				"--extension",
				reviewExtension,
				"--extension",
				smokeProvider,
				"--provider",
				"smoke",
				"--model",
				"faux-1",
			],
		});
		client = started;
		started.onExtensionUIRequest((request) => {
			requests.push(request);
			if (request.method === "select")
				started.sendExtensionUIResponse({ type: "extension_ui_response", id: request.id, value: answer });
		});
		await started.start();
		return requests;
	}

	it("sends the exact new content for review and writes it only after Accept", async () => {
		const requests = await start(ACCEPT);
		const events = await client!.promptAndWait("smoke:edit", undefined, 30_000);

		const [request] = requests;
		expect(request?.method).toBe("select");
		const metadata = request?.method === "select" ? request.metadata : undefined;
		expect(isFileChangeMetadata(metadata)).toBe(true);
		expect(metadata).toMatchObject({
			toolCallId: expect.any(String),
			tool: "edit",
			path: join(cwd!, "sample.ts"),
			content: "export function add(a: number, b: number) {\n\treturn a + b; // reviewed\n}\n",
		});
		expect(readFileSync(join(cwd!, "sample.ts"), "utf8")).toContain("// reviewed");
		expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({ isError: false });
	}, 60_000);

	it("leaves the file untouched and reports an error after Reject", async () => {
		await start(REJECT);
		const events = await client!.promptAndWait("smoke:edit", undefined, 30_000);

		expect(readFileSync(join(cwd!, "sample.ts"), "utf8")).not.toContain("// reviewed");
		const end = events.find((event) => event.type === "tool_execution_end");
		expect(end).toMatchObject({ isError: true });
		expect(JSON.stringify(end)).toContain("The user rejected this change");
	}, 60_000);

	it("reviews a command that deletes a file and blocks it after Reject", async () => {
		const requests = await start(REJECT);
		const events = await client!.promptAndWait("smoke:rm sample.ts", undefined, 30_000);

		expect(existsSync(join(cwd!, "sample.ts"))).toBe(true);
		const request = requests[0];
		const metadata = request?.method === "select" ? request.metadata : undefined;
		expect(isCommandReviewMetadata(metadata)).toBe(true);
		expect(metadata).toMatchObject({ tool: "bash", command: "rm sample.ts", reason: "deletes files (rm)" });
		const end = events.find((event) => event.type === "tool_execution_end");
		expect(end).toMatchObject({ isError: true });
		expect(JSON.stringify(end)).toContain("The user rejected this command");
	}, 60_000);

	it("runs an accepted file-deleting command and leaves read-only commands unreviewed", async () => {
		const requests = await start(ACCEPT);
		await client!.promptAndWait("smoke:rm sample.ts", undefined, 30_000);
		expect(existsSync(join(cwd!, "sample.ts"))).toBe(false);
		expect(requests).toHaveLength(1);

		// The default reply runs `ls`, which needs no review.
		await client!.promptAndWait("hello", undefined, 30_000);
		expect(requests).toHaveLength(1);
	}, 60_000);

	it("does not create directories for a rejected write", async () => {
		await start(REJECT);
		await client!.promptAndWait("smoke:write nested/dir/new.txt", undefined, 30_000);

		expect(existsSync(join(cwd!, "nested"))).toBe(false);
	}, 60_000);
});
