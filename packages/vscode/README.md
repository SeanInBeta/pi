# pi-vscode

Experimental VS Code extension for pi. Private, not published.

Spawns pi in [RPC mode](../coding-agent/docs/rpc.md) for the first workspace folder and shows a chat panel in the Pi activity bar view. The raw event stream is also written to the `Pi` output channel.

## Chat panel

- Enter sends, Shift+Enter inserts a new line. While pi is working, Send becomes Steer and queues a steering message.
- Assistant text streams in as plain text. Thinking and tool calls are collapsible; a tool call shows its main argument (command or path), its raw arguments, and its output.
- Abort stops the current run. Errors from pi (failed requests, retries that gave up, rejected commands) appear in the transcript.
- pi starts on the first message. Each start begins a new session, so the transcript is cleared.

Code layout:

| File | Role |
|---|---|
| `src/chat-state.ts` | Pure reducer from pi RPC events to transcript items, plus the diff sent to the webview |
| `src/chat-view.ts` | Webview view provider; keeps the transcript and replays it when the webview reloads |
| `src/webview/main.ts` | Webview renderer (plain DOM, no framework), typechecked by `tsconfig.webview.json` |

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

Run the tests (source launcher and chat reducer against the faux provider):

```bash
cd packages/vscode
node ../../node_modules/vitest/dist/cli.js --run
```

## Known limitations

- Extension UI dialogs (`extension_ui_request`) are only logged. A pi extension that waits on a dialog without a timeout blocks until pi is stopped.
- If the pi process exits unexpectedly, run `Pi: Stop` and then `Pi: Start`.
- Markdown is not rendered yet.
