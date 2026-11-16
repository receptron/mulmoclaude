# fix: the wiki read engine reads only inside the workspace (#3573)

Follow-up to `plans/fix-3573-wiki-page-reads.md`, which left the read engine in core out.

## Problem

The wiki read engine (`packages/core/src/wiki/server/engine.ts`, shared by MulmoClaude and MulmoTerminal) built every
path from `wikiDirs(workspace)` and read it as is. A `data/wiki` or `data/wiki/pages` linked to a folder outside the
workspace, or an `index.md` / `log.md` linked to a file outside, was followed:

- `resolvePagePath` / `readWikiPage` listed and returned outside `.md` pages (the wiki view, `POST /api/wiki`);
- `readWikiIndex` / `readWikiLog` returned the outside files;
- `loadWikiGraph` and `collectLintIssues` read every outside page.

A page file that is itself a link was already skipped: the page index lists regular files only.

Reproduced on `main`: with `data/wiki` linked out, `readWikiPage` returns the outside page. The new test does this for
each case.

## Fix

- `wikiReadLocations` (`packages/core/src/wiki/server/locations.ts`): the pages folder, index and log as realpaths that
  stay inside the workspace realpath, or `null`. It uses the native realpath: the JS one keeps the letter case a link was
  written with, so on a case-insensitive disk a link inside the workspace spelled with different case looked like it led
  out (Codex review). The shared `resolveWithinRoot` uses the JS realpath and has the same trait; it is left as is here.
  The containment test (`isWithin`) uses `path.relative`, so a workspace at a filesystem root (`/`, `C:\`) still
  passes (CodeRabbit / Sourcery review).
- The engine lists and reads only through those realpaths; `null` reads as absent (no pages, empty index or log).
- Paths handed back to callers (`resolvePagePath`, `readWikiPage().filePath`) keep the caller's spelling,
  `<workspace>/data/wiki/pages/<file>`, because hosts compare them with paths built the same way (`wikiSlugFromAbsPath`).

## Behaviour changes

- Wiki folder, pages folder, index or log that leads out of the workspace: the wiki view shows no such page, the index
  and log read empty, the graph is empty, and lint reports the pages folder as missing. A link to something inside the
  workspace keeps working.

## Verified

- Old and new engine ran side by side over page names (literal, title, fuzzy, CJK, link form, missing, empty) and every
  public function, across layouts (plain, missing folders, missing workspace, linked workspace, wiki / pages / index /
  page linked inside, pages a file, no index, and five link-out layouts). Outside the link-out layouts: no difference.
  With a link out: the outside pages, index, log, graph nodes and lint findings are gone.
- `packages/core/test/wiki/test_engineConfinement.ts` fails on `main` for the three link-out cases.

## Not in this PR

- The agent prompt (`server/agent/prompt.ts`, `buildWikiContext`) reads the wiki summary into the system prompt by path.
- The session backlinks driver lists and reads pages by path; its write back is refused since #3653.
- The swap-after-check race stays best-effort, as in the earlier plans.

## Release

A core change: it reaches npm users after a `@mulmoclaude/core` publish (and a launcher publish for MulmoClaude).
