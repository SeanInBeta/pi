# pi-vscode-plugin: development

How the extension works, how to develop and test it, and how to package a release. The user guide is [README.md](README.md).

The extension spawns pi in [RPC mode](../coding-agent/docs/rpc.md) for the first workspace folder and shows a chat panel in the Pi activity bar view. The raw event stream is also written to the `Pi` output channel.

## Repository and branches

The extension lives in the fork [SeanInBeta/pi](https://github.com/SeanInBeta/pi) of [earendil-works/pi](https://github.com/earendil-works/pi):

| Branch or tag | Content |
|---|---|
| `main` | Tracks upstream pi; no extension code |
| `vscode` | The extension (`packages/vscode`) plus the pi changes it needs; releases are built from here |
| `vscode-v<version>` | Release tags on `vscode`, for example `vscode-v0.87.1`, each with a GitHub Release carrying the VSIX |

The extension bundles pi from this branch's source, so it needs these changes to pi, kept as separate `(coding-agent)` commits so they can be offered upstream:

| Commit | Change |
|---|---|
| `fix(coding-agent): reject RpcClient commands whose response reports failure` | `RpcClient` throws on `success: false` responses |
| `feat(coding-agent): add list_sessions RPC command` | Saved sessions of the current folder |
| `feat(coding-agent): forward dialog metadata and handle extension UI in RpcClient` | Review metadata on dialogs; `onExtensionUIRequest`, `sendExtensionUIResponse` |
| `feat(coding-agent): let RpcClient run the CLI with a chosen executable` | `RpcClientOptions.command`, used to run pi on VS Code's Node |
| `feat(coding-agent): add login, logout and provider auth RPC commands` | `get_auth_providers`, `login`, `abort_login`, `logout` |

List them with `git log --oneline --grep="(coding-agent)" main..vscode`.

To bring in a new upstream pi release:

```bash
git remote add upstream https://github.com/earendil-works/pi.git   # once
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout vscode && git merge main
# resolve conflicts, then set packages/vscode/package.json "version" to the new pi version
npm install --ignore-scripts && npm run hydrate:model-data && npm run check
```

Merge rather than rebase, so `vscode` keeps its published history and release tags.

## Chat panel behavior

- Tabs work like terminals: every tab runs its own pi process, so tabs work at the same time. A tab's dot pulses while pi works, turns green when the run finished, and red when it needs you (a pending Accept/Reject) or the run was aborted or failed. `+` opens a tab and the trash icon stops and closes one; the last tab cannot be closed. Clicking the active tab, or right-clicking any tab, opens the session menu: New session, Rename, Fork, Close tab, Delete session (moves the session file to the trash after confirmation; where the file system has no trash, a second confirmation deletes it permanently), and recent sessions (opened in a tab, or in an empty current tab). When the tabs overflow, a small navigation bar under them scrolls the strip (drag it, click it, or use the mouse wheel over the tabs). Open tabs and their sessions are restored when the window reloads. Session and model choices open inside the panel, not in VS Code's quick pick.
- The composer has a `+` menu (attach selection, current file, problems, mention a file), the approval mode, a model chip (model and thinking level), and a round send button. The model chip reads "Loading model..." until pi reports its model, then the model and thinking level. It opens a compact Codex-style popover: the thinking level on a slider with the model name below it; the level title opens the model list, which returns to the popover after a pick.
- `@path` mentions and known `/commands` (including `/skill:...`) are highlighted in the input and in sent messages. Backspace right after a token first selects the whole token; a second Backspace deletes it, and any other key or click cancels. A path picked from the `@` menu, or a known command, stays one token when text follows it without a space (`@1.txt改成...`). Deleting text never opens the `/` or `@` menu; only typing does. Enter sends, Shift+Enter inserts a new line. While pi works, the button becomes a stop button (also Esc); typing turns it back into send, which steers the running agent.
- A finished answer ends with a smile marker and a copy button.
- `/` lists commands with fuzzy matching (`/awe` finds `/skill:awesome-review`). At the start of the input it lists the built-ins below and pi's extension, prompt template and skill commands; after a space in the middle of the text (`what is /`) it lists pi's commands and inserts the chosen one. `@` lists workspace files (fuzzy match, same matcher as pi's terminal UI) and inserts `@path`, like the terminal UI.
- Assistant text streams in and renders as Markdown: headings, emphasis, lists, task lists, links, inline code, code blocks (no syntax highlighting), blockquotes, and tables. Raw HTML is shown as text, never rendered. Only `http`, `https`, and `mailto` links are clickable; VS Code opens them externally. Thinking and tool calls are collapsible; a tool call shows its main argument (command or path), its raw arguments, and its output.
- Abort stops the current run. Errors from pi (failed requests, retries that gave up, rejected commands) appear in the transcript.
- pi starts when the panel opens, so setup problems show before the first message (see [First run](#first-run)).
- The gear button opens Settings: model providers (sign in, enter or replace an API key, sign out), model choice, the extension's VS Code settings, pi's `settings.json`, custom models (`models.json`, created from an Ollama example when missing), and the log. Saving `settings.json`, `models.json` or `auth.json` from VS Code restarts idle tabs, since pi reads them only at start. `Pi: Settings` and `Pi: Sign In to a Model Provider` open the same menus from the palette.

## Which pi runs, and where its configuration lives

- **Program**: the installed extension runs the pi bundled in the VSIX (`dist/pi`), never a pi installed on the machine. The Extension Development Host runs this repository's pi source. `pi.cliPath` can point at another pi entry point.
- **Configuration**: the bundled pi uses the same agent directory as pi in the terminal: `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set. Logins and API keys (`auth.json`), the default model (`settings.json`), custom providers and models (`models.json`) and sessions are shared both ways. A login made with `pi` in the terminal shows up in the extension after its tabs restart, and a login made in the extension works in the terminal.
- **Model menu**: lists models whose provider has credentials (stored, environment variable, or `models.json`), from pi's `get_available_models`.

## First run

Until chatting is possible, the panel shows a setup card instead of the chat, and the composer is disabled. The checks run in this order when the panel opens:

1. **No folder open**: "Open a folder to start" with an Open Folder button. pi works in the first workspace folder and keeps sessions per folder.
2. **pi cannot start**: before starting pi, the extension checks its Node.js. The installed extension uses VS Code's own Node when it is 22.19 or later, as pi requires; otherwise it asks `node` on `PATH` (or `pi.nodePath`) for its version. A missing or older Node.js shows "Node.js 22.19 or newer is required" with the exact problem, a download link, Open Settings and Retry. Any other start failure shows the error with Show Log and Retry. Changing `pi.nodePath`, `pi.cliPath` or `pi.args` retries automatically.
3. **No model configured**: pi reports no usable model when no provider has credentials. The card "Connect a model provider" offers:
   - **Sign in with an account** (OAuth, for example Anthropic, GitHub Copilot, OpenAI Codex): pick the provider; the sign-in page opens in the browser (VS Code asks before opening it). The card shows progress, a device code when the provider uses one, and a field to paste the redirect URL or code when the browser runs on another machine. Cancel stops the sign-in.
   - **Use an API key**: pick the provider and enter the key in VS Code's masked input box.

   After signing in, pi selects the provider's default model and saves it as the default, and the chat appears. Credentials go to pi's `auth.json` (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), shared with pi in the terminal, so an existing pi login is reused and no card appears. Environment variables such as `ANTHROPIC_API_KEY` also count as configured.

Sign-in uses the `get_auth_providers`, `login`, `abort_login` and `logout` RPC commands, which the `vscode` branch adds to pi.

## Reviewing file changes

The approval mode, switchable in the composer or with the `pi.approvalMode` setting, decides what happens when pi changes files. With "Ask for approval" (default) every change waits for your decision before any file is touched; with "Auto edit" it is applied directly. Reviews cover:

- `edit` and `write` calls, shown as a diff (steps below);
- `bash` and `powershell` commands that may delete, move or modify files, shown in the chat under the command ("Run this command? It deletes files (rm).") without a diff. A rejected command is not run, and the model is told why.

A command counts as file-changing when it uses a delete, move or write command (`rm`, `del`, `Remove-Item`, `mv`, `Rename-Item`, `cp`, `mkdir`, `touch`, `chmod`, `tee`, `Set-Content`, ...), an output redirect (`> file`, `>> file`; not `2>&1` or `> /dev/null`), `sed -i`/`perl -i`, `find -delete`/`-exec`, a git command that changes the working tree (`checkout`, `restore`, `reset`, `clean`, `stash`, `pull`, `merge`, ...), or a package install (`npm install`, `pip install`, ...). This is a check of the command text: it cannot see what a script or program such as `python script.py` does internally. The rules and their tests are in `src/command-review.ts` and `test/command-review.test.ts`.

For `edit` and `write`:

1. The diff editor opens with the file on disk on the left and pi's exact new content on the right (an empty left side for a new file).
2. Accept or Reject with the buttons shown in the chat right under the `edit`/`write` call, the check and close buttons in the diff editor title bar, or `Pi: Accept Proposed Change` / `Pi: Reject Proposed Change`.
3. Accept writes the file and pi continues. Reject leaves the file untouched and the tool call fails with "The user rejected this change", so the model sees it. Aborting the run closes the review without writing.

Closing the diff tab does not decide; the review stays pending until Accept, Reject or Abort. Reviews are shown one at a time.

How it works: the extension always starts pi with the review extension (`src/pi-extension/review-changes.ts` in development, its compiled copy `dist/pi-extension/review-changes.js` in the VSIX). That pi extension replaces the built-in `edit` and `write` tools with copies whose final file write first calls `ctx.ui.select(..., ["Accept", "Reject"], { metadata })`, and handles pi's `tool_call` event to review file-changing `bash` and `powershell` commands before they run (a rejected call is blocked). The metadata carries the path and the complete new content, so pi's own edit logic decides the content and the review shows exactly what will be written. Directories for a new file are created only after Accept.

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

pi saves sessions as usual (disable with `"pi.args": ["--no-session"]`). The session menu (active tab or history button) has Fork, Rename and the saved sessions of this folder, newest first. `/new` starts a new session in the current tab; `+` opens a new tab. Palette commands (`Pi: Switch Session`, `Pi: Select Model`, ...) and the status bar model item open the same in-panel menus.

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
| `/login [provider]` | Open the provider list, or the named provider's sign-in options (`/login openai`) |
| `/logout` | Sign out of a provider with stored credentials |

Other `/` commands are sent to pi. Session commands are refused while pi is working. When `pi.args` resumes a session (`--continue`, `--session`), its transcript loads on start.

Saved sessions are listed through the `list_sessions` RPC command, which the `vscode` branch adds to pi.

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
| `src/command-review.ts` | Decides which shell commands may change files (pure, tested) |
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
| `Pi: Settings` | Open the settings menu in the panel |
| `Pi: Sign In to a Model Provider` | Open the provider list in the panel |

## Settings

- `pi.cliPath`: another pi CLI entry point, run with `node`. Empty uses the pi bundled in the VSIX, or in development `scripts/pi-dev-rpc.mjs`, which runs `packages/coding-agent/src/cli.ts` from source through `tsx`, so pi does not need to be built.
- `pi.nodePath`: Node.js executable that runs pi (22.19 or later), in the VSIX and in development. Empty uses VS Code's own Node when it is new enough (VSIX only), otherwise `node` from `PATH`.
- `pi.args`: extra pi CLI arguments, for example `["--provider", "anthropic", "--model", "claude-sonnet-5"]`.
- `pi.approvalMode`: `ask` (default) reviews every edit and write in a diff editor first; `auto` applies them directly. Also switchable in the composer.

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

`smoke:edit` makes it edit `sample.ts` (replacing `return a + b;`), `smoke:write [path]` makes it write a file, `smoke:rm <path>` makes it run `rm <path>`, and `/smoke-ui` runs confirm, select and input dialogs. Other messages get thinking, a reply that lists the attached context blocks, and a `bash ls` tool call, followed by a Markdown summary. The provider has two models: `faux-1` (reasoning) and `faux-2`.

Run the tests (source launcher, sessions against local pi, prompt formatting, quick picks, and chat reducer against the faux provider):

```bash
cd packages/vscode
node ../../node_modules/vitest/dist/cli.js --run
```

## Packaging

```bash
npm install --ignore-scripts          # from the repository root
npm run hydrate:model-data            # from the repository root
npm --prefix packages/vscode run package
code --install-extension packages/vscode/pi-vscode-plugin-<version>.vsix
```

`npm run package` runs `scripts/build-package.mjs`, then `vsce package`. The VSIX is self-contained: it needs neither this repository nor a global pi.

The build refuses to package when:

- the extension's version differs from the bundled pi's (`packages/coding-agent/package.json`); the extension carries pi's version, currently 0.87.1;
- pi's model data is missing or stale (`npm run check:model-data`). Stale catalogs load as empty, so the bundled pi would offer no built-in models. Run `npm run hydrate:model-data` first; it needs network access to models.dev.

| Path in the VSIX | Content |
|---|---|
| `dist/extension.cjs`, `dist/webview/` | Extension and chat panel, bundled and minified |
| `dist/pi-extension/review-changes.js` | The review extension, compiled; its `@earendil-works/*` imports resolve to the modules inside the bundled pi |
| `dist/pi/` | pi, bundled from this repository's source (so it includes this fork's pi changes), laid out like pi's npm package: `dist/bundle/rpc-entry.js`, themes, docs, examples, and `node_modules` with `jiti` (loads TypeScript extensions) and `photon-node` (image resizing) |
| `dist/THIRD_PARTY_NOTICES.txt` | Licenses of all bundled packages |

The installed extension (VS Code's production mode) runs `dist/pi` with `PI_PACKAGE_DIR` pointing at it. It uses VS Code's own Node (the editor binary with `ELECTRON_RUN_AS_NODE=1`) when that is 22.19 or later, as pi requires; older VS Code builds fall back to `node` from `PATH`, or `pi.nodePath`. The Extension Development Host keeps running pi from source as described under [Development](#development).


## Release checklist

1. On `vscode`, bring in upstream pi if wanted (see [Repository and branches](#repository-and-branches)), and keep `packages/vscode/package.json` `version` equal to `packages/coding-agent/package.json` (the build enforces it).
2. `npm install --ignore-scripts` and `npm run hydrate:model-data` (needs network access to models.dev).
3. `npm run check` and `./test.sh`, plus the extension tests (`cd packages/vscode && node ../../node_modules/vitest/dist/cli.js --run`).
4. `npm --prefix packages/vscode run package`, install the VSIX in a clean VS Code profile (`code --profile Test --install-extension ...`), and check the first-run card, a sign-in, a chat, and an edit review.
5. Tag the commit and push the tag (`git tag vscode-v<version> && git push origin vscode-v<version>`), then create a GitHub Release from the tag and attach the VSIX.

## Known limitations

- A slash command sent while pi is working is queued as a steering message, not run as a command.
- In RPC mode pi cannot show its project trust prompt, so project `.pi` extensions, skills and prompts load only with `--approve` in `pi.args`, a saved `/trust` decision, or `defaultProjectTrust: "always"`.
- If the pi process exits unexpectedly, run `Pi: Stop` and then `Pi: Start`.
- A reloaded session shows messages sent with attachments as their full prompt text, not as chips.
