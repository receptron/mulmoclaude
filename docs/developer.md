# Developer Guide

Reference for contributors hacking on MulmoClaude. End-user instructions live in [README.md](../README.md); architectural notes for the agent live in [CLAUDE.md](../CLAUDE.md). Read those first; this doc fills in the operational knobs and conventions.

---

## Contributing — please open an issue with a plan first

Thanks for wanting to contribute! Please read this section before sending a pull request — **we do not accept pull requests from outside the development team, regardless of size**, and unsolicited ones are commented on and closed automatically. **Issues are a different story — bug reports and feature requests are always welcome, and an issue is the way to get a change in.** The flow we ask for instead is:

1. **Open a GitHub issue describing the problem and a proposed plan.** A few paragraphs are enough: what's wrong (or what's missing), the approach you have in mind, the files you expect to touch, and any open questions. The files under [`plans/`](../plans/) are good references for the level of detail we want.
2. **Discuss the plan in the issue thread.** We may suggest scope adjustments, point out existing helpers or in-flight refactors that overlap, or surface constraints that are hard to see from the outside, such as security boundaries or deprecation paths. This is usually a short back-and-forth.
3. **A maintainer drafts the pull request.** Once we agree on the plan, one of us turns it into a pull request. You are welcome to follow the work, comment on the implementation, and flag anything that diverges from the agreed plan.

### How to write the issue

Maintainer review time is the bottleneck. These rules keep that time productive:

- **One issue covers exactly one topic.** If you have two unrelated proposals, file two issues. A combined issue is hard to scope, hard to review, and tends to stall on whichever half is harder.
- **Keep it short.** Long issues do not get read carefully. Aim for the smallest amount of text that fully covers the problem, the proposal, and any decision points the maintainer needs to weigh in on. If your draft does not fit on two screens, it is probably two issues.
- **Be specific.** Replace vague phrases with the concrete thing you mean. Instead of "the roles", write "the three built-in roles defined in `src/config/roles.ts`". Instead of "improve performance", write "reduce the number of `readFile` calls in `GET /api/sessions`".
- **Spell things out.** Avoid project-internal abbreviations and acronyms unless the same form already appears in the code or in [README.md](../README.md) / [CLAUDE.md](../CLAUDE.md). A reader who is new to MulmoClaude should be able to follow the issue without opening other documents.

### Why this flow — and why we close large unsolicited pull requests

AI coding assistants make it easy to generate large, polished-looking diffs in minutes. The catch is that reviewing such a pull request cold can take far longer than writing it, and even when the code reads cleanly, validating that no subtle behavioural, security, or data-handling regression slipped in is genuinely hard for a reviewer who did not help shape the design. We cannot responsibly merge code we cannot fully audit, and we cannot dedicate the review hours that auditing a large drive-by submission would require.

This is not about screening out AI-assisted work — the maintainer who drafts the pull request will often be using an agent too. The point is that **the plan is what we agree on, and the resulting code is owned by whoever lands it**. Locking that ownership boundary at the plan keeps responsibility clear and review focused on the parts that need human judgement.

### There is no small-diff exemption

Every change from outside the development team starts as an issue — typos, copy fixes,
documentation tweaks and dependency bumps included. A one-line fix still needs a maintainer to
judge whether it is the right fix, and routing it through an issue costs you less than writing a
pull request that will be closed.

The one exception is a change **a maintainer or a continuous integration bot explicitly asked
for in a review comment on your existing pull request** — that request is the agreement, so
there is nothing left to negotiate in an issue.

If you are not sure, opening an issue first is always cheaper. Thanks for understanding.

### Automated triage on pull requests

The `.github/workflows/pr_triage.yaml` workflow runs on every PR and enforces the rule above mechanically:

- PRs from maintainers and allowlisted bots pass through untouched. The current allowlist is `isamu`, `snakajima`, `ystknsh`, `yuki0627`, `dependabot[bot]`, `coderabbitai[bot]`, `sourcery-ai[bot]`. To add a maintainer, edit the `MAINTAINERS` list in the workflow and the same list here, in the same commit.
- **Every other PR gets a templated comment linking back to this section and is closed. There is no small-diff exemption.** The comment asks for an issue instead — **its first three lines should be a compact summary of the problem and the proposed plan** so a maintainer can decide whether to engage at a glance.
- The guard runs on PRs against **any** branch, not just `main`: a PR opened against a long-lived branch is exactly as unreviewable as one against `main`.
- An event a maintainer triggered stands the automation down, so retitling an outside PR you have decided to keep does not re-close it.
- Re-closing a reopened PR is silent — the workflow recognises its own earlier comment and does not post a second copy.

---

## Environment variables

All env vars are **optional unless flagged "required"**. The server reads them at process start (or per-agent-invocation where noted); set them in `.env` (loaded via `dotenv`) or your shell.

> **CLI flag equivalents**: the launch-time boolean toggles also accept a `--flag` form on both `yarn dev` and `npx mulmoclaude` (handy on Windows PowerShell / IDE run configs): `DISABLE_SANDBOX` → `--disable-sandbox`, `DISABLE_MACOS_REMINDER_NOTIFICATIONS` → `--disable-macos-reminders`, `PERSIST_TOOL_CALLS` → `--persist-tool-calls`, `JOURNAL_FORCE_RUN_ON_STARTUP` → `--journal-force-run`, `CHAT_INDEX_FORCE_RUN_ON_STARTUP` → `--chat-index-force-run`, `MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES` → `--allow-multiple-instances`. Registry: `server/utils/cli-flags.mjs`. Secret-bearing vars have no flag form (argv leaks via `ps`).

### API keys

