import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcAuthEvent } from "../src/modes/rpc/rpc-types.ts";

type RpcClientPrivate = {
	handleLine: (line: string) => void;
	process: { stdin: PassThrough; exitCode: number | null } | null;
};

function connect(client: RpcClient): { stdin: PassThrough; internals: RpcClientPrivate } {
	const stdin = new PassThrough();
	const internals = client as unknown as RpcClientPrivate;
	internals.process = { stdin, exitCode: null };
	return { stdin, internals };
}

describe("RpcClient auth", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("delivers auth events to auth listeners only", () => {
		const client = new RpcClient();
		const authEvents: RpcAuthEvent[] = [];
		const events: unknown[] = [];
		client.onAuthEvent((event) => authEvents.push(event));
		client.onEvent((event) => events.push(event));
		const event = {
			type: "auth_event",
			provider: "anthropic",
			event: { type: "auth_url", url: "https://example.com/login" },
		};

		(client as unknown as RpcClientPrivate).handleLine(JSON.stringify(event));

		expect(authEvents).toEqual([event]);
		expect(events).toEqual([]);
	});

	it("sends login and waits past the normal request timeout", async () => {
		vi.useFakeTimers();
		const client = new RpcClient();
		const { stdin, internals } = connect(client);

		const result = client.login("openai", "api_key");
		const command = JSON.parse(stdin.read().toString());
		expect(command).toMatchObject({ type: "login", provider: "openai", method: "api_key" });

		// Other commands time out after 30 seconds; a login waits for the user.
		await vi.advanceTimersByTimeAsync(60_000);
		const model = { provider: "openai", id: "gpt-5" };
		internals.handleLine(
			JSON.stringify({ id: command.id, type: "response", command: "login", success: true, data: { model } }),
		);
		await expect(result).resolves.toEqual({ model });
	});

	it("rejects a failed login", async () => {
		const client = new RpcClient();
		const { stdin, internals } = connect(client);

		const result = client.login("openai", "api_key");
		const command = JSON.parse(stdin.read().toString());
		internals.handleLine(
			JSON.stringify({
				id: command.id,
				type: "response",
				command: "login",
				success: false,
				error: "Login cancelled",
			}),
		);
		await expect(result).rejects.toThrow("Login cancelled");
	});
});
