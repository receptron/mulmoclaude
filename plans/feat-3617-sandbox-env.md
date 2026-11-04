# feat: environment variables for the Docker sandbox (#3617)

## Goal

Let the user pass their own tokens to the sandboxed agent as environment variables instead of key files in the
workspace. Off by default; no change for anyone who does not set the new variables.

## Settings

- `SANDBOX_ENV=NAME1,NAME2` — host variables by name.
- `SANDBOX_ENV_FILE=<path>` — a docker-style env file.
- No CLI flag (the other `SANDBOX_*` settings are env-only; #3499 was a documented flag that did not exist).

## Decisions

- **No value in the docker argv.** Names become `-e NAME`; docker reads the value from its own environment, which
  the server's spawn inherits unchanged.
- **The file is never copied into the spawn environment** — that environment also configures the docker CLI, so a
  line like `DOCKER_HOST=…` or `HOME=…` would redirect the CLI instead of reaching the container. Nor is the user's
  path handed to docker: the lines that pass are re-serialised and written into a pipe on the child's fd 3, which
  docker reads as `--env-file /dev/fd/3`. Docker reads exactly what was checked, and nothing touches the disk.
- **Why a pipe and not a staged file.** A staged copy needs a directory only this user can read on every platform,
  an ownership check that Windows cannot express by uid, and a cleanup that survives a killed server (pid in the
  name, a sweep, pid reuse). Each of those produced a further finding; the pipe removes the whole class. Windows has
  no `/dev/fd`, so `SANDBOX_ENV_FILE` is not passed there (logged); `SANDBOX_ENV` works everywhere.
- **A file the container can reach is refused**: every ancestor of the path, as written and resolved, and the file's realpath (`realpathSync.native`, so letter case matches the disk) must be outside every mount; the file is opened once, must have a single hard link (another may be inside a mount), must be the object at the realpath (dev/ino), and only that descriptor is read. Before that rule it was compared by realpath alone, which a link inside a mount could retarget; the agent could read refused values and
  rewrite the file for the next run. The mount sources are read off the final docker argv (`dockerMountSources` over
  `-v` / `--mount`), not listed by hand, so app-code, plugin-tree and reference-dir mounts are all covered.
- **Reserved names** = the `-e` names in the sandbox argv (`dockerEnvNames`, no hand-kept list) ∪ the variables
  `sandbox-entrypoint.sh` reads (`ENTRYPOINT_ENV_NAMES`, pinned by a test that scans the script) — `HOST_UID` is only
  in the argv with SSH forwarding on, yet setting it alone switches the entrypoint's branch ∪ the image's own variables
  (`IMAGE_ENV_NAMES`: `PATH` above all — the entrypoint and the CLI start by bare name; pinned by a test against
  `docker image inspect` when the image is present). Dropped from both settings.
- **Names follow docker's rule** (non-empty, no whitespace; `=` also refused for `SANDBOX_ENV`). A bad line is dropped
  on its own; skips are logged by name, or by position / line number for an invalid entry, never by its text.
- **The read cannot block**: `O_NONBLOCK` open, then `isFile` and a size cap.
- New options are spliced in just before the image, after every existing option.

## Files

- `server/agent/sandboxEnvPlan.ts` — pure: parse, reserved names, mount sources, plan, env-file text, splice.
- `server/agent/sandboxEnv.ts` — non-blocking bounded read, mounted-dir refusal, Windows gate, logging.
- `server/agent/backend/claude-code.ts` — wiring at the docker spawn; fd 3 pipe only when there is file text.
- `server/system/env.ts` — the two settings.
- `test/agent/test_sandboxEnv.ts`.
- Docs: `docs/sandbox-credentials.md`, `docs/developer.md`, `README.md`, `docs/CHANGELOG.md`.

## Not in this change

- Showing the passed names in the lock popup (`GET /api/sandbox`) — UI + all locales; separate PR.
- `packages/core/assets/helps/sandbox.md` — changing it requires a `@mulmoclaude/core` release.
- Moving the existing `GH_TOKEN` fallback (value in argv) to the same scheme — separate issue.
