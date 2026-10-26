# fix: runtime-plugin assets are served only from inside the plugin's folder (#3573)

Follow-up to `plans/fix-3573-files-route-create.md`.

## Problem

`GET /api/plugins/runtime/:pkg/:version/*` serves a registered plugin's files, and is exempt from the bearer token so
the browser can `import()` them. `resolvePluginRoot` realpathed the registered `cachePath` on every request and took
the result as the boundary; `resolveWithinRoot` then checked the asset path against it, and `readFile` re-opened it by
path.

A user-installed plugin's `cachePath` is `plugins/.cache/<name>/<version>`, inside the workspace, so a workspace
writer can replace it. Reproduced on `main`: with that folder replaced by a link to a folder outside the workspace, a
request for `id_rsa` under the plugin's URL returned the outside file's bytes with 200, no token and no race needed.
On top of that is the race of the issue: the check realpaths, then the read re-opens by path.

## Fix

- `pluginAssetScope(pkg, version)` replaces `resolvePluginRoot`. It returns a `VerifiedScope` instead of a path:
  - a plugin whose `cachePath` lies (lexically) under the workspace is anchored at the workspace's realpath, with the
    cache folder as the scope, so the scope is re-resolved under the workspace at every check and a link out is refused;
  - a preset, under the app's `node_modules` and out of the workspace writer's reach, is anchored at its own realpath.
- The asset path must be lexically inside the scope's realpath, and the bytes come from `openArtifactFile` (the verified
  open plus a regular-file check). `readPluginAsset(scope, relPath)` in `plugins-io.ts` does the read.

## Behaviour changes

- A folder (or the plugin root itself) answers 404 instead of 500 (`EISDIR`).
- A named pipe or other non-regular file answers 404 instead of a read that waits.
- A user-installed plugin whose cache folder leads out of the workspace answers 404 for every asset.

## Verified

- The reproduction above: 200 with the outside bytes on `main`; 404 on this branch.
- Old and new routes ran side by side for a workspace-installed plugin, a preset and an unregistered name, over
  generated asset paths: assets of each content type, missing files, folders, the root, `..` and encoded `..`, links in
  and out of the tree, a folder link out, dotfiles, an unreadable file, query strings, spaces and non-ASCII names. The
  only differences were folders and the root, 500 before and 404 now. The harness is in the PR description.
- The new tests in `test/api/routes/test_runtimePluginRoot.ts` fail on `main` for the swapped cache folder and the
  folder request.

## Not in this PR

- Wiki page overwrites (`writeWikiPage`), `mulmoscript-plugin` ops, `exportShapeScriptUsdz`.
