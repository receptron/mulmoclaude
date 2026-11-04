# Sandbox Host Credentials

By default, the MulmoClaude Docker sandbox is **credential-free**. The container has `git` and `gh` installed, but no SSH keys, no GitHub token, no git identity — so `git pull` over SSH, `gh issue list`, or `git commit --signoff` all fail inside the container.

This page describes the opt-in mechanisms for giving the sandbox just enough credentials to authenticate, without leaking the underlying secrets: SSH agent forward, allowlisted config mounts, and extra environment variables.

> **Before you turn anything on, read [What we do NOT do](#what-we-do-not-do) and [What we cannot do](#what-we-cannot-do) below.** Each mechanism is safe by design, but the safety relies on understanding the scope.

---

## Quick start

Add one or both to your `.env` (or shell environment):

```env
# Forward the host's SSH agent into the container.
# Private keys stay on the host; only the signing oracle is exposed.
SANDBOX_SSH_AGENT_FORWARD=1

# Mount allowlisted config files/dirs read-only.
# See the table below for the names you can put here.
SANDBOX_MOUNT_CONFIGS=gh,gitconfig
```

Restart the server. On the next agent run you should see a log line like:

```text
INFO  [sandbox] host credentials attached to container mounts=["gh (GitHub CLI auth token + hosts config)","gitconfig (...)","ssh-agent forward"]
```

Inside the container (you can verify by running an agent task that executes shell commands):

```bash
ssh -T git@github.com   # should authenticate via the forwarded agent
gh auth status          # should show your host's gh login
git config --global user.email
```

---

## Mechanism 1 — SSH agent forward

Set `SANDBOX_SSH_AGENT_FORWARD=1`.

**What it does.** Forwards the host SSH agent into the container so `git`, `ssh`, and anything else that speaks the agent protocol can authenticate using the host's keys. **Your private key bytes never enter the container.**

On macOS, Docker Desktop's built-in magic socket (`/run/host-services/ssh-auth.sock`) is used. On Linux, the host's `$SSH_AUTH_SOCK` is bind-mounted directly.

**Host whitelist (security).** By default, the forwarded agent is restricted to `github.com` only — the container cannot use your keys to SSH into other servers. To allow additional hosts:

```bash
SANDBOX_SSH_ALLOWED_HOSTS=github.com,gitlab.com,bitbucket.org
```

The entrypoint generates a restrictive `~/.ssh/config` inside the container (SSH is first-match-wins, so whitelisted hosts come first):
```
Host github.com
  IdentityAgent /ssh-agent    # exception: agent allowed

Host *
  IdentityAgent none          # catch-all: agent blocked
```

**Prerequisites on the host:**

- An SSH agent is running and `$SSH_AUTH_SOCK` is set (Linux only; macOS agent is automatic).
- Your keys have been added (`ssh-add`). Passphrase-protected keys need to be unlocked once on the host before starting the server — the container has no TTY to prompt for a passphrase.

**Skipped automatically (with a `log.warn`) when:**

- Linux: `$SSH_AUTH_SOCK` is not set or the socket path doesn't exist.
- macOS: never skipped (Docker Desktop's magic socket is always available).

The server doesn't fail — it just logs the reason and continues without the forward.

---

## Mechanism 2 — Allowlisted config mounts

Set `SANDBOX_MOUNT_CONFIGS=<names>` to a comma-separated list of names from the table below. Each name is a server-side key that resolves to a fixed host path and container path. **Users cannot pass arbitrary paths** — unknown names are logged as warnings and ignored.

### Allowlist

| Name | Host path | Container path | Kind | What it enables |
|---|---|---|---|---|
| `gh` | `~/.config/gh` | `/home/node/.config/gh` | dir | `gh` CLI (`gh issue list`, `gh pr create`, etc.). Also makes `git push` to GitHub over HTTPS work via the `gh` credential helper. |
| `gitconfig` | `~/.gitconfig` | `/home/node/.gitconfig` | file | `user.name`, `user.email`, signing key, global aliases. Needed to let `git commit` record an author identity. |

All mounts are **read-only**. The container cannot write back to your host config. (The flag that carries it is `-v … :ro`, or `--mount …,readonly` when the path holds a character `-v` cannot express — see [`claude-docker-boundary.md`](claude-docker-boundary.md#how-a-host-path-becomes-a-mount-argument).)

### Adding a new tool

Extending the list is a code change, not a user config. This is deliberate — the allowlist is the security boundary. To add an entry:

1. Append a row to `ALLOWED` in [`server/agent/sandboxMounts.ts`](../server/agent/sandboxMounts.ts), specifying `name`, `hostPath`, `containerPath`, `kind`, and `description`.
2. Add a row to the table above.
3. Think about what the mount exposes and write a short "What it enables" sentence. If the expose is wider than `gh`-level (e.g. tokens for multiple hosts, or a key used for more than one service), consider whether it deserves its own env var instead of riding on `SANDBOX_MOUNT_CONFIGS`.

---

## Mechanism 3 — Extra environment variables

For a token your own tools need inside the sandbox (an HTTP service the agent calls, for example), pass it as an environment variable instead of putting a key file in the workspace. Two settings, usable together:

```env
# Pass host variables by name. The value comes from the server's own environment.
SANDBOX_ENV=MY_SERVICE_TOKEN,MY_SERVICE_URL

# Pass every variable in a docker-style env file (KEY=VALUE per line).
SANDBOX_ENV_FILE=/path/to/agent.env
```

- **Values never appear in the docker command line, and nothing is written to disk.** `SANDBOX_ENV` names become `-e NAME` and docker reads the value from its own environment. The env file is checked, and the lines that pass are written into a pipe that docker reads as `--env-file /dev/fd/3`: docker never re-reads your file, no copy is made, and nothing appears as a file inside the container.
- **Keep the env file outside every directory the sandbox mounts.** A file inside the workspace, `~/.claude`, a reference directory, a plugin tree, or any other path bind-mounted into the container is refused (`SANDBOX_ENV_FILE not passed to the container … inside a directory mounted into the sandbox`): the agent could read every value in it and rewrite it for the next run. The mounts are read off the docker command itself, so this covers whatever the sandbox mounts on that run.
- **The fixed variables cannot be overridden.** Names the sandbox sets (`HOME`, `MULMOCLAUDE_HOST`, `MULMOCLAUDE_CHAT_SESSION_ID`, `MCP_CONNECT_TIMEOUT_MS`, `GH_TOKEN`, …) the ones its entrypoint reads (`HOST_UID`, `HOST_GID`, `SSH_AUTH_SOCK`, `SANDBOX_SSH_ALLOWED_HOSTS`), and the image's own (`PATH`, `NODE_VERSION`, `YARN_VERSION` — a host `PATH` would stop the container from starting) are dropped from both settings and logged as `sandbox env entries ignored`.
- **The env file follows docker's `--env-file` format**: one `KEY=VALUE` per line, `#` comments and blank lines skipped, CRLF line endings fine, no quote stripping, and a bare `KEY` line takes the host's value. A name must not be empty or contain whitespace. A line that breaks that rule is dropped on its own and logged by line number — never by its text, since a mistyped line can hold a secret.
- **When both set the same name, `SANDBOX_ENV` wins.**
- **`SANDBOX_ENV_FILE` is not supported on Windows hosts yet** (there is no `/dev/fd` to read the pipe from); the server logs this and starts the sandbox without it. `SANDBOX_ENV` works on every host.
- The file is re-read on every agent run, so an edit takes effect on the next message without a restart. A FIFO, a directory, an oversized file or one that cannot be read is not passed, and the run goes ahead without it.
- With `DISABLE_SANDBOX=1` the agent runs on the host and already sees the server's whole environment; these settings only matter for the sandbox.

On a run that passes anything, the log shows the names (never the values):

```text
INFO  [sandbox] host env passed to container names=["MY_SERVICE_TOKEN","MY_SERVICE_URL"]
```

---

## What we do NOT do

- **We do not mount `~/.ssh`.** Direct filesystem access to private keys would defeat the point of the sandbox. Use `SANDBOX_SSH_AGENT_FORWARD=1` instead.
- **We do not mount `~/.git-credentials`.** That file contains plaintext HTTPS tokens for *any* host; the blast radius is unbounded. If you need HTTPS for a specific service, set it up through that service's CLI (like `gh`) and mount the CLI's config dir instead.
- **We do not support cloud-provider CLIs (`gcloud`, `aws`, Azure) today.** They're intentionally out of scope — larger attack surface, different threat model. A future issue can revisit this if concrete demand appears.
- **We do not resolve symlinks for you.** If `~/.config/gh` is a symlink to a path outside your home directory, Docker will follow it and mount the target. Check that your config dirs are not symlinked to secrets you don't mean to expose.
- **The read-only flag is not tamper-proof against a malicious image.** The sandbox runs images we build from `Dockerfile.sandbox`. If you replace that image with something hostile, it can read the mounted credentials. The point of the opt-in is to keep *unmodified-Claude-Code* safe, not to defend against a compromised container.

## What we cannot do

- **macOS Keychain-backed credentials.** Git's `osxkeychain` helper, iTerm's SSH keychain integration, and Apple-signed SSH keys in the system keychain all require macOS APIs that aren't mountable. If your GitHub token is only in Keychain, run `gh auth login` once with the `file` credential store to get a mountable `~/.config/gh/hosts.yml`. Same for Windows `wincred`.
- **Passphrase prompts.** Neither mechanism gives the container a TTY. If an SSH key is passphrase-protected and not yet unlocked in the agent, the sign request fails silently. Unlock once on the host (`ssh-add ~/.ssh/id_ed25519`) before starting the server.
- **Interactive 2FA (`gh auth login`, `aws configure sso`).** The container can't drive a browser-based device flow. Do the login on the host; the resulting config is what the mount exposes.
- **Remote bridge / multi-user setups.** This whole page assumes the machine running MulmoClaude is the same machine whose credentials you want to expose. If a future feature lets MulmoClaude run on a remote box, the credentials story is different and this doc does not cover it.

---

## Troubleshooting

**`gh auth status` inside the container says "not logged in", but the mount is set.**
- The server logged `config mount skipped (host path missing) name=gh hostPath=...`: your `~/.config/gh` doesn't exist on the host. Run `gh auth login` on the host first.
- The mount is present but the `.config/gh/hosts.yml` file is writable only by root or a different user. Docker preserves uid/gid; the container runs as your host uid. Run `ls -l ~/.config/gh/hosts.yml` and confirm it's readable by you.

**`git push` over SSH fails with `Permission denied (publickey)`.**
- Confirm `SSH_AUTH_SOCK` is set inside the container: the startup log line should list `ssh-agent forward`. If it's not listed, the server logged a `SSH agent forward requested but skipped` warning with the reason.
- Run `ssh-add -l` on the host — if it says "The agent has no identities", nothing is available to forward.

**`git commit` inside the container errors with `Please tell me who you are`.**
- You haven't mounted `gitconfig`. Either add it to `SANDBOX_MOUNT_CONFIGS` or let Claude set a per-repo identity with `git config user.email` inside the workspace.

**I turned both flags on and see no extra mounts in `docker inspect`.**
- Check the server log at startup for `unknown SANDBOX_MOUNT_CONFIGS entries ignored` — you may have a typo in the env var (`ghub`, `git-config`, etc. are not recognised; only the names in the allowlist table above).
- `DISABLE_SANDBOX=1` also disables the sandbox entirely — in that case `git` and `gh` run on the host and use your host credentials directly, which is why the mounts look absent.

---

## Related

- Issue [#259](https://github.com/receptron/mulmoclaude/issues/259) — the design discussion that led to this doc.
- [packages/core/assets/helps/sandbox.md](../packages/core/assets/helps/sandbox.md) — general sandbox behaviour (what runs where, how to disable it).
- [docs/developer.md](./developer.md) — full list of env vars honoured by the server.
