# pi-vscode

Experimental VS Code extension for pi. Private, not published.

Spawns pi in [RPC mode](../coding-agent/docs/rpc.md) for the first workspace folder and shows a chat panel in the Pi activity bar view. The raw event stream is also written to the `Pi` output channel.

## Chat panel

- Enter sends, Shift+Enter inserts a new line. While pi is working, Send becomes Steer and queues a steering message.
- Assistant text streams in and renders as Markdown: headings, emphasis, lists, task lists, links, inline code, code blocks (no syntax highlighting), blockquotes, and tables. Raw HTML is shown as text, never rendered. Only `http`, `https`, and `mailto` links are clickable; VS Code opens them externally. Thinking and tool calls are collapsible; a tool call shows its main argument (command or path), its raw arguments, and its output.
- Abort stops the current run. Errors from pi (failed requests, retries that gave up, rejected commands) appear in the transcript.
- pi starts on the first message. Each start begins a new session, so the transcript is cleared.

## Sessions and models

pi saves sessions as usual (disable with `"pi.args": ["--no-session"]`). The chat view title bar has New Session, Switch Session and Select Model buttons; the `...` menu adds Fork Session, Rename Session, Select Thinking Level, Stop and Show Log. All are also in the command palette under `Pi:`.

| Command | Action |
|---|---|
| `Pi: New Session` | Start an empty session |
| `Pi: Switch Session` | Pick a saved session of this folder (newest first) and load its transcript |
| `Pi: Fork Session` | Pick an earlier user message; pi starts a new session from before it and the message returns to the composer for editing |
| `Pi: Rename Session` | Set the session name, shown next to the view title |
| `Pi: Select Model` | Pick from the models pi has credentials for |
| `Pi: Select Thinking Level` | Pick from the levels the current model supports |

The status bar shows the model and thinking level; clicking it opens Select Model. Session commands are refused while pi is working. When `pi.args` resumes a session (`--continue`, `--session`), its transcript loads on start.

Saved sessions are listed through the `list_sessions` RPC command, which this branch adds to pi.

## Editor context

Attach context from the editor, then type a message (or send the attachments alone):

| Command | Where | Attaches |
|---|---|---|
| `Pi: Add Selection to Pi Chat` | Editor context menu (with a selection), palette | Each non-empty selection with its line range |
| `Pi: Add File to Pi Chat` | Editor and explorer context menus, palette | The file's current text, including unsaved edits. Files over 100,000 characters are attached by path only |
| `Pi: Add Problems to Pi Chat` | Editor context menu, palette | Errors and warnings of the active file, or errors across the workspace when no file is active (at most 100) |

Attachments appear as chips above the input and can be removed before sending. A sent message shows the typed text with its attachments as expandable chips. pi receives each attachment as a labeled block before the message, for example:

````
Selected code from src/a.ts lines 10-20:
```typescript
...
```

Problems reported by VS Code in src/a.ts:
- src/a.ts:1:7 error [ts 2322]: Type 'string' is not assignable to type 'number'.
  | const x: number = "oops";

Why does this fail?
````

Code layout:

| File | Role |
|---|---|
| `src/chat-state.ts` | Pure reducer from pi RPC events to transcript items, plus the diff sent to the webview |
| `src/chat-view.ts` | Webview view provider; keeps the transcript and replays it when the webview reloads |
| `src/editor-context.ts` | Builds attachments from selections, documents, and diagnostics |
| `src/prompt-context.ts` | Formats attachments into the prompt text (pure, tested) |
| `src/quick-picks.ts` | QuickPick items for sessions, models, forks and thinking levels (pure, tested) |
| `src/webview/main.ts` | Webview renderer (plain DOM, no framework), typechecked by `tsconfig.webview.json` |
| `src/webview/markdown.ts` | Markdown to DOM using only `marked`'s lexer; nodes are built with `textContent`, never `innerHTML` |

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

To try the extension without an API key, point pi at the scripted provider in `test/fixtures/smoke-provider.ts` (user or workspace settings):

```json
"pi.args": ["--extension", "<repo>/packages/vscode/test/fixtures/smoke-provider.ts", "--provider", "smoke", "--model", "faux-1"]
```

Every message then gets thinking, a reply that lists the attached context blocks, and a `bash ls` tool call, followed by a Markdown summary. The provider has two models: `faux-1` (reasoning) and `faux-2`.

Run the tests (source launcher, sessions against local pi, prompt formatting, quick picks, and chat reducer against the faux provider):

```bash
cd packages/vscode
node ../../node_modules/vitest/dist/cli.js --run
```

## Known limitations

- Extension UI dialogs (`extension_ui_request`) are only logged. A pi extension that waits on a dialog without a timeout blocks until pi is stopped.
- If the pi process exits unexpectedly, run `Pi: Stop` and then `Pi: Start`.
- A reloaded session shows messages sent with attachments as their full prompt text, not as chips.