| Variable                    | Used by                       | Notes                                                                                                                                                    |
| --------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`            | `server/utils/gemini.ts`      | Enables Gemini image generation / editing. Without it, image plugins surface a UI warning. The `geminiAvailable` flag in `GET /api/health` mirrors this. |
| `X_BEARER_TOKEN`            | `server/agent/mcp-tools/x.ts` | **Required** to enable `readXPost` / `searchX` MCP tools. Tools are silently disabled if absent.                                                         |
| `TELEGRAM_BOT_TOKEN`        | `@mulmobridge/telegram`       | **Required** for the Telegram bridge. BotFather token. Treat like a password. See [`message_apps/telegram/`](message_apps/telegram/).                    |
| `TELEGRAM_ALLOWED_CHAT_IDS` | `@mulmobridge/telegram`       | CSV of integer Telegram chat IDs allowed to message the bot. Empty / unset → deny everyone. A non-integer entry halts startup.                           |
| `TELEGRAM_POLL_TIMEOUT_SEC` | `@mulmobridge/telegram`       | Long-polling timeout in seconds. Defaults `25` (Telegram's recommended max).                                                                             |

### Runtime

| Variable                               | Default                        | Effect                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                 | `3001`                         | Express listen port (`server/system/env.ts` — `env.port`) **and the port `yarn dev`'s Vite proxy targets** (#2650), so setting it moves both halves together and a second instance stays separate. Resolved the same way the server resolves it — shell first, then `.env` (`scripts/lib/devServerPort.ts`). Left unset, a busy port walks forward so a stale `yarn dev` doesn't crash the launch, and the proxy follows: it reads `<workspace>/.server-port` at startup and re-aims itself from the next request when that file changes (#2995). The server reports the walk at info level for exactly that reason. That walk only happens when no MulmoClaude is already serving this workspace — one that is stops the launch outright (#3079, see `MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES`). Set **explicitly** and a busy port exits instead, matching `npx mulmoclaude --port`. See [Running two instances](#running-two-instances). |
| `MULMOCLAUDE_WORKSPACE_PATH`           | `<homedir>/mulmoclaude`        | Absolute path to the workspace (`server/workspace/paths.ts` — `workspacePath`). **Evaluated once at module load**, so it is a start-time choice: there is no API, UI, or CLI flag that switches workspaces on a running server. A path that does not exist yet is created on boot, `git init` included. Under a test runner with an un-overridden `HOME` the default becomes `<tmpdir>/mulmoclaude-test` instead. Point it elsewhere to run a second, fully isolated instance — see [Running two instances](#running-two-instances). |
| `MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES` | unset                          | Set to `1` (or pass `--allow-multiple-instances`) to start even when another server is already running against this workspace (`server/utils/instance-guard.mjs`). Off by default because the two overwrite each other's `.session-token` and plugin views then stop rendering on one of them, with nothing erroring (#3079). A second instance pointed at its own `MULMOCLAUDE_WORKSPACE_PATH` needs no flag — the check is per workspace, not per port. |
| `MULMOCLAUDE_CLIENT_DIR`               | `<serverDir>/../client`        | Absolute path to the built client Express serves when `NODE_ENV=production` (`server/index.ts`, `server/utils/clientDir.ts`). The default is the layout `packages/mulmoclaude/bin/prepare-dist.js` produces when packaging the tarball; set it when the bundle lives elsewhere — e.g. running from a source clone, where it points at `<repo-root>/dist/client`. Empty string falls back to the default. |
| `NODE_ENV`                             | unset / `production`           | When `production`, Express serves the built client from `dist/client` and falls back to `index.html` for SPA history-mode routing. Auto-set by tooling — you rarely set this manually.                                                                                                            |
| `DISABLE_SANDBOX`                      | unset                          | Set to `1` to bypass the Docker sandbox even when Docker is available. The agent runs `claude` directly on the host. Useful for debugging without container rebuild overhead (`server/system/docker.ts:49`, `server/index.ts:147`).                                                               |
| `SANDBOX_SSH_AGENT_FORWARD`            | unset                          | Set to `1` to forward the host's `$SSH_AUTH_SOCK` into the sandbox. Private keys stay on the host; the agent signs on the container's behalf. Full contract: [docs/sandbox-credentials.md](sandbox-credentials.md).                                                                               |
| `SANDBOX_MOUNT_CONFIGS`                | unset                          | CSV of allowlisted config mounts (currently `gh`, `gitconfig`). Each entry resolves to a fixed host→container path pair defined in `server/agent/sandboxMounts.ts`; unknown names are logged and ignored.                                                                                         |
| `SESSIONS_LIST_WINDOW_DAYS`            | `90`                           | Caps how far back the sidebar looks when listing chat sessions (`server/api/routes/sessions.ts`). Set to `0` to disable the cutoff entirely. Introduced in PR #203 to keep `GET /api/sessions` cheap on long-lived workspaces; anything older is still on disk, just hidden from the list.        |
| `MACOS_REMINDER_NOTIFICATIONS`         | `1` (Darwin) / unset elsewhere | Set to `0` to disable the macOS Reminders sink. The sink mirrors notifications into the system Reminders app via `osascript`. Title and body are passed via argv (not via `osascript` attribute) so notification text containing `osascript`-meta characters can't escape into the script (#789). |
| `DISABLE_MACOS_REMINDER_NOTIFICATIONS` | unset                          | Alternate kill-switch for the same sink — set to `1` to silence it without changing the primary flag. Auto-enabled in `node:test` runs to keep test output clean.                                                                                                                                 |
| `MULMOCLAUDE_DEV_LAN`                  | unset                          | Set to `1` to bind the Vite dev server to every interface instead of `127.0.0.1`, so another device on the network can load the page. The backend stays loopback-only either way: with LAN enabled, a non-loopback caller receives an **empty** auth token and the proxied backend paths (`/api`, `/artifacts`, `/htmlfile`, `/ws`) are refused, so the page loads but cannot reach the API. Only enable it on a network you trust. Dev server only — `vite build` output is unaffected. |
| `MULMOCLAUDE_DEV_WATCH_PACKAGES`       | unset                          | Windows-only escape hatch. `yarn dev` stops watching `packages/*/dist` on win32 because every sandboxed agent spawn bind-mounts the workspace packages into the container and Docker Desktop bumps their mtimes, which full-reloads the page mid-turn (#2632). Set to `1` while iterating on a workspace package to get its rebuild HMR back — at the cost of the reload storms. No effect on macOS/Linux, where those mounts never happen and the dists stay watched. |
| `MULMOCLAUDE_DEV_WAIT_MS`              | `60000`                        | How long `yarn dev` waits for the backend to start listening before it starts Vite anyway (#2975). The client half blocks on `scripts/wait-for-backend.ts` until the API port accepts a connection, which is also the moment the session token exists on disk (`server/index.ts` writes it before `app.listen`) — so the first page load gets neither a body-less 502 from the proxy nor an empty auth token baked into `index.html`. On timeout it logs why and starts Vite regardless, so a backend that never boots cannot hold the dev server hostage. Raise it on a slow machine (a cold `tsx` boot behind a Windows virus scanner is the case this exists for); it replaced a flat 2-second sleep that Windows routinely lost. |
| `MULMOCLAUDE_TRUSTED_ORIGINS`          | unset                          | CSV of additional `Origin` values allowed by the CSRF guard (`server/api/csrfGuard.ts`) for cross-origin state-changing requests. Match is verbatim — include the scheme and port, no trailing slash. Localhost is always allowed regardless of this list. The literal string `null` (browsers send it for sandboxed iframes / `file://` / `data:` pages) is rejected even if listed — there is no opt-in escape hatch for opaque origins. Note this only widens the **Origin** check; it does not by itself make the dev server reachable off-host (see `MULMOCLAUDE_DEV_LAN`), and the backend refuses non-loopback callers regardless. |
| `CLAUDE_CONFIG_DIR`                    | `<homedir>/.claude`            | Absolute path to the user's Claude Code CLI config directory. This is Claude Code's own env var, so setting it relocates the real install — and `.claude.json` **moves with it**, into the directory rather than staying at `~/.claude.json` (verified against the CLI; its docs mention neither the interaction nor the file's default). MulmoClaude follows that, so this one var is enough (#2654). Resolved by `server/utils/claudeConfigPath.ts` and consumed by the sandbox pre-flight (`server/system/docker.ts`), the Docker bind mounts (`server/agent/config.ts`), the credentials probe (`server/index.ts`), and the user-scope skills lookup (`server/workspace/skills/paths.ts`). Issue #87 §2. |
| `CLAUDE_CONFIG_JSON`                   | `<CLAUDE_CONFIG_DIR>/.claude.json`, else `<homedir>/.claude.json` | MulmoClaude-only escape hatch for the top-level JSON config alone; resolved by the same helper, and it wins over `CLAUDE_CONFIG_DIR`. Claude Code itself does not read this var, so setting it alone points MulmoClaude at a file the CLI is not using — reach for it only when the file genuinely sits outside its config dir (test fixture, corporate redirect). A blank value in either var counts as unset. |

### Bridges & relay

| Variable                        | Used by                              | Notes                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_ACK_REACTION`            | `@mulmobridge/slack` ≥ `0.4.0`       | Set to `1` to react with 👀 on every received Slack message before the agent finishes, so users see the bot saw the message. Off by default (#695).                                                                                                                           |
| `RELAY_<PLATFORM>_DEFAULT_ROLE` | `@mulmobridge/<bridge>` (relay mode) | Per-platform default role for the relay flow — e.g. `RELAY_TELEGRAM_DEFAULT_ROLE=guide` makes Telegram-originated chats start under the Guide & Planner role regardless of the host app's current role (#739, #794). Falls back to the host app's `currentRoleId` when unset. |

### Debug startup hooks

Both gate idempotent backfills that normally run on a schedule. Set to `1` to force-run once at server start (`server/index.ts:197`, `:209`):

| Variable                          | Forces                                                            |
| --------------------------------- | ----------------------------------------------------------------- |
| `JOURNAL_FORCE_RUN_ON_STARTUP`    | A full daily journal pass over the workspace at boot.             |
| `CHAT_INDEX_FORCE_RUN_ON_STARTUP` | A backfill of session titles / summaries for every existing chat. |

### Logger (`LOG_*`)

The structured logger (`server/system/logger/`) reads its config fresh at process start. Full reference in [`docs/logging.md`](logging.md). Quick map:

| Variable                                   | Default              | Values                                                                                              |
| ------------------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`                                | `info`               | Coarse knob — applies to both sinks unless overridden below. `error` \| `warn` \| `info` \| `debug` |
| `LOG_CONSOLE_LEVEL` / `LOG_FILE_LEVEL`     | `info` / `debug`     | Per-sink override.                                                                                  |
| `LOG_CONSOLE_FORMAT` / `LOG_FILE_FORMAT`   | `text` / `json`      | `text` (human) or `json` (JSONL).                                                                   |
| `LOG_CONSOLE_ENABLED` / `LOG_FILE_ENABLED` | `true` / `true`      | Boolean.                                                                                            |
| `LOG_CONSOLE_STREAM`                       | `split`              | `split` (warn+error → stderr, rest → stdout) \| `stderr` (everything → stderr, for a process whose stdout is a protocol channel). |
| `LOG_FILE_DIR`                             | `server/system/logs` | Where rotating daily files land.                                                                    |
| `LOG_FILE_MAX_FILES`                       | `14`                 | Retention count.                                                                                    |
| `LOG_TELEMETRY_*`                          | —                    | Telemetry sink stub for a future remote shipper. No-op today.                                       |

### Client (Vite)

Client-side env vars use the `VITE_` prefix so Vite exposes them to the bundled frontend via `import.meta.env`. They're baked at build/dev time — restart `yarn dev` or rerun `yarn build` after changing.

| Variable      | Default | Effect                                                                                                                                                                                                         |
| ------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_LOCALE` | `en`    | Locale passed to vue-i18n (`src/lib/vue-i18n.ts`). Supports `en` / `ja` / `zh` / `ko` / `es` / `pt-BR` / `fr` / `de` (see `SUPPORTED_LOCALES`). Missing keys fall back to English. See [i18n](#i18n-vue-i18n). |

### Launcher → server handoff

Set by `npx mulmoclaude` on the server it spawns. Auto-computed like the container vars below, but nothing to do with Docker — setting one by hand only misleads the server about its own launch.

| Variable | Set by | Purpose |
| -------- | ------ | ------- |
| `MULMOCLAUDE_SHADOWED_ENV_KEYS` | launcher | CSV of launch-dir `.env` key NAMES the shell had already defined, so the file's values lost (#2604). Read once at boot by `server/system/shadowedEnv.ts`, which raises a bell notification — otherwise a user editing `.env` against a stale `export` gets no hint why nothing changes. Names only, never values; the server drops any token that isn't an env var name. Absent when there is no conflict. Outside `npx mulmoclaude` the same notification still fires, from the server's own `.env` load instead (`server/system/loadEnv.ts`, #2610) — that path is where `yarn dev` lands. |

### Container-only env (auto-set)

You never set these by hand; the server constructs them when spawning Claude inside the Docker sandbox (`server/agent/config.ts` and `server/agent/mcp-server.ts`). They're listed here so log lines / failures involving them are decodable.

| Variable                         | Set by         | Purpose                                                                                                                                                                                                                                                                       |
| -------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_ID`                     | per agent run  | Session id passed to the MCP stdio bridge.                                                                                                                                                                                                                                    |
| `PORT`                           | per agent run  | Host server port the bridge connects back to.                                                                                                                                                                                                                                 |
| `PLUGIN_NAMES`                   | per agent run  | Comma-separated list of plugins active for this session's role.                                                                                                                                                                                                               |
| `ROLE_IDS`                       | per agent run  | Comma-separated list of all role ids.                                                                                                                                                                                                                                         |
| `MULMOCLAUDE_CHAT_SESSION_ID`    | per agent run  | Chat session id forwarded to Claude CLI's process env so the wiki-history `PostToolUse` hook can publish a `page-edit` toolResult to the right session. Claude CLI's own hook payload `session_id` is the _CLI_ session, which doesn't match our session store (#963 / #989). |
| `MULMOCLAUDE_HOST`               | container only | `host.docker.internal` (Docker) so the wiki-history hook can POST back to the parent server from inside the container. Falls back to `127.0.0.1` outside Docker.                                                                                                              |
| `MULMOCLAUDE_AUTH_TOKEN`         | per agent run  | Bearer token forwarded to the MCP subprocess so its `/api/*` calls authenticate without re-reading `<workspace>/.session-token`. The file fallback still works in container scenarios where the token file isn't bind-mounted.                                                |
| `MCP_HOST`                       | container only | `host.docker.internal` so the bridge inside the container can reach the host's Express server.                                                                                                                                                                                |
| `NODE_PATH`                      | container only | `/app/node_modules` — points the container's tsx runtime at the bind-mounted modules.                                                                                                                                                                                         |
| `HOME`                           | container only | `/home/node` so Claude CLI finds its credentials at `~/.claude`.                                                                                                                                                                                                              |
| Sentinel `X_BEARER_TOKEN=1` etc. | container only | `isMcpToolEnabled()` re-evaluates inside the container; the actual API call still happens on the host, so we only signal "enabled" with `1`.                                                                                                                                  |

> **Paths inside the sandbox are not host paths.** The container sees the workspace at `/home/node/mulmoclaude` (`server/agent/config.ts` — `CONTAINER_WORKSPACE_PATH`), and each configured reference directory at `/mnt/readonly/<basename>-<hash8>` (`server/workspace/reference-dirs.ts` — `containerPath`), never at its host location. Anything that hands the agent a **literal host path** — a custom role's `prompt`, a collection action template, a skill — therefore reads nothing in Docker mode, and does so silently. Refer to a reference directory by its **label**: the host injects a label→mount-path table into the system prompt (`buildReferenceDirsPrompt`), and the built-in roles keep every path workspace-relative for the same reason.

---

## Scripts (`package.json`)

### Development

| Script                            | What it does                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn dev`                        | Server (`:3001` by default, see `PORT`) + Vite client (`:5173`) concurrently. The default.                                                                                                                                     |
| `yarn dev:debug`                  | Same as `dev` but spawns the server with `--debug` (Node inspector ready).                                                                                                                              |
| `yarn dev:full-build`             | Same as `dev` but rebuilds every workspace package unconditionally first. Use when a plugin's `dist/` is stale or half-written — `dev`'s mtime gate treats a partial `dist/` as fresh and skips it.      |
| `yarn dev:client`                 | Vite client only — useful when you've already started the server elsewhere.                                                                                                                             |
| `yarn dev:server` / `yarn server` | Express server only.                                                                                                                                                                                    |
| `yarn server:debug`               | Server with `--debug` flag.                                                                                                                                                                             |
| `yarn cli`                        | CLI bridge — REPL in your terminal that talks to the running server (see [`bridge-protocol.md`](bridge-protocol.md)).                                                                                   |
| `yarn telegram`                   | Telegram bridge — operator guide at [`message_apps/telegram/`](message_apps/telegram/) (JP: [`README.ja.md`](message_apps/telegram/README.ja.md) / EN: [`README.md`](message_apps/telegram/README.md)). |

### Static checks

| Script                  | Notes                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `yarn lint`             | ESLint on `src server test e2e e2e-live packages scripts batch config`. CI-blocking. Under GitHub Actions it also writes a findings report to the job summary. |
| `yarn lint:summary`     | That same report on stdout, for reading it locally.                                |
| `yarn format`           | Prettier auto-fix on `{src,server,test,e2e,e2e-live,packages,scripts,batch,config}/**/*.{ts,mts,mjs,json,yaml,vue}`. |
| `yarn typecheck`        | `vue-tsc --noEmit` for the client.                                                 |
| `yarn typecheck:server` | `tsc -p server/tsconfig.json --noEmit` for the server (separate, stricter config). |
| `yarn build`            | Vite client build → `dist/client`, then server typecheck.                          |
| `yarn build:client`     | Client build only.                                                                 |

### Tests

| Script                                               | Notes                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn test`                                          | Node `node:test` unit suite. Globs across `test/*/test_*.ts` and 1–3 levels deep.                                                     |
| `yarn test:coverage`                                 | Same but with `--experimental-test-coverage`. CI uses this.                                                                           |
| `yarn test:e2e`                                      | Playwright (Chromium headless). Auto-starts Vite dev client.                                                                          |
| `yarn test:e2e -- tests/smoke.spec.ts`               | Single file.                                                                                                                          |
| `yarn test:e2e -- --headed`                          | Visible browser, useful for debugging.                                                                                                |
| `npx tsx --test test/agent/test_mcp_smoke.ts`        | MCP server subprocess smoke test (CI).                                                                                                |
| `npx tsx --test test/agent/test_mcp_docker_smoke.ts` | MCP server Docker smoke test (local only, requires `mulmoclaude-sandbox` image). Run after changing package exports or Docker mounts. |

