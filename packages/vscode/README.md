# pi-vscode

Experimental VS Code extension for pi. Private, not published.

Phase 1 spawns pi in [RPC mode](../coding-agent/docs/rpc.md) for the first workspace folder and writes the raw event stream to the `Pi` output channel.

## Commands

| Command | Action |
|---|---|
| `Pi: Start` | Start pi for the first workspace folder |
| `Pi: Send Prompt` | Ask for a message and send it as a `prompt` command (starts pi if needed) |
| `Pi: Abort` | Abort the current run |
| `Pi: Stop` | Stop the pi process |
| `Pi: Show Log` | Show the `Pi` output channel (also opened by clicking the status bar item) |

## Settings

- `pi.cliPath`: JavaScript entry of the pi CLI, run with `node`. Empty uses `scripts/pi-dev-rpc.mjs`, which runs `packages/coding-agent/src/cli.ts` from source through `tsx`, so pi does not need to be built.
- `pi.args`: extra pi CLI arguments, for example `["--provider", "anthropic", "--model", "claude-sonnet-5"]`.

## Development

Requires `node` on `PATH` and hydrated model data (`npm run hydrate:model-data` from the repository root).

```bash
npm install --ignore-scripts          # from the repository root
npm --prefix packages/vscode run build
code --extensionDevelopmentPath="$PWD/packages/vscode" /path/to/project
```

Test that the source launcher starts pi in RPC mode:

```bash
cd packages/vscode
node ../../node_modules/vitest/dist/cli.js --run test/pi-launch.test.ts
```

## Known limitations

- Extension UI dialogs (`extension_ui_request`) are only logged. A pi extension that waits on a dialog without a timeout blocks until pi is stopped.
- If the pi process exits unexpectedly, run `Pi: Stop` and then `Pi: Start`.
