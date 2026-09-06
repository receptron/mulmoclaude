// Single source of truth for every HTTP endpoint the server exposes
// under `/api/*`. Issue #289 (part 1) — consolidate the 77+ route
// registrations and ~57 frontend `fetch("/api/...")` call sites so
// that typos fail typecheck instead of producing runtime 404s.
//
// **Two shapes coexist**:
//
//   - **Host routes** (this file's `HOST_API_ROUTES` literal): values
//     are full URL strings. Used by host-only routes (`/api/agent`,
//     `/api/wiki`, …) where the method is implicit at the call site.
//   - **Plugin routes** (auto-merged from each plugin's META): values
//     are `ResolvedRoute = { method, url }` records. The plugin
//     declares `{ apiNamespace, apiRoutes: { key: { method, path } } }`
//     and the host composes `/api/<apiNamespace><path>` with the
//     `method` flowing through to the value. Plugin-owned dispatch
//     URLs and HTTP verbs land in the same place at the same time.
//
// **Adding a new host endpoint**: add it to `HOST_API_ROUTES` below;
// reference it from the route file as a string.
// **Adding a new plugin endpoint**: edit the plugin's `meta.ts` —
// the host aggregator picks it up automatically.

import { CHAT_SERVICE_ROUTES } from "@mulmobridge/protocol";
import { BUILT_IN_PLUGIN_METAS, defineHostAggregate, type BuiltInPluginMetas, type HostPluginCollision, type IntraPluginCollision } from "../plugins/metas";
import type { ResolvedRoute, RouteSpec } from "../plugins/meta-types";

// Plugin-owned API routes auto-merged from each plugin's META. Each
// plugin's `apiNamespace` becomes the outer key under `API_ROUTES`
// (defaulting to `toolName` when omitted); each route key's value
// is `ResolvedRoute = { method, url }` with `url` composed as
// `/api/<apiNamespace><path>`. Plugins without `apiRoutes` are skipped.
type ResolveRoutes<R extends Readonly<Record<string, RouteSpec>>> = {
  readonly [K in keyof R]: ResolvedRoute;
};
type PluginApiRoutesMap<T extends BuiltInPluginMetas> = {
  readonly [
    M in T[number] as M extends { readonly apiRoutes: Readonly<Record<string, RouteSpec>> }
      ? M extends { readonly apiNamespace: infer K extends string }
        ? K
        : M["toolName"]
      : never
  ]: M extends { readonly apiRoutes: infer R extends Readonly<Record<string, RouteSpec>> } ? ResolveRoutes<R> : never;
};

/** Resolve every plugin route into a `ResolvedRoute` keyed by the
 *  same name the META used. Used by the aggregator extractor; kept
 *  exported so server-side helpers can compose the same URLs from
 *  any META (e.g. `BUILT_IN_SERVER_BINDINGS.mcpDispatch` lookup). */
export function resolvePluginRoutes(namespace: string, routes: Readonly<Record<string, RouteSpec>>): Record<string, ResolvedRoute> {
  const resolved: Record<string, ResolvedRoute> = {};
  for (const [key, spec] of Object.entries(routes)) {
    resolved[key] = { method: spec.method, url: `/api/${namespace}${spec.path}` };
  }
  return resolved;
}