### Docker sandbox

| Script                | Notes                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `yarn sandbox:remove` | `docker rmi mulmoclaude-sandbox` — rebuild on next run. Reuses the cached layers, so it does NOT refresh the bundled Claude CLI; add `docker builder prune -a -f` for that (#2202). |
| `yarn sandbox:login`  | macOS only. Exports the Claude CLI keychain entry to `~/.claude/.credentials.json` so the sandbox container can reuse it. |
| `yarn sandbox:logout` | Removes that file.                                                                                                        |

---

## Process map

Three independent Node processes cooperate at runtime:

1. **Express server** (`server/index.ts`) — listens on `127.0.0.1` at the port it resolves: `PORT` when set — and it exits rather than moving if that one is busy — otherwise `3001`, walking forward when *that* is busy. The bound port is published to `<workspace>/.server-port`, which is how everything outside the process finds it (#2650, #2981). IPv4 loopback only — `localhost` resolves to `::1` first on a dual-stack host, where nothing answers. Hosts every `/api/*` endpoint, the SSE stream for `POST /api/agent`, the pub-sub bus, and the cron-like [task manager](task-manager.md). Spawns the Claude CLI per agent invocation.
2. **Vite dev client** — listens on `localhost:5173`, proxies `/api/*` to the port the backend published, re-aiming itself when that file changes after startup (#2995). Following is gated on `MULMOCLAUDE_DEV_FOLLOW_PORT=1`, which only `yarn dev` sets: `yarn dev:client` starts no backend, so a `.server-port` it found would be a leftover, and it targets what `PORT` implies instead. Production builds skip Vite and let Express serve the static `dist/client`.
3. **MCP stdio bridge** (`server/agent/mcp-server.ts`) — spawned by the Claude CLI subprocess via `--mcp-config`. No HTTP listener: speaks JSON-RPC over stdin/stdout, forwards Claude's tool calls back to the Express server (`MCP_HOST:PORT/api/*`).

### Running two instances

`PORT` moves both halves — the Express server and the Vite proxy that fronts it (#2650) — so a second stack is two env vars:

```bash
MULMOCLAUDE_WORKSPACE_PATH=~/mulmoclaude-scratch PORT=3100 yarn dev
```

Vite's own port needs no flag: `strictPort` is off, so the second client takes 5174 when 5173 is busy and proxies to `:3100`.

**`yarn dev` twice needs BOTH env vars, not just `PORT`.** The proxy no longer resolves its target once: it follows `<workspace>/.server-port` and re-aims from the next request (#2995), so the old failure — the second client silently talking to the *first* server — is gone. What remained was the workspace, and that is now refused rather than documented around: two stacks sharing one overwrite each other's `.server-port` AND `.session-token`, and neither file can describe two servers. So a launch that would share this workspace with a server already running against it stops (#3079):

```
MulmoClaude is already running against this workspace at http://localhost:3001
```

That covers `yarn dev` twice AND `PORT=3100 yarn dev` alone, which this section used to offer as the way out. It was never a good one: the two instances overwrite each other's `.session-token`, after which a stateless plugin dispatch authenticates against the wrong server while the session-scoped `/api/internal/tool-result` push is dropped — so plugin views silently stop rendering on one of them. Give the second instance its own `MULMOCLAUDE_WORKSPACE_PATH`, as above, and no flag is needed.

To share one workspace between two servers anyway, `--allow-multiple-instances` (or `MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES=1`) restores the old walk-forward behaviour, with the token-stomping it implies.

The check is asked of `<workspace>/.server-port` rather than of the port, so it is silent about a port held by something that is not MulmoClaude — a busy 3001 with no instance of ours behind it still walks forward as before.

Serving a prebuilt client from Express instead of running Vite is still available, and is what `e2e-live/fixtures/isolated-dev-server.ts` uses (plus `HOME`) to give each live test its own stack — which is why live tests exercise the production serving path rather than the Vite one:

```bash
yarn build   # once, produces dist/client
MULMOCLAUDE_WORKSPACE_PATH=~/mulmoclaude-scratch \
PORT=3100 \
NODE_ENV=production \
MULMOCLAUDE_CLIENT_DIR="$PWD/dist/client" \
  yarn server
```

---

## Workspace layout (`~/mulmoclaude/`)

`initWorkspace()` creates / refreshes this on every server start (`server/workspace/workspace.ts`). The location defaults to `~/mulmoclaude` and is overridden with [`MULMOCLAUDE_WORKSPACE_PATH`](#runtime), read once at module load. Everything is plain files tracked in a private git repo, grouped into four top-level buckets by purpose (issue #284):

```text
~/mulmoclaude/
  config/             # app configuration
    settings.json     (web Settings UI — extraAllowedTools)
    mcp.json          (Claude CLI --mcp-config compatible)
    csp.json          (optional — extend the sandbox-view CSP; see csp-config.md)
    roles/            user-defined role overrides
    helps/            synced from server/workspace/helps/ at every boot
  conversations/      # chat + distilled context
    chat/             session ToolResults (one .jsonl per session)
    chat/index/       per-session title/summary cache
    memory.md         always-loaded agent context
    summaries/        journal output (daily/, topics/, archive/)
  data/               # user-managed content (the app treats these as authoritative)
    wiki/             personal knowledge wiki (index.md, pages/, sources/, log.md)
    calendar/         calendar events
    contacts/         contact records
    scheduler/        scheduled tasks (items.json)
    sources/          information-source registry + state
    transports/       per-chat messaging bridge state (future)
  artifacts/          # LLM-generated output, mostly regenerable
    charts/
    documents/        (was markdowns/ pre-#284)
    html/             persistent saved HTML (was HTMLs/ pre-#284)
    html-scratch/     transient generate-and-preview buffer (was html/ pre-#284)
    images/           generated / edited images
    news/             daily news briefs
    spreadsheets/     .xlsx files
    stories/          mulmo scripts
  .session-token      bearer auth token (mode 0600, see Auth below)
  .git/               auto-init'd repo
  .mulmoclaude/       internal: per-session MCP config files
```

The `config/` dir is the home for the [web Settings UI](../README.md#configuring-additional-tools-web-settings) — `settings.json` carries `extraAllowedTools`, `mcp.json` follows Claude CLI's `--mcp-config` format so you can copy it between machines. The optional `csp.json` extends the sandbox-view Content Security Policy (e.g. to allow a Google Maps embed) — see [csp-config.md](csp-config.md) for the schema and the security tradeoffs.

Pre-#284 workspaces (with `chat/`, `summaries/`, `memory.md` at the workspace root) are still accepted by the server — old directory names continue to work alongside the modern layout. If you want to clean them up by hand, move them under `conversations/` and `data/` per the tree above.

---

## Auth (bearer token on `/api/*`)

Every HTTP call to `/api/*` requires `Authorization: Bearer <token>`. Layered on top of the CSRF origin check (`server/api/csrfGuard.ts`): **both** must pass. The origin check stops cross-origin browser attacks; the bearer check stops sibling processes on the same machine that bypass browser CORS entirely.

**Exception — `/api/files/*`**: exempt from bearer auth because rendered markdown (`presentDocument`, wiki pages) embeds `<img src="/api/files/raw?path=...">` tags, and the browser's native image fetcher cannot attach an `Authorization` header. CSRF origin check + loopback-only binding still apply, so the exposure is limited to processes on localhost. The exemption is a negative-lookahead regex in `server/index.ts`.

**Token lifecycle**

| Event                            | What happens                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Server start                     | `generateAndWriteToken()` writes a fresh 32-byte hex token to `<workspace>/.session-token` (mode 0600)                                 |
| Vue page load / reload / new tab | Vite plugin (dev) / Express handler (prod) reads the file and substitutes `<meta name="mulmoclaude-auth" content="…">` into index.html |
| Vue bootstrap (`src/main.ts`)    | Reads the meta tag, calls `setAuthToken()` so every `apiFetch` attaches the header                                                     |
| HMR                              | No file I/O — token stays in Vue memory, SPA never reloads                                                                             |
| `SIGINT` / `SIGTERM`             | Best-effort `unlink` of BOTH `.session-token` and `.server-port` (#3082)                                                               |
| Crash / `kill -9`                | Both may linger. The token is harmless — the next startup generates a new one and the stale value stops matching. The PORT is not: it names a port this server has left, and a bridge that follows it presents its token to whatever took it. See [`bridge-protocol.md`](bridge-protocol.md) |

**Dev-mode escape hatch**: setting `MULMOCLAUDE_AUTH_TOKEN=…` before `yarn dev:client` makes the Vite plugin use that value instead of reading the file. Used by `e2e/playwright.config.ts` to inject a predictable token in E2E; also handy for debugging without a running server. Production (Express serving built HTML) never reads env — the in-memory token from `generateAndWriteToken()` is the sole source.

**Server-side pinning (#316)**: setting `MULMOCLAUDE_AUTH_TOKEN=…` before `yarn dev` (or any process that starts Express) makes `generateAndWriteToken()` use that value verbatim instead of generating a fresh random token. The same var is honoured by the Vite dev plugin and by `@mulmobridge/client`, so pinning it once in a shared shell / `.env` / docker-compose file keeps one token across restarts. **A bridge on this host does not need that.** Since #3078 the shared client re-reads `.session-token` and `.server-port` after a failed connection and rebuilds its socket, so a long-running bridge follows a restart on its own — pinned or not. Pin it for a client that cannot read the workspace AT ALL: another machine, or a container without it mounted, where there is no file to re-read. A warning logs if the override is shorter than 32 chars; no other validation. Use random-per-startup (the default) everywhere else — a pinned token is one that outlives the run that issued it.

**Current scope**: Vue client, Express middleware, and every bridge through `@mulmobridge/client`. A bridge presents the token in the socket.io handshake (`auth`), not as a `fetch` header, and it resolves it from `MULMOCLAUDE_AUTH_TOKEN` or `<workspace>/.session-token` — re-reading that pair after a failed connection rather than once at startup (#3078).

**Files**

- `server/api/auth/token.ts` — generate / write / unlink
- `server/api/auth/bearerAuth.ts` — Express middleware
- `src/utils/api.ts` — `setAuthToken()` + header injection (no call site changes needed; `apiFetch` auto-attaches)
- `vite.config.ts` — `mulmoclaudeAuthTokenPlugin` for dev HTML substitution
- `@mulmobridge/client` (token.ts) — bridge-side resolver (env var → file)
- `@mulmobridge/client` (client.ts) — shared socket.io setup for every bridge (see `docs/bridge-protocol.md`)

---

## Notifications (PoC scaffold)

A one-shot, delayed **push fan-out** that lands on every open Web tab _and_ every connected bridge simultaneously. Scaffolding for the in-app notification center (#144) and external-channel notifications (#142) — the endpoint and fan-out are stable, the UI / persistence layers land in those issues.

### Trigger

```bash
curl -X POST http://localhost:3001/api/notifications/test \
  -H "Authorization: Bearer $(cat ~/mulmoclaude/.session-token)" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello from curl","delaySeconds":5}'
# → 202 { "firesAt": "2026-04-16T15:37:42.123Z", "delaySeconds": 5 }
```

Body fields (all optional):

| Field          | Default                | Effect                                                                                                                                 |
| -------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `message`      | `"Test notification"`  | Title delivered to both targets.                                                                                                       |
| `body`         | _(none)_               | Optional second-line body in the bell panel.                                                                                           |
| `delaySeconds` | `60`, capped at `3600` | Timer length. Non-numeric / NaN falls back to the default; negative clamps to `0`; fractional floors.                                  |
| `transportId`  | `"cli"`                | Bridge target for `chatService.pushToBridge`.                                                                                          |
| `chatId`       | `"notifications"`      | Bridge chat slot.                                                                                                                      |
| `kind`         | `"push"`               | One of `todo` / `scheduler` / `agent` / `journal` / `push` / `bridge`. Drives the bell-panel icon — see `NOTIFICATION_ICONS`.          |
| `action`       | `{ type: "none" }`     | Permalink target — see [Notification permalinks](#notification-permalinks-762) below. Without this the click in the bell does nothing. |

### Fan-out at fire time

```text
setTimeout elapses
  ├─ pubsub.publish(PUBSUB_CHANNELS.notifications, { message, firedAt })  → Web
  └─ chatService.pushToBridge(transportId, chatId, message)               → Bridge (offline-queued)
```

Web subscribers listen on `PUBSUB_CHANNELS.notifications` (`src/config/pubsubChannels.ts`). The `useNotifications` composable wraps the subscription; `NotificationToast.vue` renders the latest inbound item as a top-right toast that auto-dismisses after 5 s. Bridges receive via the Phase B push socket (`yarn cli` prints `[push] notifications: hello …`).

### Observing the PoC end-to-end

1. `yarn dev` (server + Vite)
2. In a second terminal: `yarn cli`
3. In a third terminal: fire the curl above with `delaySeconds: 5`
4. After 5 s: a toast slides in top-right of the open browser tab ("hello from curl"), and the CLI terminal prints `[push] notifications: hello from curl`

### Scope caveats

- **Single toast**, no stack / notification-center bell / bell badge — those land with the real notification center (#144). The toast is intentionally a thin wrapper to confirm the pipeline delivers.
- **No persistence**: `setTimeout` is in-memory; a server restart before the delay elapses drops the push.
- **One bridge per call**: `pushToBridge` targets a single `transportId`. Fan-out to every connected bridge is deferred until a caller needs it.
- **One-shot only**: no repeat / snooze / dedup. Production triggers should go through the notification center once #144 lands.

Full motivation + file plan: `plans/done/feat-notification-push-scaffold.md`. Implementation: `server/events/notifications.ts` (scheduler) + `server/api/routes/notifications.ts` (HTTP wrapper) + `src/composables/useNotifications.ts` + `src/components/NotificationToast.vue`.

### Notification permalinks (#762)

Clicking a bell entry calls `router.push` with whatever its `action.target` resolves to. Targets are typed per feature page so the dispatcher and the page components agree on identifier semantics:

| `target.view` | Identifier(s)                        | Resolves to URL                                       |
| ------------- | ------------------------------------ | ----------------------------------------------------- |
| `chat`        | `sessionId` (required)               | `/chat/:sessionId`                                    |
| `calendar`    | _none_                               | `/calendar`                                           |
| `automations` | `taskId?`                            | `/automations` or `/automations/:taskId`              |
| `sources`     | `slug?`                              | `/sources` or `/sources/:slug`                        |
| `files`       | `path?`                              | `/files/<segments>` (catch-all)                       |
| `wiki`        | `slug?`, `anchor?`                   | `/wiki/pages/:slug` (`#:anchor` if set)               |

Pure dispatcher: `src/utils/notification/dispatch.ts`. App.vue feeds the result straight into `router.push(target)`.

#### Manual testing

`scripts/dev/fire-sample-notifications.sh` POSTs eight representative notifications — one per target variant — through the test endpoint. Useful for confirming every permalink lands on the right page after a UI change.

```bash
# Server + Vite
yarn dev

# In another terminal
./scripts/dev/fire-sample-notifications.sh
# (optional flags) --host http://127.0.0.1:3001  --delay 0.5
```

The script reads the bearer token from `MULMOCLAUDE_AUTH_TOKEN` first, then falls back to `~/mulmoclaude/.session-token`. **Stale-token gotcha**: a long-running server's in-memory token can drift from the on-disk file if a different server process overwrote it. If every call returns `401`, restart `yarn dev` so memory + file resync, or pin a token across restarts:

```bash
MULMOCLAUDE_AUTH_TOKEN=$(openssl rand -hex 32) yarn dev
# In another terminal — must use the same value
MULMOCLAUDE_AUTH_TOKEN=<same value> ./scripts/dev/fire-sample-notifications.sh
```

After firing, open the bell in the Web UI and click each entry; every click should land on the URL noted in the script's `→` output line. The `automations` and `sources` rows additionally scroll + flash the matching item via `scrollIntoViewByTestId` (`src/utils/dom/`).

#### Automated coverage

- **Unit**: `test/utils/notification/test_dispatch.ts` — every target variant + edge cases (missing sessionId, file path splitting, wiki anchor hash).
- **E2E**: `e2e/tests/notifications.spec.ts` — boots the app with a mocked pub-sub socket that delivers one canned payload per scenario, clicks bell + item, asserts the resulting URL. Run via `yarn test:e2e notifications`.

Plan doc: `plans/done/feat-notification-permalinks.md`. Implementation lives in `src/types/notification.ts` (typed targets), `src/utils/notification/dispatch.ts` (dispatcher), `src/router/pageRoutes.ts` (route names), and per-page mount-time scroll handlers (`SourcesView.vue`, `TasksTab.vue`).

---

## Dynamic favicon (#470)

The browser tab favicon changes color to reflect the agent's state. Implemented via Canvas API — no static icon files.

### States

| State       | Color                        | Condition                                                                     |
| ----------- | ---------------------------- | ----------------------------------------------------------------------------- |
| **idle**    | Gray (`#6B7280`)             | No agent running, no unread replies in the **current** session                |
| **running** | Blue (`#3B82F6`) + glow ring | Agent is executing (`isRunning === true`)                                     |
| **done**    | Green (`#22C55E`)            | Current session has `hasUnread === true` (agent finished, user hasn't viewed) |
| **error**   | Red (`#EF4444`)              | (Reserved — not currently wired to any state)                                 |

A notification badge (orange dot, top-right) appears when the notification composable's `unreadCount > 0` (independent of session state).

### Scope / known limitation

The favicon reflects the **current session only**. If another session has unread replies but the user is viewing a different (read) session, the favicon shows idle (gray). This matches the original implementation (#470). Cross-session unread indication is tracked in the notification center (#144).

### Files

| File                                   | Role                                                          |
| -------------------------------------- | ------------------------------------------------------------- |
| `src/composables/useDynamicFavicon.ts` | Canvas rendering + `<link rel="icon">` injection              |
| `src/composables/useFaviconState.ts`   | State derivation (isRunning / hasUnread / notification badge) |

---

## Centralized constants (`as const` modules)

Cross-module string literals (endpoint paths, tool names, role IDs, etc.) are defined once and imported everywhere. A typo in an import key fails typecheck; a typo in a raw string literal silently produces a runtime 404 or broken channel.

| Constant                               | Module                         | Consumers                                                                                                                                            |
| -------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_ROUTES`                           | `src/config/apiRoutes.ts`      | Server route files (`router.post(API_ROUTES.scheduler.tasks, ...)`), frontend fetch calls (`fetch(API_ROUTES.scheduler.tasks)`), MCP bridge `postJson` calls |
| `EVENT_TYPES` / `EventType`            | `src/types/events.ts`          | SSE stream emitters, pub-sub session events, chat jsonl parsers, `AgentEvent` union discriminators                                                   |
| `WORKSPACE_PATHS` / `WORKSPACE_DIRS`   | `server/workspace/paths.ts`    | Every server module that reads or writes workspace files                                                                                             |
| `TOOL_NAMES` / `ToolName`              | `src/config/toolNames.ts`      | Role definitions (`availablePlugins`), plugin registry, session-store tool matching                                                                  |
| `BUILTIN_ROLE_IDS` / `BuiltInRoleId`   | `src/config/roles.ts`          | Anywhere a built-in role ID appears outside the role definition itself                                                                               |
| `PUBSUB_CHANNELS` / `sessionChannel()` | `src/config/pubsubChannels.ts` | Pub-sub publish/subscribe sites in session-store and task-manager                                                                                    |

**Convention**: add new entries to the appropriate module before writing the first consumer. Keep the `as const` assertion so TypeScript infers literal types, not `string`.

**Plugin-aware aggregators** — `API_ROUTES`, `TOOL_NAMES`, `WORKSPACE_DIRS`, and `PUBSUB_CHANNELS` are not pure host records. Each is built via `defineHostAggregate(BUILT_IN_PLUGIN_METAS, { hostRecord, extract, … })` (see `src/plugins/metas.ts`) which merges per-plugin contributions from each plugin's `meta.ts` into the host record at module load. First-write-wins semantics: a plugin claiming a key the host already owns is dropped and reported on the bell; two plugins claiming the same key keep the first registration and drop the second. To add a plugin's tool name, route, dir, or channel, edit the plugin's `meta.ts` rather than the host module — the aggregator does the rest.

---

## i18n (vue-i18n)

CLAUDE.md mandates `$t()` / `useI18n()` for all template strings — never hardcode. The infrastructure lives in three places:

| File                  | Purpose                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/lib/vue-i18n.ts` | `createI18n({ legacy: false, locale, fallbackLocale: "en", messages })`. Locale comes from `VITE_LOCALE`. |
| `src/lang/en.ts`      | English dictionary — the **source of truth** for key shape. Missing keys in other locales fall back here. |
| `src/lang/ja.ts`      | Japanese dictionary. Mirror the tree shape of `en.ts`; any missing key silently falls back.               |

### Adding a string

1. Add the key to `src/lang/en.ts` first, grouped by feature area (e.g. `common.*`, `chat.*`, `session.*`). Keep nested objects over flat `dot.keys` strings so related entries stay together.
2. Mirror the new key in **all 7 sibling locales** (`ja.ts`, `ko.ts`, `zh.ts`, `es.ts`, `pt-BR.ts`, `fr.ts`, `de.ts`). `src/lang/en.ts` is the schema source of truth — `typeof enMessages` is threaded through `createI18n` in `src/lib/vue-i18n.ts`, so `vue-tsc` treats every missing key as a type error. Translate properly per locale (don't copy the English string); placeholders like `{count}` / `{error}` stay verbatim.
3. In a component:

   ```vue
   <script setup lang="ts">
   import { useI18n } from "vue-i18n";
   const { t } = useI18n();
   </script>

   <template>
     <button>{{ t("common.save") }}</button>
     <!-- or in a template without setup:  {{ $t("common.save") }} -->
   </template>
   ```

### Changing the running locale

Set `VITE_LOCALE` in `.env` and restart `yarn dev`. Supported values: `en`, `ja`, `ko`, `zh`, `es`, `pt-BR`, `fr`, `de` (see `SUPPORTED_LOCALES` in `src/lib/vue-i18n.ts`). Vite inlines env vars at build time, so the app must be re-bundled for a new locale — there's no runtime selector.

### Scope today vs. plans

`src/lang/*.ts` currently holds only a seed (`common.save` / `common.cancel`). Existing hard-coded strings across `src/**/*.vue` will be extracted incrementally in follow-up PRs. See `plans/done/feat-vue-i18n-setup.md` for the rationale and [issue #559](https://github.com/receptron/mulmoclaude/issues/559).

---

## Docker sandbox (`Dockerfile.sandbox`)

Minimal image: `node:22-slim` + `@anthropic-ai/claude-code` + `tsx`. Built lazily on first Docker-mode run; rebuilt when `Dockerfile.sandbox` changes (image SHA pinned in code). `yarn sandbox:remove` forces a rebuild.

The CLI is installed unpinned, so the image freezes whatever was latest at build time, and no upstream CLI release retriggers a rebuild (the Dockerfile SHA is unchanged). `yarn sandbox:remove` alone does not refresh it either — the rebuild reuses the cached `npm install -g` layer. To move the CLI, check what the image actually has and clear the build cache too:

```bash
docker run --rm --entrypoint claude mulmoclaude-sandbox --version
yarn sandbox:remove && docker builder prune -a -f
```

A stale CLI here surfaces as `handlePermission not found` (versions before 2.1.206 crash on `--permission-prompt-tool` before the broker connects) — see #2202 and `packages/core/assets/helps/error-recovery.md`.

**Bind mounts** (constructed by `buildDockerSpawnArgs` in `server/agent/config.ts`):

| Host             | Container                 | Mode             |
| ---------------- | ------------------------- | ---------------- |
| `./node_modules` | `/app/node_modules`       | ro               |
| `./packages`     | `/app/packages`           | ro               |
| `./server`       | `/app/server`             | ro               |
| `./src`          | `/app/src`                | ro               |
| `<workspace>`    | `/home/node/mulmoclaude`  | rw               |
| `~/.claude`      | `/home/node/.claude`      | rw (credentials) |
| `~/.claude.json` | `/home/node/.claude.json` | rw               |

The last two rows' host paths come from `server/utils/claudeConfigPath.ts`, so `CLAUDE_CONFIG_DIR` moves BOTH — `.claude.json` lives inside that directory, not beside it (#2654). The container side never moves: `CLAUDE_CONFIG_*` is not forwarded with `-e`, so the CLI inside finds both at its own defaults.

**Path translation**: `resolveMcpConfigPaths()` writes the per-session MCP config to `<workspace>/.mulmoclaude/mcp-<id>.json` on the host and passes the container path to `--mcp-config`.

**Limitations** ([#162](https://github.com/receptron/mulmoclaude/issues/162) tracks): no `python`, `git`, `jq`, or arbitrary binaries inside the container. User-defined stdio MCP servers added via the Settings UI are limited to `npx` / `node` / `tsx` for that reason; HTTP MCP servers work universally.

---

## Chat attachments (paste / drag-and-drop)

Users can paste or drop files into the chat input. The server converts non-native types before forwarding to Claude.

| Type                                                 | Conversion           | Claude block       | Dependency      | Environment                      |
| ---------------------------------------------------- | -------------------- | ------------------ | --------------- | -------------------------------- |
| image/\*                                             | None (native)        | `type: "image"`    | —               | All                              |
| PDF                                                  | None (native)        | `type: "document"` | —               | All                              |
| text/\* (.txt, .csv, .json, .md, .xml, .html, .yaml) | base64 → UTF-8       | `type: "text"`     | —               | All                              |
| DOCX                                                 | mammoth → plain text | `type: "text"`     | `mammoth` (npm) | All                              |
| XLSX                                                 | xlsx → CSV per sheet | `type: "text"`     | `xlsx` (npm)    | All                              |
| PPTX                                                 | libreoffice → PDF    | `type: "document"` | LibreOffice     | Docker sandbox or native install |

**PPTX conversion path**: the server process runs on the host (macOS/Linux), but LibreOffice lives inside the Docker sandbox image. `convertPptxToPdf()` in `server/agent/attachmentConverter.ts` tries native `libreoffice` first; if not found, falls back to `docker run --rm -v tmpdir:/data mulmoclaude-sandbox libreoffice --headless --convert-to pdf`. Without either, the user sees a text hint suggesting PDF or image export.

**Adding a new type**: add MIME handling in `server/agent/attachmentConverter.ts` (conversion logic), update `isConvertibleMime()` + `CONVERTIBLE_MIME_TYPES`, and add the MIME to `ACCEPTED_MIME_EXACT` in `src/App.vue`.

---

## Logging conventions

Full reference: [`docs/logging.md`](logging.md). Two rules to keep in mind when contributing:

1. **Never call `console.*` outside `server/system/logger/`.** Import and use `log.{error,warn,info,debug}(prefix, msg, data?)` instead. The structured payload powers JSON file shipping and grep-friendly text output. The only sanctioned `console.error` is the file-sink fallback inside the logger itself.
2. **Prefix is lowercase, hyphenated, no brackets.** The text formatter wraps it in `[ ]`. Keep payload values scalar; nested objects are JSON-stringified.

Existing prefixes in use: `agent`, `agent-stderr`, `server`, `workspace`, `sandbox`, `mcp`, `task-manager`, `journal`, `chat-index`, `pdf`, `config`, `image`, `wiki`, `pipeline`, `pipeline.fetch`, `scheduler`, `scheduler-tasks`, `sources`, `notifications`, `auth`.

### Layered logging template (#779)

Routes that do anything more than echo state should follow this shape, mirroring [`server/api/routes/image.ts`](../server/api/routes/image.ts) (PR #780) and [`server/api/routes/wiki.ts`](../server/api/routes/wiki.ts):

| Stage                                      | Level   | Required payload                                                                                                                                     |
| ------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry, after input validation              | `info`  | route name + key id (sessionId / slug / path) + `promptMeta(prompt)` for freeform user input, or `previewSnippet(slug)` for identifier-shaped fields |
| Success                                    | `info`  | bytes / item count / generated id                                                                                                                    |
| External SDK / fetch returned no data      | `warn`  | input fingerprint + reason                                                                                                                           |
| Internal exception (we threw, not the SDK) | `error` | input fingerprint + `errorMessage(err)`                                                                                                              |
| External SDK request/response shape        | `debug` | only inside the SDK wrapper (`server/utils/gemini.ts` etc.); never inside route files                                                                |

The "input fingerprint" in the warn / error rows is whichever helper the entry log used — `promptMeta` for freeform prompts, `previewSnippet` for identifiers. Pick by call-site shape, per the table below:

| Helper                                            | Use for                                                                                            | Output                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`promptMeta`](../server/utils/promptMeta.ts)     | freeform user-supplied prompts / pasted text — anything that could carry credentials, URLs, or PII | `{ length, sha256: <12-hex> }` — fingerprint only |
| [`previewSnippet`](../server/utils/logPreview.ts) | identifier-shaped fields with grep value (slug, page name, action verb)                            | first 120 chars + `…`                             |

Default to `promptMeta` for any field a user types or pastes freely; reserve `previewSnippet` for fields the user picks from a closed set (a slug, an action name) or that the system already constrains (a page name routed through a slugifier). **Never log** API keys, bearer tokens, cookies, full prompts, full markdown bodies, or absolute paths that include `/Users/<name>` (use the workspace-relative path instead).

### Operational note: hard-to-reproduce error reports

When a user reports "this failed with no UI feedback" and you can't reproduce it, **start by auditing the relevant route's log coverage**. If the file has zero `log.*` calls (or only catch-block logs without an entry log), there's nothing to grep against — the first move is to add the layered logging template above and ship it as its own PR before continuing the bug hunt. The current state of every route is tracked in [`plans/log-audit/findings.md`](../plans/log-audit/findings.md); if the route you're touching is marked "none" or "partial", upgrading it counts as in-scope groundwork.

---

## Test layout

`test/` mirrors `server/` and `src/` 1:1; e.g. `server/workspace/journal/dailyPass.ts` → `test/journal/test_dailyPass.ts`. The pattern: extract pure helpers from route handlers / Vue composables, then unit-test them without an HTTP harness. The test glob in `package.json` walks 1–3 directory levels — keep new tests at the right depth or extend the glob.

E2E tests live in `e2e/tests/*.spec.ts`. **No backend runs**; `await mockAllApis(page)` from `e2e/fixtures/api.ts` intercepts every `/api/*` call. Per-test mocks registered AFTER `mockAllApis` win because Playwright walks routes last-registered-first.

When to add E2E coverage is documented in [CLAUDE.md](../CLAUDE.md#when-to-add-e2e-coverage).

---

## CI (`.github/workflows/pull_request.yaml`)

Two jobs gate every PR:

- **`lint_test`** — matrix: Node 22.x & 24.x × {ubuntu, windows, macOS}. Runs `typecheck`, `typecheck:server`, `lint`, `build`, `test:coverage`.
- **`e2e`** — Ubuntu / Node 22.x. Runs `playwright install chromium` then `test:e2e`. Failed runs upload `test-results/` as an artifact for 7 days.

Cross-platform compatibility is a hard requirement — use `node:path` joins, `node:url` for file URL conversions, no shell-specific syntax in scripts.

---

## Internal packages (`packages/`)

MulmoClaude uses a yarn-workspaces monorepo. Shared code lives in `packages/`, published to npm as independent MIT-licensed packages.

| Package                     | Scope     | Description                                      |
| --------------------------- | --------- | ------------------------------------------------ |
| `@mulmobridge/protocol`     | messaging | Wire protocol types and constants                |
| `@mulmobridge/chat-service` | messaging | Server-side Express + socket.io chat service     |
| `@mulmobridge/client`       | messaging | Bridge-side socket.io client library             |
| `@mulmobridge/mock-server`  | messaging | Lightweight mock server for testing              |
| `@mulmobridge/cli`          | messaging | Interactive terminal bridge                      |
| `@mulmobridge/telegram`     | messaging | Telegram bot bridge                              |
| `@mulmobridge/slack`        | messaging | Slack bot bridge (Socket Mode)                   |
| `@mulmobridge/discord`      | messaging | Discord bot bridge                               |
| `@mulmobridge/line`         | messaging | LINE bot bridge (webhook)                        |
| `@mulmobridge/whatsapp`     | messaging | WhatsApp Cloud API bridge (webhook)              |
| `@mulmobridge/matrix`       | messaging | Matrix bridge (matrix-js-sdk)                    |
| `@mulmobridge/irc`          | messaging | IRC bridge (irc-framework)                       |
| `@mulmobridge/mattermost`   | messaging | Mattermost bridge (WebSocket + REST)             |
| `@mulmobridge/zulip`        | messaging | Zulip bridge (long-polling events API)           |
| `@mulmobridge/messenger`    | messaging | Facebook Messenger bridge (webhook + HMAC)       |
| `@mulmobridge/google-chat`  | messaging | Google Chat bridge (webhook + JWT)               |
| `@mulmobridge/mastodon`     | messaging | Mastodon bridge (WebSocket streaming)            |
| `@mulmobridge/bluesky`      | messaging | Bluesky bridge (chat.bsky DMs, long polling)     |
| `@mulmobridge/chatwork`     | messaging | Chatwork bridge (Japanese business chat)         |
| `@mulmobridge/xmpp`         | messaging | XMPP / Jabber bridge                             |
| `@mulmobridge/rocketchat`   | messaging | Rocket.Chat bridge (REST polling)                |
| `@mulmobridge/signal`       | messaging | Signal bridge (via signal-cli-rest-api)          |
| `@mulmobridge/teams`        | messaging | Microsoft Teams bridge (Bot Framework)           |
| `@mulmobridge/line-works`   | messaging | LINE Works bridge (enterprise LINE)              |
| `@mulmobridge/nostr`        | messaging | Nostr encrypted DM bridge                        |
| `@mulmobridge/viber`        | messaging | Viber bridge (Public Account bot)                |
| `@mulmobridge/webhook`      | messaging | Generic HTTP webhook (developer glue)            |
| `@mulmobridge/twilio-sms`   | messaging | SMS bridge via Twilio                            |
| `@mulmobridge/email`        | messaging | Email bridge (IMAP poll + SMTP)                  |
| `@receptron/task-scheduler` | general   | Persistent task scheduler with catch-up recovery |

**Build order matters** — `build:packages` in root `package.json` runs them in dependency order. When adding a new package, insert it at the correct position in the chain.

**Source-first dev** — in the workspace, `tsx` resolves symlinks to `.ts` source directly, so `dist/` builds are only needed for npm publish and CI typecheck.

See [`packages/README.md`](../packages/README.md) for the MulmoBridge architecture overview.

---

## Plugin development

Built-in plugins live under `src/plugins/<name>/` and own their entire identity — `toolName`, dispatch URL(s), workspace dirs, pubsub channels — in their own `meta.ts`. Host aggregator records (`API_ROUTES`, `TOOL_NAMES`, `WORKSPACE_DIRS`, `PUBSUB_CHANNELS`) auto-merge those contributions at module load via `defineHostAggregate` (`src/plugins/metas.ts`). Host code holds zero plugin-specific literals — adding a plugin doesn't touch `src/config/apiRoutes.ts`, `src/config/toolNames.ts`, `src/config/pubsubChannels.ts`, or `server/workspace/paths.ts`.

Runtime-loaded plugins (npm packages installed into a workspace at runtime) have a separate contract — see [`docs/plugin-runtime.md`](./plugin-runtime.md). The `meta.ts` pattern below is for built-in plugins only.

### Files per plugin

Plugin-local (lives entirely under `src/plugins/<name>/`):

- **`meta.ts`** — `definePluginMeta({ toolName, apiNamespace?, apiRoutes?, mcpDispatch?, workspaceDirs?, staticChannels? })`. Browser- and server-safe (no Vue / no Node-only imports). Single source of truth for the plugin's identity. Each route in `apiRoutes` is `{ method, path }`; the host composes `/api/<apiNamespace><path>` and exposes `{ method, url }` to consumers (#1141). `mcpDispatch` names the route key the MCP bridge POSTs to — host derives the binding URL from META, no duplication.

  ```ts
  // src/plugins/markdown/meta.ts
  import { definePluginMeta } from "../meta-types";
  export const META = definePluginMeta({
    toolName: "presentDocument",
    apiNamespace: "markdown", // → /api/markdown
    mcpDispatch: "create",
    apiRoutes: {
      create: { method: "POST", path: "" }, // POST /api/markdown
      update: { method: "PUT", path: "/update" }, // PUT  /api/markdown/update
    },
  });
  ```

- **`definition.ts`** — MCP `ToolDefinition`, default-exported. Derive `TOOL_NAME` and the endpoint type from META so the schema, dispatch URL, and HTTP verb can't drift:

  ```ts
  import type { ToolDefinition } from "gui-chat-protocol";
  import { META } from "./meta";
  import type { ResolvedRoute } from "../meta-types";

  export const TOOL_NAME = META.toolName;
  export type DocumentEndpoints = { readonly [K in keyof typeof META.apiRoutes]: ResolvedRoute };

  const toolDefinition: ToolDefinition = { name: TOOL_NAME /* ... */ };
  export default toolDefinition;
  ```

- **`index.ts`** — `PluginRegistration` exporting `REGISTRATION` (single-entry plugins) or `REGISTRATIONS` (multi-entry, e.g. scheduler's calendar+automations). The executor calls `pluginEndpoints<E>(scope)` from `../api` rather than importing `API_ROUTES` directly — the ESLint rule (#1144) enforces this for every file under `src/plugins/<name>/`. Vue components are wrapped via `wrapWithScope(scope, Component)` so descendants get the plugin runtime via `useRuntime()`.

- **`View.vue` / `Preview.vue`** — Vue surfaces. `useRuntime()` from `gui-chat-protocol/vue` returns a `BrowserPluginRuntime` (see "Plugin runtime API" below). Plain HTTP calls go through `apiCall(url, { method, body })` — pull both fields off the resolved route. The two `markdown` routes above have no path parameters, so the View just reads `endpoints.<key>.url`:

  ```ts
  import { apiCall } from "../../utils/api";
  import { useRuntime } from "gui-chat-protocol/vue";
  import type { DocumentEndpoints } from "./definition";

  const endpoints = useRuntime().endpoints as DocumentEndpoints;
  await apiCall(endpoints.create.url, { method: endpoints.create.method, body: payload });
  await apiCall(endpoints.update.url, { method: endpoints.update.method, body: payload });
  ```

  When a route DOES carry path parameters — e.g. a hypothetical `delete: { method: "DELETE", path: "/:id" }` → `DELETE /api/markdown/:id` — substitute via `buildRouteUrl` so the literal segment isn't open-coded:

  ```ts
  import { buildRouteUrl } from "../meta-types";
  // resolves `/api/markdown/:id` against `{ id: "abc" }` → `/api/markdown/abc`
  const url = buildRouteUrl(endpoints.delete, { id: docId });
  await apiCall(url, { method: endpoints.delete.method });
  ```

Server-side, only when the plugin owns endpoints:

- **`server/api/routes/<name>.ts`** — Express handlers. Use `bindRoute(router, route, ...handlers)` from `server/utils/router.ts` to wire each METHOD+URL pair from META in one line:

  ```ts
  import { bindRoute } from "../../utils/router.js";
  import { API_ROUTES } from "../../../src/config/apiRoutes.js";
  bindRoute(router, API_ROUTES.markdown.create, async (req, res) => {
    /* ... */
  });
  bindRoute(router, API_ROUTES.markdown.update, async (req, res) => {
    /* ... */
  });
  ```

Host wiring, exactly once per plugin:

- **`src/main.ts`** — entry in the host endpoint registry passed to `installHostContext({ endpoints })`. The DI registry is the only place that maps a plugin's scope name to its `API_ROUTES.<apiNamespace>` object; plugin code reads via `pluginEndpoints<E>(scope)` and never sees the host config tree.

Role wiring is independent — to expose a plugin to a Role's chat, add its `toolName` to that role's `availablePlugins` in `src/config/roles.ts`.

### Auto-discovery (no host barrel edits)

The 3 host barrels (`src/plugins/metas.ts`, `src/plugins/index.ts`, `src/plugins/server.ts`) used to need a manual append per plugin — easy to forget, the `presentForm` scope mismatch in #1141 was caught the same way. The barrels now re-export from `src/plugins/_generated/{metas,registrations,server-bindings}.ts`, regenerated by `scripts/codegen-plugin-barrels.ts` on every `yarn dev` / `yarn build` (and verifiable in CI via `yarn plugins:codegen:check`). Adding a built-in plugin is the 5 plugin-local files plus `src/main.ts` registry — barrels untouched.

Plugins that don't fit the standard convention (image plugins sharing the host's `/api/image/*`, external npm plugins like `@gui-chat-plugin/mindmap`) live in `src/plugins/_extras.ts` instead. The list there is small and stable.

### When the plugin needs significant server-side state

The standard pattern above keeps the entire plugin under `src/plugins/<name>/` because most plugins push their work to thin Express handlers in `server/api/routes/<name>.ts`. Plugins with non-trivial server-side state (scheduled background work, on-disk DSLs, mutex-serialised dispatch, custom file I/O) split their code:

- `src/plugins/<name>/` — only the browser-safe surface: `meta.ts`, `definition.ts`, `index.ts` (with `execute` posting to the apiNamespace), and the View component. ESLint forbids importing from `server/` here.
- `server/<name>/` — every other piece (handlers, tick body, lock, notifier wrapper, on-disk format helpers, …). Imported only by `server/api/routes/<name>.ts` and by `server/index.ts` for boot wiring.

### Plugin runtime API

`useRuntime()` from `gui-chat-protocol/vue` returns a `BrowserPluginRuntime` scoped to the plugin's package name. Built-in plugins get this surface via `wrapWithScope(scope, …)` (chat canvas) or an `<PluginScopedRoot>` wrapper at the standalone-route call site (see next section). The API:

| field                                     | purpose                                                                                                                                                                                                     | example                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `endpoints`                               | resolved route map. Cast to your plugin's `*Endpoints` type.                                                                                                                                                | `(useRuntime().endpoints as SchedulerEndpoints).list.url`  |
| `dispatch(args)`                          | MCP-style single-call dispatch (`POST /api/plugins/runtime/:pkg/dispatch`). Built-in plugins typically prefer their own typed routes via `endpoints`; runtime-loaded plugins commonly only have `dispatch`. | `await runtime.dispatch({ action: "create", title })` |
| `pubsub.subscribe(eventName, handler)`    | Subscribe to a plugin-scoped channel. Returns an unsubscribe function. The host fans events as `unknown`; validate the shape at the call site.                                                              | `runtime.pubsub.subscribe("changed", (data) => …)`    |
| `log.{debug,info,warn,error}(msg, data?)` | Frontend logger that prefixes `[plugin/<pkg>]` so console output is owner-tagged.                                                                                                                           | `runtime.log.warn("retrying", { attempt })`           |
| `openUrl(url)`                            | Open an external link in a new tab with `noopener,noreferrer`. Allowlists `http:` / `https:` only — `javascript:` / `data:` are rejected.                                                                   | `runtime.openUrl("https://example.com")`              |
| `locale`                                  | `Ref<string>` with the active vue-i18n locale (`en`, `ja`, `zh`, `ko`, `es`, `pt-BR`, `fr`, `de`). Reactive — re-render on locale change.                                                                   | `<span>{{ runtime.locale }}</span>`                   |

Plugin code is also bound by ESLint's plugin import rule (#1144): under `src/plugins/<name>/` you cannot import from `src/config/*`, `src/tools/*` (value imports), or `server/*`. Use the runtime API or the DI helpers (`pluginEndpoints<E>(scope)`, `pluginBuiltinRoleIds()`, `pluginPageRoute(name)` from `../api`) instead.

### Two mounting paths, both must work

A plugin's `View` / `Preview` components mount in two distinct trees, and both must provide the plugin runtime so descendant `useRuntime()` calls resolve:

1. **Chat canvas** (tool-result rendering). The `wrapWithScope(scope, View)` helper in `src/plugins/scope.ts` produces a component that mounts `<PluginScopedRoot pkg-name :endpoints>` around the inner View. Used by `BUILT_IN_PLUGINS` entries.
2. **Standalone routes** (`/automations`, `/wiki`, etc.). These mount the View directly, outside the plugin registry, so the host wraps them at the call site:
   ```vue
   <PluginScopedRoot pkg-name="scheduler" :endpoints="API_ROUTES.scheduler">
     <AutomationsView />
   </PluginScopedRoot>
   ```
   `App.vue` carries these wrappers for the routed page surfaces. A new standalone route for a plugin needs the same wrapping pattern, or `useRuntime()` will throw at first render.

`PluginScopedRoot` doubles as a per-plugin **error boundary** (#1147): a Vue `errorCaptured` hook catches uncaught throws from the plugin subtree's render / setup / lifecycle and renders an in-place fallback panel ("Plugin X crashed", optional stack via Show details, Retry). The retry remounts the slotted subtree with a fresh setup so transient bugs (stale ref, momentary endpoint outage) clear without a full page reload. Errors are logged to the console with a `[plugin/<pkg>]` prefix; the boundary does NOT forward to the bell to keep its coupling minimal.

### Diagnostics

Aggregator collisions don't throw — they're filtered and reported. `server/plugins/diagnostics.ts` collects them at boot via `log.warn` and a system notification on the bell; the late-mount `usePluginDiagnostics()` composable fetches `/api/plugins/diagnostics` so a tab opening after the boot push still sees the warning. Notification title/body are localized in all 8 locales via the `pluginDiagnostics.*` i18n keys.

### Sync invariants

`test/plugins/test_meta_aggregation.ts` enforces:

- `defineHostAggregate` first-write-wins semantics (the second plugin claiming a key is dropped, not silently overwritten).
- `apiNamespace ?? toolName` default when META omits the explicit namespace.
- `BUILT_IN_SERVER_BINDINGS` → META — every server-bound built-in plugin has a matching META. The reverse direction is intentionally not asserted: GUI-only / deprecated plugins (e.g. wiki) legitimately have META without a binding. External-package plugins (`@gui-chat-plugin/mindmap` and friends) are exempt via an allowlist.

`test/composables/test_usePluginErrorBoundary.ts` covers the error-boundary state machine (capture / details / retry / mountKey bump). The CI step `yarn plugins:codegen:check` fails the build if a developer added a plugin directory without re-running the codegen.

---

## Common gotchas

> Setup-time symptoms (unstyled UI, `dist/*` 404s, Windows/OneDrive, `401` after a restart) live in [`troubleshooting.md`](troubleshooting.md).

- **Playwright uses its own port `:45173`** (`dev:client:e2e` in `package.json` + `webServer` in `e2e/playwright.config.ts`), so it doesn't collide with a running `yarn dev` on `:5173`. `reuseExistingServer: true` is still on for that port — if a stale `vite` process from a different working tree is already serving `:45173`, Playwright will happily talk to _that_ one. Symptom: tests fail because UI changes "haven't landed". Kill the stray process: `lsof -i :45173 | grep LISTEN`.
- **CSRF guard is strict.** `requireSameOrigin` (`server/api/csrfGuard.ts`) rejects state-changing requests from non-localhost origins. Requests with no `Origin` header (CLI tools, server-to-server) are allowed because the listener is bound to `127.0.0.1`. If you ever expose the listener publicly, tighten this middleware first.
- **Workspace is git-init'd.** The first server start creates `~/mulmoclaude/.git`. Don't be surprised when journal / wiki edits show up in `git log`.
- **`.vue` cognitive-complexity is warn-only.** A few legacy components exceed 15. The override demotes the rule to warn so CI isn't blocked. Each fix should re-raise to error in `eslint.config.mjs`.
- **MCP plugin registration touches several places.** See the [Plugin development](#plugin-development) section below. Forgetting one location silently drops the plugin (no error, just missing tool); a sync-invariant test (`test/plugins/test_meta_aggregation.ts`) catches the most common mismatch — a `BUILT_IN_SERVER_BINDINGS` row without a matching META in `BUILT_IN_PLUGIN_METAS`.
- **Settings reload is per-agent-call, not per-process.** `loadSettings()` runs every time `runAgent` spawns Claude, so the Settings UI takes effect on the next message — but a long-running script that holds an agent reference won't pick up changes mid-stream.

---

## Where to file what

| Problem area                  | File / dir                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adding a new `/api/*` route   | `server/api/routes/<name>.ts`, wire in `server/index.ts`                                                                                                                                                            |
| Adding a shared server helper | `server/utils/<concept>.ts` (one concept per file)                                                                                                                                                                  |
| Adding a Vue composable       | `src/composables/use<Name>.ts`                                                                                                                                                                                      |
| Adding a plugin               | `src/plugins/<name>/{meta,definition,index,View,Preview}.{ts,vue}` (host barrels regenerate via codegen) — see [Plugin development](#plugin-development) and [Auto-discovery](#auto-discovery-no-host-barrel-edits) |
| Adding a test                 | `test/<mirrored-source-path>/test_<module>.ts`                                                                                                                                                                      |
| New developer-facing doc      | `docs/<name>.md` and link from the table at the top of the README                                                                                                                                                   |
