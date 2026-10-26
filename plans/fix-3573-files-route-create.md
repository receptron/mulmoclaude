# fix: new files and dropped files are created only inside the workspace (#3573)

Follow-up to `plans/fix-3573-files-route-put.md`. This PR moves the exclusive creates of `server/api/routes/files.ts`;
the wiki writer is its own PR.

## Problem

`POST /api/files/create` (a file that is not a wiki page) and `POST /api/files/upload` check the path with
`resolveNewFilePath` (containment, hidden folders, sensitive names, the realpath of the deepest existing ancestor), and
then create it by path: `mkdir -p` and `writeFile(…, { flag: "wx" })`. A folder on the path swapped for a link out in
between sends the create through the link.

Deterministic on `main`: `writeNewFileExclusive` called with a checked path after its folder was replaced by a link out
creates the file, with its content, in the link's target. The new test does this.

The verified write that `PUT` now uses cannot serve here: it renames a staging file over the target, which would
replace an existing file instead of failing with EEXIST, and the upload's rename-on-collision loop depends on EEXIST.

## Fix

- `createFileVerifiedInScope(scope, dirReal, leaf, content)` in `@mulmoclaude/core/files`. It opens `leaf` with
  `O_CREAT | O_EXCL | O_NOFOLLOW`, so EEXIST comes from the open exactly as with `wx`. It then proves, as the verified
  write does for its staging file, that the folder is inside the scope and holds exactly the opened file. Only then are
  the bytes written, through the handle. There is no rename, so an existing file is never replaced.
- When the proof fails, the empty file the open created in the link's target is left there, and the call fails. It is
  not removed: by then the name in that folder may belong to a file someone else just created.
- `writeNewFileExclusive(workspaceRoot, absPath, content)` (`server/utils/files/upload-io.ts`) uses it, anchored at the
  async realpath of the workspace. `POST create`'s plain-file branch and the upload's default writer call it.
- Missing parent folders are still made with `mkdir -p` first. A swap there can leave empty folders in a link's
  target; the create that follows is refused.

## Behaviour changes

- A create or upload whose folder was swapped for a link out between the check and the create fails with 500. Before,
  it created the file there.

## Verified

- Old and new `create` and `upload` handlers ran side by side, each in its own process and workspace. Inputs: new
  files, nested missing folders, existing files and folders (409), a read-only folder, wiki pages new and existing,
  hidden and sensitive names, JSON valid and broken, links in and out, a folder that is a link out, `..` and absolute
  paths, a file used as a folder, and uploads with a collision (the second upload of a name). Each compared the reply
  and the whole resulting tree, inside and outside the workspace. No difference. The harness is in the PR description.
- Core: new tests for `createFileVerifiedInScope`. With its proof removed, the three swap tests fail.
- `test/utils/files/test_upload_io.ts` fails on `main`'s `writeNewFileExclusive`.

## Not in this PR

- Wiki page writes (`writeWikiPage`), including the wiki branch of `POST create`.
- `mulmoscript-plugin` ops, `exportShapeScriptUsdz`, `runtime-plugin` assets.

## Release

The host side imports `createFileVerifiedInScope`, so `@mulmoclaude/core` with it must be published before the next
`mulmoclaude` launcher publish.
