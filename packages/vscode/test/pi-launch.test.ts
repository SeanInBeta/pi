import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPiClient } from "../src/pi-launch.ts";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));

describe("createPiClient", () => {
	let cwd: string | undefined;

	afterEach(() => {
		if (cwd) rmSync(cwd, { recursive: true, force: true });
		cwd = undefined;
	});

	it("starts the monorepo-local pi in RPC mode", async () => {
		cwd = mkdtempSync(join(tmpdir(), "pi-vscode-"));
		const client = createPiClient({ extensionPath, cwd, args: ["--no-session"] });
		try {
			await client.start();
			const state = await client.getState();
			expect(state.isStreaming).toBe(false);
			expect(state.messageCount).toBe(0);
		} finally {
			await client.stop();
		}
	}, 60_000);
});
