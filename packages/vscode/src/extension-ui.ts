import { basename } from "node:path";
import * as vscode from "vscode";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../../coding-agent/src/modes/rpc/rpc-types.ts";
import { ACCEPT, type FileChangeMetadata, isFileChangeMetadata, REJECT } from "./file-change.ts";

const PROPOSED_SCHEME = "pi-proposed";
const REVIEW_CONTEXT = "pi.reviewPending";

type DialogRequest = Extract<RpcExtensionUIRequest, { method: "select" | "confirm" | "input" | "editor" }>;

export interface ExtensionUIHost {
	respond(response: RpcExtensionUIResponse): void;
	/** Put text in the chat composer. */
	setInput(text: string): void;
	/** Show or clear a transient chat status such as a pending review. */
	setStatus(status: string | undefined): void;
	log(line: string): void;
}

/**
 * Maps pi extension UI requests to native VS Code UI. Dialogs are shown one at a time, in order.
 * A select request carrying file change metadata becomes a diff review with Accept and Reject.
 */
export class ExtensionUIBridge implements vscode.Disposable {
	private readonly host: ExtensionUIHost;
	private readonly proposed = new Map<string, string>();
	private readonly statusItems = new Map<string, vscode.StatusBarItem>();
	private readonly disposables: vscode.Disposable[];
	private queue: Promise<void> = Promise.resolve();
	private readonly open = new Set<vscode.CancellationTokenSource>();
	private decide: ((choice: string | undefined) => void) | undefined;
	private nextId = 0;

