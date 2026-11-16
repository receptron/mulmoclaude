# fix: plugin results without `message` reach the LLM as "Done" (#3660)

## Defect

`handleToolCall` in `server/agent/mcp-server.ts` returns `message` / `instructions`
from a plugin dispatch envelope and falls back to `"Done"` otherwise. The google
plugin (and any narrate-only plugin) returns plain JSON — `{ ok, linked, ... }`,
`{ ok, calendars }` — with neither field and no `data`, so the whole result is
dropped and the LLM reads `Done`.

The fake-echo backend (`server/agent/backend/fake-echo.ts`) makes the same decision
with its own copy of the rule.

## Fix

Move the rule into a pure function, `server/agent/pluginResultText.ts`, and route both
callers through it:

1. `message` / `instructions` set → joined with `\n` (unchanged).
2. `data` set → `"Done"` (unchanged: the card carries the result, and `data` can be
   large, so it is not put into the LLM's context).
3. Otherwise → `JSON.stringify(envelope)`, and `"Done"` only when that is `{}`.

Fixing the bridge rather than the google plugin covers every plugin that returns
plain JSON, which is the reason the issue gives for preferring option A.

## Verification

- `test/agent/test_pluginResultText.ts`: covers normal inputs and unusual ones
  (empty, falsy text fields, `data: null`, undefined-only).
- The real broker subprocess, driven against a stub host whose google dispatch returns
  the plugin's shapes: on `origin/main` the result is `Done`; with the fix it is the
  JSON. Envelopes with `message`, with `data` only, and `{}` give the same output on
  both trees.
