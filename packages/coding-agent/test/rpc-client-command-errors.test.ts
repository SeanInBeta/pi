import { describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
};

describe("RpcClient command errors", () => {
	it("rejects when a command without result data fails", async () => {
		const client = new RpcClient();
		(client as unknown as RpcClientPrivate).send = async (command) => ({
			type: "response",
			command: command.type,
			success: false,
			error: "No API key found for the selected model.",
		});

		await expect(client.prompt("hello")).rejects.toThrow("No API key found for the selected model.");
		await expect(client.abort()).rejects.toThrow("No API key found for the selected model.");
	});

	it("resolves when a command without result data succeeds", async () => {
		const client = new RpcClient();
		(client as unknown as RpcClientPrivate).send = async (command) => ({
			type: "response",
			command: command.type,
			success: true,
		});

		await expect(client.prompt("hello")).resolves.toBeUndefined();
	});
});
