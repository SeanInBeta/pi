import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createChatState, reduceChat } from "../src/chat-state.ts";
import { createPiClient, devRuntime } from "../src/pi-launch.ts";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));
const smokeProvider = fileURLToPath(new URL("./fixtures/smoke-provider.ts", import.meta.url));

describe("sessions through the source launcher", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("lists, switches to, and forks a saved session", async () => {
		root = mkdtempSync(join(tmpdir(), "pi-vscode-sessions-"));
		const client = createPiClient({
			runtime: devRuntime(extensionPath),
			cwd: root,
			args: [
				"--session-dir",
				join(root, "sessions"),
				"--extension",
				smokeProvider,
				"--provider",
				"smoke",
				"--model",
				"faux-1",
			],
		});
		try {
			await client.start();
			await client.promptAndWait("first question", undefined, 30_000);
			const { sessionFile } = await client.getState();

			await client.newSession();
			expect((await client.getState()).messageCount).toBe(0);

			const sessions = await client.listSessions();
			expect(sessions.map((session) => [session.path, session.firstMessage])).toContainEqual([
				sessionFile,
				"first question",
			]);

			await client.switchSession(sessionFile!);
			const state = reduceChat(createChatState(), { type: "load_messages", messages: await client.getMessages() });
			expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant", "assistant"]);
			expect(state.items[0]).toEqual({ kind: "user", text: "first question" });
			expect(state.items.map((item) => item.kind === "assistant" && item.done === true)).toEqual([
				false,
				false,
				true,
			]);
			const toolTurn = state.items[1];
			expect(toolTurn?.kind === "assistant" ? Object.values(toolTurn.tools).map((run) => run.status) : []).toEqual([
				"done",
			]);

			const [forkPoint] = await client.getForkMessages();
			const fork = await client.fork(forkPoint!.entryId);
			expect(fork).toEqual({ text: "first question", cancelled: false });
			expect((await client.getState()).sessionFile).not.toBe(sessionFile);
		} finally {
			await client.stop();
		}
	}, 60_000);
});
