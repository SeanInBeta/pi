import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

describe("RpcClient command option", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("runs the CLI entry with the given executable", async () => {
		dir = mkdtempSync(join(tmpdir(), "rpc-client-command-"));
		// A stand-in CLI that answers get_state with the runtime that started it.
		const cliPath = join(dir, "fake-cli.mjs");
		writeFileSync(
			cliPath,
			`process.stdin.on("data", (chunk) => {
				const { id } = JSON.parse(String(chunk).split("\\n")[0]);
				process.stdout.write(JSON.stringify({ id, type: "response", command: "get_state", success: true, data: { execPath: process.execPath } }) + "\\n");
			});`,
		);
		const client = new RpcClient({ cliPath, command: process.execPath });
		try {
			await client.start();
			const state = (await client.getState()) as unknown as { execPath: string };
			expect(state.execPath).toBe(process.execPath);
		} finally {
			await client.stop();
		}
	});
});
