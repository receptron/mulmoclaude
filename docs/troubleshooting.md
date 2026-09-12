# Troubleshooting

Things that go wrong between `git clone` / `npx mulmoclaude` and a working UI.

For failures the **agent** hits while running tools (sandbox auth, plugin install, build ordering),
see [`packages/core/assets/helps/error-recovery.md`](../packages/core/assets/helps/error-recovery.md) —
Claude reads that file itself before asking you about a tool failure.

---

## Icons render as words and the layout overlaps

**Symptom** — the app loads, but icon-only buttons show text (`send`, `star`, or a translated
`送信`, `星`), nav labels are drawn twice on top of each other, and every icon row is far too wide.
Plain-text areas (chat bubbles, prompt suggestions) look fine.

**Cause** — browser auto-translation, not CSS. Material Icons / Material Symbols draw glyphs via
**ligatures**: the element's text content _is_ the icon name. Chrome's "Translate this page" (and the
Google Translate extension) rewrites those text nodes, the ligature no longer matches, and the icon
name renders as literal text — which also inflates the width of every icon-only control. The
translator additionally overlays translated spans on the original text, producing the doubled nav.

**Fix** — update. The app chrome now carries `translate="no"` (#2561), so translation leaves the
icons alone; only agent / user content (chat replies, wiki pages, skill bodies) stays translatable.
On an older build, turn translation off instead: address-bar translate icon → **Show original** /
**Never translate this site**, or open the app in a window with the extension disabled.

MulmoClaude ships its own UI in 8 locales, so page translation is never needed for the chrome: set
`VITE_LOCALE=ja` (or `zh` / `ko` / `es` / `pt-BR` / `fr` / `de`) in `.env` and restart `yarn dev`.

---

## Console shows `404` for `dist/style.css` or `dist/vue.js`

Two unrelated sources — check the request path first.

**`/api/plugins/runtime/<pkg>/<version>/dist/...`** — a _runtime-loaded_ plugin installed into the
workspace (`~/mulmoclaude/plugins/`) whose files are missing or half-installed. Non-fatal: the loader
logs and skips that plugin, the rest of the app is unaffected. Reinstall the plugin. See
[`plugin-runtime.md`](plugin-runtime.md).

**A workspace plugin package (`@mulmoclaude/<name>-plugin`)** — the in-repo packages under
`packages/plugins/` have not been built. `yarn dev` does build them on a cold clone
(`scripts/dev-build-if-needed.mjs`), so this should not happen after a clean `yarn install && yarn dev`.

It happens when a build was **interrupted or failed halfway**. The freshness gate is mtime-based: it
compares the newest file under `<pkg>/src` against the newest under `<pkg>/dist`, and a _partial_
`dist/` looks fresher than the source — so the rebuild is skipped and the missing files stay missing.
(A completely absent `dist/` is handled correctly; only a partial one fools the gate.)

```bash
yarn dev:full-build                            # unconditional package build, then server + Vite
node scripts/dev-build-if-needed.mjs --force   # rebuild only, without starting anything
```

---

## Windows: `'concurrently' is not recognized` although `yarn install` says "Already up-to-date"

**Cause** — the repository sits inside a OneDrive-synced folder (e.g.
`...\OneDrive\Documents\GitHub\mulmoclaude`). OneDrive Files On-Demand dehydrates
`node_modules\.bin`, so the executables are listed but their contents are not on disk — yarn sees the
packages as installed while the shims fail to run.

**Fix** — move the clone outside OneDrive, then reinstall:

```powershell
# close VS Code and any running yarn processes first
Move-Item "$env:USERPROFILE\OneDrive\Documents\GitHub\mulmoclaude" "$env:USERPROFILE\GitHub\mulmoclaude"
cd "$env:USERPROFILE\GitHub\mulmoclaude"
Remove-Item -Recurse -Force node_modules
yarn install
yarn dev:full-build
```

Right-click → **Always keep on this device** rehydrates the folder as a stopgap, but OneDrive can
evict it again.

---

## `Couldn't find a package.json file in ...`

You are in the **workspace**, not the source clone. Two different directories share the name:

| Directory                                                | Contents                                                     | `package.json` |
| -------------------------------------------------------- | ------------------------------------------------------------ | -------------- |
| `~/mulmoclaude` (override: `MULMOCLAUDE_WORKSPACE_PATH`) | Data MulmoClaude creates — `config/`, `data/`, `artifacts/`, … | no             |
| wherever you cloned the repo                              | `src/`, `server/`, `packages/`                                | yes            |

Run every `yarn` command in the clone. Workspace layout: [`developer.md`](developer.md#workspace-layout-mulmoclaude).

---

## `401` on `/api/*` right after (re)starting the server

The server writes a **fresh bearer token on every start** to `<workspace>/.session-token`, and the
page picks it up when the HTML is served. A tab left open across a restart still holds the previous
token.

**Fix** — reload the tab (`Ctrl+Shift+R` / `Cmd+Shift+R`) once the server logs `listening`. To keep one
token across restarts, set `MULMOCLAUDE_AUTH_TOKEN`. That is for a client that cannot read
`<workspace>/.session-token` for itself — a container without the workspace mounted, or another
machine. A messaging bridge on this host does not need it: it re-reads the pair and reconnects on
its own (#3078). Details: [`developer.md`](developer.md#auth-bearer-token-on-api).

A brief `ECONNREFUSED` from Vite in the first second is expected — the client starts before Express
finishes booting, and the proxy recovers on its own.

---

## Boot warnings that are not errors

| Log                                                              | Meaning                              | Action (optional)                                     |
| ---------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| `GEMINI_API_KEY not set — image / audio / video generation ...`  | Media generation disabled            | Add `GEMINI_API_KEY=...` to `.env` and restart        |
| `optional dependency 'ffmpeg' unavailable — mulmocast degraded`  | MulmoScript video rendering disabled | Install ffmpeg and put it on `PATH`                   |
| `Docker not found — claude will run unrestricted`                | Sandbox disabled                     | Install Docker Desktop to enable it                   |
| `optional dependency 'whisper-server' unavailable — voiceInput degraded` | Local voice input disabled   | Only announced when voice input is enabled in Settings |

Registry: `server/system/optionalDeps.ts`.