	constructor(host: ExtensionUIHost) {
		this.host = host;
		this.disposables = [
			vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
				provideTextDocumentContent: (uri) => this.proposed.get(uri.query) ?? "",
			}),
		];
	}

	handle(request: RpcExtensionUIRequest): void {
		switch (request.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
				this.queue = this.queue.then(() => this.runDialog(request));
				return;
			case "notify": {
				const show =
					request.notifyType === "error"
						? vscode.window.showErrorMessage
						: request.notifyType === "warning"
							? vscode.window.showWarningMessage
							: vscode.window.showInformationMessage;
				void show(`Pi: ${request.message}`);
				return;
			}
			case "setStatus":
				this.setStatusItem(request.statusKey, request.statusText);
				return;
			case "set_editor_text":
				this.host.setInput(request.text);
				return;
			case "setWidget":
			case "setTitle":
				// No VS Code surface yet; keep them visible in the log.
				this.host.log(`extension UI ${request.method}: ${JSON.stringify(request)}`);
				return;
		}
	}

	/** Answer from the Accept and Reject buttons of the review diff editor. */
	resolveReview(choice: typeof ACCEPT | typeof REJECT): void {
		this.decide?.(choice);
	}

	/** Dismiss open dialogs, for example when the run they belong to ended. pi has already resolved them. */
	cancelAll(): void {
		for (const source of this.open) source.cancel();
	}

	dispose(): void {
		this.cancelAll();
		for (const item of this.statusItems.values()) item.dispose();
		for (const disposable of this.disposables) disposable.dispose();
	}

	private async runDialog(request: DialogRequest): Promise<void> {
		const source = new vscode.CancellationTokenSource();
		this.open.add(source);
		const timeout =
			"timeout" in request && request.timeout ? setTimeout(() => source.cancel(), request.timeout) : undefined;
		try {
			const response = await this.showDialog(request, source.token);
			// After a timeout or cancellation pi has already resolved the dialog itself.
			if (!source.token.isCancellationRequested)
				this.host.respond({ type: "extension_ui_response", id: request.id, ...response });
		} catch (error) {
			this.host.log(
				`extension UI ${request.method} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (!source.token.isCancellationRequested) {
				this.host.respond({ type: "extension_ui_response", id: request.id, cancelled: true });
			}
		} finally {
			clearTimeout(timeout);
			this.open.delete(source);
			source.dispose();
		}
	}

	private async showDialog(
		request: DialogRequest,
		token: vscode.CancellationToken,
	): Promise<{ value: string } | { confirmed: boolean } | { cancelled: true }> {
		switch (request.method) {
			case "select": {
				const value = isFileChangeMetadata(request.metadata)
					? await this.reviewChange(request.metadata, token)
					: await vscode.window.showQuickPick(
							request.options,
							{ title: request.title, ignoreFocusOut: true },
							token,
						);
				return value === undefined ? { cancelled: true } : { value };
			}
			case "confirm": {
				const choice = await vscode.window.showWarningMessage(
					request.title,
					{ modal: true, detail: request.message },
					"Yes",
					"No",
				);
				return choice === undefined ? { cancelled: true } : { confirmed: choice === "Yes" };
			}
			case "input": {
				const value = await vscode.window.showInputBox(
					{ title: request.title, placeHolder: request.placeholder, ignoreFocusOut: true },
					token,
				);
				return value === undefined ? { cancelled: true } : { value };
			}
			case "editor":
				return this.editText(request.title, request.prefill ?? "");
		}
	}

	/** Show pi's proposed content against the file on disk and wait for Accept or Reject. */
	private async reviewChange(
		change: FileChangeMetadata,
		token: vscode.CancellationToken,
	): Promise<string | undefined> {
		const id = String(++this.nextId);
		this.proposed.set(id, change.content);
		const target = vscode.Uri.file(change.path);
		const proposed = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: change.path, query: id });
		const exists = await vscode.workspace.fs.stat(target).then(
			() => true,
			() => false,
		);
		const original = exists
			? target
			: vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: change.path, query: "empty" });
		const label = vscode.workspace.asRelativePath(target, false);

		const decision = new Promise<string | undefined>((resolve) => {
			this.decide = resolve;
			token.onCancellationRequested(() => resolve(undefined));
		});
		try {
			this.host.setStatus(`Review ${change.tool} of ${label}`);
			await vscode.commands.executeCommand("setContext", REVIEW_CONTEXT, true);
			await vscode.commands.executeCommand(
				"vscode.diff",
				original,
				proposed,
				`${basename(change.path)}: pi's proposed ${change.tool}${exists ? "" : " (new file)"}`,
				{ preview: false },
			);
			void vscode.window
				.showInformationMessage(
					`pi wants to ${change.tool} ${label}.`,
					{ detail: "Review the diff." },
					ACCEPT,
					REJECT,
				)
				.then((choice) => {
					if (choice) this.decide?.(choice);
				});
			return await decision;
		} finally {
			this.decide = undefined;
			this.proposed.delete(id);
			this.host.setStatus(undefined);
			await vscode.commands.executeCommand("setContext", REVIEW_CONTEXT, false);
			await closeDiff(proposed);
		}
	}

	/** Multi-line editing in an untitled document, submitted or cancelled from a notification. */
	private async editText(title: string, prefill: string): Promise<{ value: string } | { cancelled: true }> {
		const document = await vscode.workspace.openTextDocument({ content: prefill });
		await vscode.window.showTextDocument(document);
		const choice = await vscode.window.showInformationMessage(
			`Pi: ${title}`,
			{ detail: "Edit the text, then submit." },
			"Submit",
			"Cancel",
		);
		const value = document.getText();
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
		return choice === "Submit" ? { value } : { cancelled: true };
	}

	private setStatusItem(key: string, text: string | undefined): void {
		let item = this.statusItems.get(key);
		if (text === undefined) {
			item?.dispose();
			this.statusItems.delete(key);
			return;
		}
		if (!item) {
			item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
			this.statusItems.set(key, item);
		}
		item.text = text;
		item.tooltip = `pi extension status: ${key}`;
		item.show();
	}
}

async function closeDiff(proposed: vscode.Uri): Promise<void> {
	const tabs = vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.filter(
			(tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === proposed.toString(),
		);
	if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
}
