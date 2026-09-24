import { join } from "node:path";
import { RpcClient } from "../../coding-agent/src/modes/rpc/rpc-client.ts";

export interface PiLaunchOptions {
	/** Root folder of this extension. */
	extensionPath: string;
	/** Working folder for pi, normally the first workspace folder. */
	cwd: string;
	/** pi CLI entry point run with node. Defaults to the monorepo-local source launcher. */
	cliPath?: string;
	/** Extra pi CLI arguments. */
	args?: string[];
}

/** Create an RPC client for pi. The caller starts and stops it. */
export function createPiClient(options: PiLaunchOptions): RpcClient {
	return new RpcClient({
		cliPath: options.cliPath ?? join(options.extensionPath, "scripts", "pi-dev-rpc.mjs"),
		cwd: options.cwd,
		args: options.args,
	});
}
