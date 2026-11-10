# fix: wiki edit history stays inside the workspace (#3573)

Follow-up to `plans/fix-3573-wiki-page-writes.md`, which left the history snapshot write out.

## Problem

`server/workspace/wiki-pages/snapshot.ts` checked only the slug's own history folder (`.history/<slug>`) with
`lstat`, then used the path as built. A folder above it — `data/wiki` or `data/wiki/.history` — that is a link to a
folder outside the workspace was followed by every operation:

- `appendSnapshot` (after a page save, and from `POST /api/wiki/internal/snapshot`) made the folders and wrote the
  snapshot outside.
- `listSnapshots` / `readSnapshot` (the history routes, restore, and the internal route's "no change" check) read
  outside files.
- `gcSnapshots` deleted outside files whose names look like snapshots.

Reproduced on `main`: with `.history` linked out, an append writes outside, a list returns the outside files, and GC
deletes the oldest outside one. The new test does this.

## Fix

- One rule, in `historyDirForRead`: the slug's history folder is used only as its realpath, and only when it is not
  itself a link and resolves inside the workspace. List, read and GC go through it and treat anything else as "no
  history", as a slug folder that is a link already was.
- `writeSnapshotFile`: missing folders are made through `resolveWriteWithinRoot` (every existing folder realpath-checked
  first) and the file is written with `writeFileVerifiedInScope`, scoped to the workspace realpath, as page writes are.
- A slug folder that is a link is still refused before anything else, with the same error.

## Behaviour changes

- History whose folder leads outside the workspace: recording fails (logged as a background error after a page save;
  500 from the internal route), and the history view shows none.
- Recording now needs the workspace folder to exist; before, a missing workspace folder was made. No caller reaches
  this: the page write before it already needs the workspace, and the internal route runs inside a started server.

## Verified

- Old and new `snapshot.ts` ran side by side over generated slugs (valid, CJK, dotted, traversal, empty, nested), seeded
  history (none, a few, past the retention count, stray files, a link entry), all four operations, and layouts (plain,
  missing folders, missing workspace, linked workspace, history linked inside, slug folder linked inside or out or a
  file, read-only history). Results and the whole tree were compared. In the layouts without a link out the only
  difference is the missing workspace above. With a link out, every difference is the intended refusal: append
  refused, list empty, read null, GC touching nothing.
- `test/workspace/wiki-pages/test_snapshotConfinement.ts` fails on `main` for the three link-out cases.

## What stays best-effort

- A folder swapped for a link out between the check and the use. A write is still verified before any byte lands;
  `mkdir` can make an empty folder outside, as in `plans/fix-3573-wiki-page-writes.md`. A read or GC can still be
  redirected by a swap after the check; snapshot files are opened with `O_NOFOLLOW`, and GC unlinks only names shaped
  like snapshots.