const HOST_API_ROUTES = {
  health: "/api/health",
  sandbox: "/api/sandbox",

  // Environment report for a bug report, as markdown. Secret values are
  // withheld by an allow list in `server/utils/diagnostics/report.ts` — the
  // agent pastes what it gets rather than deciding what to mask.
  diagnosticsReport: "/api/diagnostics/report",

  // Manually-pinned launcher shortcuts (collections / feeds). GET reads
  // the list; PUT replaces it wholesale (client owns add / remove /
  // order). Single replace-endpoint — no add/remove route sprawl.
  shortcuts: "/api/shortcuts",

  // Dashboard layout (per-tile view mode + order for the favorites grid).
  // GET reads the list; PUT replaces it wholesale (client owns order /
  // view mode). Single replace-endpoint, mirroring `shortcuts`.
  dashboard: "/api/dashboard",

  agent: {
    run: "/api/agent",
    cancel: "/api/agent/cancel",
    internal: {
      toolResult: "/api/internal/tool-result",
    },
  },

  // `chart` group migrated to META — see `src/plugins/chart/meta.ts`.
  // Auto-merged into `API_ROUTES.chart` via `apiRoutesKey: "chart"`.

  chatIndex: {
    rebuild: "/api/chat-index/rebuild",
  },

  // Single source of truth: @mulmobridge/protocol. See plans/done/messaging_transports.md.
  chatService: CHAT_SERVICE_ROUTES,

  shutdown: "/api/shutdown",

  config: {
    base: "/api/config",
    settings: "/api/config/settings",
    mcp: "/api/config/mcp",
    workspaceDirs: "/api/config/workspace-dirs",
    referenceDirs: "/api/config/reference-dirs",
    schedulerOverrides: "/api/config/scheduler-overrides",
    // Side-effect refresh endpoint: re-scans the skills dir +
    // re-registers user-defined scheduler tasks so changes to
    // `<workspace>/.claude/skills/<slug>/SKILL.md` or
    // `<workspace>/config/scheduler/tasks.json` activate without
    // a server restart. Called by the config-refresh PostToolUse hook
    // after Write/Edit (#1283); serves the `mc-manage-skills` +
    // `mc-manage-automations` preset skills (split out in #1295).
    // Safe to call ad-hoc — pure side effect, no body.
    refresh: "/api/config/refresh",
    connectors: "/api/config/connectors",
  },

  files: {
    tree: "/api/files/tree",
    dir: "/api/files/dir",
    content: "/api/files/content",
    /** POST — create a new file. Refuses on conflict (409) so the
     *  client doesn't have to gate creation through PUT, which is
     *  update-only and 404s on non-existent paths (#1598). */
    create: "/api/files/create",
    /** POST { dir, filename, dataUrl } — save dropped OS files into a
     *  workspace folder. Unlike `create` this takes binary (a `data:`
     *  URI) and never overwrites: a name collision is resolved by
     *  auto-renaming to `name (n).ext` (#2270). */
    upload: "/api/files/upload",
    raw: "/api/files/raw",
    refRoots: "/api/files/ref-roots",
    /** POST { path } — spawn the host OS's default handler for the
     *  file (`open` on macOS, `xdg-open` on Linux, `start` on
     *  Windows). The Files view exposes this as an "Open in OS"
     *  button on binary / unsupported previews so `.xlsx` / `.pptx`
     *  can be viewed in the native app when in-browser preview
     *  isn't available (#1985). */
    open: "/api/files/open",
    /** POST { path } — open the file's containing folder in the host
     *  file manager (file selected on macOS `open -R` / Windows
     *  `explorer /select,`; Linux opens the folder). Exposed as a
     *  "Show in folder" button so a generated file can be dragged
     *  into another app (#1985 follow-up). */
    reveal: "/api/files/reveal",
  },

  // `html` group migrated to META — see `src/plugins/presentHtml/meta.ts`.
  // Auto-merged via `apiRoutesKey: "html"`.

  image: {
    generate: "/api/generate-image",
    edit: "/api/edit-image",
    upload: "/api/images",
    // Body carries the workspace-relative path so the route doesn't
    // have to reconstruct one from a basename — required after #764
    // sharded image storage by YYYY/MM.
    update: "/api/images/update",
  },

  // Generic attachment store (paste/drop/file-picker uploads). Saves
  // the file under data/attachments/YYYY/MM/<id>.<ext> and returns
  // the workspace-relative path. PPTX uploads also save a companion
  // .pdf; the PDF path is what the route returns so the LLM never
  // needs to know about the original PPTX. Image uploads use this
  // same route now — image.upload remains for canvas drawings.
  attachments: {
    upload: "/api/attachments",
  },

  // Sharing: pack an HTML artifact + its referenced local assets into a
  // self-contained zip (index.html + assets/), streamed as a download.
  // `packMarkdown` renders markdown / a wiki page to a self-contained
  // HTML (images inlined) and zips that.
  share: {
    pack: "/api/share/pack",
    packMarkdown: "/api/share/pack-markdown",
  },

  // Remote host over Firestore (phase 1). The server signs in to Firebase as
  // the user (connect, body carries a browser-minted Google idToken), runs the
  // command-loop + presence heartbeat, and exposes its running state. See
  // plans/done/feat-remote-host-firestore-list-collections.md.
  remoteHost: {
    connect: "/api/remote-host/connect",
    reconnect: "/api/remote-host/reconnect",
    disconnect: "/api/remote-host/disconnect",
    status: "/api/remote-host/status",
  },

  // Local Google account link (settings UI). authorize starts the
  // loopback + PKCE consent flow on this host and returns the consent URL;
  // the refresh token never leaves the machine. See
  // plans/done/feat-2111-google-settings-ui.md.
  google: {
    status: "/api/google/status",
    authorize: "/api/google/authorize",
    unlink: "/api/google/unlink",
  },

  /** Startup beacon from the mulmoclaude MCP broker (#2842). The broker is a
   *  GRANDCHILD of this server — Claude CLI spawns it and owns its stderr — so
   *  this endpoint is the only path by which its cold-boot timing reaches our
   *  logs. Without it, "the broker is slow" and "the broker never came up" are
   *  indistinguishable from the host side. */
  mcp: {
    brokerReady: "/api/mcp/broker-ready",
    /** Fired from an `--import` preload before the broker loads anything, so
     *  it says "the process exists" without waiting for the cold boot.
     *
     *  Diagnostic only — nothing acts on it while a turn runs. It is read
     *  AFTER the CLI exits, to say whether a turn that lost its tools had a
     *  broker that never launched (the spawn) or one that launched and never
     *  finished booting (the boot). The fail-fast this was originally built
     *  for was measured and deliberately not shipped; see #2842. */
    brokerStarting: "/api/mcp/broker-starting",
  },

  mcpTools: {
    list: "/api/mcp-tools",
    invoke: "/api/mcp-tools/:tool",
  },

  /** Notifier dispatch — single endpoint, body carries `{ action,
   *  ... }`. Matches the `manage*` tool pattern used elsewhere
   *  (manageAccounting / manageSkills). */
  notifier: {
    dispatch: "/api/notifier",
  },

  journal: {
    // Most recent existing daily summary (today, falling back to
    // prior days). Backs the top-bar "today's journal" shortcut
    // (#876). Returns null when no daily summary has been generated
    // yet on this workspace.
    latestDaily: "/api/journal/latest-daily",
  },

  // `mulmoScript` group migrated to META — see `src/plugins/presentMulmoScript/meta.ts`.
  // Auto-merged via `apiNamespace: "mulmoScript"`.

  pdf: {
    markdown: "/api/pdf/markdown",
  },

  translation: {
    translate: "/api/translation",
  },

  // Local voice input (Mac-only, whisper.cpp). `run` transcribes one
  // audio clip; `model` reports capability + download status; `modelDownload`
  // is the opt-in trigger fired by the Settings → Voice enable toggle.
  // See plans/done/feat-voice-input.md.
  transcribe: {
    run: "/api/transcribe",
    model: "/api/transcribe/model",
    modelDownload: "/api/transcribe/model/download",
  },

  // Plugin-owned endpoints that don't follow a single naming pattern.
  // Names match the plugin tool name or the short verb the plugin uses.
  plugins: {
    // `presentDocument` / `updateMarkdown` migrated to META — see
    // `src/plugins/markdown/meta.ts`. Auto-merged via
    // `apiRoutesKey: "presentDocument"`.
    // `presentSpreadsheet` / `updateSpreadsheet` migrated to META —
    // see `src/plugins/spreadsheet/meta.ts`. Auto-merged via
    // `apiRoutesKey: "presentSpreadsheet"`.
    mindmap: "/api/mindmap",
    quiz: "/api/quiz",
    // `form` and `canvas` migrated to META — exposed at top-level
    // `API_ROUTES.presentForm.dispatch` / `API_ROUTES.canvas.dispatch`.
    // mapControl — `@gui-chat-plugin/google-map` external package.
    googleMap: "/api/google-map",
    // Runtime-loaded plugins (#1043 C-2). One generic dispatch
    // endpoint shared by every workspace-installed plugin; the URL
    // pkg parameter is the URL-encoded npm package name (e.g.
    // `%40gui-chat-plugin%2Fweather`). Matched against the runtime
    // registry server-side; the registry's plugin.execute() handles
    // the call.
    runtimeList: "/api/plugins/runtime/list",
    runtimeDispatch: "/api/plugins/runtime/:pkg/dispatch",
    /** Generic OAuth callback receiver for runtime plugins (#1162).
     *  The plugin declares a short alias (e.g. `OAUTH_CALLBACK_ALIAS
     *  = "spotify"`) and registers this URL as the redirect_uri in
     *  its provider's developer dashboard. The host extracts the
     *  alias, looks up the plugin in the registry, and forwards
     *  `{ code, state, error }` as `kind: "oauthCallback"` dispatch
     *  args.
     *
     *  Why a short alias instead of the npm package name in the path?
     *  Spotify's Dashboard rejects redirect URIs containing
     *  percent-encoded `@` / `/` characters (the natural shape when
     *  the npm scoped name lands in a single path segment), so each
     *  OAuth-using plugin declares its own short, alphanumeric alias.
     *  Collisions are detected at boot and logged.
     *
     *  Bearer-auth-EXEMPT (browser redirect carries no Authorization
     *  header); CSRF defended by the plugin's single-use `state`. */
    runtimeOauthCallback: "/api/plugins/runtime/oauth-callback/:alias",
    /** Boot-time META aggregator collisions (host vs plugin, plugin
     *  vs plugin). Returns an empty array when clean. Frontend
     *  fetches once at mount so a tab that opens after server boot
     *  still surfaces the warning toast + bell entry. See
     *  `server/plugins/diagnostics.ts`. */
    diagnostics: "/api/plugins/diagnostics",
    /** Static-mount of the extracted plugin tree. The URL pkg is the
     *  un-encoded npm name plus version dir. Used by the frontend
     *  loader's dynamic `import()` to fetch `dist/vue.js`.
     *
     *  Express 5 path-to-regexp uses `/{*name}` for catch-all
     *  wildcards (the bare `*` from Express 4 throws at registration).
     *  Handler reads the wildcard via `req.params.splat`. */
    runtimeAsset: "/api/plugins/runtime/:pkg/:version/{*splat}",
  },

  roles: {
    list: "/api/roles",
    manage: "/api/roles/manage",
  },

  // Custom Marp themes (#1649). One CSS file per theme under
  // `config/marp-themes/`; `GET /api/marp-themes` returns the list
  // for the MarpView previewer to register via `marp.themeSet.add()`.
  marpThemes: {
    list: "/api/marp-themes",
  },

  // Schema-driven collections (see plans/done/feat-skill-driven-apps.md
  // — historical name predates the rename). One "collection" is a
  // skill that ships a `schema.json` alongside its `SKILL.md`; the
  // host renders its records via `<CollectionView>`.
  collections: {
    list: "/api/collections",
    /** GET → { entries: CollectionOntologyEntry[] } — the raw workspace
     *  ontology; the /collections Map tab builds its graph client-side
     *  from these via the shared `buildOntologyGraph` (server/client
     *  parity). Must be registered BEFORE `detail` so "ontology" is
     *  never matched as a `:slug`. */
    ontology: "/api/collections/ontology",
    /** GET → { collection, items } */
    detail: "/api/collections/:slug",
    /** POST → create one record (auto-id when primaryKey value omitted) */
    items: "/api/collections/:slug/items",
    /** PUT → upsert; DELETE → remove */
    item: "/api/collections/:slug/items/:itemId",
    /** POST → assemble a schema-declared action's seed prompt → { prompt, role } */
    itemAction: "/api/collections/:slug/items/:itemId/actions/:actionId",
    /** POST → assemble a collection-level action's seed prompt (no record;
     *  injects a progress summary of all items) → { prompt, role } */
    collectionAction: "/api/collections/:slug/actions/:actionId",
    /** POST → re-run a collection's retrieval now: a feed's `ingest`, or a
     *  `googleCalendar` sync (#2427) → { refreshed, written, removed? }.
     *  400 when the collection declares neither. */
    refresh: "/api/collections/:slug/refresh",
    /** POST → push locally created / edited records to the Google calendar the
     *  collection declares (#2598) → { pushed, created, updated, conflicts, … }.
     *  400 when the collection declares no `googleCalendar`. Never deletes. */
    calendarPush: "/api/collections/:slug/calendar-push",
    /** GET ?id=<viewId> → the custom view's HTML file (global-bearer auth),
     *  read from data/skills/:slug/views/. The parent renders it sandboxed. */
    viewFile: "/api/collections/:slug/view-file",
    /** GET ?id=<viewId>&locale=<tag> → a mobile (`target: "mobile"`) custom
     *  view wrapped into its sandboxed srcdoc (global-bearer auth) →
     *  { view, srcdoc, bytes }. Same builder as the command channel's
     *  `getRemoteView`, so the desktop phone-frame preview renders the exact
     *  artifact the phone receives (plans/done/feat-remote-custom-view.md). */
    remoteView: "/api/collections/:slug/remote-view",
    /** POST { op: "update"|"delete", id, patch? } → apply one mutate on behalf
     *  of a `target: "mobile"` view, authorized by that view's declared
     *  editableFields / allowDelete and enforced host-side (global-bearer auth).
     *  The desktop phone-frame preview's write channel — same builder the
     *  command channel's `mutateRemoteViewItem` uses, so preview === phone
     *  (plans/done/feat-remote-writable-view.md). */
    remoteViewMutate: "/api/collections/:slug/remote-view/:viewId/mutate",
    /** GET ?offset&limit&fields=<csv> → one page of a `target: "mobile"` view's
     *  records with its declared `imageFields` inlined as `data:` URL thumbnails
     *  (global-bearer auth) → { page, inlined, omitted }. Same builder as the
     *  command channel's `getRemoteViewItems`, so the desktop phone-frame preview
     *  pages the exact data (incl. real thumbnails) the phone will
     *  (plans/done/feat-remote-view-images.md). */
    remoteViewItems: "/api/collections/:slug/remote-view/:viewId/items",
    /** GET ?id=<viewId>&locale=<tag> → translation dict for one custom view
     *  (global-bearer auth) → { locale, dict }. `dict` is the host-picked
     *  flat map for the requested locale (fallback `"en"`, else `{}`); the
     *  host never streams other locales' strings. Empty dict + `locale: ""`
     *  when the view declares no `i18n` file or the file is missing /
     *  malformed — the view keeps working via `__MC_VIEW.t()`'s key
     *  fallback. */
    viewI18n: "/api/collections/:slug/view-i18n",
    /** POST → mint a slug- and capability-scoped token for a custom view
     *  (global-bearer auth) → { token, exp, dataUrl, capabilities }. */
    viewToken: "/api/collections/:slug/view-token",
    /** GET → enriched records (getItems); PUT → validated write (putItems).
     *  Guarded by the scoped view token (NOT the global bearer); exempt from
     *  the global bearer + CSRF middleware. See server/api/auth/viewToken.ts. */
    viewData: "/api/collections/:slug/view-data",
    /** POST → invoke a `kind: "mutate"` action from a custom view (body:
     *  { itemId, params? }) → { written, itemId, item }. Requires the `write`
     *  capability on the view token; mutate kind ONLY — a view token must
     *  never be able to start LLM work (chat/agent stay bearer-guarded). */
    viewDataAction: "/api/collections/:slug/view-data/actions/:actionId",
    /** POST → run a structured aggregation query (body: { query }) over a
     *  dataSource collection's WHOLE data file → { collection, count, rows }.
     *  Requires only the `read` capability on the view token — the DSL is
     *  read-only by construction (see core/queryZ.ts); 400 on a file-backed
     *  collection (no query engine). Backs chart-drawing custom views. */
    viewDataQuery: "/api/collections/:slug/view-data/query",
    /** GET → resolve one record-referenced `image` field value (a workspace
     *  path, `?path=…`) into a downscaled thumbnail → { path, dataUrl }.
     *  Requires only the `read` capability; the path must be a CURRENT value
     *  of one of the schema's image-type fields (no arbitrary file reads).
     *  Optional `?maxEdge=` (clamped 64–1024, default 512). This is how a
     *  desktop custom view displays workspace image files — sibling of the
     *  remote view's `imageFields` inlining. */
    viewDataImage: "/api/collections/:slug/view-data/image",
    /** DELETE → remove one custom view: drop it from schema.json `views[]` and
     *  unlink its `views/<file>.html` (global-bearer auth) → { deleted, viewId }.
     *  Source-aware; refuses user-scope + preset collections. */
    viewDelete: "/api/collections/:slug/views/:viewId",
  },

  // Curated collection registry (receptron/mulmoclaude-collections). The host
  // server-fetches the published index.json (GitHub Pages) and proxies it to the
  // /collections Discover tab — the upstream URL is never exposed to the client.
  collectionsRegistry: {
    list: "/api/collections-registry",
    /** GET ?author=&slug= → { entry, schema, meta } for one in-index collection. */
    preview: "/api/collections-registry/preview",
    /** POST { author, slug } → fetch + re-validate + install into .claude/skills/,
     *  normalize dataPath, materialize seed, record provenance. */
    import: "/api/collections-registry/import",
    /** POST { slug, author, license?, includeSeed? } → write a registry-contribution
     *  bundle (collections/<author>/<slug>/ + meta.json + optional seed) under
     *  data/registry-export/ for the user to open a PR. */
    export: "/api/collections-registry/export",
  },

  // `scheduler` group migrated to META — see `src/plugins/scheduler/automationsMeta.ts`.
  // Auto-merged via `apiNamespace: "scheduler"`.

  sessions: {
    list: "/api/sessions",
    // GET /api/sessions/:id (read) + DELETE /api/sessions/:id (hard delete)
    detail: "/api/sessions/:id",
    markRead: "/api/sessions/:id/mark-read",
    bookmark: "/api/sessions/:id/bookmark",
  },

  // `skills` group migrated to META — see `src/plugins/manageSkills/meta.ts`.

  // Data-source feeds. Read-only list for the /feeds UI; feeds are
  // created/removed by the agent writing feeds/<slug>/schema.json files
  // (config/helps/feeds.md), and refreshed via collections.refresh.
  feeds: {
    list: "/api/feeds",
    /** DELETE → remove a feed's registry entry (records retained). Backs
     *  the feed-delete button; the agent deletes via its own file tools. */
    detail: "/api/feeds/:slug",
  },

  hooks: {
    /** Internal endpoint hit by the PostToolUse dispatcher
     *  (`<workspace>/.claude/hooks/mulmoclaude-dispatcher.mjs`) to
     *  forward debug / status lines into the server's structured
     *  logger. Without this, hook handlers (skill-bridge mirror copy
     *  etc.) silently succeed and a user trying to verify a copy
     *  ran has no signal to look at. POST body:
     *    { namespace: string; message: string;
     *      level?: "info" | "warn" | "error"; data?: object }
     *  Never called by the Vue client. */
    log: "/api/hooks/log",
  },

  wiki: {
    base: "/api/wiki",
    /** History routes (#763 PR 2). `:slug` and `:stamp` are filled in
     *  by the caller — the constants stay route-pattern shaped so the
     *  Express router and the Vue API layer share one source of truth. */
    pageHistory: "/api/wiki/pages/:slug/history",
    pageHistorySnapshot: "/api/wiki/pages/:slug/history/:stamp",
    pageHistoryRestore: "/api/wiki/pages/:slug/history/:stamp/restore",
    /** Internal endpoint hit by the LLM-write hook script
     *  (`<workspace>/.claude/hooks/wiki-snapshot.mjs`). Re-reads
     *  the just-written file from disk and routes it into the
     *  snapshot pipeline. Never called by the Vue client. */
    internalSnapshot: "/api/wiki/internal/snapshot",
  },
} as const;

