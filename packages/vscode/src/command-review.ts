/**
 * Decides whether a shell command may delete, move or modify files, so "Ask for approval" can review it
 * before it runs. Used inside pi by the review-changes extension; free of vscode and DOM APIs.
 *
 * It is a heuristic over the command text: it catches the common file-changing commands, redirects and
 * flags of bash, cmd and PowerShell, but cannot see what a script or program does internally.
 */

const DELETE = new Set(["rm", "rmdir", "unlink", "shred", "del", "erase", "rd", "remove-item", "ri"]);
const MOVE = new Set(["mv", "move", "ren", "rename", "move-item", "mi", "rename-item", "rni"]);
const WRITE = new Set([
	"cp",
	"copy",
	"xcopy",
	"robocopy",
	"dd",
	"truncate",
	"touch",
	"mkdir",
	"md",
	"ln",
	"mklink",
	"install",
	"rsync",
	"tee",
	"patch",
	"chmod",
	"chown",
	"chgrp",
	"copy-item",
	"cpi",
	"new-item",
	"ni",
	"set-content",
	"sc",
	"add-content",
	"ac",
	"out-file",
	"clear-content",
	"clc",
	"tee-object",
	"expand-archive",
	"compress-archive",
]);
const GIT_CHANGES = new Set([
	"checkout",
	"switch",
	"restore",
	"reset",
	"clean",
	"rm",
	"mv",
	"apply",
	"am",
	"stash",
	"pull",
	"merge",
	"rebase",
	"cherry-pick",
	"revert",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_CHANGES = new Set([
	"install",
	"i",
	"add",
	"remove",
	"rm",
	"uninstall",
	"un",
	"update",
	"up",
	"upgrade",
	"ci",
	"link",
]);
/** Words that run the next word as the actual command. */
const PREFIXES = new Set(["sudo", "command", "builtin", "exec", "nohup", "time", "env", "xargs", "doas"]);
const NULL_TARGETS = new Set(["/dev/null", "nul", "$null"]);

/** A short reason such as "deletes files (rm)", or undefined when the command looks read-only. */
export function fileChangeReason(command: string): string | undefined {
	const redirect = outputRedirect(command);
	if (redirect) return `writes to a file (> ${redirect})`;
	for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
		const reason = segmentReason(segment.trim());
		if (reason) return reason;
	}
	return undefined;
}

function segmentReason(segment: string): string | undefined {
	const words = segment.split(/\s+/).filter(Boolean);
	let index = 0;
	// Skip variable assignments (FOO=bar), wrappers (sudo, env, xargs) and their flags.
	while (index < words.length) {
		const word = words[index]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word.startsWith("-") || PREFIXES.has(word)) index++;
		else break;
	}
	const name = commandName(words[index]);
	if (!name) return undefined;
	const args = words.slice(index + 1);
	if (DELETE.has(name)) return `deletes files (${name})`;
	if (MOVE.has(name)) return `moves or renames files (${name})`;
	if (WRITE.has(name)) return `writes files (${name})`;
	if ((name === "sed" || name === "perl") && args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg === "--in-place")) {
		return `edits files in place (${name} -i)`;
	}
	if (name === "find" && args.some((arg) => arg === "-delete" || arg === "-exec" || arg === "-execdir")) {
		return "changes files found by find (-delete or -exec)";
	}
	if (name === "git") {
		// -C <path> and -c <name=value> take a value before the subcommand.
		const subcommand = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "-C" && args[i - 1] !== "-c");
		if (subcommand && GIT_CHANGES.has(subcommand)) return `changes files with git ${subcommand}`;
	}
	if (PACKAGE_MANAGERS.has(name)) {
		const subcommand = args.find((arg) => !arg.startsWith("-"));
		if (subcommand && PACKAGE_CHANGES.has(subcommand)) return `changes dependencies (${name} ${subcommand})`;
	}
	if ((name === "pip" || name === "pip3") && args.some((arg) => arg === "install" || arg === "uninstall")) {
		return `changes installed packages (${name})`;
	}
	return undefined;
}

/** `/usr/bin/rm` and `Remove-Item.exe` become `rm` and `remove-item`. */
function commandName(word: string | undefined): string | undefined {
	if (!word) return undefined;
	const base =
		word
			.replace(/^["']|["']$/g, "")
			.split(/[\\/]/)
			.pop() ?? "";
	return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, "") || undefined;
}

/** The target of the first `>` or `>>` output redirect, ignoring `2>&1` and redirects to the null device. */
function outputRedirect(command: string): string | undefined {
	const pattern = /(?:^|[^<>&=\d-])\d?>>?(?![&=])\s*("[^"]*"|'[^']*'|[^\s|;&<>()]+)/g;
	for (let match = pattern.exec(command); match; match = pattern.exec(command)) {
		const target = match[1]!.replace(/^["']|["']$/g, "");
		if (!NULL_TARGETS.has(target.toLowerCase())) return target;
	}
	return undefined;
}
