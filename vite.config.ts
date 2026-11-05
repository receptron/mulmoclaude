import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDevWatchIgnore } from './scripts/lib/devWatchIgnore'
import { resolveDevWorkspacePath } from './scripts/lib/devWorkspace'
import { createProxyTargetFollower } from './scripts/lib/proxyTargetFollower'
import { assertProxyablePort, describeRejection, parsePublishedPort, resolveProxyTarget, resolveServerPort, serverOrigins } from './scripts/lib/devServerPort'
import { parseEnvFile } from './server/utils/launch-env.mjs'
import { decideOwnerTokenHandoff, isLoopbackAddress } from './server/api/auth/ownerTokenHandoff'

// `.env` as the launcher's parser sees it — the same `dotenv.parse` the server's
// own loader uses. Read once, here, because BOTH things the dev client takes out
// of `.env` depend on it: where the workspace is, and which port to proxy to.
const ENV_FILE_VALUES = parseEnvFile(path.join(process.cwd(), '.env')).parsed

// Token file path mirrors `WORKSPACE_PATHS.sessionToken` in
// server/workspace-paths.ts. Duplicated here (rather than imported)
// because Vite config runs outside the TS server tsconfig.
//
// Honors MULMOCLAUDE_WORKSPACE_PATH (via process.env or `.env`) so the dev token
// plugin reads the same workspace the server is using. The resolution is shared
// with the readiness wait (`resolveDevWorkspacePath`) rather than written twice:
// this file used to match the assignment with its own regex, which keeps quotes
// and inline comments that `dotenv.parse` strips, so a quoted path sent the two
// halves of the dev client to different directories (#2981).
function resolveWorkspacePath(): string {
  return resolveDevWorkspacePath({ processEnv: process.env, envFileValues: ENV_FILE_VALUES })
}
const TOKEN_FILE_PATH = path.join(resolveWorkspacePath(), '.session-token')
const TOKEN_PLACEHOLDER = '__MULMOCLAUDE_AUTH_TOKEN__'

// Where the dev proxy sends `/api` and the pubsub socket. Read from the same
// place the backend reads its own port (#2650): a literal `localhost:3001` meant
// `PORT=3100 yarn dev` moved only the server, and with a first instance still on
// 3001 the second browser silently showed the FIRST instance's data.
//
// `.env` is consulted for the same reason `resolveWorkspacePath()` consults it —
// the server's loader populates `process.env` from that file, so a `PORT` set
// there and nowhere else must not split the two halves apart.
const PORT_RESOLUTION = resolveServerPort({
  processEnv: process.env,
  // The launcher's parser — i.e. `dotenv.parse`, the same one the server's loader
  // uses. Reading the file by hand here would let the two disagree about inline
  // comments, an `export ` prefix or quoting, which is this bug one level down.
  envFileValues: ENV_FILE_VALUES
})
// Reported only when it still matters. `PORT=0` is a problem for config-time
// resolution and no problem at all once the backend has published the port it
// got, so warning about it after successfully following would just be noise.
function reportUnusablePortValues(): void {
  if (PROXY_TARGET.source === 'published') return
  for (const { source, raw, reason } of PORT_RESOLUTION.problems) {
    console.warn(`[vite] ignoring ${source}="${raw}" — ${describeRejection(reason)}`)
  }
}

// What the backend ACTUALLY bound, which is not always what it was asked for:
// `server/index.ts` walks forward off a busy implicit default and publishes the
// result here. Reading it is what makes the proxy follow (#2981/#2650) instead
// of addressing a port nobody is on.
//
// Ordering is what makes this safe rather than racy: `yarn dev`'s client pane is
// `yarn wait:backend && vite`, and that wait does not return until this run's
// backend has published. So by the time this config is evaluated the file holds
// this run's port — and `yarn dev` cleared it beforehand, so a leftover from a
// dead run cannot be mistaken for it.
//
// Gated on an env var that ONLY `yarn dev` sets, because that guarantee is
// `yarn dev`'s and not the file's: `yarn dev:client` and `dev:client:e2e` run
// Vite with no backend and no `--reset`, so whatever `.server-port` holds there
// is a leftover, and following it would address a port nothing is on. Those
// keep targeting what `PORT` implies, exactly as before.
const FOLLOWS_PUBLISHED_PORT = process.env.MULMOCLAUDE_DEV_FOLLOW_PORT === '1'

