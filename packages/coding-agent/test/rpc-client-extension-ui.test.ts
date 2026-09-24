import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.ts";

type RpcClientPrivate = {
	handleLine: (line: string) => void;
	process: { stdin: PassThrough } | null;
};

describe("RpcClient extension UI", () => {
	it("delivers extension UI requests to UI listeners only", () => {
		const client = new RpcClient();
		const requests: RpcExtensionUIRequest[] = [];
		const events: unknown[] = [];
		client.onExtensionUIRequest((request) => requests.push(request));
		client.onEvent((event) => events.push(event));
		const request = {
			type: "extension_ui_request",
			id: "ui-1",
			method: "select",
			title: "Apply?",
			options: ["Accept", "Reject"],
			metadata: { kind: "test" },
		};

		(client as unknown as RpcClientPrivate).handleLine(JSON.stringify(request));
		(client as unknown as RpcClientPrivate).handleLine(JSON.stringify({ type: "agent_start" }));

		expect(requests).toEqual([request]);
		expect(events).toEqual([{ type: "agent_start" }]);
	});

	it("writes dialog responses as JSONL", () => {
		const client = new RpcClient();
		const stdin = new PassThrough();
		(client as unknown as RpcClientPrivate).process = { stdin };

		client.sendExtensionUIResponse({ type: "extension_ui_response", id: "ui-1", value: "Accept" });

		expect(stdin.read()?.toString()).toBe('{"type":"extension_ui_response","id":"ui-1","value":"Accept"}\n');
	});

	it("throws when the client is not started", () => {
		expect(() =>
			new RpcClient().sendExtensionUIResponse({ type: "extension_ui_response", id: "x", cancelled: true }),
		).toThrow("Client not started");
	});
});
