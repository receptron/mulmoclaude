# Sandbox

MulmoClaude runs the Claude Code agent inside a **Docker sandbox** when Docker is available. This isolates the agent's file-system access and limits what it can do on the host.

## How It Works

- On each agent invocation, the server checks whether Docker is running.
- If Docker is available (and `DISABLE_SANDBOX` is not set), Claude Code runs inside a disposable container (`mulmoclaude-sandbox`) built from `Dockerfile.sandbox`.
- If Docker is not available, Claude Code runs directly on the host with the workspace as its working directory.

## What the Container Can Access

| Mount | Container path | Mode |
|---|---|---|
| Workspace | `/home/node/mulmoclaude` | read-write |
| `node_modules/` | `/app/node_modules` | read-only |
| `server/` | `/app/server` | read-only |
| `src/` | `/app/src` | read-only |
| `~/.claude/` | `/home/node/.claude` | read-write |
| `~/.claude.json` | `/home/node/.claude.json` | read-write |

The container runs with `--cap-drop ALL` and as the host user's UID/GID, so it has no elevated privileges.

## Disabling the Sandbox

Set the environment variable `DISABLE_SANDBOX=1` to always run the agent directly on the host, even when Docker is available. Equivalently, pass the `--disable-sandbox` CLI flag — `npx mulmoclaude --disable-sandbox` or `yarn server --disable-sandbox` (**not** `yarn dev`, whose compound script drops trailing args; use the env var there). The flag form is handy on Windows PowerShell (no inline `VAR=value` syntax), in IDE / launcher run configs, and for quick ad-hoc debugging. Both set the same internal switch; the env var stays supported in parallel.

## Debug aids (opt-in env vars)

These flags exist for development / debugging only. Off by default so production runs aren't surprised. Each has an equivalent `--flag` CLI form (drop the `=1`, kebab-case the name) accepted by `npx mulmoclaude` and `yarn server` — but **not** `yarn dev`, which drops trailing args — e.g. `DISABLE_SANDBOX=1` ≡ `--disable-sandbox`, `PERSIST_TOOL_CALLS=1` ≡ `--persist-tool-calls`, `DISABLE_MACOS_REMINDER_NOTIFICATIONS=1` ≡ `--disable-macos-reminders`, `JOURNAL_FORCE_RUN_ON_STARTUP=1` ≡ `--journal-force-run`, `CHAT_INDEX_FORCE_RUN_ON_STARTUP=1` ≡ `--chat-index-force-run`. Secret-bearing vars (auth token, API keys) have no flag form on purpose — argv is visible via `ps` / shell history.

- `DISABLE_SANDBOX=1` — see above. Bypasses the Docker sandbox.
- `PERSIST_TOOL_CALLS=1` — also persist `tool_call` events to the session jsonl alongside `tool_result`. Useful for reading the args sent to a tool after the run is over (page refresh / server restart). Off by default because args can be large and may carry payload bytes (inline images, full MulmoScript JSON) you didn't expect to land in the jsonl. See [issue #1096](https://github.com/receptron/mulmoclaude/issues/1096) for the rationale.

## Host Credentials (opt-in)

The sandbox is credential-free by default. Two opt-in flags let you expose the minimum needed for `git` / `gh` to authenticate without leaking private keys into the container:

- `SANDBOX_SSH_AGENT_FORWARD=1` — forwards the host's SSH agent socket (private keys stay on the host).
- `SANDBOX_MOUNT_CONFIGS=gh,gitconfig` — allowlisted read-only config mounts.

Full contract, what's deliberately excluded, and troubleshooting: [`docs/sandbox-credentials.md`](../../docs/sandbox-credentials.md).

## Checking the Current Sandbox State

Two places surface what's actually attached to **your** running container — useful when you've just toggled an opt-in flag and want to confirm it took effect.

### From the UI — lock icon popup

Click the 🔒 icon in the top bar. The popup shows:

- **Sandbox enabled / disabled** — whether Docker was detected and `DISABLE_SANDBOX` is off.
- **Host credentials attached** (only when the sandbox is on):
  - **SSH agent**: `forwarded` when `SANDBOX_SSH_AGENT_FORWARD=1` **and** `$SSH_AUTH_SOCK` points at a live socket. If the flag is on but the socket is missing, the popup shows `not forwarded` and the server log carries the reason.
  - **Mounted configs**: allowlisted names from `SANDBOX_MOUNT_CONFIGS` whose host path exists. Names you typed but whose host path is missing are silently dropped from the UI (they appear in the server log as `config mount skipped`).

The popup also has a **sample query button** that asks Claude to summarise this information in natural language.

### From inside a chat session

Inside the container, you can verify each piece directly:

```bash
# SSH agent — lists identities the host agent will sign with
ssh-add -l

# gh config — mounted read-only, so `gh auth status` should succeed
ls /home/node/.config/gh && gh auth status

# gitconfig — mounted read-only
cat /home/node/.gitconfig
```

### From the server log

The popup intentionally exposes **names only**, never host paths or skip reasons. Full debug detail lives in the server log:

- `[sandbox] host credentials attached to container` — one-line summary of what was mounted on agent spawn.
- `[sandbox] unknown SANDBOX_MOUNT_CONFIGS entries ignored` — typo in the CSV.
- `[sandbox] config mount skipped (host path missing)` — name is in the allowlist but the host file/dir doesn't exist.
- `[sandbox] SSH agent forward requested but skipped` — flag on but `$SSH_AUTH_SOCK` unset or non-existent.

If the popup isn't showing what you expect, grep the startup log for `[sandbox]` first.

## First-Time Setup (macOS)

On macOS, the Docker container uses a separate credential store from the host. Before using the sandbox for the first time (and whenever the credential expires), run:

```
yarn sandbox:login
```

This opens an interactive `claude login` session inside the container so that the sandbox has valid credentials.

## Building the Image

The sandbox image is built automatically on first use. If `Dockerfile.sandbox` changes, the image is rebuilt on the next agent invocation. No manual build step is needed.