function readPublishedPort(): string | null {
  if (!FOLLOWS_PUBLISHED_PORT) return null
  try {
    return fs.readFileSync(path.join(resolveWorkspacePath(), '.server-port'), 'utf-8')
  } catch {
    return null
  }
}
const PROXY_TARGET = resolveProxyTarget(readPublishedPort(), PORT_RESOLUTION)
if (PROXY_TARGET.source === 'published' && PROXY_TARGET.port !== PORT_RESOLUTION.port) {
  console.info(`[vite] proxying to :${PROXY_TARGET.port} — the port the backend actually bound (PORT resolved to :${PORT_RESOLUTION.port})`)
}
reportUnusablePortValues()
const { http: SERVER_ORIGIN, ws: SERVER_WS_ORIGIN } = serverOrigins(PROXY_TARGET.port)

// Following, continued — the reading above is only the one taken at startup
// (#2995). `vite.config.ts` is evaluated once, so when the readiness wait ran
// out of budget and Vite started against the merely-REQUESTED port, a backend
// publishing a moment later was left unreachable for the rest of the session.
// The proxy can be re-aimed per request; `scripts/lib/proxyTargetFollower.ts`
// explains why that is a supported property and not a poke at internals.
//
// Polling rather than `fs.watch`: one small file once a second costs nothing,
// and `fs.watch` is what `docs/windows-gotchas.md` says not to rely on.
const TARGET_POLL_MS = 1000
type Reaimable = { options: { target?: unknown } }
const followedProxies: Array<{ proxy: Reaimable; origin: (port: number) => string }> = []

/** Register a proxy instance so it is re-aimed when the backend moves. */
function reaimable(origin: (port: number) => string) {
  return (proxy: unknown): void => {
    followedProxies.push({ proxy: proxy as Reaimable, origin })
  }
}
const httpOrigin = (port: number): string => serverOrigins(port).http
const wsOrigin = (port: number): string => serverOrigins(port).ws

function followPublishedPort(server: { httpServer: { once: (event: string, cb: () => void) => void } | null }): void {
  if (!FOLLOWS_PUBLISHED_PORT || followedProxies.length === 0) return
  const follower = createProxyTargetFollower({
    initialPort: PROXY_TARGET.port,
    readPublished: readPublishedPort,
    parsePort: parsePublishedPort,
    onSwitch: (port) => {
      followedProxies.forEach(({ proxy, origin }) => {
        proxy.options.target = origin(port)
      })
      console.info(`[vite] backend moved to :${port} — proxy re-aimed`)
    }
  })
  const timer = setInterval(() => follower.poll(), TARGET_POLL_MS)
  timer.unref()
  server.httpServer?.once('close', () => clearInterval(timer))
}

// `PORT=0` (or a whitespace-only PORT, which coerces to 0) leaves the backend on an
// OS-assigned port that no proxy target can name, so the dev server must refuse to
// start rather than quietly serve a page wired to whatever else is on :3001.
// `apply: 'serve'` because `PORT` means nothing to `vite build` — failing a build
// over it would be its own bug.
function proxyPortGuardPlugin(): Plugin {
  return {
    name: 'mulmoclaude-proxy-port-guard',
    apply: 'serve',
    configResolved() {
      assertProxyablePort(PORT_RESOLUTION, PROXY_TARGET)
    },
    // RETURNED, not run inline. Vite calls plugin `configureServer` hooks first
    // and installs the proxy middleware afterwards, so the instances do not
    // exist yet at that point — an inline call registered nothing and the proxy
    // never moved. The returned function is the post hook, which runs once the
    // middlewares (and therefore every `configure`) are in place. Tied to the
    // server so the poll stops with it rather than outliving what it followed.
    configureServer(server) {
      return () => followPublishedPort(server)
    }
  }
}

