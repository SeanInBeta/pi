import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bundledRuntime, createPiClient, devRuntime, supportsPi } from "../src/pi-launch.ts";

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
	});
});
