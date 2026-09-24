# pi-vscode

Experimental VS Code extension for pi. Private, not published.

Spawns pi in [RPC mode](../coding-agent/docs/rpc.md) for the first workspace folder and shows a chat panel in the Pi activity bar view. The raw event stream is also written to the `Pi` output channel.

## Chat panel

- The panel header shows the session name (or its first message) with New Session and session menu buttons. Session and model choices open as menus inside the panel, not in VS Code's quick pick.
- The composer has a `+` menu (attach selection, current file, problems, mention a file), a model chip (model and thinking level), and a round send button. Enter sends, Shift+Enter inserts a new line. While pi works, the button becomes a stop button (also Esc); typing turns it back into send, which steers the running agent.
- `/` at the start of the input lists commands: the built-ins below, then pi's extension, prompt template and skill commands. `@` lists workspace files (fuzzy match, same matcher as pi's terminal UI) and inserts `@path`, like the terminal UI.
- Assistant text streams in and renders as Markdown: headings, emphasis, lists, task lists, links, inline code, code blocks (no syntax highlighting), blockquotes, and tables. Raw HTML is shown as text, never rendered. Only `http`, `https`, and `mailto` links are clickable; VS Code opens them externally. Thinking and tool calls are collapsible; a tool call shows its main argument (command or path), its raw arguments, and its output.
- Abort stops the current run. Errors from pi (failed requests, retries that gave up, rejected commands) appear in the transcript.
- pi starts on the first message. Each start begins a new session, so the transcript is cleared.

## Reviewing file changes

With `pi.reviewChanges` (default `true`), every `edit` and `write` waits for your decision before the file changes:

1. The diff editor opens with the file on disk on the left and pi's exact new content on the right (an empty left side for a new file).
2. Accept or Reject with the check and close buttons in the diff editor title bar, the notification buttons, or `Pi: Accept Proposed Change` / `Pi: Reject Proposed Change`.
3. Accept writes the file and pi continues. Reject leaves the file untouched and the tool call fails with "The user rejected this change", so the model sees it. Aborting the run closes the review without writing.

Closing the diff tab does not decide; the review stays pending until Accept, Reject or Abort. Reviews are shown one at a time.

How it works: the extension starts pi with `--extension src/pi-extension/review-changes.ts`. That pi extension replaces the built-in `edit` and `write` tools with copies whose final file write first calls `ctx.ui.select(..., ["Accept", "Reject"], { metadata })`. The metadata carries the path and the complete new content, so pi's own edit logic decides the content and the review shows exactly what will be written. Directories for a new file are created only after Accept.

## Extension dialogs

Dialogs from any pi extension use native VS Code UI:

| pi extension UI call | VS Code |
|---|---|
| `select` | QuickPick (a file change review when it carries review metadata) |
| `confirm` | Modal Yes/No dialog |
| `input` | Input box |
| `editor` | Untitled document with Submit/Cancel notification |
| `notify` | Information, warning or error notification |
| `setStatus` | Status bar item per status key |
| `set_editor_text` | Chat composer text |
| `setWidget`, `setTitle` | Written to the `Pi` log only |

Dialogs are shown one at a time. When pi resolves a dialog itself (timeout, abort), the VS Code dialog closes where the API allows it (QuickPick, input box, reviews).

## Sessions and models

pi saves sessions as usual (disable with `"pi.args": ["--no-session"]`). The session menu (header title or history button) has New Session, Fork, Rename and the saved sessions of this folder, newest first. The model chip opens the model and thinking level menu. Palette commands (`Pi: Switch Session`, `Pi: Select Model`, ...) and the status bar model item open the same in-panel menus.

Built-in slash commands, handled by the extension like pi's terminal UI handles them:

| Command | Action |
|---|---|
| `/new` | Start an empty session |
| `/resume` | Open the session menu |
| `/model [provider/model]` | Open the model menu, or switch directly |
| `/thinking [level]` | Open the model menu, or set the level directly |
| `/fork` | Pick an earlier user message; pi starts a new session from before it and the message returns to the composer |
| `/clone` | Duplicate the current session |
| `/name [name]` | Rename inline in the header, or set the name directly |
| `/compact [instructions]` | Compact the session context |
| `/copy` | Copy the last assistant message |

Other `/` commands are sent to pi. Session commands are refused while pi is working. When `pi.args` resumes a session (`--continue`, `--session`), its transcript loads on start.

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
| `src/extension-ui.ts` | Native VS Code UI for pi extension UI requests, including the diff review |
| `src/file-change.ts` | Review metadata shared by both sides |
| `src/pi-extension/review-changes.ts` | pi extension (runs inside pi) that routes edit and write through a review |
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
- `pi.reviewChanges`: review every edit and write in a diff editor before pi changes the file (default `true`). Takes effect when pi starts.

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

`smoke:edit` makes it edit `sample.ts` (replacing `return a + b;`), `smoke:write [path]` makes it write a file, and `/smoke-ui` runs confirm, select and input dialogs. Other messages get thinking, a reply that lists the attached context blocks, and a `bash ls` tool call, followed by a Markdown summary. The provider has two models: `faux-1` (reasoning) and `faux-2`.

Run the tests (source launcher, sessions against local pi, prompt formatting, quick picks, and chat reducer against the faux provider):

```bash
cd packages/vscode
node ../../node_modules/vitest/dist/cli.js --run
```

## Known limitations

- `src/pi-extension/review-changes.ts` is loaded from the extension folder as TypeScript, which works for the source checkout; a published build will need to ship it.
- A slash command sent while pi is working is queued as a steering message, not run as a command.
- If the pi process exits unexpectedly, run `Pi: Stop` and then `Pi: Start`.
- A reloaded session shows messages sent with attachments as their full prompt text, not as chips.