// The workspace-is-the-Vite-root comparison below has to survive symlinked
// homes (macOS resolves `/tmp` and some `$HOME` layouts through `/private`) and
// NTFS junctions, so both sides go through realpath first. A workspace that
// doesn't exist yet (first boot) keeps its literal path.
function realpathOrSelf(candidate: string): string {
  try {
    return fs.realpathSync.native(candidate)
  } catch {
    return candidate
  }
}

// #2632: prune runtime writes and (on Windows) sandbox-mount mtime bumps from
// the dev watcher, both of which full-reload the page mid-agent-turn.
const devWatchIgnore = createDevWatchIgnore({
  projectRoot: realpathOrSelf(import.meta.dirname),
  workspacePath: realpathOrSelf(resolveWorkspacePath()),
  platform: process.platform,
  watchPackageDists: process.env.MULMOCLAUDE_DEV_WATCH_PACKAGES === '1',
})

// Dev-side half of the bearer-token injection (#272). The server
// writes the token to `TOKEN_FILE_PATH` at startup (mode 0600); this
// plugin reads that file on every index.html request and substitutes
// it into the `<meta name="mulmoclaude-auth" content="...">` tag.
//
// **Fallback**: if the file is missing (server not running, E2E with
// mocked API, `yarn dev:client` alone), we inject an empty string.
// Vue boot code reads an empty token as "no auth" and every real
// request 401s — that matches the dev ergonomics we want (no silent
// fake token). E2E tests never reach the real server (mocks), so they
// don't care about the header value.
function readDevToken(): string {
  // Env var takes precedence over the workspace file. This is the
  // escape hatch for (a) E2E tests that spawn `yarn dev:client`
  // without a running server (playwright.config.ts sets it), and
  // (b) future debugging / alternative dev workflows. Production
  // never reads env — Express is always the source of truth there.
  const fromEnv = process.env.MULMOCLAUDE_AUTH_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  try {
    return fs.readFileSync(TOKEN_FILE_PATH, 'utf-8').trim()
  } catch {
    return ''
  }
}

// Carries "may this page load receive the token?" from the connect
// middleware (which can see the request) down to `transformIndexHtml` (which
// cannot — `IndexHtmlTransformContext` has no `req`). AsyncLocalStorage rather
// than a module-level variable because concurrent requests would otherwise
// read each other's value.
const requestMayReceiveToken = new AsyncLocalStorage<boolean>()

// Every path this dev server forwards to Express. Kept in sync with
// `server.proxy` below — a prefix added there without being added here is
// reachable from the LAN whenever MULMOCLAUDE_DEV_LAN is set
// (`test/config/test_viteDevProxy.ts` fails when the two drift apart).
//
// `/ws` is the backend pub/sub socket. It needs BOTH guards below: the
// connect middleware never sees a WebSocket handshake (those arrive on the
// http server's `upgrade` event, not the request pipeline), so the prefix
// alone would not stop it.
//
// Exported for that test alone — this module is the dev server's config and
// loads node builtins, so client code under `src/` can never import it.
export const PROXIED_BACKEND_PREFIXES = ['/api', '/artifacts', '/htmlfile', '/ws'] as const

function startsWithProxiedPrefix(url: string | undefined): boolean {
  return PROXIED_BACKEND_PREFIXES.some((prefix) => url?.startsWith(prefix) ?? false)
}

// Only a navigation is worth a warning; every module and asset request of a
// refused page would otherwise log the same line.
const isPageLoad = (accept: string | undefined): boolean => accept?.includes('text/html') ?? false

