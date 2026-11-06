# fix: launcher waits for the server as long as it lives (#3623)

## Problem

`npx mulmoclaude` polls the spawned server and gives up after a fixed 15 s window
without saying anything. `server/index.ts` awaits `setupSandbox()` (Docker image
check / build) and other boot work before `app.listen()`, so on Windows + Docker
startup routinely exceeds the window: no ready banner, no browser, no message.

## Decision

Drop the deadline. The launcher already exits when the server exits
(`server.on("exit")`), so polling while the server lives cannot hang — the
"crash loop" the deadline guarded against ends the launcher anyway.

- `server/utils/wait-ready.mjs`: `waitUntilReady({ port, isServerAlive, onSlowStart, ... })`
  polls until the server answers or dies, with probe / sleep / clock injected.
- Readiness reuses `detectRunningServer` (`/api/health`, 401 = MulmoClaude) — the
  same probe the instance guard uses — instead of a second hand-rolled GET `/`.
- After `SLOW_START_NOTICE_AFTER_MS` without an answer, print one notice naming
  the URL, so a user who would rather not wait knows where to go.
- `shouldAnnounceSlowStart` is the pure rule; `test/utils/test_waitReady.ts` covers it
  and the loop (ready, notice exactly once, stop on server exit).

## Out of scope

- Server-side readiness signal over IPC (considered; touches the server, not needed).
- The macOS icon launcher (`server/utils/launcher/start.mjs`) shows its own starting
  page and does not use this wait.
