# MulmoClaude

GUI front-end for Claude Code — chat with rich visual output, schema-driven data apps, and long-term memory. AI-native application platform that runs locally on your machine.

## Quick Start

```bash
# Prerequisites: Node.js 22.19+, Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude              # one-time OAuth — completes the CLI setup

# Launch MulmoClaude
npx mulmoclaude@latest
```

Your browser opens to `http://localhost:3001`. That's it.

> Closing the terminal stops the server. Run inside `tmux` / `screen` (macOS / Linux) or a Task Scheduler task (Windows) to keep it up.

## What can you do?

| Ask Claude to…                  | What you get                                          |
| ------------------------------- | ----------------------------------------------------- |
| "Write a project proposal"      | Rich markdown document in the canvas                  |
| "Chart last quarter's revenue"  | Interactive ECharts visualization                     |
| "Create a trip plan for Kyoto"  | Illustrated guide with images                         |
| "Set up a todo list"            | Schema-driven collection with table / kanban / calendar |
| "Ingest this article: URL"      | Wiki page with `[[links]]` for long-term memory       |
| "Schedule a daily news digest"  | Recurring task that runs automatically                |
| "Generate an image of a sunset" | AI-generated image (Gemini)                           |
| "Make slides on …"              | Marp-rendered slide deck with PDF export              |
| "Add this to my calendar"       | Event in your Google Calendar (sign in, no setup)     |
| "Put that on my task list"      | Task in Google Tasks, with notes and a due date       |
| "Subscribe to this RSS feed"    | Data feed on `/feeds`, fetched on a schedule          |
| "Model a chess piece in 3D"     | Interactive ShapeScript scene, exportable to USDZ     |

**Pages you can visit directly**: `/wiki` (browse + lint), `/feeds` (data feeds), `/collections` (data apps — Discover tab to import community collections, Contribute to share your own), `/automations` (recurring tasks), `/files` (drop files onto a folder row to save them straight into it), `/skills`, `/roles`. Each page has its own chat composer that spawns a fresh chat already aware of the page context.

**Editing what Claude wrote**: a markdown document in the canvas opens a source editor — beside the rendered document on wide panes, below it otherwise — with an optional live preview, optional auto save, and a bookmark rail for navigating long documents.

## Options

```
npx mulmoclaude                              # Default (port 3001, opens browser)
npx mulmoclaude --port 8080                  # Custom port
npx mulmoclaude --no-open                    # Don't open browser
npx mulmoclaude --disable-sandbox            # Run the agent directly on the host
npx mulmoclaude --dev-plugin ./my-plugin     # Load a runtime plugin from a local
                                             # project dir (repeatable; relative or
                                             # absolute path)
npx mulmoclaude --version                    # Show version
npx mulmoclaude --help                       # Full flag list
```

Each boolean flag mirrors an environment variable, so `--disable-sandbox` and `DISABLE_SANDBOX=1` do the same thing. `--help` lists the rest: `--disable-macos-reminders` (skip the macOS Reminder notification sink) plus the `--journal-force-run`, `--chat-index-force-run`, and `--persist-tool-calls` debugging toggles.

## Start from an icon (macOS / Windows)

```
npx mulmoclaude create-shortcut              # macOS: MulmoClaude.app / Windows: MulmoClaude.lnk
npx mulmoclaude create-shortcut --dir ~/Desktop
npx mulmoclaude create-shortcut --yes        # Skip the confirmation prompt
```

Creates a real app bundle on macOS (no Electron — an `Info.plist` and a shell stub) in `/Applications`, or `~/Applications` when that is not writable. On Windows it creates a Start Menu shortcut pointing at a `.vbs` stub run through `wscript.exe`, so no console window appears; the launcher's files live under `%LOCALAPPDATA%\MulmoClaude`. Double-clicking it:

1. reuses an already-running MulmoClaude by just opening the browser,
2. checks Node.js, `npx`, and Claude Code, and explains in your system language what to do when one is missing,
3. shows a progress page while `npx mulmoclaude@latest` starts, then switches to the app.

A GUI launch gets none of your shell's `PATH`, so the bundle asks your login shell for it before looking for anything — this is why a version manager (nodebrew / nvm / asdf / Volta) still works from the icon.

It also starts the server from your home directory rather than the `/` macOS hands a GUI app, so the `.env` it loads is `~/.env`.

