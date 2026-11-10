# fix: wiki page overwrites write through the verified write (#3573)

Last part of #3573. Follow-up to `plans/fix-3573-files-route-put.md` and `plans/fix-3573-files-route-create.md`.

## Problem

Every wiki page write goes through `writeWikiPage` (`server/workspace/wiki-pages/io.ts`): the file explorer's save of
a wiki page, `PUT /api/wiki`, restore from history, and the session backlinks. The create-only mode already proves the
new file sits inside the workspace (#3604). The overwrite did not: it wrote by path with `writeFileAtomic`, so a
`data/wiki` or `data/wiki/pages` that is a link to a folder outside the workspace, from the start or swapped in after
the path was built, was written through.

Reproduced on `main`: with either folder replaced by a link out, an overwrite writes the outside folder. The new test
does this.

## Decision

The maintainer chose to refuse such a setup, as the create of a new page already does. A link to a folder inside the
workspace, and a workspace reached through a link, keep working.

## Fix

- The overwrite moves to `writeFileVerifiedInScope` (`@mulmoclaude/core/files`, no core change), scoped to the
  workspace realpath. Its staging file is verified to sit inside the workspace before any byte is written, and its name
  is random, as `uniqueTmp: true` made it before.
- The parent folders are still created when missing, as `writeFileAtomic` did.
- Both modes share one helper (`writePageFile`) and the existing path re-anchoring that CodeQL recognises.

## Behaviour changes

- A wiki save, backlink append or restore whose wiki folder leads out of the workspace now fails (500 from the routes;
  the backlinks driver logs it). Before, it wrote the outside folder.

## Verified

- Old and new `writeWikiPage` ran side by side over generated slugs (valid, CJK, dot-prefixed, traversal, empty,
  nested), existing pages (none, body only, frontmatter, broken frontmatter), bodies, both modes, and layouts (plain,
  missing folders, linked workspace, pages linked inside, read-only pages, page that is a folder). Each compared the
  result and the whole tree including history snapshots: no difference. With a pages folder linked out added, the only
  differences were the overwrites of a valid slug, as intended.
- `test/workspace/wiki-pages/test_writeWikiPageOverwrite.ts` fails on `main` for both link-out cases.

## Not in this PR

- The history snapshot write (`appendSnapshot`, `snapshot.ts`) checks `data/wiki/.history` with `lstat` and then writes
  by path. Same shape, its own change.
- The read of the old content before the write (`readTextSafe`) still follows a page that is a link out; its frontmatter
  can be merged into the saved page. The save itself replaces the link and leaves the target as it was.
