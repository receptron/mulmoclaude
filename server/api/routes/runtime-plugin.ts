// HTTP routes for runtime-loaded plugins (#1043 C-2).
//
//   GET  /api/plugins/runtime/list
//        → { plugins: [{ name, version, toolName, description }, …] }
//
//   POST /api/plugins/runtime/:pkg/dispatch
//        body: <args> directly — same convention as static plugin
//              endpoints (see server/api/routes/plugins.ts), so
//              mcp-server's generic `postJson(endpoint, args)` works
//              unchanged for runtime plugins.
//        → whatever the plugin's `execute()` returns (forwarded as JSON)
//
//   GET  /api/plugins/runtime/:pkg/oauth/callback?code=&state=&error=
//        Generic OAuth redirect receiver (#1162). Spotify (and any
//        future OAuth-using runtime plugin) registers this URL with
//        its provider's developer dashboard; the browser comes back
//        here after consent. Host extracts `:pkg`, registry-looks-up
//        the plugin, forwards as `kind: "oauthCallback"` dispatch
//        args, and renders the plugin's returned `html` (or a fallback)
//        back to the browser. Bearer-auth-EXEMPT (no Authorization
//        header on a redirect); CSRF defended by the plugin's
//        single-use `state`.
//
//   GET  /api/plugins/runtime/:pkg/:version/*
//        Static-mount of the extracted cache directory; the frontend
//        loader uses this for `import("/api/plugins/runtime/<pkg>/<ver>/dist/vue.js")`.
//
// The registry is owned by `server/plugins/runtime-registry.ts` and
// populated at boot from the install ledger. A 404 from any of these
// routes means the plugin isn't installed (or failed to load — see
// boot logs).

import { Router, type Request, type Response } from "express";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { getRuntimePluginByOauthAlias, getRuntimePlugins } from "../../plugins/runtime-registry.js";
import { getBuiltinDispatch } from "../../plugins/builtin-dispatch.js";
import { notFound, serverError } from "../../utils/httpError.js";
import { errorMessage } from "../../utils/errors.js";
import { escapeHtml } from "@mulmoclaude/core/wiki";
import { isRecord } from "../../utils/types.js";
import { realpathIfPresent, scopeRealpath, type VerifiedScope } from "@mulmoclaude/core/files";
import { lexicallyInside } from "../../utils/files/artifactMount.js";
import { readPluginAsset } from "../../utils/files/plugins-io.js";
import { workspacePath } from "../../workspace/workspace.js";
import { log } from "../../system/logger/index.js";
import { singleLineForLog } from "../../utils/logPreview.js";

const LOG_PREFIX = "api/plugins/runtime";

const router = Router();

interface ListedPlugin {
  name: string;
  version: string;
  toolName: string;
  description: string;
  /** Absolute URL prefix the frontend uses for static-mount fetches. */
  assetBase: string;
}

router.get(API_ROUTES.plugins.runtimeList, (_req: Request, res: Response<{ plugins: ListedPlugin[] }>) => {
  const plugins = getRuntimePlugins().map<ListedPlugin>((entry) => ({
    name: entry.name,
    version: entry.version,
    toolName: entry.definition.name,
    description: entry.definition.description,
    assetBase: `/api/plugins/runtime/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`,
  }));
  res.json({ plugins });
});

router.post(API_ROUTES.plugins.runtimeDispatch, async (req: Request<{ pkg: string }>, res: Response) => {
  const pkg = decodeURIComponent(req.params.pkg);
  const args = isRecord(req.body) ? req.body : {};
  // Built-in plugins (bundled by Vite, wrapped with `wrapWithScope`)
  // share this dispatch channel but resolve out of the built-in
  // registry — they need host backends injected via ToolContext.app,
  // which the generic runtime path doesn't carry (task #6). Resolve
  // built-ins FIRST so a (user-installed) runtime plugin can't shadow a
  // first-party built-in scope by registering the same name.
  const builtin = getBuiltinDispatch(pkg);
  if (builtin) {
    try {
      res.json(await builtin(args));
    } catch (err) {
      log.error(LOG_PREFIX, "builtin execute failed", { pkg: singleLineForLog(pkg), error: errorMessage(err) });
      serverError(res, `plugin execute failed: ${errorMessage(err)}`);
    }
    return;
  }
  const plugin = getRuntimePlugins().find((entry) => entry.name === pkg);
  if (!plugin) {
    notFound(res, `runtime plugin "${pkg}" not registered`);
    return;
  }
  if (!plugin.execute) {
    serverError(res, `runtime plugin "${pkg}" has no execute() — the package's dist/index.js must export a function under "${plugin.definition.name}"`);
    return;
  }
  try {
    // gui-chat-protocol's ToolPluginCore.execute is
    // `(context: ToolContext, args) => Promise<ToolResult>`. The
    // server has no UI-side state to share, so context is an empty
    // object — but it MUST be the first arg, otherwise the plugin
    // destructures its args from `undefined` and the call fails with
    // "Cannot destructure property '<field>' of '<arg>' as it is
    // undefined".
    const context = {};
    const result = await plugin.execute(context, args);
    // Forward whatever the plugin returns as the response body
    // (mirrors static plugin routes — see plugins.ts). MCP server
    // spreads this into the toolResult event downstream.
    res.json(result);
  } catch (err) {
    log.error(LOG_PREFIX, "execute failed", { pkg: singleLineForLog(pkg), error: errorMessage(err) });
    serverError(res, `plugin execute failed: ${errorMessage(err)}`);
  }
});