// First-write-wins host+plugin aggregate (see `defineHostAggregate`):
// host outer-keys win on collision (plugins claiming `agent`/`roles`/
// `wiki` are dropped), the second-claiming plugin's `apiNamespace`
// is dropped, both diagnostic lists are exposed for boot warnings.
//
// The aggregator's value-type union spans:
//   - host string URLs (`/api/health`),
//   - host nested groups (`{ run, cancel, internal }`),
//   - plugin route maps (`Record<string, ResolvedRoute>` produced by
//     `resolvePluginRoutes`).
// `defineHostAggregate` takes the host record type and the
// literal-preserving plugin map as type arguments, so the merged
// result carries the shape above without a cast at this call site.
type ApiRoutesAggregateValue =
  (typeof HOST_API_ROUTES)[keyof typeof HOST_API_ROUTES] | Readonly<Record<string, string>> | Readonly<Record<string, ResolvedRoute>>;

const API_ROUTES_AGGREGATE = defineHostAggregate<ApiRoutesAggregateValue, typeof HOST_API_ROUTES, PluginApiRoutesMap<BuiltInPluginMetas>>(
  BUILT_IN_PLUGIN_METAS,
  {
    label: "API_ROUTES",
    hostRecord: HOST_API_ROUTES,
    extract: (meta) => {
      if (meta.apiRoutes === undefined) return undefined;
      const namespace = meta.apiNamespace ?? meta.toolName;
      return { [namespace]: resolvePluginRoutes(namespace, meta.apiRoutes) };
    },
    dimension: "apiNamespace",
  },
);
export const API_ROUTES_HOST_COLLISIONS: readonly HostPluginCollision[] = API_ROUTES_AGGREGATE.hostCollisions;
export const API_ROUTES_INTRA_COLLISIONS: readonly IntraPluginCollision[] = API_ROUTES_AGGREGATE.intraCollisions;

export const API_ROUTES = API_ROUTES_AGGREGATE.merged;
