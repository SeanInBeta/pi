import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcExtensionUIRequest } from "../../coding-agent/src/modes/rpc/rpc-types.ts";
import { createPiClient, devRuntime } from "../src/pi-launch.ts";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));

/** Ambient credentials would configure a provider before any login. */
const NO_AMBIENT_AUTH = { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_PROFILE: "", OPENAI_API_KEY: "" };

describe("provider login through pi RPC", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("reports no model, saves an API key, selects a model, and signs out", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-vscode-auth-"));
		const agentDir = join(dir, "agent");
		const runtime = { ...devRuntime(extensionPath), env: { ...NO_AMBIENT_AUTH, PI_CODING_AGENT_DIR: agentDir } };
		const client = createPiClient({ runtime, cwd: dir, args: ["--no-session"] });
		const prompts: RpcExtensionUIRequest[] = [];
		client.onExtensionUIRequest((request) => {
			prompts.push(request);
			client.sendExtensionUIResponse({ type: "extension_ui_response", id: request.id, value: "sk-test-key" });
		});
		try {
			await client.start();
			// No credentials: pi reports a placeholder model, which the panel treats as "no model".
			expect((await client.getState()).model?.provider).toBe("unknown");
			const openai = (await client.getAuthProviders()).find((provider) => provider.id === "openai");
			expect(openai).toMatchObject({ apiKey: true, configured: false });

			const result = await client.login("openai", "api_key");

			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toMatchObject({
				method: "input",
				metadata: { kind: "pi.auth", provider: "openai", promptType: "secret" },
			});
			expect(result.model?.provider).toBe("openai");
			expect((await client.getState()).model?.provider).toBe("openai");
			expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).openai).toMatchObject({
				type: "api_key",
			});
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
				defaultProvider: "openai",
			});

			await client.logout("openai");
			expect((await client.getAuthProviders()).find((provider) => provider.id === "openai")?.configured).toBe(false);
		} finally {
			await client.stop();
		}
	}, 90_000);

	it("fails a cancelled login", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-vscode-auth-"));
		const runtime = {
			...devRuntime(extensionPath),
			env: { ...NO_AMBIENT_AUTH, PI_CODING_AGENT_DIR: join(dir, "a") },
		};
		const client = createPiClient({ runtime, cwd: dir, args: ["--no-session"] });
		client.onExtensionUIRequest((request) =>
			client.sendExtensionUIResponse({ type: "extension_ui_response", id: request.id, cancelled: true }),
		);
		try {
			await client.start();
			await expect(client.login("openai", "api_key")).rejects.toThrow("Login cancelled");
			expect((await client.getAuthProviders()).find((provider) => provider.id === "openai")?.configured).toBe(false);
		} finally {
			await client.stop();
		}
	}, 90_000);
});