// Exported for `test/config/test_viteAuthTokenPlugin.ts` alone (see
// PROXIED_BACKEND_PREFIXES on why client code cannot import this module).
export function mulmoclaudeAuthTokenPlugin(): Plugin {
  return {
    name: 'mulmoclaude-auth-token',
    // **Dev only.** In production the built index.html keeps the
    // placeholder; Express substitutes it per-request when serving
    // the file (see `server/index.ts` prod static handler). If this
    // plugin ran at build time too, the placeholder would be baked
    // out to whatever value the builder happened to see — wrong for
    // every subsequent user.
    apply: 'serve',
    // Registered from the `configureServer` body (not a returned function)
    // so it runs BEFORE Vite's own html-serving middleware, and therefore
    // before `transformIndexHtml` reads the store.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const fromLoopback = isLoopbackAddress(req.socket.remoteAddress)
        // Backend surface stays loopback-only even when the dev server is
        // bound to every interface. These paths are PROXIED to Express, and
        // some of them (`/api/files/*`, the `/artifacts/*` static mounts)
        // are deliberately bearer-exempt because a browser `<img>` cannot
        // send an Authorization header — their only protection was that
        // Express binds to 127.0.0.1. The proxy defeats that: Express sees
        // the proxy's own loopback socket, not the real client. Refusing
        // here is the only layer that can still tell the two apart.
        if (!fromLoopback && startsWithProxiedPrefix(req.url)) {
          res.statusCode = 403
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Forbidden: backend access is loopback-only' }))
          return
        }
        const handoff = decideOwnerTokenHandoff({
          remoteAddress: req.socket.remoteAddress,
          target: req.url,
          headers: req.headers,
          rawHeaders: req.rawHeaders
        })
        if (!handoff.ok && isPageLoad(req.headers.accept)) {
          server.config.logger.warn(`[auth] index.html served without the token: not a direct localhost load (${handoff.reason})`)
        }
        requestMayReceiveToken.run(handoff.ok, next)
      })

      // WebSocket handshakes never reach the middleware above — Node routes
      // them to the http server's `upgrade` event instead. Without this the
      // `/ws` proxy would still carry backend pub/sub to a LAN client even
      // though every HTTP path is refused.
      //
      // `prependListener` so this runs before the proxy's own upgrade
      // handler, and only backend prefixes are destroyed — Vite's HMR socket
      // is left alone, otherwise enabling LAN mode would break the very page
      // it is meant to serve.
      server.httpServer?.prependListener('upgrade', (req, socket) => {
        if (isLoopbackAddress(socket.remoteAddress)) return
        if (!startsWithProxiedPrefix(req.url)) return
        socket.destroy()
      })
    },
    transformIndexHtml(html) {
      // The session token is a bearer credential for the whole API, so only
      // a direct localhost load gets it (`decideOwnerTokenHandoff`: a LAN
      // peer under `MULMOCLAUDE_DEV_LAN`, or a tunnel to this port, does
      // not). Anyone else gets the empty string, which the Vue boot code
      // treats as "no auth" — the same path as a missing token file.
      const mayReceiveToken = requestMayReceiveToken.getStore() ?? false
      return html.replace(TOKEN_PLACEHOLDER, mayReceiveToken ? readDevToken() : '')
    },
  }
}

