# fix: resolve a natively installed `claude.exe` on Windows (#3681)

## Problem

On Windows the launcher's pre-flight (`claude --version`) passes, but every spawn
then fails with `claude CLI binary not found`. `server/utils/claudeBin.ts` only
looks for `node_modules/@anthropic-ai/claude-code/bin/claude.exe` under the
npm / Yarn / pnpm global layouts, reached from `where claude.cmd`. A `claude.exe`
installed by the native installer (`install.ps1`, into `%USERPROFILE%\.local\bin`)
or WinGet is on PATH as a bare `.exe`, so none of the probes reach it.

Whether this is what the reporter of #3681 hit is not yet confirmed (asked in
the issue); the gap itself is reachable from the code alone.

## Change

- PATH probe: `where claude` instead of `where claude.cmd`, so lines come back in
  the PATH order the launcher check resolves. A `.exe` line is a candidate as-is;
  any other line is a package-manager shim and keeps the existing walk-up.
- Last-resort default: `%USERPROFILE%\.local\bin\claude.exe`, after the existing
  npm / Yarn / pnpm defaults so hosts that resolve today resolve the same way.

## Out of scope

- The not-found message can list the same path twice (npm prefix and
  `%APPDATA%\npm` coincide). Cosmetic; left alone.
- The launcher's `claude --version` check and the server resolver still decide
  independently.

## Tests

`test/utils/test_claudeBin.ts`: exe on PATH, upper-case `.EXE`, PATH order in both
directions, a listed exe that no longer exists, blank `where` output, the
`USERPROFILE` fallback, and the path appearing in the not-found error.
