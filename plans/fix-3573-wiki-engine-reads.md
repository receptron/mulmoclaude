# fix: the wiki read engine reads only inside the workspace (#3573)

Follow-up to `plans/fix-3573-wiki-page-reads.md`, which left the read engine in core out.

## Problem

The wiki read engine (`packages/core/src/wiki/server/engine.ts`, shared by MulmoClaude and MulmoTerminal) built every
path from `wikiDirs(workspace)` and read it as is. A `data/wiki` or `data/wiki/pages` linked to a folder outside the
workspace, or an `index.md` / `log.md` linked to a file outside, was followed:

- `resolvePagePath` / `readWikiPage` listed and returned outside `.md` pages (the wiki view, `POST /api/wiki`);
- `readWikiIndex` / `readWikiLog` returned the outside files;
- `loadWikiGraph` and `collectLintIssues` read every outside page.

The page index lists regular files only, but it is cached on the pages folder's mtime. A page swapped for a link after
the index was built, with the folder's mtime set back, was read through the link. A FIFO at `index.md` or `log.md`
blocked the server on read.

Reproduced on `main`: with `data/wiki` linked out, `readWikiPage` returns the outside page. The page swap and the FIFO
reproduce on the first head of this PR too. The new test covers each.

## Fix

- `wikiReadLocations` (`packages/core/src/wiki/server/locations.ts`): the pages folder, index and log as realpaths that
  stay inside the workspace realpath, or `null`. It uses the native realpath: the JS one keeps the letter case a link was
  written with, so on a case-insensitive disk a link inside the workspace spelled with different case looked like it led
  out (Codex review). When the native call fails for a reason other than "not found", the JS one is tried. The
  containment test (`isWithin`) uses `path.relative`, so a workspace at a filesystem root (`/`, `C:\`) still passes
  (CodeRabbit / Sourcery review).
- The engine lists and reads only through those realpaths; `null` reads as absent (no pages, empty index or log).
- Every file read (`readTextSafe` / `readTextSafeSync` in `wiki/server/fs.ts`) opens with `O_NOFOLLOW | O_NONBLOCK` and
  reads only a regular file, so a cached page that became a link, or a FIFO, reads as empty (review).
- Paths handed back to callers (`resolvePagePath`, `readWikiPage().filePath`) keep the caller's spelling,
  `<workspace>/data/wiki/pages/<file>`, because hosts compare them with paths built the same way (`wikiSlugFromAbsPath`).

## Behaviour changes

- Wiki folder, pages folder, index or log that leads out of the workspace: the wiki view shows no such page, the index
  and log read empty, the graph is empty, and lint reports the pages folder as missing. A link to something inside the
  workspace keeps working.

## Verified

- Old and new engine ran side by side over page names (literal, title, fuzzy, CJK, link form, missing, empty) and every
  public function, across layouts (plain, missing folders, missing workspace, linked workspace, wiki / pages / index /
  page linked inside, pages a file, no index, and the link-out layouts). Outside the link-out layouts: no difference.
  With a link out: the outside pages, index, log, graph nodes and lint findings are gone.
- `packages/core/test/wiki/test_engineConfinement.ts`: the link-out cases fail on `main`; the cached-page swap and the
  FIFO cases fail on the first head of this PR (the FIFO one hangs).

## Not in this PR

- The agent prompt (`server/agent/prompt.ts`, `buildWikiContext`) reads the wiki summary into the system prompt by path.
- The session backlinks driver lists and reads pages by path; its write back is refused since #3653.
- A wiki that leads outside is reported as missing (lint: "pages/ directory does not exist yet"), not as refused.
- The shared `resolveWithinRoot` (`@mulmoclaude/core/files`) keeps the JS realpath and the `rootReal + sep` prefix, so
  the case and filesystem-root fixes live only here; aligning it touches every caller.
- The page index is still validated on the folder's mtime alone, so a folder restored with an older mtime is listed
  from the stale index. A wrong listing, not a read outside: every read is checked as above.
- MulmoTerminal declares `@mulmoclaude/core` `^6`, and this ships in core 7; it reaches MulmoTerminal when it moves to
  core 7.
- The swap-after-check race on the folders stays best-effort, as in the earlier plans.

## Release

A core change: it reaches npm users after a `@mulmoclaude/core` publish (and a launcher publish for MulmoClaude).
