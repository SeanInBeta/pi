import { join } from "node:path";
import { RpcClient } from "../../coding-agent/src/modes/rpc/rpc-client.ts";

/** How to start pi: which runtime runs which entry point, and the matching review extension. */
export interface PiRuntime {
	/** Executable that runs `cliPath`. */
	command: string;
	cliPath: string;
	/** The review-changes pi extension built for this runtime. */
	reviewExtension: string;
	env: Record<string, string>;
}

/** Oldest Node.js that the bundled pi supports (pi's `engines.node`). */
const MIN_NODE = [22, 19] as const;

/** Development (Extension Development Host): pi from this repository's source, through tsx. */
export function devRuntime(extensionPath: string): PiRuntime {
	return {
		command: "node",
		cliPath: join(extensionPath, "scripts", "pi-dev-rpc.mjs"),
		reviewExtension: join(extensionPath, "src", "pi-extension", "review-changes.ts"),
		env: {},
	};
}

/**
 * Installed VSIX: the pi bundled in dist/pi. It runs on VS Code's own Node (the extension host binary in
 * Node mode) when that is new enough, otherwise on `nodePath` or `node` from PATH.
 */
export function bundledRuntime(
	extensionPath: string,
	host: { execPath: string; nodeVersion: string },
	nodePath?: string,
): PiRuntime {
	const piDir = join(extensionPath, "dist", "pi");
	const useHost = !nodePath && supportsPi(host.nodeVersion);
	return {
		command: nodePath || (useHost ? host.execPath : "node"),
		cliPath: join(piDir, "dist", "bundle", "rpc-entry.js"),
		reviewExtension: join(extensionPath, "dist", "pi-extension", "review-changes.js"),
		// pi finds its package.json, themes and docs through PI_PACKAGE_DIR.
		env: { PI_PACKAGE_DIR: piDir, ...(useHost ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
	};
}

export function supportsPi(nodeVersion: string): boolean {
	const [major = 0, minor = 0] = nodeVersion.split(".").map(Number);
	return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

export interface PiLaunchOptions {
	runtime: PiRuntime;
	/** Working folder for pi, normally the first workspace folder. */
	cwd: string;
	/** Extra pi CLI arguments. */
	args?: string[];
}

/** Create an RPC client for pi. The caller starts and stops it. */
export function createPiClient(options: PiLaunchOptions): RpcClient {
	return new RpcClient({
		command: options.runtime.command,
		cliPath: options.runtime.cliPath,
		cwd: options.cwd,
		env: options.runtime.env,
		args: options.args,
	});
}
