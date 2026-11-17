# fix: the system prompt reads workspace files only from inside the workspace (#3573)

Follow-up to `plans/fix-3573-wiki-engine-reads.md`, which left `server/agent/prompt.ts` out.

## Problem

`buildSystemPrompt` (sync) reads workspace files by path:

- `buildWikiContext`: `data/wiki/summary.md` into the prompt, and the existence of `index.md` / `SCHEMA.md`;
- `readLegacyMemoryFile`: `conversations/memory.md` into the prompt.

A `data/wiki`, or any of those files, linked to something outside the workspace was followed, so the outside contents
reached the agent's system prompt. A sandboxed agent can plant such a link in the shared workspace. Reproduced on
`main`: with `data/wiki` linked out, the outside `summary.md` appears in the prompt.

A summary that is a folder or unreadable threw (`EISDIR` / `EACCES`), breaking prompt assembly.

## Fix

- The sync checked read the wiki engine got in #3662 moves from `wiki/server/fs.ts` to `@mulmoclaude/core/files`
  (`withinRoot.ts`: `readTextWithinRootSync`, `readTextWithinRoot`, `isWithinRoot`, `realpathSyncOrNull`), and the
  engine imports it from there. One implementation; catalogued in `docs/shared-utils.md`.
- `prompt.ts` resolves each file first (`realpathSyncOrNull` + `isWithinRoot`), so a file linked to another file inside
  the workspace still reads, then reads the realpath with `readTextWithinRootSync`. `index.md` / `SCHEMA.md`
  existence uses the same resolution.

## Behaviour changes

- A wiki whose `index.md` leads outside counts as no wiki ("No wiki exists yet"); a summary, schema or legacy memory file
  that leads outside is left out.
- A summary that is a folder or unreadable falls back to the layout hint instead of throwing.

## Verified

- Old and new `buildWikiContext` / `buildMemoryContext` side by side over summary and memory contents and layouts
  (plain, missing files, missing workspace, linked workspace, wiki / summary / memory linked inside, summary a folder or
  unreadable, the link-out layouts, a FIFO summary). Outside the link-out layouts the only differences are the two
  where the old code threw. With a link out, nothing outside reaches the prompt; the FIFO case runs on the new code only
  (the old one blocks).
- The engine moved onto the shared read: side by side against `main`, no difference.
- `test/agent/test_promptConfinement.ts` fails on `main` for the link-out and folder cases;
  `packages/core/test/files/test_withinRoot.ts` covers the shared read.

## Not in this PR

- The typed and topic memory loaders (`server/workspace/memory/`) read files by path; their own change.
- `prependJournalPointer` checks `summaries/_index.md` existence by path (one bit, no contents).
- The shared `resolveWithinRoot` / `verified.ts` containment keeps the JS realpath and the `rootReal + sep` prefix;
  aligning it with `withinRoot.ts` is the next change.
