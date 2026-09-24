import * as vscode from "vscode";
import type { RpcClient } from "../../coding-agent/src/modes/rpc/rpc-client.ts";
import { createPiClient } from "./pi-launch.ts";

type PiStatus = "stopped" | "starting" | "idle" | "working";

/** Owns one pi RPC process for the first workspace folder and logs its raw event stream. */
class PiController implements vscode.Disposable {
	private readonly extensionPath: string;
	private readonly output = vscode.window.createOutputChannel("Pi");
	private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	private client: RpcClient | undefined;
	private starting: Promise<RpcClient> | undefined;

	constructor(extensionPath: string) {
		this.extensionPath = extensionPath;
		this.statusItem.command = "pi.showLog";
		this.setStatus("stopped");
		this.statusItem.show();
	}

	/** Start pi, or return the running client. Concurrent callers share one process. */
	start(): Promise<RpcClient> {
		if (this.client) return Promise.resolve(this.client);
		this.starting ??= this.spawn().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async stop(): Promise<void> {
		const client = this.client ?? (await this.starting?.catch(() => undefined));
		this.client = undefined;
		if (!client) return;
		await client.stop();
		this.output.appendLine("pi stopped");
		this.setStatus("stopped");
	}

	async prompt(): Promise<void> {
		const message = await vscode.window.showInputBox({ prompt: "Message for pi" });
		if (!message) return;
		const client = await this.start();
		this.output.show(true);
		await client.prompt(message);
	}

	async abort(): Promise<void> {
		await this.client?.abort();
	}

	showLog(): void {
		this.output.show();
	}

	/** Run a command handler and report failures instead of dropping them. */
	async run(action: () => Promise<unknown>): Promise<void> {
		try {
			await action();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`error: ${message}`);
			void vscode.window.showErrorMessage(`Pi: ${message.split("\n")[0]}`);
		}
	}

	/** The process is stopped by deactivate(), which VS Code awaits. */
	dispose(): void {
		this.statusItem.dispose();
		this.output.dispose();
	}

	private async spawn(): Promise<RpcClient> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) throw new Error("Open a folder before starting pi");

		const config = vscode.workspace.getConfiguration("pi");
		const client = createPiClient({
			extensionPath: this.extensionPath,
			cwd,
			cliPath: config.get<string>("cliPath") || undefined,
			args: config.get<string[]>("args"),
		});
		client.onEvent((event) => {
			this.output.appendLine(JSON.stringify(event));
			if (event.type === "agent_start") this.setStatus("working");
			if (event.type === "agent_settled") this.setStatus("idle");
		});

		this.setStatus("starting");
		try {
			await client.start();
			const state = await client.getState();
			const model = state.model ? `${state.model.provider}/${state.model.id}` : "none";
			this.output.appendLine(`pi started in ${cwd} (model: ${model})`);
		} catch (error) {
			await client.stop();
			this.setStatus("stopped");
			throw error;
		}
		this.client = client;
		this.setStatus("idle");
		return client;
	}

	private setStatus(status: PiStatus): void {
		const icon = status === "working" || status === "starting" ? "$(loading~spin)" : "$(hubot)";
		this.statusItem.text = `${icon} pi: ${status}`;
		this.statusItem.tooltip = "Show pi log";
	}
}

let controller: PiController | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const pi = new PiController(context.extensionPath);
	controller = pi;
	context.subscriptions.push(
		pi,
		vscode.commands.registerCommand("pi.start", () => pi.run(() => pi.start())),
		vscode.commands.registerCommand("pi.stop", () => pi.run(() => pi.stop())),
		vscode.commands.registerCommand("pi.prompt", () => pi.run(() => pi.prompt())),
		vscode.commands.registerCommand("pi.abort", () => pi.run(() => pi.abort())),
		vscode.commands.registerCommand("pi.showLog", () => pi.showLog()),
	);
}

export async function deactivate(): Promise<void> {
	await controller?.stop();
	controller = undefined;
}
