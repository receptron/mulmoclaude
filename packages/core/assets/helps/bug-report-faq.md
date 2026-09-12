# Bug-report FAQ — check these before calling it a bug

This file is an **index, not an answer sheet**. It never states a value ("the default is off"), only
where today's truth lives, because the agent reads the real thing at run time. Values rot silently;
a config key or a file path cannot — rename one and the implementation stops working, so it gets
fixed.

Each entry's `configKey:` / `source:` / `help:` lines are **verified by CI**: a key that no longer
exists, or a path that moved, fails the test rather than misleading a user months later.

Read in this order, because only the first two are available to every user:

1. **`configKey:`** — the live value, from `config/settings.json` in the workspace. Absent from the
   file means the setting is at its default, which is the answer to most entries here.
2. **`help:`** — another page in `config/helps/`, always present.
3. **`source:`** — a path in the MulmoClaude **repository**. Only readable when running from a clone
   (`yarn dev`); an `npx mulmoclaude` user has no repo, so never tell them to open one. It is listed
   so CI can prove the pointer is still real, and for whoever ends up fixing the code.

Entry format:

```
## The symptom, in the words a user would say

configKey: <a key in config/settings.json>   (optional, repeatable)
source: <path in the MulmoClaude repo>       (optional, repeatable)
help: <another page in config/helps/>        (optional, repeatable)

What to check. Never what the value is.
```

Maintained by hand, in the repo. This file is the source of truth; the issue tracker is the inbox.

---

## Voice input does nothing, or the mic button is disabled

configKey: voiceInput
source: packages/core/src/whisper
help: error-recovery.md

Read `voiceInput` from the live settings — a key absent from the file has never been touched, and
turning it on is what triggers the model download. Three separate conditions gate the mic button:
platform capability, the opt-in, and whether the model finished downloading. `GET /api/health`
reports all three as `voiceInput`, so check it before deciding which one is missing — "on but still
greyed out" is a different question from "never turned on".

## I don't get a notification when a task finishes

configKey: pushEnabled
source: server/agent/webPush.ts
help: remote-host.md

Two conditions must hold at once, so read both before calling it a bug. `pushEnabled` in the live
settings is the user's opt-in. The RemoteHost channel must also be connected — that connection is
what supplies the Firebase auth, so with the phone link down the send is a no-op by design. A user
who never connected a phone has nothing to receive the push regardless of the setting.

## MulmoClaude is answering with a different model than I expected

configKey: chatModel
source: server/agent/config.ts

Read `chatModel` from the live settings. Absent means MulmoClaude passes no `--model` at all and the
CLI resolves the model from `~/.claude/settings.json` — the same file the VS Code and Cursor Claude
Code extensions write their `/model` pick to, so a switch made in another editor changes MulmoClaude
too, with nothing on screen to say so. Setting the key from Settings → Model is what pins MulmoClaude
independently of that shared file. A session already running keeps its model until the next turn, so
"it changed partway through a conversation" is the expected shape of this, not a second bug.

## My chats never get titles or summaries

configKey: chatIndex
source: server/workspace/chat-index/indexer.ts

Read `chatIndex` — it names the model the background summarizer spawns, and the summarizer does
nothing until it does. One exception worth knowing before calling it a bug: sessions that didn't
originate from the user (`system`, `scheduler`) are always skipped whatever the setting says, so a
scheduled task's chat having no title is expected.

## The journal / daily summary is empty

configKey: journal
source: server/workspace/journal/index.ts

Read `journal` first — it gates the archivist that summarizes chat sessions into `journal/*.md`,
and when it is not enabling a run the archivist short-circuits before the interval gate is even
consulted. Neither the turn-end hook nor the hourly scheduled task will have written anything, so
an empty journal is not evidence of a scheduler fault.

## Gmail / Google Calendar / Notion tools don't show up for the agent

configKey: extraAllowedTools
source: server/agent/config.ts

Connector tools reach the agent only when their MCP prefix is listed in `extraAllowedTools` — the
list is appended to the base allowed-tools set on every spawn. Check the live value for the
expected `mcp__…` prefix, and remember the connector must also be linked on the Claude side. A tool
that is linked but unlisted is configuration, not a bug.

## A skill I saved isn't callable

source: server/workspace/hooks/handlers/skillBridge.ts
source: server/workspace/skills/discovery.ts
help: collection-skills.md

Skills are authored at `data/skills/<slug>/SKILL.md` and mirrored into `.claude/skills/<slug>/` by a
hook — agents must not write the latter directly. If the staging file exists but the mirror doesn't,
the hook is the thing to look at. Bundled `mc-*` presets are a different case: they land in the
catalog (`data/skills/catalog/preset/`) and are **not** active until the user stars one, so "the
preset skill doesn't respond" is usually "it was never activated".

## I edited an mc-* skill and my changes came back reverted

source: packages/core/src/workspace-setup/sync.ts

Working as designed: `mc-*` presets are launcher-managed factory defaults, refreshed from the
shipped copy on every server boot so bug fixes and renames actually reach an already-starred copy.
Any file it overwrites is first saved next to it as `<file>.bak.<timestamp>`, so the user's edits
are recoverable — point them at that instead of re-typing. To keep changes permanently, copy the
skill to a new non-`mc-` slug.

## The agent can't use git / gh / ssh

help: error-recovery.md
help: sandbox.md

The agent's Docker sandbox exposes no host SSH agent and no `gh` config unless the user opted them
in at start-up. `GET /api/sandbox` reports whether the sandbox is active and which config mounts it
was started with — read that rather than assuming either way. This is the single most common "it's
broken" report and it is configuration. `error-recovery.md` has the exact flags and the
verification commands; don't restate them from memory.

## A collection's custom view is blank

help: custom-view.md
help: custom-view-remote.md

Desktop and phone views have **incompatible runtime contracts** — a desktop view fetches its own
records with an injected token, while a `target: "mobile"` view gets them over a postMessage bridge
and cannot `fetch` at all. A view authored against the wrong contract renders empty with no error.
Check which target it is registered as before treating it as a rendering fault.

## The narration is not the voice I asked for, or a small tweak re-recorded every beat

help: mulmoscript.md
help: error-recovery.md

Speech settings resolve through fallbacks that raise no error, so read the script's own
`speechParams` block against the speaker reference in `mulmoscript.md` (§ speechParams) before
treating it as a bug. Three mechanisms explain nearly every report: a `lang` entry replaces the
whole speaker rather than extending it, each delivery option reaches some providers and is dropped
by others, and the audio cache key of each beat is built from the speaker's own fields — so editing
one of them re-records every beat that speaker narrates. Which field is missing decides which
symptom you are looking at.
