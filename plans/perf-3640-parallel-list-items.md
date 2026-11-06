# perf: read collection records in parallel in `listItems` (#3640)

## Problem

`listItems` (`packages/core/src/collection/server/io.ts`) reads every
`<id>.json` with `for … await`, one `lstat` + `readFile` + parse at a time.
On a large file-backed collection the listing dominates `queryItems`,
`getItems`, `store.page` and every view's full read (reporter: Windows 11;
the issue has the measured breakdown).

## Change

- Add `mapWithConcurrency(items, limit, worker)` to `@mulmoclaude/common`:
  bounded concurrency, results in input order. Lifted from the private
  helper in `markdown-plugin/src/render/imageFill.ts`, plus a clamp so a
  non-positive / NaN / fractional limit cannot spawn zero runners.
- `listItems` filters names as before, then reads with
  `mapWithConcurrency(filePaths, LIST_READ_CONCURRENCY, tryReadRecord)` and drops nulls in
  readdir order, logging each skip as before.

Unchanged on purpose: the dataDir containment check, the per-file
`lstat` symlink defense, the dot-file / non-`.json` filter, readdir
order, and the per-skip warning (same order, same payload).

## Verification

- Differential run: the old `listItems` copied verbatim beside the new
  one, over generated data dirs (records, malformed JSON, arrays, null,
  scalars, empty files, dot files, `.txt`, symlinks, `*.json` dirs, a
  missing dir), comparing the full result AND the warning log. A
  mutation of the new code's warning makes it red.
- Permanent tests: `packages/common/test/test_concurrency.ts` (order,
  limit cap, once-per-item, empty, bad limits, rejection) and a
  `listItems` case in `test/workspace/collections/test_io.ts` with more
  records than one read batch plus every skip kind.

## Out of scope

- Switching `imageFill.ts` to the shared helper (separate PR).
- Releasing: this ships through `@mulmoclaude/common` (new export) then
  `@mulmoclaude/core`, then the launcher.
