# Image-path routing — research notes

Read-only audit of how MulmoClaude turns LLM-emitted image references into URLs the browser can fetch.
Scope: wiki, presentHtml, markdown, news, and the workspace file server. Snapshot of `main` at commit
`038995ea` (2026-04-29).

> **TL;DR.** Every image reference funnels through one URL shape: `/api/files/raw?path=<workspace-relative>`,
> served by `server/api/routes/files.ts` and gated by `resolveWithinRoot()` (realpath against
> `~/mulmoclaude`). The frontend has *two* parallel rewriters — `rewriteMarkdownImageRefs` (uses
> marked's lexer, accepts a `basePath`) and `rewriteHtmlImageRefs` (regex over `<img src="…">`,
> no `basePath`) — that share a `shouldSkip` rule and `resolveImageSrc()`. The Docker sandbox is
> agent-side only; the file server always reads from the host filesystem at `~/mulmoclaude`.

## 1. Topology

```
LLM markdown / HTML
        │  (page body or srcdoc)
        ▼
[Vue plugin View.vue]
   wiki/View.vue            rewriteMarkdownImageRefs(body, WIKI_BASE_DIR)
   markdown/View.vue        rewriteMarkdownImageRefs(body, dir(file))
   FileContentRenderer.vue  rewriteMarkdownImageRefs(body, dir(file))
   presentHtml/View.vue     rewriteHtmlImageRefs(html)
        │  → marked.parse() / iframe srcdoc
        ▼
HTML with src="/api/files/raw?path=<encoded-workspace-rel>"
        │  (browser fetch)
        ▼
[Express /api/files/raw]    resolveSafe(relPath) → resolveWithinRoot()
        │
        ▼
fs.createReadStream(absPath)   ← host's ~/mulmoclaude (always — server is host-side)
        │
        ▼
Bytes streamed back with `Content-Type` per extension and the CSP `sandbox` header
(not for PDF, audio or video — a browser cannot show those under it; `nosniff` always)
```

1. **Plugin View** receives raw markdown / HTML from a tool result, runs the appropriate
   *rewriter*, hands the result to `marked.parse(...)` (markdown) or to `<iframe srcdoc>` (HTML).
2. **Rewriters** are pure browser-side string transforms (`src/utils/image/rewriteMarkdownImageRefs.ts`,
   `src/utils/image/rewriteHtmlImageRefs.ts`) that produce URLs of the shape
   `/api/files/raw?path=<workspace-relative>`.
