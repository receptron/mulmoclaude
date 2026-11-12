# fix: a wiki page that links out is not read into its history (#3573)

Follow-up to `plans/fix-3573-wiki-page-writes.md` and `plans/fix-3573-wiki-snapshot-writes.md`, which left two host
reads of a page out.

## Problem

Two host reads of `data/wiki/pages/<slug>.md` followed links:

- `POST /api/wiki/internal/snapshot` (the agent's write hook) read the page with `readTextOrNull` and recorded what it
  read as a snapshot. A page that is a link to a file outside the workspace had that file stored in the page's history
  inside the workspace, where the history routes serve it.
- `writeWikiPage` read the page it is about to replace with `readTextSafe` to keep its frontmatter. A page that links out
  had the outside file's frontmatter merged into the saved page and its snapshot.

Reproduced on `main`: both new tests fail there (the route records the outside file; the save carries its frontmatter).

## Fix

`readWikiPage` (`server/workspace/wiki-pages/io.ts`) opens the page with `openVerifiedWithinScope`
(`@mulmoclaude/core/files`, no core change), scoped to the workspace realpath, and reads through that handle. Anything
that is not a file inside the workspace now — missing, a folder, a link out, or under a folder that leads out — reads as
`null`. `writeWikiPage`'s pre-write read and the internal route both go through it.

## Behaviour changes

- The internal route answers 404 ("wiki page not found on disk") for a page that links out, and records nothing.
- Overwriting a page that links out starts its frontmatter fresh (`created` is today), as for a new page. The save
  already replaced the link without touching the outside file.

## Verified

- Old and new `io.ts` ran side by side over slugs, existing content (none, body, frontmatter, broken frontmatter, same
  body), read and overwrite, and layouts (plain, missing folders, missing workspace, linked workspace, page a folder,
  page unreadable, page dangling, page or pages folder linked inside, and three link-out layouts). Results and whole
  trees were compared. Outside the link-out layouts: no difference. With a link out: reads return null, and an
  overwrite of a page that links out no longer carries the outside frontmatter.
- `test/workspace/wiki-pages/test_readWikiPageConfinement.ts` and the new case in
  `test/routes/test_wikiInternalSnapshotRoute.ts` fail on `main`.

## Not in this PR

- The wiki read engine in core (`packages/core/src/wiki/server/engine.ts`, `pageIndex.ts`) reads the index, log and
  pages by path. A `data/wiki` or `data/wiki/pages` linked out has its `.md` files shown by the wiki view, graph and
  lint. A page file that is itself a link is not listed. This is a core change with a release, shared with
  mulmoterminal, so it is its own change.
- The swap-after-check race stays best-effort, as in the earlier plans; the read is proved on the opened handle.