// Runtime-plugin importmap rewrite for production builds (#1043 C-2
// Phase E). The dev importmap maps `"vue"` → `/src/_runtime/vue.ts`,
// which Vite serves transformed and resolves to the host's Vue dep.
// In `vite build` that dev URL no longer exists — Vite emits a
// hashed asset for the runtime/vue chunk. This plugin (build-only)
// finds the hashed filename in the bundle and rewrites the
// importmap target so runtime-loaded plugins still share the host's
// Vue instance after `yarn build` and `npx mulmoclaude` distribution.
function runtimeImportmapBuildPlugin(): Plugin {
  // Each importmap entry maps `(dev URL → chunk name)`. The dev URL is
  // the static path the browser sees during `yarn dev`; the chunk
  // name matches the Rollup input key registered in
  // `build.rollupOptions.input` below. After build, the dev URL gets
  // rewritten to the hashed asset path.
  const ENTRIES: Array<{ devUrl: string; chunkName: string }> = [
    { devUrl: '/src/_runtime/vue.ts', chunkName: 'runtime-vue' },
    { devUrl: '/src/_runtime/protocol-vue.ts', chunkName: 'runtime-protocol-vue' },
  ]
  return {
    name: 'mulmoclaude-runtime-importmap',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html
        let next = html
        for (const { devUrl, chunkName } of ENTRIES) {
          let runtimeFile: string | null = null
          for (const [fileName, chunk] of Object.entries(ctx.bundle)) {
            if (chunk.type === 'chunk' && chunk.name === chunkName) {
              runtimeFile = fileName
              break
            }
          }
          if (!runtimeFile) {
            // Surface explicitly so a future input rename (or a
            // tree-shake regression on the runtime entry) doesn't
            // silently leave the dev URL in the built importmap and
            // break runtime-loaded plugins in production with no
            // diagnostic. CodeRabbit review on PR #1124.
            console.warn(`[mulmoclaude] runtime importmap chunk not emitted: ${chunkName} (importmap entry "${devUrl}" left as dev URL)`)
            continue
          }
          // `replaceAll` (not `replace`) so both occurrences get
          // rewritten — the importmap target AND any comment that
          // documents the dev URL.
          next = next.replaceAll(devUrl, `/${runtimeFile}`)
        }
        return next
      },
    },
  }
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), mulmoclaudeAuthTokenPlugin(), runtimeImportmapBuildPlugin(), proxyPortGuardPlugin()],
  // manifold-3d (ShapeScript's CSG, src/main.ts) finds its WebAssembly beside its
  // own module (`new URL("manifold.wasm", import.meta.url)`); pre-bundled into
  // .vite/deps that URL names a file that is not there, and the dev server
  // answers index.html for it.
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: {
    outDir: 'dist/client',
    rollupOptions: {
      // `index.html` is the SPA entry. `runtime-vue` is a side-entry
      // that emits a separate chunk for the runtime importmap target
      // (#1043 C-2 Phase E). Without it as an explicit input, Vite
      // would tree-shake `src/_runtime/vue.ts` to nothing because no
      // build-time `import` references it — the importmap is consumed
      // by the BROWSER, not by Vite's static analysis.
      input: {
        index: path.resolve(import.meta.dirname, 'index.html'),
        'runtime-vue': path.resolve(import.meta.dirname, 'src/_runtime/vue.ts'),
        // Same pattern as runtime-vue: the importmap consumer is the
        // browser, not Vite's static analysis, so without this entry
        // the chunk gets tree-shaken out of the build.
        'runtime-protocol-vue': path.resolve(import.meta.dirname, 'src/_runtime/protocol-vue.ts'),
      },
      // Force every named re-export from `src/_runtime/vue.ts` to be
      // preserved in the emitted chunk. Without `'strict'`, Rolldown
      // tree-shakes the `export * from "vue"` re-exports (no static
      // consumer in the build references them — the browser does,
      // via the runtime importmap), shrinking the chunk to a 46-byte
      // side-effect stub. A runtime-loaded plugin's
      // `import { createCommentVNode } from "vue"` then fails with
      // "does not provide an export named 'createCommentVNode'".
      // `'strict'` is the public-library mode and matches what we
      // want here: the entry's exports ARE the public surface for
      // browser-side consumers.
      preserveEntrySignatures: 'strict',
      // Targeted build-time warning suppressions. EVERY entry here
      // matches by code AND file/message so unrelated occurrences of
      // the same warning code still surface.
      //
      // 1. INEFFECTIVE_DYNAMIC_IMPORT — `PluginScopedRoot.vue` is
      //    dynamically imported from `src/tools/runtimeLoader.ts`
      //    ONLY so that `test/tools/test_runtimeLoader.ts` (which
      //    runs under tsx in Node with no Vue SFC compiler) can
      //    import the loader module without crashing on a top-level
      //    `.vue` import. Production code also references the
      //    component statically (App.vue / SettingsModal.vue /
      //    plugins/scope.ts), so the dynamic import legitimately
      //    doesn't chunk-split — that's the intended outcome.
      onwarn(warning, defaultHandler) {
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT' && warning.message.includes('PluginScopedRoot.vue')) {
          return
        }
        defaultHandler(warning)
      },
    },
  },
  server: {
    // Loopback by default. `host: true` (0.0.0.0) used to be
    // unconditional, which put the dev server on every interface — and
    // since `/api` is proxied to Express, that made a
    // deliberately-127.0.0.1-bound backend reachable from the LAN through
    // the proxy. Express saw those calls arriving from loopback, so the
    // "we only bind to 127.0.0.1, therefore remote traffic can't reach
    // us" assumption in `server/api/csrfGuard.ts` no longer held.
    //
    // Set MULMOCLAUDE_DEV_LAN=1 to bind every interface. Note that a LAN
    // client still receives an EMPTY auth token (see
    // `mulmoclaudeAuthTokenPlugin`), so opting in exposes the page, not
    // the API. Only do it on a network you trust.
    host: process.env.MULMOCLAUDE_DEV_LAN === '1' ? true : '127.0.0.1',
    watch: {
      ignored: [devWatchIgnore],
    },
    // Disable Vite's dev CORS middleware. The app itself is same-origin in dev
    // (the page and the proxied `/api` both live on :5173), so it needs no CORS
    // headers from Vite. The one cross-origin consumer is a custom collection
    // view: it renders in a sandboxed (opaque-origin) iframe whose fetch to
    // `/api/collections/:slug/view-data` is cross-origin and preflighted. With
    // Vite's CORS enabled, Vite answers that OPTIONS itself WITHOUT an
    // `Access-Control-Allow-Origin` (it rejects the "null" origin) and the
    // preflight fails before reaching the backend. Disabling it lets the
    // preflight (and the request) flow through the proxy to Express, which sets
    // the correct CORS headers (`viewDataCors` in
    // server/api/routes/collections.ts). Production has no Vite proxy — the
    // iframe hits Express directly — so this is dev-only.
    cors: false,
    proxy: {
      '/api': {
        target: SERVER_ORIGIN,
        changeOrigin: true,
        configure: reaimable(httpOrigin)
      },
      // Static-mount on the backend (server/index.ts: app.use('/artifacts/images', ...)).
      // Without this proxy, dev's Vite catch-all returns the SPA index.html instead.
      '/artifacts/images': {
        target: SERVER_ORIGIN,
        changeOrigin: true,
        configure: reaimable(httpOrigin)
      },
      // Static-mount on the backend (server/index.ts: app.use('/artifacts/svg', ...)).
      // Same reason as `/artifacts/images`: `<img src="/artifacts/svg/...">` would
      // otherwise hit Vite's SPA catch-all and receive index.html (HTTP 200, HTML
      // body), which the browser silently fails to render as an image.
      '/artifacts/svg': {
        target: SERVER_ORIGIN,
        changeOrigin: true,
        configure: reaimable(httpOrigin)
      },
      // Static-mount on the backend (server/index.ts: app.use('/artifacts/html', ...)).
      // Without this proxy, Vite's HTML transform injects `/@vite/client` and
      // `/src/main.ts` into the response, which the iframe (opaque origin) then
      // tries to load and the browser blocks via CORS. Forwarding to Express
      // returns the file untouched plus the CSP HTTP header.
      //
      // `xfwd: true` adds `X-Forwarded-Host` / `X-Forwarded-Proto` so Express
      // can recover the browser-visible origin (`localhost:5173`) when emitting
      // the CSP `img-src` directive. `changeOrigin: true` rewrites `Host` to
      // the upstream backend origin, so without xfwd the CSP would advertise
      // the wrong origin and Safari would block every `<img src="../images/...">`
      // request (Chrome happens to be lenient because images route through the
      // same proxy).
      '/artifacts/html': {
        target: SERVER_ORIGIN,
        changeOrigin: true,
        xfwd: true,
        configure: reaimable(httpOrigin)
      },
      // Static-mount on the backend (server/index.ts: app.use(HTML_FILE_MOUNT, ...)),
      // serving a page presentHtml was pointed AT rather than one it wrote — the
      // `path` form's `docs/report.html` or an absolute path. Its iframe `src`
      // comes from `htmlFileUrl()` in @mulmoclaude/html-plugin. Without this the
      // SPA catch-all answers 200 with index.html and the pane renders blank
      // (#2928); `test/config/test_viteDevProxy.ts` pins the URLs against this
      // table so a new URL shape fails there instead.
      //
      // `xfwd: true` for the same reason as `/artifacts/html`, and it bites
      // harder here: this mount serves the page's subresources (images, media)
      // too, so a CSP naming the backend origin blocks them.
      '/htmlfile': {
        target: SERVER_ORIGIN,
        changeOrigin: true,
        xfwd: true,
        configure: reaimable(httpOrigin)
      },
      '/ws': {
        target: SERVER_WS_ORIGIN,
        ws: true,
        configure: reaimable(wsOrigin)
      }
    }
  }
})
