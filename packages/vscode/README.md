# Pi for VS Code

A chat panel for the [pi coding agent](https://github.com/earendil-works/pi) inside VS Code. Ask pi to explain, write or change code in your project, attach editor context, and review every file change before it is applied.

pi is included in the extension: you do not need to install pi separately.

## Features

- **Chat panel** in the activity bar, with streaming answers rendered as Markdown, collapsible thinking and tool calls, and a copy button on each finished answer.
- **Review before changes**: with "Ask for approval" (default), every file edit opens in VS Code's diff editor and waits for Accept or Reject. Shell commands that delete, move or modify files (`rm`, `mv`, `> file`, `git reset`, `npm install`, ...) also wait for your approval. "Auto edit" applies changes directly.
- **Editor context**: attach the current selection, the current file or its problems, or mention any workspace file with `@`.
- **Tabs**: each tab runs its own pi, so several tasks can run at the same time. Sessions are saved and can be resumed, renamed, forked or deleted.
- **Models**: sign in with a subscription account or an API key, pick a model and thinking level, or add local and custom models (Ollama, LM Studio, compatible endpoints).
- **Commands**: `/` lists pi's commands, skills and prompt templates; `@` lists files.

## Requirements

- VS Code 1.100 or newer.
- Node.js 22.19 or newer. Recent VS Code versions include a new enough Node.js, which the extension uses automatically. If yours does not, the extension tells you on first start; install Node.js from [nodejs.org](https://nodejs.org/) or set `pi.nodePath`.
- An account or API key for a model provider (for example Anthropic, OpenAI, Google, GitHub Copilot, OpenRouter), or a local model server.

## Installation

1. Download `pi-vscode-plugin-<version>.vsix` from the [Releases page](https://github.com/SeanInBeta/pi/releases).
2. In VS Code, open the Extensions view, click `...` at the top, choose **Install from VSIX...**, and select the file.

   Or from a terminal:

   ```bash
   code --install-extension pi-vscode-plugin-<version>.vsix
   ```

3. Click the **Pi** icon in the activity bar.

To update, install the newer VSIX the same way. To uninstall, use the Extensions view; your pi settings, logins and sessions stay in `~/.pi/agent`.

## First start

The Pi panel walks you through what is missing before you can chat:

1. **Open a folder.** pi works inside a project folder: it reads and changes files there and saves sessions per folder.
2. **Node.js check.** If no suitable Node.js is found, the panel explains what to install. Click **Retry** afterwards.
3. **Connect a model provider.**
   - **Sign in with an account**: choose the provider; the sign-in page opens in your browser. If the browser runs on another machine, paste the final redirect URL into the panel.
   - **Use an API key**: choose the provider and paste the key into the input box.

   pi then selects the provider's default model and the chat appears.

If you already use pi in a terminal, your existing logins and settings are picked up and these steps are skipped.

## Using pi

- Type a message and press **Enter** (Shift+Enter for a new line). While pi works, the send button becomes a stop button (or press Esc); typing a message while pi works steers it.
- **Attach context** with the `+` button, the editor's right-click menu (**Add Selection / File / Problems to Pi Chat**), or `@file`.
- **Review changes**: an edit opens a diff; click **Accept** or **Reject** under the tool call in the chat, or use the check and close buttons in the diff editor. Switch between "Ask for approval" and "Auto edit" in the composer.
- **Model and thinking level**: click the model name at the bottom right.
- **Tabs and sessions**: `+` opens a tab. Click the active tab (or right-click any tab) for New session, Rename, Fork, Close and Delete, and to reopen recent sessions.

Useful commands in the chat:

| Command | Action |
|---|---|
| `/login [provider]` | Sign in to a model provider |
| `/logout` | Sign out of a provider |
| `/model [provider/model]` | Choose a model |
| `/thinking [level]` | Set the thinking level |
| `/new` | Start a new session in this tab |
| `/resume` | Open a saved session |
| `/fork` | Continue from an earlier message in a new session |
| `/compact` | Summarize the conversation to free up context |
| `/copy` | Copy the last answer |

## Settings

Click the gear in the panel header (or run **Pi: Settings**):

- **Model providers**: sign in, replace an API key, or sign out.
- **Choose model**.
- **Extension settings**: the VS Code settings below.
- **pi settings file** and **Custom models**: pi's `settings.json` and `models.json`. Custom models start from an Ollama example; see pi's [model guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md). Saving either file reloads pi.

| VS Code setting | Default | Description |
|---|---|---|
| `pi.approvalMode` | `ask` | `ask` reviews every file change first; `auto` applies changes directly |
| `pi.nodePath` | empty | Node.js 22.19+ executable for pi, when VS Code's own Node.js is too old |
| `pi.args` | `[]` | Extra pi command-line arguments, for example `["--no-session"]` |
| `pi.cliPath` | empty | Run a different pi instead of the included one (advanced) |

## Where your data is stored

The extension runs the pi included in it, but shares its configuration folder with pi in the terminal: `~/.pi/agent` (or `PI_CODING_AGENT_DIR` when set).

| File | Content |
|---|---|
| `auth.json` | Logins and API keys. Keep it private. |
| `settings.json` | Default model and other pi settings |
| `models.json` | Custom providers and models |
| `sessions/` | Saved conversations |

Your messages, attached context and the files pi reads go to the model provider you choose. The extension itself collects no telemetry. The included pi behaves as in the terminal: it downloads model catalog updates from pi.dev and adds attribution headers to some provider requests; set `"enableInstallTelemetry": false` in `settings.json` to turn off the headers.

## Troubleshooting

- **"Node.js 22.19 or newer is required"**: install Node.js 22.19+ and click Retry, or set `pi.nodePath` to its path.
- **"pi could not start"**: click **Show Log** (or run **Pi: Show Log**) for details.
- **A model does not appear**: sign in to its provider (`/login`), or add it to `models.json`. Models appear only for providers with credentials.
- **Project skills or extensions in `.pi/` are not loaded**: pi loads project resources only for trusted folders. Add `"--approve"` to `pi.args`, or trust the folder once with pi in a terminal.
- **pi stopped responding**: run **Pi: Stop**, then send a message again.

## License

MIT. Includes pi (MIT, Copyright (c) 2025 Mario Zechner) and other open source packages; see `dist/THIRD_PARTY_NOTICES.txt` in the installed extension. Development and packaging notes are in `packages/vscode/DEVELOPMENT.md` in the source repository.
