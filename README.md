# MulmoClaude

[![npm version](https://img.shields.io/npm/v/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![npm downloads](https://img.shields.io/npm/dm/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![License: MIT](https://img.shields.io/npm/l/mulmoclaude.svg)](LICENSE)
[![CI](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml/badge.svg)](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml)
[![GitHub stars](https://img.shields.io/github/stars/receptron/mulmoclaude.svg?style=social)](https://github.com/receptron/mulmoclaude/stargazers)

**English** · [日本語](README.ja.md) · [简体中文](README.zh.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

**An AI assistant that knows everything about you and supports you around the clock is not sold anywhere. You cannot buy one — you can only nurture one. MulmoClaude is a tool for nurturing your own AI assistant, on your own computer.**

The substance of an assistant is not the AI model — the model is just the engine. What makes an assistant valuable is how much it knows about you: your conversations, your calendar, your notes, your data, and the apps you use. Something that important should not be entrusted to any single service provider — the longer you use it, the harder it becomes to leave. MulmoClaude is open source and runs locally, so everything your assistant accumulates — memories, data, apps — stays in your own hands, as plain files in your workspace.

Nurturing takes an environment, and MulmoClaude provides one: a place to accumulate memories (a personal wiki that Claude builds and maintains itself), a place to keep your data (schema-driven collections, feeds, plain files), and a place to build apps just for you — no programming knowledge required. You say "I want something like this" in everyday words, and Claude builds the small app you need: a restaurant list, an invoice tracker, vocabulary practice — software for an audience of one. Right after install the garden is empty; you plant seeds and tend the soil, and grow an assistant that is yours alone.

And the assistant is not tied to your desk. Log in from your phone — or a messaging app you already use — and you reach the same assistant living on your computer. The relay server only carries messages in transit — your memories, data, and apps never leave your computer.

Under the hood, MulmoClaude is an AI-native application platform: capabilities are plugins in a single registry (today: a full accounting system with real server-side bookkeeping logic, a personal wiki, an SEC-filings reader, and more), Claude acts as a universal controller that composes across them, and chat summons the right GUI for each task — markdown, charts, forms, wikis, spreadsheets, or 3D scenes.

> **[How AI-Native Applications Should Be Built](MANIFEST.md)** — the architecture, UX, and protocol thesis behind MulmoClaude.

## 📣 Updates

New releases and features are announced on X, **in Japanese**.

- [Singularity Society (@SingularitySoci)](https://x.com/SingularitySoci) — release and feature announcements
- [Satoshi Nakajima (@snakajima)](https://x.com/snakajima) — MulmoClaude's owner

## Quick Start

```bash
npx mulmoclaude@latest
```

The launcher boots the server and opens [http://localhost:3001](http://localhost:3001) in your browser. That's it — start chatting.

> **Keep it running**: closing the terminal stops the server. To run in the background, launch inside `tmux` / `screen` (macOS/Linux) or as a startup task (Windows Task Scheduler).

### Start it from an icon (macOS / Windows)

To launch without opening a terminal, create an app bundle once:

```bash
npx mulmoclaude@latest create-shortcut
```

This writes `MulmoClaude.app` to `/Applications` (or `~/Applications` if that is not writable — pass `--dir <path>` to choose, `--yes` to skip the prompt). Double-clicking it checks the prerequisites, shows a progress page while the server starts, and opens the app when it is ready. If the server is already running it just opens the browser rather than starting a second one.

When something is missing — Node.js, `npx`, or Claude Code — it says which one and what to run, in your system language. Its log is at `~/Library/Logs/MulmoClaude/launcher.log`.

> **Where `.env` goes**: a terminal launch reads `.env` from the directory you launched in. An icon has no such directory — macOS starts apps in `/`, and Windows starts them wherever the shortcut points — so the icon launch reads `~/.env`, your home directory.

On **Windows** the same command writes a shortcut to the Start Menu instead (`--dir` puts it elsewhere, e.g. the Desktop), with the launcher's own files under `%LOCALAPPDATA%\MulmoClaude`. It opens no console window. Everything else behaves identically.

Re-run the command after upgrading: the shortcut carries its own copy of the launcher.

### Prerequisites

- **Node.js 20+** — runtime
- **[Claude Code CLI](https://claude.ai/code)** — installed and authenticated. Run `claude` once to complete OAuth
- **ffmpeg** — required for movie generation. Skip if you don't generate videos
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg`
- **Docker Desktop** (optional but recommended) — enables sandbox mode. See [Installing Docker Desktop](#installing-docker-desktop) below
- **whisper.cpp** (optional, macOS only) — enables local voice input (dictate chat messages). See [Optional: Local Voice Input](#optional-local-voice-input-macos) below

> **UI language**: 8 locales are supported (English, Japanese, Simplified Chinese, Korean, Spanish, Brazilian Portuguese, French, German). The default is auto-detected from the browser / OS language. To set it explicitly, put `VITE_LOCALE=ja` (or `zh` / `ko` / `es` / `pt-BR` / `fr` / `de`) in `.env`. Locale is picked at build/dev time; restart `yarn dev` after changing it. See [`docs/developer.md`](docs/developer.md#i18n-vue-i18n) for how to add strings.

### Run from source (for developers)

To modify the code instead of just running it:

```bash
git clone git@github.com:receptron/mulmoclaude.git
cd mulmoclaude && yarn install
cp .env.example .env   # optional — add GEMINI_API_KEY for image generation
yarn dev
```

Open [http://localhost:5173](http://localhost:5173). See [`docs/developer.md`](docs/developer.md) for architecture and scripts.

> **UI looks broken or unstyled?** Icons showing as words, `dist/*` 404s, `401` after a restart — see [`docs/troubleshooting.md`](docs/troubleshooting.md).

## What can you do?

| Ask Claude to...                | What you get                                    |
| ------------------------------- | ----------------------------------------------- |
| "Write a project proposal"      | Rich markdown document in the canvas            |
| "Chart last quarter's revenue"  | Interactive ECharts visualization               |
| "Create a trip plan for Kyoto"  | Illustrated guide with images                   |
| "Set up a todo list"            | Schema-driven collection with a kanban board    |
| "Ingest this article: URL"      | Wiki page with `[[links]]` for long-term memory |
| "Schedule a daily news digest"  | Recurring task that runs automatically          |
| "Generate an image of a sunset" | AI-generated image (Gemini)                     |
| "Subscribe to this RSS feed"    | Data feed on `/feeds`, fetched on a schedule    |
| "What's new in my feeds?"       | Feed items collected at `/feeds`                |

> **Pages you can visit directly**: `/wiki` (browse + lint), `/feeds` (data feeds), `/collections` (data apps), `/automations` (recurring tasks), `/files`, `/skills`, `/roles`. Each has its own scoped chat composer that spawns a fresh chat already aware of the page context.

> **Hacking on MulmoClaude?** See [`docs/developer.md`](docs/developer.md) for environment variables, scripts, and architecture.

### Messaging bridges

MulmoClaude can be accessed from messaging apps via **bridge processes**. Bridges run as separate child processes and connect to the server over socket.io.

```bash
# Interactive CLI bridge (same machine)
yarn cli

# Telegram bot bridge (requires TELEGRAM_BOT_TOKEN in .env)
yarn telegram
```

Bridges are also available as standalone npm packages:

```bash
# Chat platforms
npx @mulmobridge/cli@latest          # CLI bridge
npx @mulmobridge/telegram@latest     # Telegram bridge
npx @mulmobridge/slack@latest        # Slack bridge
npx @mulmobridge/discord@latest      # Discord bridge
npx @mulmobridge/line@latest         # LINE bridge
npx @mulmobridge/whatsapp@latest     # WhatsApp bridge
npx @mulmobridge/matrix@latest       # Matrix bridge
npx @mulmobridge/irc@latest          # IRC bridge
npx @mulmobridge/mattermost@latest   # Mattermost bridge
npx @mulmobridge/zulip@latest        # Zulip bridge
npx @mulmobridge/messenger@latest    # Facebook Messenger bridge
npx @mulmobridge/google-chat@latest  # Google Chat bridge
npx @mulmobridge/mastodon@latest     # Mastodon bridge
npx @mulmobridge/bluesky@latest      # Bluesky bridge
npx @mulmobridge/chatwork@latest     # Chatwork bridge (Japanese business chat)
npx @mulmobridge/xmpp@latest         # XMPP / Jabber bridge
npx @mulmobridge/rocketchat@latest   # Rocket.Chat bridge
npx @mulmobridge/signal@latest       # Signal bridge (via signal-cli-rest-api)
npx @mulmobridge/teams@latest        # Microsoft Teams bridge (Bot Framework)
npx @mulmobridge/line-works@latest   # LINE Works bridge (enterprise LINE)
npx @mulmobridge/nostr@latest        # Nostr encrypted DM bridge
npx @mulmobridge/viber@latest        # Viber bridge

# Universal / glue
npx @mulmobridge/webhook@latest      # Generic HTTP webhook (dev glue)
npx @mulmobridge/twilio-sms@latest   # SMS via Twilio
npx @mulmobridge/email@latest        # Email bridge (IMAP + SMTP)
```

All bridges support **real-time text streaming** (typing updates as the agent writes). CLI and Telegram also support **file attachments** (images, PDFs, DOCX, XLSX, PPTX). See [`docs/mulmobridge-guide.md`](docs/mulmobridge-guide.md) for the full platform list and setup instructions.

#### Auth token persistence for long-running bridges

The MulmoClaude server regenerates a fresh bearer token on every startup and writes it to `<workspace>/.session-token` (`$MULMOCLAUDE_WORKSPACE_PATH`, or `~/mulmoclaude` when unset), alongside the port it bound in `.server-port`.

**A bridge follows a restart on its own.** When the connection fails it re-reads both files and rebuilds its socket once the server has published a new generation — new token, new port, or both (#3078). Restarting the bridge is not required.

Pinning the token is still useful when the bridge runs **on a different machine** from the server, where it cannot read the workspace at all: set `MULMOCLAUDE_AUTH_TOKEN` to the same long random value on both sides. The server then uses it verbatim instead of regenerating.

```bash
# Server (one-time setup — same value across restarts)
MULMOCLAUDE_AUTH_TOKEN=long-random-string yarn dev

# Bridge (separate process / machine — same value)
MULMOCLAUDE_AUTH_TOKEN=long-random-string \
  TELEGRAM_BOT_TOKEN=... \
  npx @mulmobridge/telegram@latest
```

Recommended: at least 32 characters of random data (the server logs a warning at startup for shorter values).

### Why do you need a Gemini API key?

MulmoClaude uses Google's **Gemini 3.1 Flash Image (nano banana 2)** model for image generation and editing. This powers:

- `generateImage` — creates images from text descriptions
- `editImage` — transforms or modifies an existing image (e.g. "convert to Ghibli style")
- Inline images embedded in documents (Recipe Guide, Trip Planner, etc.)

Without a Gemini API key, roles that use image generation will be disabled in the UI.

### Getting a Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Click **Create API key**
4. Copy the key and paste it into your `.env` file as `GEMINI_API_KEY=...`

The Gemini API has a free tier that is sufficient for personal use.

## Security

MulmoClaude uses Claude Code as its AI backend, which has access to tools including Bash — meaning it can read and write files on your machine.

**Without Docker**, Claude can access any file your user account can reach, including SSH keys and credentials stored outside your workspace. This is acceptable for personal local use, but worth understanding.

**With Docker Desktop installed**, MulmoClaude automatically runs Claude inside a sandboxed container. Only your workspace and Claude's own config (`~/.claude`) are mounted — the rest of your filesystem is invisible to Claude. No configuration is required: the app detects Docker on startup and enables the sandbox automatically.

**Bearer token auth**: every `/api/*` endpoint requires an `Authorization: Bearer <token>` header. The token is auto-generated on server startup and injected into the browser via a `<meta>` tag — no manual setup. The only exception is `/api/files/*` (exempt because `<img>` tags in rendered documents can't attach headers). See [`docs/developer.md`](docs/developer.md#auth-bearer-token-on-api) for details.

**Sandbox credential forwarding** (opt-in): by default the sandbox has no access to host credentials. Two environment variables let you selectively expose what `git` / `gh` need:

- `SANDBOX_SSH_AGENT_FORWARD=1` — forwards the host's SSH agent socket. Private keys stay on the host.
- `SANDBOX_MOUNT_CONFIGS=gh,gitconfig` — mounts `~/.config/gh` and `~/.gitconfig` read-only.

Full contract and security notes: [`docs/sandbox-credentials.md`](docs/sandbox-credentials.md).

### Installing Docker Desktop

1. Download Docker Desktop from [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
2. **macOS**: open the `.dmg` and drag Docker to Applications, then launch it from Applications
3. **Windows**: run the installer and follow the prompts (WSL2 is set up automatically if needed)
4. **Linux**: follow the [Linux install guide](https://docs.docker.com/desktop/install/linux/)
5. Wait for Docker Desktop to finish starting — the whale icon in the menu bar / system tray should turn steady (not animated)
6. Restart MulmoClaude — it will detect Docker and build the sandbox image on first run (one-time, takes about a minute)

When the Docker sandbox is active on macOS, credentials are managed automatically — the app extracts OAuth tokens from the system Keychain at startup and refreshes them on 401 errors, so no manual steps are needed.

If Docker is not installed, the app shows a warning banner and continues to work without sandboxing.

> **Debug mode**: To run without the sandbox even when Docker is installed, set `DISABLE_SANDBOX=1` before starting the server, or pass the `--disable-sandbox` CLI flag (`yarn dev --disable-sandbox` / `npx mulmoclaude --disable-sandbox`) — handy on Windows PowerShell where `VAR=value cmd` doesn't work inline.
>
> **Tool-call history**: Set `PERSIST_TOOL_CALLS=1` to also record `tool_call` events (with their `args`) in the per-session jsonl alongside `tool_result`. Off by default because `args` can be large and may carry payload bytes you didn't expect to land on disk; useful for debugging after a page refresh or server restart. See [issue #1096](https://github.com/receptron/mulmoclaude/issues/1096).

## Logging

The server writes readable text to the console and full-fidelity JSON
to rotating daily files under `server/system/logs/`. Everything is
configurable via `LOG_LEVEL`, `LOG_*_FORMAT`, `LOG_FILE_DIR`, etc.

See [docs/logging.md](docs/logging.md) for the full reference, format
examples, rotation behaviour, and recipes.

## Roles

Each role gives Claude a different persona, tool palette, and focus area:

| Role                | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| **General**         | All-purpose assistant — todos, scheduler, wiki, documents, mind maps |
| **Office**          | Documents, spreadsheets, forms, presentations, data dashboards       |
| **Guide & Planner** | Travel guides, recipe books, trip planners with rich visual output   |
| **Artist**          | Image generation, image editing, generative art with p5.js           |
| **Tutor**           | Adaptive teaching — evaluates your level before explaining anything  |
| **Storyteller**     | Interactive illustrated stories with images and HTML scenes          |

Switching roles resets Claude's context and swaps in only the tools that role needs — keeping responses fast and focused.

## Skills — Run Your Claude Code Skills from MulmoClaude

MulmoClaude can list and launch the **Claude Code skills** you already have. A skill is any folder under `~/.claude/skills/<name>/` containing a `SKILL.md` file with a YAML frontmatter `description` and a markdown body of instructions. See the [Claude Code Skills docs](https://docs.claude.com/en/docs/claude-code/skills) for details on authoring skills.

### How to use

1. Open MulmoClaude and stay in one of the skill-enabled roles: **General**, **Office**, or **Tutor**.
2. Ask Claude to show your skills — e.g. _"show my skills"_ or _"list skills"_.
3. Claude invokes the `manageSkills` tool, and a split-pane **Skills** view opens in the canvas:
   - **Left**: every skill discovered on your machine, with its description and scope badge (`USER` / `PROJECT`).
   - **Right**: the full `SKILL.md` content of the selected skill.
4. Click **Run** on a skill. MulmoClaude sends `/<skill-name>` to Claude as a regular chat message; Claude Code's slash-command machinery resolves it against `~/.claude/skills/` and executes the skill's instructions inline in the same chat session.

No extra typing, no copy-pasting SKILL.md bodies — the Run button is a one-click wrapper around `/skill-name`.

### Skill discovery — two scopes

| Scope       | Location                               | Semantics                                                                                 |
| ----------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| **User**    | `~/.claude/skills/<name>/SKILL.md`     | Personal skills, shared across every project you open with the Claude CLI.                |
| **Project** | `~/mulmoclaude/.claude/skills/<name>/` | MulmoClaude-workspace-scoped skills. Project scope **wins** if a name collides with user. |

Both scopes are read-only in phase 0 — edits happen on the file system. A future release will let MulmoClaude itself create / edit project-scope skills.

### Docker sandbox vs non-Docker

MulmoClaude's default **Docker sandbox mode** isolates Claude Code in a container for safety (see [Security](#security)). Skill behaviour differs between the two modes:

| Mode                                 | User skills (`~/.claude/skills/`) | Project skills (`~/mulmoclaude/.claude/skills/`) | Built-in CLI skills (`/simplify`, `/update-config`, …) |
| ------------------------------------ | --------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| **Non-Docker** (`DISABLE_SANDBOX=1`) | ✅ All work                       | ✅                                               | ✅                                                     |
| **Docker sandbox** (default)         | ⚠️ See caveats below              | ✅ Mounted via workspace volume                  | ✅                                                     |

**Docker caveats — why user skills sometimes don't work in the sandbox:**

- **Symlinked `~/.claude/skills/`** — if your `~/.claude/skills` (or any sub-entry) is a symlink pointing outside `~/.claude/` (for example `~/.claude/skills → ~/ss/dotfiles/claude/skills`), the symlink's target is not present inside the container. The link appears as **dangling**, and Claude Code falls back to only the built-in skills.
- **Older Claude CLI inside the sandbox image** — `Dockerfile.sandbox` pins the CLI version at image build time. If that version is behind your host CLI (e.g. 2.1.96 in the image vs 2.1.105 on the host), user-skill discovery may behave differently.

**Workarounds for skill-rich setups that don't play nicely with the sandbox:**

1. **Disable the sandbox for this session**:

   ```bash
   # env-var form (any shell supporting VAR=value)
   DISABLE_SANDBOX=1 yarn dev

   # or the equivalent --disable-sandbox CLI flag (Windows PowerShell / npx / IDE run configs)
   yarn dev --disable-sandbox
   npx mulmoclaude --disable-sandbox
   ```

   The Claude CLI runs with your real `~/.claude/` and everything resolves natively. Use this when you trust the prompts you're about to send — sandbox is still the recommended default for untrusted / exploratory work.

2. **Move skills into project scope** — copy the specific skills you want into `~/mulmoclaude/.claude/skills/` (this path is mounted as the workspace volume inside the sandbox, so no symlink drama). Great for skills that are specific to your MulmoClaude workflow anyway.

3. **Flatten symlinks** — if you maintain your skill library via symlinks (e.g. in a dotfiles repo), replacing the top-level `~/.claude/skills` symlink with the real directory is the simplest fix.

### What the skill actually receives

When you press **Run**, MulmoClaude sends a plain user turn containing the slash-command string:

```text
/my-skill-name
```

That is the entire payload — MulmoClaude does **not** inline the `SKILL.md` body or extra context. The body is what Claude Code reads when the CLI resolves the slash command on its end. This keeps the chat input small and makes long skills (multi-kilobyte `SKILL.md`) safe to run without blowing up the prompt context.

### Save a conversation as a new skill

After a productive chat, you can ask MulmoClaude to capture the workflow:

```text
"この会話を fix-ci という skill にして"
"save this as a skill called publish-flow"
"skill 化して"   ← Claude picks a slug for you
```

Claude reads the current chat transcript, distills the steps you took, and writes a new `SKILL.md` to `~/mulmoclaude/.claude/skills/<slug>/`. The skill appears in the Skills view immediately and is invokable via `/<slug>` in any future session.

Notes on saving:

- **Project scope only** — saves go to `~/mulmoclaude/.claude/skills/`, never to `~/.claude/skills/`. The user scope stays read-only from MulmoClaude.
- **No overwrite** — if a skill with the same name already exists (in either scope), the save fails and Claude will ask you for a different name.
- **Slug rules** — lowercase letters, digits, and hyphens; 1–64 chars; no leading / trailing or consecutive hyphens. Claude picks one automatically; if you want a specific name, mention it in the request.

### Delete a saved skill

Project-scope skills get a **Delete** button next to the Run button in the Skills view (user-scope skills are read-only — no Delete button shown). Confirming the dialog removes `~/mulmoclaude/.claude/skills/<slug>/SKILL.md`. If you also dropped extra files in that folder by hand, they're left in place; only the SKILL.md is removed.

You can also ask Claude to delete by name:

```text
"delete the fix-ci skill"
```

## Wiki — Long-Term Memory for Claude Code

MulmoClaude includes a **personal knowledge base** inspired by [Andrej Karpathy's LLM Knowledge Bases idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). It gives Claude Code genuine long-term memory — not just a short `memory.md`, but a growing, interconnected wiki that Claude builds and maintains itself.

The **General** role has wiki support built in. Try:

- `"Ingest this article: <URL>"` — Claude fetches the page, extracts key knowledge, creates or updates wiki pages, and logs the activity
- `"What does my wiki say about transformers?"` — Claude searches the index, reads relevant pages, and synthesizes a grounded answer
- `"Lint my wiki"` — health check for orphan pages, broken links, and missing index entries
- `"Show me the wiki index"` — renders the full page catalog in the canvas

### How it works

The wiki lives entirely as plain markdown files in your workspace:

```
<workspace>/data/wiki/
  index.md          ← catalog of all pages (title, description, last updated)
  log.md            ← append-only activity log
  pages/<slug>.md   ← one page per entity, concept, or theme
  sources/<slug>.md ← raw ingested sources
```

Claude uses its built-in file tools (`read`, `write`, `glob`, `grep`) to navigate and maintain the wiki — no special database or indexing required. Cross-references use `[[wiki link]]` syntax, which the canvas UI renders as clickable navigation.

Over time the wiki grows into a personal knowledge base that any role can consult, making Claude progressively more useful the more you use it.

## Charts (ECharts)

The `presentChart` plugin renders [Apache ECharts](https://echarts.apache.org/) visualizations in the canvas. Ask for a line, bar, candlestick, sankey, heatmap, or network/graph — Claude writes an ECharts option object, the plugin mounts it. Every chart has a **[↓ PNG]** button for one-click export.

Available in the **General**, **Office**, **Guide & Planner**, and **Tutor** roles. Try:

```text
Chart last quarter's revenue by region as a bar chart
Plot AAPL's daily closes for the last 30 days as a candlestick
Show a sankey of energy flow: coal/gas/solar → electricity → home/industry/transport
```

### Storage

Each `presentChart` call writes one file under `<workspace>/artifacts/charts/`:

```text
<workspace>/artifacts/charts/
  sales-overview-1776135210389.chart.json
  apple-stock-1776135300000.chart.json
```

A single document can hold any number of charts, which are rendered stacked in the canvas:

```json
{
  "title": "Apple Stock Analysis",
  "charts": [
    {
      "title": "Daily close",
      "type": "line",
      "option": {
        "xAxis": {
          "type": "category",
          "data": ["2024-01", "2024-02", "2024-03"]
        },
        "yAxis": { "type": "value" },
        "series": [{ "type": "line", "data": [180, 195, 210] }]
      }
    },
    {
      "title": "Volume",
      "type": "bar",
      "option": {
        "xAxis": {
          "type": "category",
          "data": ["2024-01", "2024-02", "2024-03"]
        },
        "yAxis": { "type": "value" },
        "series": [{ "type": "bar", "data": [1000000, 1200000, 950000] }]
      }
    }
  ]
}
```

The `option` field is passed to ECharts' [`setOption`](https://echarts.apache.org/en/api.html#echartsInstance.setOption) as-is — you can reference the full [ECharts option reference](https://echarts.apache.org/en/option.html) when hand-editing these files. Edits are reflected the next time the document is re-opened in the canvas.

## Optional: X (Twitter) MCP Tools

MulmoClaude includes optional MCP tools for reading and searching posts on X (Twitter) via the official X API v2.

| Tool        | What it does                              |
| ----------- | ----------------------------------------- |
| `readXPost` | Fetches a single post by URL or tweet ID  |
| `searchX`   | Searches recent posts by keyword or query |

These tools are **disabled by default** and require an X API Bearer Token to activate.

### Setup

1. Go to [console.x.com](https://console.x.com) and sign in with your X account
2. Create a new app — a Bearer Token is generated automatically
3. Copy the Bearer Token and add it to your `.env`:
   ```
   X_BEARER_TOKEN=your_bearer_token_here
   ```
4. Add credits to your account at [console.x.com](https://console.x.com) (required to make API calls)
5. Restart the dev server — the tools activate automatically

### Usage

These tools are **only available in custom roles**. The built-in roles do not include them by default (except General). To use them in your own role:

1. Create or edit a custom role JSON file under `~/mulmoclaude/roles/<id>.json`
2. Add `readXPost` and/or `searchX` to its `availablePlugins` list

Once configured, you can paste any `x.com` or `twitter.com` URL into the chat and Claude will fetch and read it automatically.

## Optional: Local Voice Input (macOS)

Dictate chat messages instead of typing them. Click the mic button to start listening; as you pause, each spoken segment is transcribed and appended to the input for review before you send it. Click again to stop. Once turned on, the mic stays armed for the session — it pauses while the agent is responding and resumes automatically on your next turn. Transcription runs **entirely on the machine running MulmoClaude** via [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with Metal acceleration: no audio leaves the device, no per-minute API cost. The transcribed text is never auto-sent — you review and send it yourself.

This is **disabled by default** and **macOS-only** (Apple Silicon recommended). The mic button stays hidden until the feature is set up and enabled.

### Setup

1. **Install `cmake` first.** The build script compiles whisper.cpp from source and requires `cmake` — it aborts with an error if `cmake` is missing. Install it before running the script:

   ```bash
   brew install cmake
   ```

2. **Build and install the `whisper-server` binary.** Homebrew's `whisper-cpp` formula ships only `whisper-cli` (it builds with the server target off), so build from source with the bundled script:

   ```bash
   yarn build:whisper      # clones + builds whisper.cpp, links whisper-server onto PATH
   ```

   Verify with `whisper-server --help`. By default the binaries are linked into `/opt/homebrew/bin`; pass `--link-dir=<dir>` (a directory on your `PATH`) or `--ref=<git-tag>` to customize. `ffmpeg` is also required (see [Prerequisites](#prerequisites)).

3. **Restart `yarn dev`** so the server re-probes for the binary.

4. **Enable it in the app.** Open **Settings → Voice**, turn on **Enable voice input**. This downloads the speech model (`large-v3-turbo`, ~1.5 GB) once into `~/mulmoclaude/models/` with a progress bar. When it reaches "Model ready," the mic button appears in the chat input.

### Notes

- **Language** is auto-detected from your UI/browser locale, with a per-session override and an `auto` option that lets Whisper detect the spoken language from the audio.
- **Model choice**: `large-v3-turbo` (default), `small`, and `base` are selectable in Settings → Voice; the lighter models suit lower-RAM machines.
- **Privacy**: audio is processed on-device and temporary files are deleted immediately after transcription. (The "on-device" guarantee assumes you run the server on your own machine.)
- Models live under `~/mulmoclaude/models/` — deliberately outside the git-managed `data/` workspace tree. Disabling the feature offers to delete the downloaded weights.

## Configuring Additional Tools (Web Settings)

The gear icon in the sidebar opens a Settings modal where you can extend Claude's tool set without editing code. Changes apply on the next message (no server restart required).

### Allowed Tools tab

Paste tool names one per line. Useful for Claude Code's built-in MCP servers (Gmail, Google Calendar) after a one-time OAuth handshake:

```text
mcp__claude_ai_Gmail
mcp__claude_ai_Google_Calendar
```

First, run `claude mcp` once in a terminal and complete the OAuth flow for each service — credentials persist under `~/.claude/`.

### MCP Servers tab

Add external MCP servers without hand-editing JSON. Two types are supported:

- **HTTP** — remote servers (e.g. `https://example.com/mcp`). Works in every mode; in Docker, `localhost` / `127.0.0.1` URLs are rewritten to `host.docker.internal` automatically.
- **Stdio** — local subprocess (e.g. an `npx` MCP), restricted to `npx` / `node` / `tsx` for safety. Runs on the host when the Docker sandbox is **off**. When the sandbox is **on**, stdio entries are **dropped by default** (the minimal sandbox image can't host arbitrary runtimes) — set `"hostExecInDocker": true` to run one on the host behind a `stdio ↔ HTTP` gateway instead. See [docs/mcp-sandbox.md](docs/mcp-sandbox.md).

Pass credentials to a stdio server with an **`env`** map (`"env": { "IMAP_PASS": "…" }`). Values are literal and stored in `mcp.json` (mode `0600`, but **plaintext** — file-permission protection, not a vault). Full details, including the `hostExecInDocker` opt-in and how `env` reaches the process, are in [docs/mcp-sandbox.md](docs/mcp-sandbox.md).

Configuration lives under `<workspace>/config/`:

```text
<workspace>/config/
  settings.json    ← extra allowed tool names
  mcp.json         ← Claude CLI --mcp-config compatible
```

The MCP file uses Claude CLI's standard format so you can copy it between machines, or even use it with the `claude` CLI directly.

### Editing the config files directly

Both files are plain JSON — you can edit them with any text editor instead of the Settings UI. The server re-reads them on every message, so:

- No server restart needed after a file edit.
- Changes are picked up by the Settings UI too — just close and reopen the modal.
- The UI and the file are always in sync: saving from the UI overwrites the file, and hand-edits show up in the UI on the next open.

This is handy for:

- Bulk-importing MCP servers from another workstation (copy `mcp.json` over).
- Version-controlling your setup in a dotfiles repo.
- Commenting out a server temporarily by flipping `"enabled": false`.

**Example `mcp.json`** — one remote HTTP server (public, no auth) and one local stdio server:

```json
{
  "mcpServers": {
    "deepwiki": {
      "type": "http",
      "url": "https://mcp.deepwiki.com/mcp",
      "enabled": true
    },
    "everything": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "enabled": true
    }
  }
}
```

Constraints the server enforces when loading the file:

- `mcpServers` keys (the server id) must match `^[a-z][a-z0-9_-]{0,63}$`.
- HTTP `url` must parse as `http:` or `https:`.
- Stdio `command` is restricted to `npx`, `node`, or `tsx`.
- Entries that fail validation are silently dropped on load (a warning is logged); the rest of the file still applies.

**Example** — a credentialed stdio server that also runs under the Docker sandbox (e.g. an IMAP MCP):

```json
{
  "mcpServers": {
    "imap": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-imap-mcp"],
      "env": { "IMAP_HOST": "imap.example.com", "IMAP_USER": "me", "IMAP_PASS": "secret" },
      "hostExecInDocker": true,
      "enabled": true
    }
  }
}
```

`hostExecInDocker` runs that server on the host, outside the sandbox. It's a per-server flag — enable it on as many servers as you need, but only ones you trust. With the sandbox off it's ignored (the server already runs on the host).

**Example `settings.json`**:

```json
{
  "extraAllowedTools": ["mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Calendar"]
}
```

You don't need to list `mcp__<id>` entries for servers defined in `mcp.json` — those are allowed automatically on every agent run. `extraAllowedTools` is only for tools that aren't reachable through your own `mcpServers`, typically Claude Code's built-in `mcp__claude_ai_*` bridges after you've run `claude mcp` and completed OAuth.

## Chat Attachments

Paste (Ctrl+V / Cmd+V) or drag-and-drop files into the chat input to send them to Claude alongside your message.

| File type                                         | What Claude sees                | Dependency                   |
| ------------------------------------------------- | ------------------------------- | ---------------------------- |
| Image (PNG, JPEG, GIF, WebP, …)                   | Vision content block (native)   | None                         |
| PDF                                               | Document content block (native) | None                         |
| Text (.txt, .csv, .json, .md, .xml, .html, .yaml) | Decoded UTF-8 text              | None                         |
| DOCX                                              | Extracted plain text            | `mammoth` (npm)              |
| XLSX                                              | CSV per sheet                   | `xlsx` (npm)                 |
| PPTX                                              | Converted to PDF                | LibreOffice (Docker sandbox) |

PPTX conversion runs inside the Docker sandbox image (`libreoffice --headless`). Without Docker, a message suggests exporting to PDF or images instead. Maximum attachment size is 30 MB.

## Canvas view modes

The canvas (right panel) supports 8 view modes, switchable via the launcher toolbar, URL query param, or keyboard shortcut:

| Shortcut     | View      | URL param         | Description                      |
| ------------ | --------- | ----------------- | -------------------------------- |
| `Cmd/Ctrl+1` | Single    | (default)         | Show the selected tool result    |
| `Cmd/Ctrl+2` | Stack     | `?view=stack`     | All results stacked vertically   |
| `Cmd/Ctrl+3` | Files     | `?view=files`     | Workspace file explorer          |
| `Cmd/Ctrl+5` | Scheduler | `?view=scheduler` | Scheduled tasks calendar         |
| `Cmd/Ctrl+6` | Wiki      | `?view=wiki`      | Wiki page index                  |
| `Cmd/Ctrl+7` | Skills    | `?view=skills`    | Skills list and editor           |
| `Cmd/Ctrl+8` | Roles     | `?view=roles`     | Role management                  |

Every view mode is URL-driven: clicking a launcher button updates `?view=`, and landing on a URL with `?view=wiki` (for example) restores the corresponding view. The view mode list is defined once in `src/utils/canvas/viewMode.ts` — adding a new mode is a single array append.

## Remote Access

Reach your running MulmoClaude from a phone (or any browser) — browse its collections, feeds, and custom views, and start chats, from anywhere. There is no separate account or server to set up: access is granted simply by signing in to **both** ends with the **same Google account**.

**How to connect**

1. On the desktop, click the **phonelink** icon in the header to open the _Remote host_ popover, then choose **Sign in with Google**. MulmoClaude signs in as your Google user and opens a command channel over Firebase (the shared public [`mulmoserver`](https://mulmoserver.web.app) project). The icon turns green while the host is online.
2. On your phone, open **[https://mulmoserver.web.app](https://mulmoserver.web.app)** and sign in with the **same Google account**. The web app finds your online host and connects to it.

Because both ends authenticate as the same Firebase user, the phone and the desktop only ever meet inside your own user space — no third party can reach your host.

**Firebase and Firestore are used purely as a transport** — a relay to pass commands and responses between your phone and your desktop. Your data is **never stored or retained** on either. Nothing lives on the host except your local workspace files; anything that must cross the channel (such as an attachment staged through Firebase Storage) is deleted as soon as it reaches its destination.

**What you can do from the phone**

- Browse and page through your **collections** and **feeds**.
- Open **custom remote views** — mobile-friendly pages Claude builds for you. Ask Claude to build a _custom remote view_ (not a regular custom view), which can be read-only or writable.
- **Start a chat** on the host and attach **photos, videos, or PDFs** from the phone. Attachment bytes are too large for the command channel, so they stage through Firebase Storage; the host downloads each file into its workspace (`data/attachments/`), deletes the staged copy, and hands the file to Claude alongside your message.

The channel is command-based and host-driven: the phone issues requests and your desktop MulmoClaude answers them. Use **Disconnect** in the popover (or quit MulmoClaude) to take the host offline.

## Workspace

All data is stored as plain files in the workspace directory, grouped into four semantic buckets (#284):

```
~/mulmoclaude/
  config/              ← settings.json, mcp.json, roles/, helps/
  conversations/       ← chat/, memory.md, summaries/, searches/
  data/                ← wiki/, todos/, calendar/, contacts/, scheduler/,
                         sources/, transports/
  artifacts/           ← charts/, documents/, html/, html-scratch/,
                         images/, news/, spreadsheets/, stories/
```

See [`docs/developer.md`](docs/developer.md#workspace-layout-mulmoclaude) for the full reference.

### Todo lists

Todo lists are built as schema-driven **collections** rather than a
dedicated view. Ask Claude to "set up a todo list" and it follows
`config/helps/todo-collection.md` to author a `todos` collection — a
status enum (`Backlog / Todo / In Progress / Done`) with a `done`
toggle, optional priority / due-date fields, and a kanban / table /
calendar view picked automatically from the schema.

### Sharing collections — Discover and Contribute

The `/collections` page has a **Discover** tab that lists collections curated
in public **registries**. Click **Import** on any card to install a collection
into your workspace; click the small **Contribute** icon on an installed
collection to publish it back as a PR to the registry. By default only the
official [`receptron/mulmoclaude-collections`](https://github.com/receptron/mulmoclaude-collections)
registry is shown — you can add your own org / community / private registries
by dropping a `config/collections-registries.json` file in your workspace. See
[`docs/collection-registries.md`](docs/collection-registries.md) for the file
format, how multi-registry merging works, and how to author your own registry.

### Scheduler and skill scheduling

The scheduler (`Cmd/Ctrl+5` or `?view=scheduler`) manages recurring tasks stored in `data/scheduler/items.json`. The scheduler core (`@receptron/task-scheduler`) handles catch-up logic for missed runs and supports `interval`, `daily`, and `cron` schedules.

Skills can be scheduled to run automatically by adding a `schedule` field to the SKILL.md frontmatter:

```yaml
---
description: Morning news digest
schedule: daily 08:00
---
```

Claude will register the skill with the scheduler, and it runs automatically on the specified schedule.

### Memory extraction

Claude automatically extracts durable user facts from chat conversations and appends them to `conversations/memory.md`. This runs as part of the journal daily pass — facts like food preferences, work habits, and tool preferences are distilled from recent chats without user intervention. The memory file is always loaded into the agent context so Claude can personalize responses.

## Monorepo Packages

Shared code is extracted into publishable npm packages under `packages/`:

| Package                     | Description                                  | Links                                                                                                   |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@mulmobridge/protocol`     | Shared types and constants                   | [npm](https://www.npmjs.com/package/@mulmobridge/protocol) / [source](packages/protocol/)               |
| `@mulmobridge/client`       | Socket.io client library                     | [npm](https://www.npmjs.com/package/@mulmobridge/client) / [source](packages/client/)                   |
| `@mulmobridge/chat-service` | Server-side chat service (DI factory)        | [npm](https://www.npmjs.com/package/@mulmobridge/chat-service) / [source](packages/chat-service/)       |
| `@mulmobridge/cli`          | Terminal bridge                              | [npm](https://www.npmjs.com/package/@mulmobridge/cli) / [source](packages/bridges/cli/)                 |
| `@mulmobridge/telegram`     | Telegram bot bridge                          | [npm](https://www.npmjs.com/package/@mulmobridge/telegram) / [source](packages/bridges/telegram/)       |
| `@mulmobridge/slack`        | Slack bot bridge                             | [npm](https://www.npmjs.com/package/@mulmobridge/slack) / [source](packages/bridges/slack/)             |
| `@mulmobridge/discord`      | Discord bot bridge                           | [npm](https://www.npmjs.com/package/@mulmobridge/discord) / [source](packages/bridges/discord/)         |
| `@mulmobridge/line`         | LINE bot bridge                              | [npm](https://www.npmjs.com/package/@mulmobridge/line) / [source](packages/bridges/line/)               |
| `@mulmobridge/whatsapp`     | WhatsApp bridge                              | [npm](https://www.npmjs.com/package/@mulmobridge/whatsapp) / [source](packages/bridges/whatsapp/)       |
| `@mulmobridge/matrix`       | Matrix bridge                                | [npm](https://www.npmjs.com/package/@mulmobridge/matrix) / [source](packages/bridges/matrix/)           |
| `@mulmobridge/irc`          | IRC bridge                                   | [npm](https://www.npmjs.com/package/@mulmobridge/irc) / [source](packages/bridges/irc/)                 |
| `@mulmobridge/mattermost`   | Mattermost bridge                            | [npm](https://www.npmjs.com/package/@mulmobridge/mattermost) / [source](packages/bridges/mattermost/)   |
| `@mulmobridge/zulip`        | Zulip bridge                                 | [npm](https://www.npmjs.com/package/@mulmobridge/zulip) / [source](packages/bridges/zulip/)             |
| `@mulmobridge/messenger`    | Facebook Messenger bridge                    | [npm](https://www.npmjs.com/package/@mulmobridge/messenger) / [source](packages/bridges/messenger/)     |
| `@mulmobridge/google-chat`  | Google Chat bridge                           | [npm](https://www.npmjs.com/package/@mulmobridge/google-chat) / [source](packages/bridges/google-chat/) |
| `@mulmobridge/mastodon`     | Mastodon bridge                              | [npm](https://www.npmjs.com/package/@mulmobridge/mastodon) / [source](packages/bridges/mastodon/)       |
| `@mulmobridge/bluesky`      | Bluesky bridge                               | [npm](https://www.npmjs.com/package/@mulmobridge/bluesky) / [source](packages/bridges/bluesky/)         |
| `@mulmobridge/chatwork`     | Chatwork bridge (Japanese business chat)     | [npm](https://www.npmjs.com/package/@mulmobridge/chatwork) / [source](packages/bridges/chatwork/)       |
| `@mulmobridge/xmpp`         | XMPP / Jabber bridge                         | [npm](https://www.npmjs.com/package/@mulmobridge/xmpp) / [source](packages/bridges/xmpp/)               |
| `@mulmobridge/rocketchat`   | Rocket.Chat bridge                           | [npm](https://www.npmjs.com/package/@mulmobridge/rocketchat) / [source](packages/bridges/rocketchat/)   |
| `@mulmobridge/signal`       | Signal bridge (via signal-cli-rest-api)      | [npm](https://www.npmjs.com/package/@mulmobridge/signal) / [source](packages/bridges/signal/)           |
| `@mulmobridge/teams`        | Microsoft Teams bridge (Bot Framework)       | [npm](https://www.npmjs.com/package/@mulmobridge/teams) / [source](packages/bridges/teams/)             |
| `@mulmobridge/line-works`   | LINE Works bridge (enterprise LINE)          | [npm](https://www.npmjs.com/package/@mulmobridge/line-works) / [source](packages/bridges/line-works/)   |
| `@mulmobridge/nostr`        | Nostr encrypted DM bridge                    | [npm](https://www.npmjs.com/package/@mulmobridge/nostr) / [source](packages/bridges/nostr/)             |
| `@mulmobridge/viber`        | Viber bridge                                 | [npm](https://www.npmjs.com/package/@mulmobridge/viber) / [source](packages/bridges/viber/)             |
| `@mulmobridge/webhook`      | Generic HTTP webhook bridge (developer glue) | [npm](https://www.npmjs.com/package/@mulmobridge/webhook) / [source](packages/bridges/webhook/)         |
| `@mulmobridge/twilio-sms`   | SMS via Twilio                               | [npm](https://www.npmjs.com/package/@mulmobridge/twilio-sms) / [source](packages/bridges/twilio-sms/)   |
| `@mulmobridge/email`        | Email bridge (IMAP + SMTP)                   | [npm](https://www.npmjs.com/package/@mulmobridge/email) / [source](packages/bridges/email/)             |
| `@mulmobridge/mock-server`  | Mock server for testing                      | [npm](https://www.npmjs.com/package/@mulmobridge/mock-server) / [source](packages/mock-server/)         |
| `@receptron/task-scheduler` | Persistent task scheduler                    | [npm](https://www.npmjs.com/package/@receptron/task-scheduler) / [source](packages/scheduler/)          |

Anyone can write a bridge in any language — just speak the socket.io protocol documented in [`docs/bridge-protocol.md`](docs/bridge-protocol.md).

## Documentation

Full documentation lives in [`docs/`](docs/README.md). Here are the key entry points:

### For users

| Guide                                                                                                      | Description                                                          |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [MulmoBridge Guide](docs/mulmobridge-guide.en.md) / [日本語](docs/mulmobridge-guide.md)                    | Connect messaging apps (Telegram, Slack, LINE, etc.) to your home PC |
| [Scheduler Guide](docs/scheduler-guide.en.md) / [日本語](docs/scheduler-guide.md)                          | Recurring automated tasks                                            |
| [Obsidian Integration](docs/tips/obsidian.en.md) / [日本語](docs/tips/obsidian.md)                         | Use Obsidian to browse MulmoClaude's wiki and documents              |
| [Telegram Setup](docs/message_apps/telegram/README.md) / [日本語](docs/message_apps/telegram/README.ja.md) | Step-by-step Telegram Bot setup                                      |
| [LINE Setup](docs/message_apps/line/README.md) / [日本語](docs/message_apps/line/README.ja.md)             | Step-by-step LINE Bot setup                                          |

### For developers

| Guide                                                                                | Description                                                                                                                                          |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Developer Guide](docs/developer.md)                                                 | Environment variables, scripts, workspace structure, CI                                                                                              |
| [Built-in Plugin Development](docs/developer.md#plugin-development)                  | Author a plugin co-located in `src/plugins/<name>/` — META shape, `useRuntime<E>()` API, mounting paths, sync invariants                             |
| [Runtime-Loaded Plugins](docs/plugin-runtime.md)                                     | Author a plugin distributed as an npm package and installed into a workspace at runtime                                                              |
| [Bridge Protocol](docs/bridge-protocol.md)                                           | Wire-level spec for writing new messaging bridges                                                                                                    |
| [Sandbox Credentials](docs/sandbox-credentials.md)                                   | Docker sandbox credential forwarding (SSH, GitHub CLI)                                                                                               |
| [Logging](docs/logging.md)                                                           | Log levels, formats, file rotation                                                                                                                   |
| [Troubleshooting](docs/troubleshooting.md)                                           | Setup problems — broken-looking UI, `dist/*` 404s, Windows/OneDrive, `401` after restart, boot warnings                                               |
| [CHANGELOG](docs/CHANGELOG.md)                                                       | Release history                                                                                                                                      |

## License

MIT — see [LICENSE](LICENSE).
