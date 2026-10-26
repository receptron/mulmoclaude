# fix: the file explorer's content and raw reads go through the verified open (#3573)

Follow-up to `plans/fix-3573-workspace-readers.md`. This PR moves the two read endpoints of
`server/api/routes/files.ts`; its writes are their own PR.

## Problem

`GET /api/files/content` and `GET /api/files/raw` check a path with `resolveSafe` / `resolveRefPath` (realpath,
containment, hidden folders, sensitive names) and then read it again by path: `readFileSync` and `createReadStream`.
Their anchor is the workspace, or the reference directory for `@ref/…`, so the symlinked-root hole of the earlier groups
does not apply. What is left is the race in the issue.

Reproduced on `main`:

- One process flips `d/f.txt` between the in-workspace file and a link to a file outside, each flip an atomic rename.
  Both endpoints return the outside file's bytes for some of the requests.
- Deterministically for `raw`: `createReadStream` opens on a later tick, so a link swapped in right after the handler
  returns is what it streams. The new tests do this.

## Fix

- `resolveAndStatFileByPath` also returns the root it confined the path to (`rootReal`); `resolveRefPath` returns its
  root with the path.
- `openResolvedFile` opens the checked path through `openArtifactFile` with that root as the anchor, and keeps the handle
  only if it is the file the check `stat`ed (same device and inode). The anchor is the async realpath, the form the
  verified open compares against; the forms differ on Windows. The workspace's is the cached `getWorkspaceRealAsync`.
- A path component that turns into a link or a file while it is opened (`ELOOP`, `ENOTDIR`) is a 404, like any other
  change.
- `content`: the metadata-only answers (image, PDF, media, binary, too large) are still decided from the path's `stat`,
  without opening. A text file is opened, judged again on the handle's `stat` so the size cap holds for the bytes read,
  and at most that many bytes are read from the handle.
- `raw`: the size cap is checked on the path's `stat` first, as before, then on the handle's. Range, `Content-Length`
  and the body come from the handle, and the stream ends at the checked size. A client that leaves mid-body destroys the
  stream, which closes the handle; one that left while the file was being opened gets no stream, and the handle is
  closed.

## Behaviour changes

- A file gone, swapped for a link, or replaced by another file between the check and the open answers 404.
- A file appended to while it is read is cut at the size it was judged by. Before, the read ran to the end, past the
  preview cap and past the `Content-Length` already sent.
- An unreadable file (`raw`) answers 500 with a JSON body before any Range is judged. Before, the 500 carried the file's
  MIME type and security headers, and an unsatisfiable Range on it answered 416.

## Verified

- Old and new handlers ran side by side over every fixture name × path prefix × Range header: text, empty, image,
  media, PDF, binary, no extension, too large for preview and for streaming, unreadable, named pipe, links in and out,
  a link to an outside folder, hidden folders, sensitive names, folders, missing files, `..` forms, and the same under a
  registered `@ref/` directory. The harness is in the PR description. The only differences were the unreadable files
  above.
- The new tests in `test/routes/test_filesReadRoutes.ts` fail on the old code: `raw` streams the outside bytes, and
  `content` answers 200. `content` read synchronously, so in-process the old handler had already answered before a
  test could swap; the race harness above is what shows it leaking.

## Not in this PR

- The writes in `files.ts` (`PUT content`, `create`, `upload`), `mulmoscript-plugin` ops, `exportShapeScriptUsdz`,
  `runtime-plugin` assets.
- `open` / `reveal` hand a path to the OS, so there is no handle to pass. The tree and dir listings return names, not
  contents.
- The hidden-folder and sensitive-name filters stay checks on the name. The verified open keeps the read inside the
  root; it does not re-apply those filters to a path swapped within the root, and a hard link already passes them on
  `main`.