3. **Express file route** (`server/api/routes/files.ts`) accepts that shape, runs path-traversal
   guards, classifies by extension, applies size caps, sets `Content-Security-Policy: sandbox`
   (except for PDF, audio and video, which a browser cannot show under the sandbox — #1299,
   #3437; `X-Content-Type-Options: nosniff` on every response), and pipes bytes from
   `~/mulmoclaude` back to the browser. Range requests are honoured for audio/video.
4. **Docker sandbox** (`server/system/docker.ts`, `server/agent/sandboxMounts.ts`) is the
   agent's container only — the Express server runs on the host. The mount mapping affects what
   the LLM sees inside the container, not what the file server reads.

## 2. Routes

| Route | Method | Handler | Guard | Workspace base |
|---|---|---|---|---|
| `/api/files/raw` | GET | `server/api/routes/files.ts:801` | `resolveAndStatFile` → `resolveSafe` (line 205) | `~/mulmoclaude` (`workspaceReal`, line 199) |
| `/api/files/content` | GET | `server/api/routes/files.ts:643` | `resolveAndStatFile` → `resolveSafe` | same |
| `/api/files/content` | PUT | `server/api/routes/files.ts:713` | `path.relative` syntactic check + `resolveSafe` | same |
| `/api/files/dir` | GET | `server/api/routes/files.ts:506` | `resolveSafe` | same |
| `/api/files/tree` | GET | `server/api/routes/files.ts:486` | walks from `workspaceReal` only | same |
| `/api/files/ref-roots` | GET | `server/api/routes/files.ts:862` | per-entry `realpathSync(entry.hostPath)` | reference dirs (out of scope) |
| `/api/images` (POST) | POST | `server/api/routes/image.ts:188` | `saveImage` writes under `WORKSPACE_PATHS.images` | `~/mulmoclaude/artifacts/images` |
| `/api/images/update` (PUT) | PUT | `server/api/routes/image.ts:207` | `isImagePath` prefix check + `safeResolve` | same |
| `/api/pdf/markdown` | POST | `server/api/routes/pdf.ts:152` | `inlineImages` → `resolveWithinRoot` (line 96) | host workspace + `WORKSPACE_DIRS.markdowns` base |

The image-display path used by every wiki / HTML / markdown rewriter is **only**
`/api/files/raw`. There is no per-kind image route — `image.ts` is for *generation /
upload / overwrite*, not for serving image bytes back to viewers.

`/api/files/raw` accepts every file kind the workspace contains: image, PDF, audio,
video, text, and binary (PDF and audio/video added range-request streaming in #147 / later).
MIME is dispatched from `MIME_BY_EXT` at `files.ts:116-136`. Anything not in that map serves
as `application/octet-stream`.

## 3. Path-traversal defense

The canonical guard is `resolveWithinRoot` in `server/utils/files/safe.ts:77`:

```ts
// `rootReal` MUST already be a realpath. Returns null on traversal or if either path doesn't exist on disk.
export function resolveWithinRoot(rootReal: string, relPath: string): string | null {
  const normalized = path.normalize(relPath || "");
  const resolved = path.resolve(rootReal, normalized);
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(resolved);
  } catch {
    return null;
  }
  if (resolvedReal !== rootReal && !resolvedReal.startsWith(rootReal + path.sep)) {
    return null;
  }
  return resolvedReal;
}
```

Two properties this gives you:

- **`..` traversal**: `path.normalize()` collapses `..`, then `path.resolve()` against
  the realpath'd root will produce a path outside `rootReal`, which the prefix check
  rejects. `path.sep + ` is critical so that `~/mulmoclaudeOTHER` is not accepted as
  a prefix of `~/mulmoclaude`.
- **Symlink escape**: `realpathSync` resolves the *resolved candidate* fully, defeating
  `workspace/secret -> /etc/passwd` style traps. Both root and candidate are realpath'd
  so a symlinked workspace home (`~/mulmoclaude` -> `/Volumes/Data/...`) doesn't
  silently route through the unresolved branch.

Call sites:

| File | Line | Caller | Wraps it as |
|---|---|---|---|
| `server/api/routes/files.ts` | 199 | module-load `realpathSync(workspacePath)` | `workspaceReal` (cached) |
| `server/api/routes/files.ts` | 205-219 | `resolveSafe(relPath)` | adds hidden-dir + `isSensitivePath` filter, used by every `/api/files/*` route |
| `server/api/routes/files.ts` | 235-268 | `resolveRefPath(prefixedPath)` | reference-dir variant |
| `server/api/routes/pdf.ts` | 59, 96 | `defaultWorkspaceRoot`, `inlineImages` | rejects `<img>` srcs that escape workspace |
| `server/api/routes/mulmo-script.ts` | 384 | mulmo-script story dir | story-scoped wrapper |
| `server/api/routes/sessions.ts` | 4 | session-id lookup | session-scoped wrapper |
| `server/utils/files/image-store.ts` | 22-30 | `safeResolve` (image overwrite + base64 read) | strips `images/` prefix before checking |
| `server/utils/files/spreadsheet-store.ts` | 22-26 | `safeResolve` (parallel of image-store) | same shape |

Every workspace endpoint goes through one of these wrappers — there is no route
that accepts a `path` query and reads bytes without one. The only route that
serves bytes from the workspace is `/api/files/raw`, and its `resolveAndStatFile`
helper at `files.ts:585-641` calls `resolveSafe` on every request.

`resolveSafe` (files.ts:205) layers two more rejections on top of `resolveWithinRoot`:

1. **Hidden dirs**: any path component matching `HIDDEN_DIRS = {".git"}` is refused
   (line 211). The file tree walkers also skip these so they never appear in listings.
2. **Sensitive basenames + extensions**: `isSensitivePath` (line 66) refuses
   `.env`, `.env.<x>`, `credentials.json`, `.session-token`, `.npmrc`, `.htpasswd`,
   SSH private-key names, and `.pem` / `.key` / `.crt` extensions.

`resolveWithinRoot` is also used by the PDF route's `inlineImages` (`pdf.ts:70-110`).
There the workspace-root realpath is computed at module load (`pdf.ts:59`) and a leading
slash is stripped to convert `/artifacts/...` into `artifacts/...` (`pdf.ts:80-82`) — see
PR #961 for the rationale (LLM-emitted web-rooted paths were getting interpreted as
host-absolute by `path.resolve`).

## 4. Wiki rewrite logic

Source: `src/utils/image/rewriteMarkdownImageRefs.ts`, called from
`src/plugins/wiki/View.vue:666`:

```ts
const withImages = rewriteMarkdownImageRefs(body, WIKI_BASE_DIR.value);
```

`WIKI_BASE_DIR` is computed at `View.vue:593`:

```ts
const WIKI_BASE_DIR = computed(() => (action.value === "page" ? WIKI_PAGES_DIR : WIKI_DATA_DIR));
// WIKI_PAGES_DIR = "data/wiki/pages"  (line 344)
// WIKI_DATA_DIR  = "data/wiki"        (line 345)
```

So a page-action render uses `data/wiki/pages` as the base; a log / lint-report /
index uses `data/wiki`.

The rewriter walks marked's token tree (`rewriteMarkdownImageRefs.ts:177-182`),
descending into containers but skipping `code` / `codespan` / `html` tokens
(`isSkippable`, line 105). When it finds an `image` token, it:

1. Drops `data:`, `http(s):`, and existing `/api/` URLs untouched (`shouldSkip`, line 35-41).
2. Resolves `href` against `basePath` via posix-style segment math
   (`resolveWorkspacePath`, lines 51-69):
   - leading `/` ⇒ ignore base, treat URL as workspace-rooted (`isAbsolute = true`,
     `baseSegs = []`)
   - otherwise start from `basePath` segments; consume `..` by popping, drop `''` and `.`
   - escape (more `..` than depth) returns `null` and the original token's raw is emitted
3. Calls `resolveImageSrc` (`src/utils/image/resolve.ts:6`):
   ```ts
   export function resolveImageSrc(imageData: string): string {
     if (imageData.startsWith("data:")) return imageData;
     return `${API_ROUTES.files.raw}?path=${encodeURIComponent(imageData)}`;
   }
   ```

Behaviour table (basePath = `data/wiki/pages`, the page-action case):

| Input markdown | After resolution | Final src | Notes |
|---|---|---|---|
| `![](foo.png)` | `data/wiki/pages/foo.png` | `/api/files/raw?path=data%2Fwiki%2Fpages%2Ffoo.png` | bare relative |
| `![](./foo.png)` | `data/wiki/pages/foo.png` | same | leading `./` collapsed |
| `![](../sources/foo.png)` | `data/wiki/sources/foo.png` | `/api/files/raw?path=data%2Fwiki%2Fsources%2Ffoo.png` | sibling dir, the #848 fix case |
| `![](../../../artifacts/images/2026/04/x.png)` | `artifacts/images/2026/04/x.png` | `/api/files/raw?path=artifacts%2Fimages%2F2026%2F04%2Fx.png` | the real LLM-emitted shape |
| `![](/data/wiki/sources/foo.png)` | `data/wiki/sources/foo.png` | `/api/files/raw?path=data%2Fwiki%2Fsources%2Ffoo.png` | leading `/` resets base |
| `![](data:image/png;base64,…)` | passthrough | `data:image/png;base64,…` | `shouldSkip` |
| `![](https://cdn/x.png)` | passthrough | unchanged | `shouldSkip` |
| `![](/api/files/raw?path=foo)` | passthrough | unchanged | `shouldSkip` (idempotent) |
| `![](../../../../escape.png)` (depth > base) | `resolveWorkspacePath` returns `null` | original raw emitted untouched | so the user sees a 404 rather than a wrong image |
| `` `![inside code](x.png)` `` | passthrough | unchanged | code/codespan tokens skipped |
| `![alt with [nested]](img.png)` | `img.png` | `/api/files/raw?path=img.png` | alt extracted by `extractBracketedAlt` (line 75) — depth counter, not regex |
| `![w](wiki/Foo_(bar).png)` | `wiki/Foo_(bar).png` | `/api/files/raw?path=wiki%2FFoo_(bar).png` | balanced parens preserved by lexer |

Inside the wiki view template the resulting URL is rendered into `v-html`
(`wiki/View.vue:265`, `:276`). The rewriter has no DOM step; everything is markdown-
to-markdown text manipulation, then `marked.parse(...)` (line 672).

The same rewriter drives `src/plugins/markdown/View.vue:173` (basePath = directory
of the file) and `src/components/FileContentRenderer.vue:183` (basePath = directory
of `selectedPath`). `textResponse/View.vue` does **not** call this rewriter (see
"Open questions" §8).

## 5. HTML rewrite logic

Source: `src/utils/image/rewriteHtmlImageRefs.ts`, called from `src/plugins/presentHtml/View.vue:50`:

```ts
const rawHtml = computed(() => rewriteHtmlImageRefs(data.value?.html ?? ""));
```

The result is then optionally injected with a print stylesheet (line 51) and fed to
`<iframe :srcdoc="html" sandbox="allow-scripts allow-same-origin allow-modals">`
(line 22).

The rewriter is a single regex pass (`rewriteHtmlImageRefs.ts:27`):

```ts
const IMG_SRC_RE = /(<img\s[^>]*src=")([^"]+)(")/g;
```

For each match:

1. `shouldSkip` filters `data:`, `http(s):`, `/api/` (lines 29-34).
2. `normalizeWorkspacePath` strips one leading `/` (lines 39-41).
3. Empty result after stripping is returned untouched.
4. `resolveImageSrc(workspacePath)` produces the same URL shape as the markdown
   rewriter.

Behaviour table:

| Input HTML | Final src | Notes |
|---|---|---|
| `<img src="/artifacts/images/2026/04/foo.png">` | `/api/files/raw?path=artifacts%2Fimages%2F2026%2F04%2Ffoo.png` | LLM web-rooted shape, dominant case |
| `<img src="artifacts/images/foo.png">` | `/api/files/raw?path=artifacts%2Fimages%2Ffoo.png` | already workspace-relative |
| `<img src="data:image/png;base64,…">` | unchanged | passthrough |
| `<img src="http://cdn/x.png">` | unchanged | passthrough |
| `<img src="/">` | unchanged | empty after stripping = no-op |
| `<img alt="cat" src="/artifacts/images/foo.png" width="100">` | `/api/files/raw?path=artifacts%2Fimages%2Ffoo.png` (other attrs preserved) | regex captures only the src group |
| `<img src='./foo.png'>` (single-quoted) | **untouched** | regex matches `src="…"` only — see §8 |
| `<source src="/artifacts/foo.webm">` | **untouched** | regex matches `<img …>` only — see §8 |
| `<a href="/artifacts/foo.pdf">` | **untouched** | rewriter is image-only — see §8 |
| `<img src="../../etc/passwd">` | rewritten to `/api/files/raw?path=..%2F..%2Fetc%2Fpasswd` | server-side `resolveSafe` rejects, returns 404 — but the URL is *built* without escape detection (see §8) |

Note the asymmetry vs. the markdown rewriter: the HTML rewriter does **not** carry
a `basePath` parameter and does **not** detect workspace-escape. It simply strips
one leading slash and trusts the server's `resolveWithinRoot` for the security gate.
That is acceptable because the iframe uses `srcdoc`, so the browser has no
"current document URL" against which `..` could resolve to a sibling page anyway —
the only sane base for the LLM is the workspace root, which the rewriter encodes
implicitly.

`presentHtml/View.vue:22` sets `sandbox="allow-scripts allow-same-origin allow-modals"`,
which means the iframe shares the SPA origin. The image fetch goes to the SPA's
`/api/files/raw`, served by Express on the same origin. Auth cookies / bearer-token
headers are *not* attached to `<img>` requests automatically (browsers don't send
custom headers on image elements), but the project relies on the bearer-token
exemption in `server/api/auth.ts` for the file routes — verify this is intended
when redesigning (see §8).

## 6. Docker awareness

Docker is the **agent** sandbox, not the **server** sandbox. The Express server
*always* runs on the host, reading from `~/mulmoclaude` directly:

- `server/workspace/paths.ts:38` hardcodes `workspacePath = path.join(homedir(), "mulmoclaude")` —
  no env override, no Docker branch.
- `server/api/routes/files.ts:199` caches `realpathSync(workspacePath)` at module load.
- `server/system/docker.ts` only manages the *agent* container image:
  build / detect at startup, no mount of `~/mulmoclaude` for the file server's purposes.

The two places where Docker container paths matter are:

- `server/agent/sandboxMounts.ts` — host SSH agent / gh CLI / gitconfig mounts for
  the agent container, exposed as `containerPath` per spec (line 32).
- `server/workspace/reference-dirs.ts:197-237` — reference-dir mounts for the agent.
  `useDocker ? containerPath(entry) : entry.hostPath` chooses the path the agent's
  prompt sees in its `Read`/`Write` tool calls, not the server's view.

So the question "does the file server know about Docker mode?" is **no, by design**.
A redesign that wants to keep that property doesn't need to plumb a sandbox flag
through the path resolver. A redesign that wants the *agent* to also serve image
bytes (e.g. tools running inside the container that emit URLs) would need a new
mapping; today there's none.

`WORKSPACE_PATHS` (paths.ts:101-143) and `WORKSPACE_DIRS` (paths.ts:43-94) are the
single source of truth for both reading and writing — both server and agent
prompt strings derive from these.

## 7. Pattern catalogue

Real-world LLM-emitted patterns observed in `~/mulmoclaude/data/wiki/pages/*.md`:

| Input form | Source | Handler | Final URL | Security note |
|---|---|---|---|---|
| `![](https://upload.wikimedia.org/wikipedia/commons/.../x.png)` | wiki | `shouldSkip` (https) | unchanged, browser fetches Wikipedia | trusts the LLM's URL; iframe has no CSP for outbound |
| `![alt](../../../artifacts/images/2026/04/<short-id>.png)` | wiki page | rewriter resolves with basePath `data/wiki/pages` | `/api/files/raw?path=artifacts%2Fimages%2F2026%2F04%2F<id>.png` | three `..` consume `data`+`wiki`+`pages`, lands at workspace root |
| `![chart](../sources/foo.png)` | wiki page | rewriter | `/api/files/raw?path=data%2Fwiki%2Fsources%2Ffoo.png` | this is the #848 fix — basePath was `wiki/pages` pre-fix, would 404 |
| `![](data/wiki/sources/foo.png)` | wiki index | rewriter, basePath `data/wiki` | `/api/files/raw?path=data%2Fwiki%2Fdata%2Fwiki%2Fsources%2Ffoo.png` (bug — see §8) | rare in practice, LLM doesn't emit this from index views |
| `<img src="/artifacts/images/2026/04/<id>.png">` | presentHtml | rewriter strips leading `/` | `/api/files/raw?path=artifacts%2Fimages%2F2026%2F04%2F<id>.png` | dominant LLM-HTML shape (#961) |
| `<img src="data:image/png;base64,…">` | presentHtml or wiki | passthrough | inline | trusted in-process render |
| `<img src='/artifacts/foo.png'>` (single-quoted) | presentHtml | **NOT rewritten** | broken inside iframe | known gap (rewriteHtmlImageRefs.ts:27 regex is double-quote only) |
| `<img src="../escape.png">` | presentHtml | rewriter encodes `..%2Fescape.png` | server-side `resolveSafe` returns null → 400 "Path outside workspace" | URL leaks the attempted path to the network log, not to disk |
| `![](../../../../etc/passwd)` from wiki page | wiki | `resolveWorkspacePath` returns null | original raw emitted, browser interprets as relative path under SPA origin | safe — never produces an `/api/files/raw` URL |
| `![](/etc/passwd)` from wiki | wiki | basePath reset, returns `etc/passwd` | `/api/files/raw?path=etc%2Fpasswd` | server-side `resolveWithinRoot` rejects (no `~/mulmoclaude/etc/passwd` exists), returns 404 |
| `![inside](images/foo.png)` inside ` ``` ` fenced block | wiki | marked-lexer skip | passthrough | renders as literal text in the rendered code block |

## 8. Open questions / inconsistencies

These are observations, not bugs to fix in this audit.

1. **Wiki rewriter's leading-slash semantics differ from what users expect.**
   `![](/data/wiki/sources/foo.png)` works (leading `/` resets base, lands at
   `data/wiki/sources/foo.png`). But `![](data/wiki/sources/foo.png)` from a
   page-action context resolves with basePath `data/wiki/pages`, yielding
   `data/wiki/pages/data/wiki/sources/foo.png` — that's almost certainly not what
   the LLM meant. The markdown rewriter has no "is the URL already workspace-rooted?"
   heuristic; it always treats absent leading-`/` as relative-to-base. If this
   pattern ever shows up in the wild it 404s silently (the user sees a broken
   image, not a clear error). The HTML rewriter accidentally handles this better
   because it has no basePath at all.

2. **`<source>` / `<video>` / `<audio>` tags are not rewritten in HTML.** The regex
   at `rewriteHtmlImageRefs.ts:27` is `<img\s[^>]*src="…"` only. LLM-emitted media
   embeds with workspace-rooted srcs would 404 inside the presentHtml iframe.
   Real LLM output rarely produces these today; if a redesign aims to support
   audio/video, this needs to expand.

3. **`<a href="...">` and CSS `url(...)` references are not rewritten.** A
   `<a href="/artifacts/documents/foo.md">` inside presentHtml would 404 — the
   iframe lookup hits the SPA origin, which doesn't serve `/artifacts`. Same for
   `background-image: url("/artifacts/...")` in inline styles. Markdown's
   `[text](workspace-path)` for non-image links is handled separately by
   `handleContentClick` in `wiki/View.vue:900-937` (it routes to internal Vue
   navigation), but the equivalent for HTML is unhandled.

4. **Single-quoted `src='…'` not rewritten.** Comment at
   `rewriteHtmlImageRefs.ts:24-26` calls this out as intentional ("extend later
   if a real case appears"). LLMs do sometimes emit single-quoted attributes;
   confirm with telemetry or just expand the regex.

5. **`textResponse/View.vue` skips the rewriter.** It uses `marked(processedText, …)`
   at line 122 directly. Tool-result text containing `![](workspace-rel)` will
   not display images. May be intentional (text responses should be self-
   contained), but worth confirming when redesigning.

6. **Two parallel rewrite layers with subtly different semantics.** Markdown uses
   marked's lexer (correct for parens, code blocks, balanced brackets); HTML uses
   a regex. A future markdown-emitting LLM that includes raw HTML inside markdown
   gets the markdown rewriter's `html` token skip rule (passthrough), which means
   `<img>` tags **inside markdown** are not rewritten by either pass. Repro:
   write a wiki page that opens with raw `<img src="/artifacts/...">` instead of
   `![](...)`. The wiki rewriter skips it (html token); the wiki view never
   invokes the HTML rewriter. The image won't render unless the LLM uses
   markdown image syntax.

7. **PDF inliner duplicates the path-resolution logic.** `server/api/routes/pdf.ts:70-110`
   re-implements "leading-slash means workspace-rooted, otherwise relative to
   markdowns/" in inlineImages. This is parallel to (but not shared with) the
   frontend rewriters. The two encode the same convention but diverge: the
   frontend HTML rewriter has no `basePath` (always workspace root); the PDF
   inliner uses `WORKSPACE_DIRS.markdowns` as the relative base. If the
   convention ever changes, both need to update in lockstep. A redesign could
   centralise this — see "Where to look first."

8. **Image fetches don't carry the bearer token.** `<img src="/api/files/raw?path=…">`
   is a regular browser image request; it does not include the `Authorization`
   header. The `/api/files/*` routes are exempt from auth in
   `server/api/auth.ts` for this reason (and because file viewing is a core UX
   need). Worth re-confirming during a redesign that the exemption is still
   acceptable, especially if the app ever runs in a multi-user context.

9. **`resolveWithinRoot` requires the file to exist on disk.** Because it calls
   `realpathSync` on the candidate (safe.ts:82), a request for a path inside the
   workspace that doesn't exist yet returns `null`. `files.ts:611-639` works
   around this for the PUT case by stat-ing the syntactic candidate first to
   distinguish 404 from "outside workspace." Other callers (image-store,
   spreadsheet-store) write through `writeFileAtomic` to the absolute path
   directly without a safe-resolve check beforehand — they trust their input
   shape via separate prefix checks (`isImagePath`).

10. **No global `<base>` element in presentHtml's iframe.** Adding `<base href="/">`
    inside the iframe srcdoc would let LLM-emitted relative paths (no leading `/`)
    resolve against the SPA origin, but `/artifacts/*` still wouldn't be served.
    A redesign could either (a) keep rewriting at injection time as today, or
    (b) inject a `<base>` *plus* a Service Worker / dedicated `/files/...` mount
    that serves workspace files at a stable URL prefix the LLM can be prompted
    to emit directly.

---

**Where to look first if redesigning this:**

1. `src/utils/image/rewriteMarkdownImageRefs.ts` and `src/utils/image/rewriteHtmlImageRefs.ts`
   — the two paths that produce every `/api/files/raw?path=...` URL the browser
   ever fetches. Any redesign of the URL shape, the base-path convention, or the
   tag coverage starts here.
2. `server/api/routes/files.ts` (especially `resolveAndStatFile` at 585 and `resolveSafe`
   at 205) — the single mouth of the file server. A new URL shape needs a parallel
   handler here, and any auth or CSP changes are localised to this file.
3. `server/utils/files/safe.ts:77` — the `resolveWithinRoot` guard. If the
   redesign introduces a new root (e.g. agent-side `/workspace/` URLs), this is
   the helper to extend rather than reimplement.
