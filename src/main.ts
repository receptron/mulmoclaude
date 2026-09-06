import { createApp } from "vue";
// Wire @mulmoclaude/collection-plugin/vue to this host's collection API +
// asset-URL scheme before any collection View mounts (side effect).
import "./composables/collections/uiHost";
// Wire @mulmoclaude/accounting-plugin/vue to this host's apiCall +
// pub/sub + stylesheet before any accounting View mounts (side effect).
import "./composables/accountingHost";
import App from "./App.vue";
import router from "./router/index";
import { installGuards } from "./router/guards";
import i18n from "./lib/vue-i18n";
import { setAuthToken } from "./utils/api";
import { readAuthTokenFromMeta } from "./utils/dom/authTokenMeta";
import { loadRuntimePlugins } from "./tools/runtimeLoader";
import { startDevPluginReloadListener } from "./composables/useDevPluginReload";
import { installHostContext, type EndpointRegistry } from "./plugins/api";
import { API_ROUTES } from "./config/apiRoutes";
import { BUILTIN_ROLE_IDS } from "./config/roles";
import { PAGE_ROUTES } from "./router";
import { getAllPluginNames } from "./tools";
import { setupMarked } from "./utils/markdown/setup";
import "./index.css";
import "material-icons/iconfont/material-icons.css";
import "material-symbols/outlined.css";

import.meta.glob(["../node_modules/@gui-chat-plugin/*/dist/style.css", "../node_modules/@mulmochat-plugin/*/dist/style.css"], { eager: true });

// Bearer auth bootstrap (#272). The server embeds the per-startup
// token into `<meta name="mulmoclaude-auth" content="...">` when it
// serves index.html. Reading it here and handing to setAuthToken()
// wires every subsequent apiFetch / apiGet / ... to attach an
// `Authorization: Bearer ...` header. A missing or empty token means
// requests will 401 — that's the intended dev-time signal when the
// server isn't running.
setAuthToken(readAuthTokenFromMeta());

// Plugin DI: wire the host's URL map / role IDs / page-name
// constants / plugin registry into the plugin-side resolver BEFORE
// app.mount(). Plugin code reads from this registry via the
// `pluginEndpoints` / `pluginBuiltinRoleIds` / `pluginPageRoute` /
// `pluginAllPluginNames` helpers in `./plugins/api`. Plugin source
// has zero direct dependency on `./config/*` — host wires them in
// here, which is the only place that knows both ends.
//
// The endpoint registry is built explicitly per-plugin so each
// plugin's scope name is stable regardless of where the host
// happens to nest the URLs in the apiRoutes tree. Plugin-owned
// scopes (#1141) match the META's `apiNamespace`; host-shared
// scopes (`files`, `imageStore`, `mcpTools`, …) carry plain string
// URLs the host owns directly.
const pluginEndpointRegistry: EndpointRegistry = {
  // Plugin-owned top-level groups. Each value is a `Record<string,
  // ResolvedRoute>` produced by the host aggregator from the
  // plugin's META `{ apiNamespace, apiRoutes }`.
  scheduler: API_ROUTES.scheduler,
  mulmoScript: API_ROUTES.mulmoScript,
  skills: API_ROUTES.skills,
  html: API_ROUTES.html,
  svg: API_ROUTES.svg,
  shapescript: API_ROUTES.shapescript,
  chart: API_ROUTES.chart,
  accounting: API_ROUTES.accounting,
  canvas: API_ROUTES.canvas,
  form: API_ROUTES.form,
  presentCollection: API_ROUTES.presentCollection,
  markdown: API_ROUTES.markdown,
  spreadsheet: API_ROUTES.spreadsheet,
  photoLocations: API_ROUTES.photoLocations,
  // Host-owned groups. `wiki` / `roles` live in `HOST_API_ROUTES`
  // as plain string URLs; `image` is a host-shared image store
  // with both a `generate`/`edit` plugin route and an `update`
  // endpoint shared with canvas. Plugins read these as
  // `Record<string, string>` via `pluginEndpoints<HostShape>`.
  wiki: API_ROUTES.wiki,
  roles: API_ROUTES.roles,
  image: API_ROUTES.image,
  // Cross-cutting host-shared services that plugins reach for
  // (read workspace files, look up MCP tools, save canvas image
  // back to disk). Exposed as their own scopes so plugins don't
  // import `API_ROUTES.files` / `image.update` / `mcpTools` directly.
  files: API_ROUTES.files,
  imageStore: { update: API_ROUTES.image.update },
  mcpTools: { list: API_ROUTES.mcpTools.list },
  marpThemes: API_ROUTES.marpThemes,
};

installHostContext({
  endpoints: pluginEndpointRegistry,
  builtinRoleIds: BUILTIN_ROLE_IDS,
  pageRoutes: PAGE_ROUTES,
  getAllPluginNames,
});

// Runtime-loaded plugins (#1043 C-2). Fire-and-forget: kick off the
// list fetch + dynamic imports immediately but do NOT block mount.
// Static plugins are bundled and ready synchronously; runtime
// plugins fill in over the next ~100ms while the app is rendering
// its first paint. By the time the LLM actually calls a runtime
// tool (which requires at least one user message round-trip), the
// registry is fully populated.
//
// Awaiting here would delay first paint even when there are no
// runtime plugins installed (every workspace today), and it shifted
// the timing of `page.goto("/chat")` enough to break the
// today-journal-button E2E spec, which captured the URL before
// app mount completed.
loadRuntimePlugins().catch((err: unknown) => {
  console.warn("[runtime-plugin] boot loader threw", err);
});

// PR3 of #1159: when `--dev-plugin` is in use and the watched dist/
// changes, this listener reloads the page. No-ops in production
// because the server only publishes when a dev plugin is loaded.
startDevPluginReloadListener();

// Configure the shared `marked` instance — installs the wiki-embed
// extension + built-in `[[amazon:...]]` / `[[isbn:...]]` handlers
// before any view renders markdown. (#1221 PR-B)
setupMarked();

installGuards(router);

const app = createApp(App);
app.use(router);
app.use(i18n);
app.mount("#app");
