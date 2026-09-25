import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	bundledRuntime,
	checkRuntime,
	createPiClient,
	devRuntime,
	NodeVersionError,
	supportsPi,
} from "../src/pi-launch.ts";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));

describe("createPiClient", () => {
	let cwd: string | undefined;

	afterEach(() => {
		if (cwd) rmSync(cwd, { recursive: true, force: true });
		cwd = undefined;
	});

	it("starts the monorepo-local pi in RPC mode", async () => {
		cwd = mkdtempSync(join(tmpdir(), "pi-vscode-"));
		const client = createPiClient({ runtime: devRuntime(extensionPath), cwd, args: ["--no-session"] });
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

describe("bundledRuntime", () => {
	const piDir = join("/ext", "dist", "pi");

	it("runs the bundled pi on the extension host's Node when it is new enough", () => {
		const runtime = bundledRuntime("/ext", { execPath: "/vscode/code", nodeVersion: "22.20.0" });
		expect(runtime).toEqual({
			command: "/vscode/code",
			cliPath: join(piDir, "dist", "bundle", "rpc-entry.js"),
			reviewExtension: join("/ext", "dist", "pi-extension", "review-changes.js"),
			env: { PI_PACKAGE_DIR: piDir, ELECTRON_RUN_AS_NODE: "1" },
		});
	});

	it("falls back to node from PATH on an older host Node", () => {
		const runtime = bundledRuntime("/ext", { execPath: "/vscode/code", nodeVersion: "20.18.1" });
		expect(runtime.command).toBe("node");
		expect(runtime.env).toEqual({ PI_PACKAGE_DIR: piDir });
	});

	it("prefers a configured Node", () => {
		const runtime = bundledRuntime("/ext", { execPath: "/vscode/code", nodeVersion: "22.20.0" }, "/opt/node");
		expect(runtime.command).toBe("/opt/node");
		expect(runtime.env).toEqual({ PI_PACKAGE_DIR: piDir });
	});
});

describe("supportsPi", () => {
	it("requires Node 22.19 or newer", () => {
		expect(supportsPi("22.19.0")).toBe(true);
		expect(supportsPi("23.0.0")).toBe(true);
		expect(supportsPi("22.18.9")).toBe(false);
		expect(supportsPi("20.19.0")).toBe(false);
		expect(supportsPi("v22.19.0")).toBe(true);
	});
});

describe("checkRuntime", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("accepts a new enough node", async () => {
		await expect(checkRuntime({ ...devRuntime(extensionPath), command: process.execPath }, "20.0.0")).resolves.toBe(
			undefined,
		);
	});

	it("trusts VS Code's own Node without running it", async () => {
		const runtime = bundledRuntime("/ext", { execPath: "/missing/code", nodeVersion: "22.20.0" });
		await expect(checkRuntime(runtime, "22.20.0")).resolves.toBe(undefined);
	});

	it("reports a missing node", async () => {
		const runtime = { ...devRuntime(extensionPath), command: "/missing/node" };
		const check = checkRuntime(runtime, "20.18.0");
		await expect(check).rejects.toBeInstanceOf(NodeVersionError);
		await expect(check).rejects.toThrow(
			'"/missing/node" could not be run. VS Code\'s built-in Node.js 20.18.0 is too old.',
		);
	});

	it.skipIf(process.platform === "win32")("reports a too old node", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-node-"));
		const oldNode = join(dir, "node");
		writeFileSync(oldNode, "#!/bin/sh\necho v20.11.0\n");
		chmodSync(oldNode, 0o755);
		await expect(checkRuntime({ ...devRuntime(extensionPath), command: oldNode }, "22.20.0")).rejects.toThrow(
			`"${oldNode}" is v20.11.0.`,
		);
	});
});
