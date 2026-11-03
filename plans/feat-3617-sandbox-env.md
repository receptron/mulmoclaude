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
- **The file goes to docker as `--env-file <path>`**, not copied into the spawn environment. That environment also
  configures the docker CLI, so a line like `DOCKER_HOST=…` or `HOME=…` would redirect the CLI instead of reaching the
  container.
- **Reserved names are read off the sandbox argv itself** (`dockerEnvNames`), not a hand-kept list, so a fixed
  variable added later is protected automatically. Reserved names are refused from `SANDBOX_ENV`; in the file the
  fixed `-e` wins because docker applies `-e` after `--env-file`.
- **A file docker would refuse is not passed at all**: a name outside `[A-Za-z_][A-Za-z0-9_]*` (docker fails the whole
  `run` on a name with whitespace), or an unreadable / oversized file. CRLF files are accepted: docker strips the `\r`
  (checked against docker 27.4, for valued and bare lines).
- New options are spliced in just before the image, after every existing option.

## Files

- `server/agent/sandboxEnvPlan.ts` — pure: parse, reserved names, plan, splice.
- `server/agent/sandboxEnv.ts` — bounded file read + logging.
- `server/agent/backend/claude-code.ts` — wiring at the docker spawn.
- `server/system/env.ts` — the two settings.
- `test/agent/test_sandboxEnv.ts`.
- Docs: `docs/sandbox-credentials.md`, `docs/developer.md`, `README.md`, `docs/CHANGELOG.md`.

## Not in this change

- Showing the passed names in the lock popup (`GET /api/sandbox`) — UI + all locales; separate PR.
- `packages/core/assets/helps/sandbox.md` — changing it requires a `@mulmoclaude/core` release.
- Moving the existing `GH_TOKEN` fallback (value in argv) to the same scheme — separate issue.
