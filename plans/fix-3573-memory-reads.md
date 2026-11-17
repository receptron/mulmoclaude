# fix: memory is read only from inside the workspace (#3573)

Follow-up to `plans/fix-3573-wiki-prompt-reads.md`, which covered the wiki summary and the single-file `memory.md`
but not the memory folders.

## Problem

`loadMemorySnapshot` builds the system prompt's `## Memory` section from `conversations/memory/` on every agent turn:

- topic format: `loadAllTopicFiles` (`server/workspace/memory/topic-io.ts`) lists `<type>/` and reads each `.md` by
  path;
- atomic format: `loadAllMemoryEntries` (`server/workspace/memory/io.ts`) lists the folder, resolves links with `stat`
  on purpose, and reads each `.md` by path.

So `conversations/memory`, a type folder, or a memory file linked to somewhere else on the host put that file's contents
into the agent's prompt, sandboxed or not: the H2 headings in topic format, the whole body in atomic format. The same
loaders feed `regenerateTopicIndex` (writes `MEMORY.md`) and the atomic → topic migration (copies entries into topic
files), so the outside contents were also written into the workspace. The startup migrations read the single-file
`conversations/memory.md` by path too (`migrateLegacyMemory`, the topic cluster's `loadClusterInput`, and the seed
check in `seed-topic-layout-run.ts`), so one linked outside was copied into memory files, and the journal's fact
extractor (`server/workspace/journal/memoryExtractor.ts`) sent it to the summariser and rewrote `memory.md` with it
(Codex review). A FIFO at a
topic file never returns, so the turn hangs.

Reproduced on `main`: each link-out layout puts the outside text into `buildMemoryContext`'s output; a FIFO at
`conversations/memory/fact/pipe.md` keeps `loadMemorySnapshot` from returning.

## Fix

- `server/utils/files/within-workspace.ts`: `locateWithinWorkspace(workspacePath, absPath)` (both realpaths, the file
  inside the workspace, else null) and `readTextWithinWorkspace` / `readTextWithinWorkspaceSync` (locate, then
  `readTextWithinRoot(Sync)` on the realpath). Resolving first keeps a link to another file inside the workspace
  working; the read itself refuses a FIFO and a swap after the check.
- Both memory loaders read through `readTextWithinWorkspace`. A refused file reads as unreadable, which they already
  log and skip.
- `server/agent/prompt.ts` uses the same helpers instead of its private copies.
- The migrations read `memory.md` the same way. The seed check keeps telling "missing" (seed) from "unreadable" (do
  not seed): a `memory.md` leading outside counts as missing; one that cannot be resolved (a link loop) or is inside but
  not a readable regular file stays unreadable (CodeRabbit review).
- The journal's fact extractor skips with a warning when `memory.md` exists but is not a readable file inside the
  workspace, instead of reading it as empty: it rewrites the file, so "empty" would replace a link with its target's
  text or wipe a file it could not read. Before, a folder or unreadable file threw, which the daily pass caught.

## Behaviour changes

- A memory file that leads outside the workspace, or is not a regular file, is skipped with the existing "failed to
  read" warning. Memory linked inside the workspace keeps working.

## Not in this PR

- Listing a folder (`readdir`) still follows a folder linked out, so outside names are listed; their contents are
  refused.
- Writes to memory (`writeTopicFile`, `writeMemoryEntry`) are not changed here.
- `run.ts` / `topic-run.ts` look only at `memory.md`'s size to decide whether to migrate; nothing is read.
- The topic migration's staging checks (`countBulletLines`, `isStagingSwappable`) still read by path. They only count
  bullets to decide whether a staging may be swapped in; nothing they read is copied.