The launcher writes `~/Library/Logs/MulmoClaude/launcher.log`. The bundle carries its own copy of the launcher code, so re-run the command after upgrading. Windows is not supported yet.

## How it works

The npm package ships with the pre-built client (Vite) and the server source — TypeScript, executed directly via `tsx`. No cloning, no build step for end users: `npx` downloads the package and starts the Express server.

Your data lives in `~/mulmoclaude/` (created on first run): conversations, memory, calendar, contacts, wiki, collections, scheduled tasks, generated artifacts. Plain files; the workspace IS the database.

## Sandbox (recommended)

When Docker is available, the Claude Code agent runs inside a credential-free Docker sandbox so it can't see anything outside the workspace. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and the launcher detects it automatically.

The sandbox is off by default for credentials (`gh auth`, SSH keys). Opt into the host's credential flow for the agent's `git` / `gh` commands:

```bash
SANDBOX_FORWARD_SSH_AGENT=1 \
SANDBOX_MOUNT_CONFIGS=gh \
  npx mulmoclaude
```

Or run directly on the host (no sandbox, full access):

```bash
npx mulmoclaude --disable-sandbox
```

## Bridges — talk to MulmoClaude from messaging apps

Bridges are separate npx-able processes that connect a messaging platform to the running server via socket.io. Each bridge supports real-time text streaming; CLI / Telegram also support file attachments.

```bash
# Run the server first (any terminal)
npx mulmoclaude

# Then in another terminal, any of:
npx @mulmobridge/cli@latest          # interactive CLI on the same machine
npx @mulmobridge/telegram@latest     # Telegram bot (needs TELEGRAM_BOT_TOKEN)
npx @mulmobridge/slack@latest        # Slack
npx @mulmobridge/discord@latest      # Discord
npx @mulmobridge/line@latest         # LINE
npx @mulmobridge/whatsapp@latest     # WhatsApp
npx @mulmobridge/email@latest        # Email (IMAP + SMTP)
# …matrix, mattermost, mastodon, bluesky, signal, teams, zulip, irc, rocketchat,
#   chatwork, xmpp, viber, messenger, google-chat, twilio-sms, webhook, nostr, line-works
```

Full bridge list and platform-specific setup: <https://github.com/receptron/mulmoclaude/blob/main/docs/mulmobridge-guide.md>

### Auth token persistence across server restarts

The server regenerates a fresh bearer token on every startup and writes it to `<workspace>/.session-token` (`$MULMOCLAUDE_WORKSPACE_PATH`, or `~/mulmoclaude` when unset), alongside the port it bound in `.server-port`.

