# fix: hand-written containment checks use the shared rule (#3573)

Follow-up to `plans/fix-3573-shared-containment.md`, which listed these sites as not done.

## Problem

Each site below decided containment with its own `candidate === root || candidate.startsWith(root + path.sep)`:

| Site | Compares |
|---|---|
| `server/plugins/runtime-loader.ts` `ensureInsideBase` | `path.resolve` spellings |
| `server/agent/mcp-tools/exportShapeScriptUsdz.ts` `artifactsRootReal` | two native realpaths |
| `core/collection/registry/server/importWriter.ts` `writeBundleFiles` | `path.join` spellings |
| `core/collection/server/paths.ts` `isUnderRealRoot` / `isContainedInRoot` | two JS realpaths |
| `core/collection/server/delete.ts` `isDataDirSafe` | `path.resolve` spellings |
| `core/collection/registry/server/exportCollection.ts` `resolveWithin` | `path.resolve` spellings |
| `core/workspace-setup/sync.ts` `isRealpathInside` | two JS realpaths |
| `plugins/mulmoscript-plugin/src/server/ops.ts` (404 vs 400 choice) | `path.resolve` spelling |

Two defects:

- A root ending in a separator (`/`, `C:\`) becomes `//` / `C:\\` as a prefix, so everything under it is refused. Every
  site has this.
- The two JS-realpath sites keep the letter case a link was written with. On a case-insensitive disk, a link inside the
  workspace whose text spells the workspace with different case resolves to a path that fails the prefix test, so it is
  refused although it is inside. Reproduced on macOS for `isContainedInRoot` (collection data under such a link reads as
  outside the workspace).

## Fix

- The lexical sites and the native-realpath site use `isWithinRoot` (the case-preserving prefix test that takes a root
  ending in a separator as is). Their two sides are spelled the same way, so case cannot differ.
- `isUnderRealRoot` stays a pure comparison and uses `isWithinRoot`: its callers resolve both sides with one function.
- `isContainedInRoot` and `isRealpathInside` use `isInsideRoot` (the prefix test, then the second look at the on-disk
  spelling), as `resolveWithinRoot` does since #3666.
- `@mulmoclaude/core/files` exports `isWithinRoot` so the host and the plugin can use it.

## Behaviour changes

- Only refusals change: a candidate under a filesystem-root root, a root spelled with a trailing separator, or an inside
  link refused for its letter case is now accepted. Nothing outside is accepted.

## Release

Core and `mulmoscript-plugin` changes ship with `@mulmoclaude/core` 7.2.0 (not published yet) and the plugin's next
publish; host changes ship with the launcher.