// Generic OAuth callback receiver (#1162). The plugin owns state
// validation + token exchange — the host's role is just URL routing
// + HTML response rendering. The plugin returns
// `{ html?: string; message?: string }` from its `oauthCallback`
// kind handler; the host renders `html` verbatim if present, else
// falls back to a minimal default.
function buildOauthCallbackArgs(query: Request["query"]) {
  const { code, state, error: providerError } = query;
  return {
    kind: "oauthCallback" as const,
    code: typeof code === "string" ? code : undefined,
    state: typeof state === "string" ? state : undefined,
    error: typeof providerError === "string" ? providerError : undefined,
  };
}

function sendOauthCallbackResult(res: Response, result: unknown): void {
  const html = isRecord(result) && typeof result.html === "string" ? result.html : null;
  const message = isRecord(result) && typeof result.message === "string" ? result.message : "";
  const ok = isRecord(result) && result.ok === true;
  res
    .status(ok ? 200 : 400)
    .type("text/html")
    .send(html ?? renderFallbackCallbackHtml(ok ? "OAuth complete" : "OAuth failed", message || "(no message)"));
}

router.get(API_ROUTES.plugins.runtimeOauthCallback, async (req: Request<{ alias: string }>, res: Response) => {
  const { alias } = req.params;
  const plugin = getRuntimePluginByOauthAlias(alias);
  if (!plugin) {
    notFound(res, `no runtime plugin registered for OAuth callback alias "${alias}"`);
    return;
  }
  if (!plugin.execute) {
    serverError(res, `runtime plugin "${plugin.name}" has no execute()`);
    return;
  }
  try {
    const result = await plugin.execute({}, buildOauthCallbackArgs(req.query));
    sendOauthCallbackResult(res, result);
  } catch (err) {
    log.error(LOG_PREFIX, "oauth callback dispatch threw", { alias: singleLineForLog(alias), plugin: plugin.name, error: errorMessage(err) });
    res
      .status(500)
      .type("text/html")
      .send(renderFallbackCallbackHtml("Plugin error", errorMessage(err)));
  }
});

function renderFallbackCallbackHtml(title: string, body: string): string {
  // Minimal fallback when the plugin doesn't return its own HTML.
  // Plugins are encouraged to return a richer page; this is just a
  // safety net so the browser always gets something readable.
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#111}h1{margin-bottom:1rem}pre{white-space:pre-wrap;background:#f5f5f5;padding:1rem;border-radius:.5rem}</style>
<h1>${escapeHtml(title)}</h1>
<pre>${escapeHtml(body)}</pre>
</html>`;
}

// Static-mount of an installed plugin's directory. Resolution flow:
//
//   1. Look up `(pkg, version)` in the runtime registry. Presets and
//      user-installed plugins are both registered server-side, with
//      cachePath set from a trusted source (preset list or workspace
//      ledger). If the URL doesn't match any registered entry, 404 —
//      this is the trust boundary that prevents arbitrary-file reads
//      via percent-encoded `../` in `pkg` / `version` (the bearer-
//      auth exemption makes this an unauthenticated path).
//   2. Serve from a verified scope. A plugin installed into the
//      workspace's plugin cache is anchored at the workspace, so a
//      cache folder replaced by a link out of the workspace is refused
//      instead of becoming the root (#3573). A preset, under the app's
//      node_modules, is anchored at its own realpath. Symlinks inside
//      the extracted tree (e.g. dist/foo.js → /etc/passwd) cannot
//      escape, and the bytes come from a handle proven to be the
//      in-scope file, so a path swapped mid-request is not followed.
/** The verified scope of a registered plugin's assets; null when the (pkg, version) pair is not registered or its
 *  anchor cannot be resolved. Exported for tests. */
export async function pluginAssetScope(pkg: string, version: string): Promise<VerifiedScope | null> {
  const plugin = getRuntimePlugins().find((entry) => entry.name === pkg && entry.version === version);
  if (!plugin) return null;
  const withinWorkspace = lexicallyInside(workspacePath, plugin.cachePath);
  const trustedReal = await realpathIfPresent(withinWorkspace === null ? plugin.cachePath : workspacePath).catch(() => null);
  return trustedReal === null ? null : { trustedReal, scopeWithinTrusted: withinWorkspace ?? "" };
}

// The in-scope relative path of a request, or null when the plugin's folder is gone or led out, or `subPath` escapes.
async function assetRelPath(scope: VerifiedScope, subPath: string): Promise<string | null> {
  const scopeReal = await scopeRealpath(scope).catch(() => null);
  return scopeReal === null ? null : lexicallyInside(scopeReal, subPath);
}

router.get(API_ROUTES.plugins.runtimeAsset, async (req: Request<{ pkg: string; version: string; splat?: string | string[] }>, res: Response) => {
  const pkg = decodeURIComponent(req.params.pkg);
  const version = decodeURIComponent(req.params.version);
  // Express 5 returns `splat` as `string[]` when the wildcard
  // matched multiple segments, `string` for a single segment, and
  // empty/undefined for an empty wildcard. Normalise to the joined
  // path so downstream `path.join` works on every shape.
  const rawSplat = req.params.splat;
  const subPath = Array.isArray(rawSplat) ? rawSplat.join("/") : (rawSplat ?? "");
  const scope = await pluginAssetScope(pkg, version);
  const relPath = scope === null ? null : await assetRelPath(scope, subPath);
  if (scope === null || relPath === null) {
    notFound(res, "asset not found");
    return;
  }
  try {
    const asset = await readPluginAsset(scope, relPath);
    if (asset === null) {
      notFound(res, "asset not found");
      return;
    }
    res.setHeader("Content-Type", asset.contentType);
    res.send(asset.data);
  } catch (err) {
    log.error(LOG_PREFIX, "asset read failed", {
      pkg: singleLineForLog(pkg),
      version: singleLineForLog(version),
      subPath: singleLineForLog(subPath),
      error: errorMessage(err),
    });
    serverError(res, "asset read failed");
  }
});

export default router;