**A bridge follows a restart on its own.** When the connection fails it re-reads both files, and rebuilds its socket if the server came back with a new token, a new port, or both (#3078). Restarting the bridge is not required.

Pinning the token is still useful when the bridge runs on a **different machine** from the server, where it cannot read the workspace at all: set `MULMOCLAUDE_AUTH_TOKEN` to the same long random value on both sides. The server then uses it verbatim instead of regenerating.

```bash
# Server (one-time setup — pin a strong random value)
MULMOCLAUDE_AUTH_TOKEN=long-random-string npx mulmoclaude

# Bridge (separate process / machine — same value)
MULMOCLAUDE_AUTH_TOKEN=long-random-string \
  TELEGRAM_BOT_TOKEN=… \
  npx @mulmobridge/telegram@latest
```

Recommended: ≥ 32 characters of random data (shorter values trigger a startup warning).

## Roles, skills, and collections

- **Roles** (sidebar selector): General, Office, Guide & Planner, Artist, Tutor, Storyteller, Settings. Each one biases Claude toward a workflow and surfaces its sample prompts.
- **Skills** (`~/.claude/skills/<name>/SKILL.md`): personal skills shared across every project, plus project skills under `<workspace>/.claude/skills/`. Bundled "preset" skills (`mc-*`) re-seed on each boot.
- **Collections**: schema-driven data apps. Author your own (`data/skills/<slug>/schema.json` declares the model + UI), or use the Discover tab on `/collections` to import community collections from the official registry — or your own org / community registry by dropping `config/collections-registries.json` in the workspace. The Map tab draws the ontology graph across your collections, so you can see how their records reference each other, and the view header has a pulldown to jump straight to a related collection.

## Optional features

- **Gemini API key** (`GEMINI_API_KEY` in environment or `.env`) — enables AI image generation (`generateImage`), audio / video. Free tier suffices for everyday use; get one from [Google AI Studio](https://aistudio.google.com/). Set it in both places and the exported shell value wins, `.env` is ignored — the app now says so in the notification bell instead of leaving you editing a file that has no effect.
- **Local voice input** (macOS only, opt-in) — `whisper.cpp` for dictating chat messages without sending audio to a cloud API.
- **Marp slides** — `marp: true` frontmatter on any markdown file renders a slide deck in the canvas with PDF export. Custom themes via `config/marp-themes/<name>.css`.
- **Auto memory** — the agent maintains a typed memory layout (`conversations/memory/<type>/<topic>.md`) and reads it ambient-style.
- **Web Push on task finish** — enable in Settings → Notifications to get a push on your phone when the answer to a question you asked is ready, even with the browser closed. Requires the RemoteHost connection + a registered device (see [`docs/remote-host.md`](https://github.com/receptron/mulmoclaude/blob/main/docs/remote-host.md#web-push-on-task-finish-2086)).
- **Google (Calendar / Tasks / Drive)** — link your Google account in Settings → Plugins → Google and consent in the browser; no Google Cloud setup needed. The agent then gets a `google` tool covering the full round trip — list, create, edit and delete calendar events and tasks (including putting a completed task back on the list), plus the Drive files it creates — and the phone remote can trigger the same commands.
- **Google Calendar ↔ collection sync** — a collection can mirror one of your calendars and keep itself current: the first sync starts as soon as you ask for the collection, an hourly pass follows, and a Sync button forces one. It calls the Calendar API directly rather than routing the events through the agent, so keeping it fresh costs no tokens. A **Push to Google** button beside it sends the other way, creating events for records you added and updating ones you edited — it never deletes, and it skips anything edited on both sides rather than picking a winner. Ask for **two-way sync** and the collection pushes on the same schedule it pulls on, as one cycle, so there is no button to forget; a record the push could not send is then left alone by the pull instead of being overwritten. Without it the pull is automatic and the push is a button, so push before you sync — a pull overwrites a locally edited record as soon as Google reports a change to that event. Event **notes and location** travel in both directions alongside the title, times and colour. **The refresh token stays on your machine** (`~/.config/mulmo/`) — the sign-in service applies the OAuth client secret Google requires and keeps nothing. Prefer your own OAuth client? Drop a *desktop-app* client JSON in `~/.secrets/` and the whole flow stays local (see [`docs/remote-host.md`](https://github.com/receptron/mulmoclaude/blob/main/docs/remote-host.md)).

## Plugin authoring (`--dev-plugin`)

`--dev-plugin <path>` is the runtime-plugin author's dev loop. Pair with `yarn dev` in the plugin directory (vite watch): edits → vite rebuilds `dist/` → the browser auto-reloads via a debounced watcher on the plugin's `dist/`. The plugin's `package.json#name` + `dist/index.js` must already be present; the launcher refuses to start on missing files or on a name collision with an already-installed plugin.

Server-side `definePlugin` factory edits still require a launcher restart (Node ESM has no cache invalidation API); the launcher log explicitly says so when `dist/index.js` changes.

## For developers

- Repo: <https://github.com/receptron/mulmoclaude>
- Architecture, scripts, and the publish flow live in `docs/developer.md` of the repo.
- Publish flow for this package: see `bin/prepare-dist.js` header comment plus `.claude/skills/publish-mulmoclaude/SKILL.md`.

## Updates

New releases and features are announced on X, **in Japanese**.

- [Singularity Society (@SingularitySoci)](https://x.com/SingularitySoci) — release and feature announcements
- [Satoshi Nakajima (@snakajima)](https://x.com/snakajima) — MulmoClaude's owner

## Related projects

This launcher is published by [Receptron](https://github.com/receptron), who also build MulmoTerminal below.

- **[MulmoClaude on GitHub](https://github.com/receptron/mulmoclaude)** — source, issues, and the full documentation for the app this package launches.
- **[MulmoTerminal](https://github.com/receptron/mulmoterminal)** — a terminal-first cockpit for running many AI coding agents in parallel. One roster showing every session's summary and PR status, tmux-backed session persistence, git-worktree isolation, one-click PRs, and mobile push with remote reply.
- **[MulmoTerminal manual](https://receptron.github.io/mulmoterminal/)** — setup, workflows, feature reference, configuration, mobile notifications, and alternative / local model providers. Available in English and Japanese.

## License

MIT
