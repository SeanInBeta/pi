import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { Attachment } from "./chat-types.ts";
import { formatProblems, type Problem } from "./prompt-context.ts";

/** Larger files are attached by path only; pi can read them with its own tools. */
const MAX_FILE_CHARS = 100_000;
const MAX_PROBLEMS = 100;

/** One attachment per non-empty selection in the editor. */
export function selectionAttachments(editor: vscode.TextEditor): Attachment[] {
	const document = editor.document;
	const path = displayPath(document.uri);
	return editor.selections
		.filter((selection) => !selection.isEmpty)
		.map((selection) => {
			const start = selection.start.line + 1;
			// A selection ending at column 0 does not include that line.
			const end =
				selection.end.character === 0 && selection.end.line > selection.start.line
					? selection.end.line
					: selection.end.line + 1;
			return {
				id: randomUUID(),
				kind: "selection",
				label: start === end ? `${path}:${start}` : `${path}:${start}-${end}`,
				path,
				lines: { start, end },
				language: document.languageId,
				content: document.getText(selection),
				note: document.isDirty ? "unsaved changes" : undefined,
			};
		});
}

/** The document's current text, including unsaved edits. */
export function fileAttachment(document: vscode.TextDocument): Attachment {
	const path = displayPath(document.uri);
	const text = document.getText();
	const tooLarge = text.length > MAX_FILE_CHARS;
	const notes = [
		document.isDirty ? "unsaved changes" : undefined,
		tooLarge ? `${text.length} characters, too large to include; read it from disk` : undefined,
	].filter(Boolean);
	return {
		id: randomUUID(),
		kind: "file",
		label: path,
		path,
		language: document.languageId,
		content: tooLarge ? "" : text,
		note: notes.length > 0 ? notes.join("; ") : undefined,
	};
}

/**
 * Errors and warnings for one document, or errors across the workspace when no document is given.
 * Returns undefined when there is nothing to attach.
 */
export async function diagnosticsAttachment(
	document: vscode.TextDocument | undefined,
): Promise<Attachment | undefined> {
	const worst = document ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
	const all: [vscode.Uri, vscode.Diagnostic[]][] = document
		? [[document.uri, vscode.languages.getDiagnostics(document.uri)]]
		: vscode.languages.getDiagnostics();
	const entries = all.map(([uri, diagnostics]): [vscode.Uri, vscode.Diagnostic[]] => [
		uri,
		diagnostics.filter((diagnostic) => diagnostic.severity <= worst),
	]);

	const sections: string[] = [];
	let count = 0;
	for (const [uri, diagnostics] of entries) {
		const selected = diagnostics.slice(0, MAX_PROBLEMS - count);
		if (selected.length === 0) continue;
		const source = document ?? (await vscode.workspace.openTextDocument(uri));
		sections.push(
			formatProblems(
				displayPath(uri),
				selected.map((diagnostic) => toProblem(diagnostic, source)),
			),
		);
		count += selected.length;
		if (count >= MAX_PROBLEMS) break;
	}
	if (count === 0) return undefined;

	const total = entries.reduce((sum, [, diagnostics]) => sum + diagnostics.length, 0);
	const path = document ? displayPath(document.uri) : "workspace";
	return {
		id: randomUUID(),
		kind: "diagnostics",
		label: `${path} (${total})`,
		path,
		content: sections.join("\n"),
		note: total > count ? `first ${count} of ${total}` : undefined,
	};
}

function toProblem(diagnostic: vscode.Diagnostic, document: vscode.TextDocument): Problem {
	const { line, character } = diagnostic.range.start;
	const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
	return {
		line: line + 1,
		column: character + 1,
		severity: severityName(diagnostic.severity),
		message: diagnostic.message,
		source: diagnostic.source,
		code: code === undefined ? undefined : String(code),
		lineText: line < document.lineCount ? document.lineAt(line).text.trim() : undefined,
	};
}

function severityName(severity: vscode.DiagnosticSeverity): Problem["severity"] {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error:
			return "error";
		case vscode.DiagnosticSeverity.Warning:
			return "warning";
		case vscode.DiagnosticSeverity.Information:
			return "info";
		case vscode.DiagnosticSeverity.Hint:
			return "hint";
	}
}

/** Workspace-relative path for files inside the workspace, absolute path otherwise. */
function displayPath(uri: vscode.Uri): string {
	return vscode.workspace.asRelativePath(uri, false);
}
