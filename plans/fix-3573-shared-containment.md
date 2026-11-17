# fix: the shared containment check is not fooled by letter case or a filesystem root (#3573)

Follow-up to `plans/fix-3573-wiki-prompt-reads.md`. Builds on `core/files/withinRoot.ts` from that PR.

## Problem

`resolveWithinRoot` (`core/files/safe.ts`) and `resolveExistingWithinRoot` (`core/files/verified.ts`) decide
containment with `candidate.startsWith(root + sep)` over realpaths:

- `resolveWithinRoot` uses the JS realpath, which keeps the letter case written in a link. On a case-insensitive disk, a
  link inside the workspace whose text spells a folder with different case (`repo/notes` for `Repo/notes`) resolves to a
  path that fails the prefix test, so the target is refused although it is inside.
- A root at a filesystem root (`/`, `C:\`) becomes `//` / `C:\\` as a prefix, so everything is refused.
- `verified.ts` resolves the candidate with the native realpath (on-disk case) but takes the root as given; a root
  realpath'd with the JS one in a different case refuses everything. No route drove this on a real server (the server
  resolves both sides the same way), so it is a defect of the shared function only.

Reproduced: unit level for all three; on a real server, `GET /api/files/content` through a case-differing inside link
is 400 on `main`.

## Fix

- `core/files/containment.ts` (a leaf both import): `isWithinRoot` (a case-preserving prefix test that takes a root
  ending in a separator as is, so `/` and `C:\` work; not `path.relative`, which folds case on Windows — Codex review),
  `realpathSyncOrNull` (native, JS fallback), and `respelledWithinRoot` — a second look with both sides at their on-disk
  spelling, returning the target re-spelled under the caller's root.
- `resolveWithinRoot`: unchanged result whenever the old test accepted; otherwise the second look.
- `resolveExistingWithinRoot`: same; the returned candidate is the native realpath, as before.
- `withinRoot.ts` and the wiki engine import the rule from `containment.ts`.

## Behaviour changes

- Only results that were `null` change: a target truly inside the root, refused for letter case or a filesystem-root
  prefix, is now accepted. Nothing outside is accepted.

## Verified

- Old and new `resolveWithinRoot` / `resolveExistingWithinRoot` side by side over roots (JS and native spelling, other
  case, a subfolder, a linked folder) and relative paths (plain, nested, case-varied, `..`, absolute, dotfiles,
  trailing separator, links inside / outside / case-differing / dangling / looping, NUL). Every difference is
  null → a path inside; no accepted result changed and no outside target is accepted.
- `packages/core/test/files/test_containment.ts` fails on `main` for the case and filesystem-root cases.
- Real server: through a case-differing inside link, `GET /api/files/content` is 200 (400 on `main`); through a link
  out it is 400 on both. A normal workspace and one spelled in lower case read files, `/artifacts` images and wiki
  pages.

## Not in this PR

Hand-written `startsWith(root + path.sep)` checks with the same two traits, each in its own domain:
`server/plugins/runtime-loader.ts`, `server/agent/mcp-tools/exportShapeScriptUsdz.ts`,
`core/collection/registry/server/importWriter.ts`, `core/collection/server/paths.ts`, `core/collection/server/delete.ts`,
`core/collection/registry/server/exportCollection.ts`, `core/workspace-setup/sync.ts`,
`plugins/mulmoscript-plugin/src/server/ops.ts`. Moving them onto `isWithinRoot` is the follow-up.
