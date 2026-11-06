// Which `/api/*` requests skip the global bearer check. Each exemption exists
// because the browser makes the request itself and cannot attach an
// `Authorization` header. The loopback-only listener still applies, and the
// CSRF origin check does for all but the custom-view data paths. Pure: the
// view-data matcher is passed in.
//
// - `/files/*`, GET / HEAD only: `<img src>`, `<iframe src>` and download
//   links load `/api/files/raw` with a plain GET. The routes that write
//   workspace files or start an OS handler (`create`, `upload`, `PUT content`,
//   `open`, `reveal`) are not GET, so they need the token like everything
//   else (#3628).
// - Custom-view data paths carry a scoped view token instead, checked by
//   `requireViewToken` (`./viewToken.ts`); they skip the CSRF check too.
// - Runtime-plugin assets, GET / HEAD: the frontend `import()`s them and
//   HEAD-probes `dist/vue.js` with a raw `fetch` before importing. Four or more
//   segments past `/plugins/runtime/` only matches assets — `list` and
//   `<pkg>/dispatch` still need the token.
// - The runtime-plugin OAuth callback, GET: a browser redirect. Guarded by the
//   registry lookup on `:alias` and the plugin's single-use `state`.

export interface ApiRequestLine {
  method: string;
  /** Relative to the `/api` mount, as Express's `req.path` gives it there. */
  path: string;
}

const RUNTIME_PLUGIN_ASSET_PATH_RE = /^\/plugins\/runtime\/[^/]+\/[^/]+\//;
const RUNTIME_PLUGIN_OAUTH_CALLBACK_RE = /^\/plugins\/runtime\/oauth-callback\/[^/]+$/;

const isReadMethod = (method: string): boolean => method === "GET" || method === "HEAD";

export function isBearerExempt(request: ApiRequestLine, isViewDataPath: (path: string) => boolean): boolean {
  const { method, path } = request;
  if (isReadMethod(method) && path.startsWith("/files/")) return true;
  if (isViewDataPath(path)) return true;
  if (isReadMethod(method) && RUNTIME_PLUGIN_ASSET_PATH_RE.test(path)) return true;
  return method === "GET" && RUNTIME_PLUGIN_OAUTH_CALLBACK_RE.test(path);
}
