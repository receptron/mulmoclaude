# fix: the file explorer's save writes through the verified write (#3573)

Follow-up to `plans/fix-3573-files-route-reads.md`. This PR moves the plain-file save of `PUT /api/files/content`;
the exclusive creates and the wiki writer are their own PRs.

## Problem

`resolveExistingTextFile` checks the path (realpath, containment, hidden folders, sensitive names, editable type),
and `writeFileContent` then writes it by path with `writeFileAtomic`: a staging file next to the target, then a rename.
A folder on the path swapped for a link out between the check and the write sends both through the link.

Reproduced on `main`:

- One process flips `d` between the real folder and a link to a folder outside, holding each state briefly. Saving
  `d/f.txt` in a loop occasionally overwrote the outside `f.txt`. It is rare, because the staging write and the rename
  must both land while `d` is the link.
- Deterministically: `writeFileContent` called with the checked path after `d` has been replaced by a link out writes
  the outside file. The new test does this.

## Fix

- A file that is not a wiki page is written with `writeFileVerifiedInScope`, scoped to the workspace (anchored at the
  cached async realpath, the form it compares against). Its staging file is verified to sit inside the workspace before
  any byte is written, and the rename stays in that verified folder, so a folder swapped for a link out makes the save
  fail instead of writing through it. The core plan (`plans/fix-3573-verified-open.md`) states what stays best-effort.
- The staging name is random, as `uniqueTmp: true` made it before, so two saves of one file still cannot share a
  staging file.
- `writeFileContent` is exported for the test.

## Behaviour changes

- A save whose folder was swapped for a link out, or removed, between the check and the write answers 500 ("Failed to
  write file"). Before, it wrote through the link, or recreated the removed folder.

## Verified

- Old and new `PUT` handlers ran side by side over generated targets and bodies: plain files in nested folders, JSON
  valid and broken, a wiki page, a file in a read-only folder, a file with mode 600, links in and out, hidden and
  sensitive names, an image, a missing file, a folder, `..` and absolute paths. Each compared the reply and the whole
  resulting tree (names, modes, bytes, and inside and outside the workspace). No difference. The harness is in the PR
  description.
- The race harness: no write outside the workspace on this branch; `main` overwrote the outside file at times.
- The new test in `test/routes/test_filesWriteContent.ts` fails on `main`'s `writeFileContent`.

## Not in this PR

- `POST create` and `POST upload` create exclusively (`wx`); the verified write renames over the target, so they need
  an exclusive verified create in core first.
- Wiki page writes (`writeWikiPage`), which the PUT and create of a wiki page go through, along with every other wiki
  writer.
- `mulmoscript-plugin` ops, `exportShapeScriptUsdz`, `runtime-plugin` assets.
