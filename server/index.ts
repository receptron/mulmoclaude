// Must stay FIRST and stay an import: importing it populates
// `process.env` from `<cwd>/.env` during the import phase, before any
// module below reads env at its own scope. A call in the body would run
// after every import had already been evaluated — too late. See
// server/system/loadEnv.ts.
import { shadowedByServerLoad } from "./system/loadEnv.js";
// Wire @mulmoclaude/core/collection/server to this host's workspace + logger
// before any module that touches collection storage loads.
import "./workspace/collections/configure.js";
import "./services/google/configure.js";
import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { fileURLToPath } from "url";
import agentRoutes, { startChat, spawnSystemWorker } from "./api/routes/agent.js";
import { createAccountingRouter, initAccountingEventPublisher, configureAccountingServer } from "@mulmoclaude/accounting-plugin/server";
import photoLocationsRoutes from "./api/routes/photo-locations.js";
import schedulerRoutes from "./api/routes/scheduler.js";
import sessionsRoutes, { loadAllSessions } from "./api/routes/sessions.js";
import chatIndexRoutes from "./api/routes/chat-index.js";
import feedsRoutes from "./api/routes/feeds.js";
import pluginsRoutes from "./api/routes/plugins.js";
import imageRoutes from "./api/routes/image.js";
import attachmentRoutes from "./api/routes/attachment.js";
import transcribeRoutes from "./api/routes/transcribe.js";
import presentHtmlRoutes from "./api/routes/presentHtml.js";
import shareRoutes from "./api/routes/share.js";
import remoteHostRoutes from "./api/routes/remoteHost.js";
import googleRoutes from "./api/routes/google.js";
import presentSvgRoutes from "./api/routes/presentSvg.js";
import chartRoutes from "./api/routes/chart.js";
import rolesRoutes from "./api/routes/roles.js";
import shortcutsRoutes from "./api/routes/shortcuts.js";
import dashboardRoutes from "./api/routes/dashboard.js";
import { DEFAULT_ROLE_ID } from "../src/config/roles.js";
import mulmoScriptRoutes from "./api/routes/mulmo-script.js";
import wikiRoutes from "./api/routes/wiki.js";
import wikiHistoryRoutes from "./api/routes/wiki/history.js";
import { provisionDispatcherHook } from "./workspace/hooks/provision.js";
import pdfRoutes from "./api/routes/pdf.js";
import marpThemesRoutes from "./api/routes/marp-themes.js";
import filesRoutes from "./api/routes/files.js";
import configRoutes from "./api/routes/config.js";
import configRefreshRoutes from "./api/routes/config-refresh.js";
import hookLogRoutes from "./api/routes/hookLog.js";
import mcpBrokerReadyRoutes from "./api/routes/mcpBrokerReady.js";
import skillsRoutes from "./api/routes/skills.js";
import collectionsRoutes, { makeViewActionRateLimiter } from "./api/routes/collections.js";
import collectionsRegistryRoutes from "./api/routes/collectionsRegistry.js";
import { startCollectionWatchers } from "./workspace/collections/watcher.js";
import runtimePluginRoutes from "./api/routes/runtime-plugin.js";
// Side-effect: registers the built-in "markdown" dispatch handler so the
// markdown View's useRuntime().dispatch({ kind }) resolves (task #6).
import "./plugins/markdown-builtin.js";
// Side-effect: registers the built-in "html" dispatch handler so the
// presentHtml View's useRuntime().dispatch({ kind }) resolves (phase 2).
import "./plugins/html-builtin.js";
import { loadRuntimePlugins } from "./plugins/runtime-loader.js";
import { evaluateDevPluginGate, loadDevPlugins, parseDevPluginsEnv } from "./plugins/dev-loader.js";
import { watchDevPlugins } from "./plugins/dev-watcher.js";
import { loadPresetPlugins } from "./plugins/preset-loader.js";
import { registerRuntimePlugins } from "./plugins/runtime-registry.js";
import { makePluginRuntime } from "./plugins/runtime.js";
import { MCP_PLUGIN_NAMES } from "./agent/plugin-names.js";
import { claudeCredentialsPath } from "./utils/claudeConfigPath.js";
import { setActiveBackend } from "./agent/backend/index.js";
import { fakeEchoBackend } from "./agent/backend/fake-echo.js";
import { startMacosReminderAdapter } from "./notifier/macosReminderAdapter.js";
import notifierRoutes from "./api/routes/notifier.js";
import { createShutdownRouter } from "./api/routes/shutdown.js";
import { initNotifier } from "./notifier/engine.js";
import { registerSaveAttachmentHook } from "./utils/files/attachment-store.js";
import { capturePhotoLocation } from "./workspace/photo-locations/index.js";
import { createJournalRouter } from "./api/routes/journal.js";
import { createTranslationRouter } from "./api/routes/translation.js";
import { announcePluginMetaDiagnostics } from "./plugins/diagnostics.js";
import { announceShadowedEnv, SHADOWED_ENV_KEYS_VAR } from "./system/shadowedEnv.js";
import { announceOptionalDeps } from "./system/announceOptionalDeps.js";
import { announceGeminiKey } from "./system/announceGeminiKey.js";
import { migrateLegacyBillingPresets } from "./workspace/billing-migration.js";
import { APP_VERSION } from "./system/appVersion.js";
import { createChatService } from "@mulmobridge/chat-service";
import { readSessionJsonl, readSessionMeta } from "./utils/files/session-io.js";
import { resolveBridgeSessionRole } from "./api/bridge/sessionRole.js";
import { onSessionEvent, initSessionStore } from "./events/session-store/index.js";
import { initFileChangePublisher } from "./events/file-change.js";
// Importing also binds the shared mulmoScript server ops to this host's
// backend and registers the built-in "mulmoScript" dispatch handler (side
// effect at module load — plans/done/feat-mulmoscript-plugin.md phase 3).
import { initMulmoScriptGenerationPublisher } from "./plugins/mulmoscript-server.js";
import { initCollectionChangePublisher } from "./events/collection-change.js";
import { initPhotoLocationsChangePublisher } from "./events/photo-locations-change.js";
import { getRole, loadAllRoles } from "./workspace/roles.js";
import { discoverSkills } from "./workspace/skills/index.js";
import { WORKSPACE_PATHS } from "./workspace/paths.js";
import { resolveClientDir } from "./utils/clientDir.js";
import { serverError } from "./utils/httpError.js";
import { browserVisibleOrigin } from "./utils/forwardedOrigin.js";
import { makeUuid } from "./utils/id.js";
import { mcpToolsRouter, mcpTools, isMcpToolEnabled } from "./agent/mcp-tools/index.js";
import { preflightUserServers, logPreflightResult } from "./agent/mcpPreflight.js";
import { loadMcpConfig, loadSettings } from "./system/config.js";
import { getVoiceInputStatus, stopWhisperSidecar, warmupVoiceInput } from "./system/whisper/index.js";
import { initWorkspace, workspacePath } from "./workspace/workspace.js";
import { runMemoryMigrationOnce } from "./workspace/memory/run.js";
import { runTopicMigrationOnce } from "./workspace/memory/topic-run.js";
import { migrateCookingRecipesFromPlugin } from "./workspace/cooking-recipes/migrate.js";
import { env, isAblated, isGeminiAvailable } from "./system/env.js";
import { buildSandboxStatus } from "./api/sandboxStatus.js";
import { buildDiagnosticsMarkdown } from "./utils/diagnostics/collect.js";
import { existsSync, readFileSync } from "fs";
import { realpath as fsRealpath, stat as fsStat } from "fs/promises";
import { makeCachedRealpath, resolveArtifactRequestPath } from "./utils/files/safe.js";
import { cpus, loadavg } from "os";
import { isDockerAvailable, ensureSandboxImage } from "./system/docker.js";
import { maybeRunJournal } from "./workspace/journal/index.js";
import { backfillAllSessions } from "./workspace/chat-index/index.js";
import { feedRefreshTaskDef } from "@mulmoclaude/core/feeds/server";
import { googleCalendarSyncTaskDef } from "@mulmoclaude/core/google";
import { configureFeeds } from "./workspace/feeds/configure.js";
import { createPubSub } from "./events/pub-sub/index.js";
import { PUBSUB_CHANNELS } from "../src/config/pubsubChannels.js";
import { createTaskManager } from "./events/task-manager/index.js";
import type { ITaskManager } from "./events/task-manager/index.js";
import { initScheduler, type SystemTaskDef } from "./events/scheduler-adapter.js";
import schedulerTasksRoutes from "./api/routes/schedulerTasks.js";
import { loadSchedulerOverrides, UTC_HH_MM_RE } from "./utils/files/scheduler-overrides-io.js";
import type { IPubSub } from "./events/pub-sub/index.js";
import { connectRelay } from "./events/relay-client.js";
import { requireSameOrigin } from "./api/csrfGuard.js";
import { bearerAuth } from "./api/auth/bearerAuth.js";
import { isViewDataPath } from "./api/auth/viewToken.js";
import { deleteTokenFile, generateAndWriteToken, getCurrentToken } from "./api/auth/token.js";
import { boundPortOf, publishServerPort, setBoundPort } from "./workspace/serverPort.js";
import { log } from "./system/logger/index.js";
import { logBackgroundError } from "./utils/logBackgroundError.js";
import { isNonEmptyString } from "./utils/types.js";
import { collectSessionEntriesNewestFirst } from "./utils/sessionJsonl.js";
import { errorMessage } from "./utils/errors.js";
import { registerScheduledSkills } from "./workspace/skills/scheduler.js";
import { registerUserTasks } from "./workspace/skills/user-tasks.js";
import { API_ROUTES } from "../src/config/apiRoutes.js";
import { EVENT_TYPES } from "../src/types/events.js";
import { SESSION_ORIGINS } from "../src/types/session.js";
import { buildHtmlPreviewCsp } from "../src/utils/html/previewCsp.js";
import { readCspExtraSync, warnIfCspExtended } from "./utils/files/csp-io.js";
import { readAndInjectHtmlArtifact, readAndInjectHtmlFile } from "./utils/html/htmlArtifactSplicer.js";
import { resolveHtmlFileRequestPath } from "@mulmoclaude/core/files";
import { HTML_FILE_MOUNT } from "@mulmoclaude/html-plugin";
import { ONE_SECOND_MS, ONE_MINUTE_MS, ONE_HOUR_MS, STARTUP_FAILURE_FORCE_EXIT_MS, FATAL_LOG_FLUSH_MS } from "./utils/time.js";
import { isPortFree, findAvailablePort, MAX_PORT_PROBES } from "./utils/port.mjs";
import { SCHEDULE_TYPES, MISSED_RUN_POLICIES } from "@receptron/task-scheduler";

const HTML_TOKEN_PLACEHOLDER = "__MULMOCLAUDE_AUTH_TOKEN__";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const debugMode = process.argv.includes("--debug");

// Global crash diagnostics (#1364). These handlers log loudly so a
// fatal failure is triagable, then EXIT — keeping the loop running
// after an uncaught exception is process-unsafe per the Node docs
// (invariants may already be broken). The launcher / supervisor
// (Electron wrapper, systemd, etc.) is responsible for restart.
//
// The canonical failure this PR set out to fix — missing `claude`
// on PATH crashing the server via spawn's `error` event — is now
// caught at the local boundary in `server/agent/backend/claude-code.ts`
// (an explicit `error` listener turns ENOENT into an AgentEvent).
// These handlers are the BACKSTOP for anything we missed, not a
// substitute for local error handling. (Codex review on #1364.)
//
// `process.exit(1)` is non-zero so supervisors that branch on exit
// code treat the bounce as an error condition.
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", errorMessage(err), {
    stack: err instanceof Error ? err.stack : undefined,
  });
  // Tiny grace so the log line flushes to disk before we exit.
  setTimeout(() => process.exit(1), FATAL_LOG_FLUSH_MS);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", errorMessage(reason), {
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  setTimeout(() => process.exit(1), FATAL_LOG_FLUSH_MS);
});

// Test-seam: CI runs without a Claude CLI / API key set the
// MULMOCLAUDE_FAKE_AGENT env var, which swaps in an echo-stub
// backend so the chat flow still completes. Decided once at boot;
// the orchestrator reads the active backend with zero per-call
// overhead. Production callers never trip this branch (no runtime
// import-time cost beyond the small fake-echo module itself).
if (process.env.MULMOCLAUDE_FAKE_AGENT === "1") {
  setActiveBackend(fakeEchoBackend);
  log.info("agent", "MULMOCLAUDE_FAKE_AGENT=1 — active backend = fake-echo");
}

initWorkspace();
warnIfCspExtended();

// Fire-and-forget memory migrations: legacy `memory.md` → atomic
// (#1029), then atomic → topic-format staging (#1070). Chained so
// that a fresh `memory.md` workspace lands in the topic format on
// a SINGLE server start instead of needing two restarts (the topic
// runner used to defer on the first start because legacy was still
// in flight; now it picks up right after legacy completes).
//
// Both runners are idempotent: legacy no-ops when the source file
// is gone, topic no-ops when the workspace already uses the topic
// format or staging is already pending review. The agent can serve
// traffic while the chain runs.
//
// `.then(noop, noop)` keeps the floating-promises rule happy
// without smuggling in a `void` (banned by sonarjs/void-use). Each
// runner logs its own failures; the chain's outer rejection
// handler is therefore a hard backstop only.
//
// CLEANUP 2026-07-01: this whole chain is one-shot migration code
// for #1029 + #1070. After every active workspace has flipped to
// the topic format, delete the chain plus the runners under
// `server/workspace/memory/` (run.ts / migrate.ts /
// llm-classifier.ts / topic-run.ts / topic-migrate.ts /
// topic-cluster.ts / topic-swap.ts) and the
// `scripts/memory-swap-topic-staging.ts` helper. Topic-format
// reading / writing (`topic-types.ts`, `topic-io.ts`,
// `topic-detect.ts`) plus the topic branch in `prompt.ts` stays.
const noop = (): void => {};
runMemoryMigrationOnce(workspacePath)
  .then(() => runTopicMigrationOnce(workspacePath))
  .then(noop, noop);

// Recipe-book plugin → `mc-cooking-coach` skill migration (#1286).
// Boot-time idempotent copy from the plugin's `files.data` scope
// (`data/plugins/<sanitised-pkg>/recipes/`) to the canonical
// `data/cooking/recipes/` path the skill drives. Sentinel-gated so
// every boot after the first is a no-op.
migrateCookingRecipesFromPlugin().catch((err) => {
  log.warn("cooking-recipes", "migration from plugin failed; falling back to original plugin path", {
    error: errorMessage(err),
  });
});

let sandboxEnabled = false;

// --- Photo-EXIF capture hook (#1222 PR-A) ---
// Registered at module load (NOT inside `startRuntimeServices`)
// because uploads can land in the gap between `app.listen` accepting
// connections and the runtime-services bootstrap finishing. The hook
// itself short-circuits on non-image MIME / auto-capture opt-out, so
// registering early is free for non-photo flows. (CodeRabbit review
// on PR #1247.)
registerSaveAttachmentHook(capturePhotoLocation);

const app = express();

app.disable("x-powered-by");
// No `cors()` middleware. The Vite dev proxy forwards `/api/*`
// from :5173 to :3001 server-side, and in production Express
// serves the built client from the same origin, so every
// legitimate request is same-origin and doesn't need CORS
// headers at all. Dropping the middleware means a page at
// `http://evil.example` can still send a request to
// `localhost:3001` but the browser refuses to expose the
// response to the calling script (no
// `Access-Control-Allow-Origin` header). See
// plans/done/fix-server-lockdown-cors-localhost.md for the threat
// model.
app.use(express.json({ limit: "50mb" }));
// CSRF guard: reject state-changing requests that arrive with a
// non-localhost Origin header. Allows missing Origin (server-to-
// server / CLI callers) because the listener is already bound to
// localhost (#148); if that ever changes, tighten this middleware
// too. See plans/done/fix-server-csrf-origin-check.md.
//
// Custom-view data endpoints are exempt: their requests come from a
// sandboxed (opaque-origin) iframe that sends `Origin: null` (which this
// guard rejects), and the unguessable, slug-scoped capability token they
// carry IS the anti-CSRF property an attacker page can't satisfy. They are
// guarded by `requireViewToken` instead. See server/api/auth/viewToken.ts.
app.use((req, res, next) => {
  if (isViewDataPath(req.path)) {
    next();
    return;
  }
  requireSameOrigin(req, res, next);
});

// Bearer token auth: every `/api/*` request must carry
// `Authorization: Bearer <token>` matching the per-startup token.
// Layered *on top of* CSRF guard so we catch both cross-origin
// browser attacks (origin check) and local sibling processes that
// bypass browser CORS (bearer check). See #272 and
// plans/done/feat-bearer-token-auth.md.
//
// /api/files/* is exempt because <img src="/api/files/raw?path=...">
// tags in rendered markdown can't attach Authorization headers.
// /api/plugins/runtime/<pkg>/<version>/<file> (#1043 C-2) is exempt
// for the same reason: the frontend dynamic-imports plugin assets
// (`import("/api/plugins/runtime/<pkg>/<ver>/dist/vue.js")`) and the
// browser cannot attach Authorization headers to those module
// requests. The pattern "4+ segments past /plugins/runtime/" only
// matches asset GETs — `/plugins/runtime/list` (3 segments) and
// `/plugins/runtime/<pkg>/dispatch` (3 segments) still require auth.
// Path traversal is hardened separately by `resolveWithinRoot` in
// the asset route handler.
// The CSRF origin check + loopback-only binding still apply.
const RUNTIME_PLUGIN_ASSET_PATH_RE = /^\/plugins\/runtime\/[^/]+\/[^/]+\//;
// Generic OAuth callback receiver for runtime plugins (#1162). Same
// browser-redirect-can't-carry-Authorization-header reason as the
// asset path above. Trust model: registry-membership (the host's
// route handler 404s an unknown :alias) plus the plugin's single-use
// `state` for CSRF.
const RUNTIME_PLUGIN_OAUTH_CALLBACK_RE = /^\/plugins\/runtime\/oauth-callback\/[^/]+$/;
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/files/")) {
    next();
    return;
  }
  // Custom-view data endpoints carry a scoped capability token, not the
  // global bearer (the sandboxed iframe can't read it). `requireViewToken`
  // guards them instead. See server/api/auth/viewToken.ts.
  if (isViewDataPath(req.path)) {
    next();
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && RUNTIME_PLUGIN_ASSET_PATH_RE.test(req.path)) {
    // HEAD is bypassed for the same reason as GET: the frontend
    // runtime-plugin loader HEAD-probes `dist/vue.js` to distinguish
    // "no Vue bundle (404, server-only plugin)" from real load
    // failures before `import()`-ing the asset (#1273 follow-up).
    // That probe is a raw `fetch`, not the bearer-attaching `apiGet`,
    // and the actual `import()` itself can't attach Authorization
    // either — so the auth-bypass must cover both verbs or every
    // runtime plugin's Vue View silently downgrades to a
    // definition-only entry (401 → "unexpected status" → no view).
    next();
    return;
  }
  if (req.method === "GET" && RUNTIME_PLUGIN_OAUTH_CALLBACK_RE.test(req.path)) {
    next();
    return;
  }
  bearerAuth(req, res, next);
});

// Static mount for the canonical image storage path. Every image
// generated by `saveImage()` (Gemini, canvas, image edit) lives under
// `artifacts/images/YYYY/MM/<id>.png` (#764, see
// server/utils/files/image-store.ts), so an `<img>` referring to that
// shape resolves directly without going through /api/files/raw.
//
// Bearer auth is intentionally skipped (same reason as /api/files/*:
// browser <img> tags can't carry an Authorization header). The
// requireSameOrigin guard above still applies; the listener also
// stays loopback-only.
//
// Three-layer guard:
//  1. Extension allowlist — reject anything that isn't an image,
//     video, or audio extension. `saveImage` currently writes `.png`
//     only, but Stage B (#1011) extends the markdown / wiki rewriter
//     to `<source>` / `<video poster|src>` / `<audio src>`; an LLM
//     placing a `.mp4` poster's source video alongside its image at
//     `artifacts/images/<id>.mp4` (or any user-dropped media file
//     under that dir) needs to round-trip through this mount the
//     same way image refs do — otherwise the rewritten URL hits this
//     mount and 404s before `express.static` gets a chance.
//  2. realpath-based traversal check via `resolveWithinRoot` — same
//     guard `/api/files/raw` uses. Catches symlinks pointing outside
//     the images dir, which `express.static` would otherwise follow.
//  3. `dotfiles: deny` + `fallthrough: false` on `express.static`
//     itself, plus its built-in `..` normalize for path traversal.
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg|mp4|webm|mov|m4v|ogv|mp3|ogg|oga|wav|m4a|aac)$/i;
const getImagesDirReal = makeCachedRealpath(WORKSPACE_PATHS.images);
app.use(
  "/artifacts/images",
  async (req, res, next) => {
    if (!IMAGE_EXT_RE.test(req.path)) {
      res.status(404).end();
      return;
    }
    const root = await getImagesDirReal();
    if (!root) {
      res.status(404).end();
      return;
    }
    // No explicit dotfile check here: this mount never short-circuits,
    // so `express.static`'s `dotfiles: "deny"` below is the authority.
    if (resolveArtifactRequestPath(root, req.path, false) === null) {
      res.status(404).end();
      return;
    }
    next();
  },
  express.static(WORKSPACE_PATHS.images, { dotfiles: "deny", fallthrough: false }),
);

// Static mount for HTML artifacts. The Files-view preview iframe
// switched from `srcdoc` to `src=/artifacts/html/<name>.html` so the
// browser can resolve relative `<img src="../images/...">` paths
// against the file's actual URL — `srcdoc` documents have
// `about:srcdoc` as their base URL, which breaks every relative ref.
// See plans/done/feat-files-html-preview-relative-paths.md.
//
// Allowlist covers `.html` / `.htm` plus common image extensions so
// HTML files that reference sibling images (e.g. a shared logo placed
// alongside a batch of LLM-generated pages) can resolve those refs
// against the file's URL — same browser-equivalent behavior the user
// gets when opening the file directly from disk. Non-image / non-html
// requests are still rejected. CSS / JS are intentionally NOT in the
// list: `'self'` is absent from `script-src` / `style-src` in the CSP
// (`previewCsp.ts`) so allowing those extensions would only delivery-
// vector for blocked resources.
//
// Same three-layer guard as `/artifacts/images`:
//  1. extension allowlist (`.html` / `.htm` plus image types).
//  2. `resolveWithinRoot` symlink-aware traversal check.
//  3. `dotfiles: deny` + `fallthrough: false` on `express.static`.
//
// Bearer auth skipped for the same reason as /artifacts/images and
// /api/files/*: an iframe `src` request can't carry an Authorization
// header. `requireSameOrigin` and the loopback-only listener still
// guard against cross-origin abuse.
//
// CSP delivered via HTTP header instead of injecting a `<meta>` tag —
// keeps the served file pristine. The explicit request origin is
// passed into `buildHtmlPreviewCsp` instead of relying on `'self'`:
// the iframe is `sandbox="allow-scripts"` only, so its document has an
// opaque origin and Safari/WebKit interprets `'self'` against that
// (null) origin, blocking every same-origin `<img src="../images/...">`
// reference. Substituting the absolute origin restores cross-browser
// parity. Sandbox stays `allow-scripts` only, so the iframe document
// still cannot read the parent's cookies / localStorage / DOM.
//
// `HTML_PREVIEW_EXT_RE` widens the allowlist to images, video and
// audio so inline `<img src="...png">` / `<source>` / `<video src>` /
// `<audio src>` references resolve through this same mount (no
// separate /artifacts/images round-trip). The CSP header is only set
// for HTML responses (`HTML_DOCUMENT_EXT_RE`); CSP doesn't apply to
// image / media subresources.
//
// eslint-disable-next-line sonarjs/regex-complexity -- flat extension allowlist with no nested quantifiers, ReDoS-safe; complexity is just the disjunction count
const HTML_PREVIEW_EXT_RE = /\.(html?|png|jpe?g|webp|gif|svg|ico|mp4|webm|mov|m4v|ogv|mp3|ogg|oga|wav|m4a|aac)$/i;
const HTML_DOCUMENT_EXT_RE = /\.html?$/i;
const getHtmlsDirReal = makeCachedRealpath(WORKSPACE_PATHS.htmls);

app.use(
  "/artifacts/html",
  async (req, res, next) => {
    if (!HTML_PREVIEW_EXT_RE.test(req.path)) {
      res.status(404).end();
      return;
    }
    const root = await getHtmlsDirReal();
    if (!root) {
      res.status(404).end();
      return;
    }
    // denyDotfiles: the HTML short-circuit below serves the file itself
    // (bypassing `express.static`'s `dotfiles: "deny"`), so this mount
    // must reject dotfile segments in the guard — without it,
    // `/artifacts/html/.hidden.html` would be served (Codex review on
    // #1056).
    const relPath = resolveArtifactRequestPath(root, req.path, true);
    if (relPath === null) {
      res.status(404).end();
      return;
    }
    if (HTML_DOCUMENT_EXT_RE.test(req.path)) {
      const origin = browserVisibleOrigin(req);
      res.setHeader("Content-Security-Policy", buildHtmlPreviewCsp(origin, undefined, readCspExtraSync()));
      res.setHeader("X-Content-Type-Options", "nosniff");
      const spliced = await readAndInjectHtmlArtifact(root, relPath);
      if (spliced === null) {
        res.status(404).end();
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(spliced);
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  },
  express.static(WORKSPACE_PATHS.htmls, { dotfiles: "deny", fallthrough: false }),
);

// Mount for HTML pages OUTSIDE `artifacts/html/` — presentHtml's `path` form
// accepts any page on disk, so the View's iframe needs a URL for one. The
// `/htmlfile/<scope>/<segments…>` scheme and the reasons it is path-shaped
// rather than `?path=` live in `src/config/htmlFileUrl.ts`; the resolver and
// what it refuses are in `server/utils/files/htmlFileRequest.ts`.
//
// Same guards as `/artifacts/html` — extension allowlist, dotfile refusal,
// realpath + regular-file check, CSP header on documents, `nosniff` — with ONE
// deliberate difference: there is no containment root, because a page the tool
// was pointed at may legitimately live anywhere. The trust boundary is
// therefore entirely the loopback-only listener plus `requireSameOrigin`
// (bearer auth does not apply outside `/api`, and an iframe `src` cannot carry
// an Authorization header anyway).
const getWorkspaceDirReal = makeCachedRealpath(workspacePath);
// A page legitimately pulls a burst of subresources (images, media) through this
// same mount while it renders, so the bucket is roomy — it exists to bound a
// runaway loop hammering the filesystem, not to police normal use. Same limiter
// the collection view routes use.
const HTML_FILE_RATE_LIMIT_PER_MINUTE = 600;
const htmlFileRateLimit = makeViewActionRateLimiter(HTML_FILE_RATE_LIMIT_PER_MINUTE, ONE_MINUTE_MS);
app.use(HTML_FILE_MOUNT, htmlFileRateLimit, async (req, res, next) => {
  if (!HTML_PREVIEW_EXT_RE.test(req.path)) {
    res.status(404).end();
    return;
  }
  const workspaceReal = await getWorkspaceDirReal();
  const absPath = workspaceReal === null ? null : resolveHtmlFileRequestPath(workspaceReal, req.path);
  if (absPath === null) {
    res.status(404).end();
    return;
  }
  // Judge the symlink by what it points at, and refuse anything that is not a
  // regular file (a directory named `page.html` would otherwise 500 the read).
  let realFile: string;
  try {
    realFile = await fsRealpath(absPath);
    if (!(await fsStat(realFile)).isFile()) {
      res.status(404).end();
      return;
    }
  } catch {
    res.status(404).end();
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!HTML_DOCUMENT_EXT_RE.test(req.path)) {
    res.sendFile(realFile, (err) => {
      if (err) next(err);
    });
    return;
  }
  res.setHeader("Content-Security-Policy", buildHtmlPreviewCsp(browserVisibleOrigin(req), undefined, readCspExtraSync()));
  const spliced = await readAndInjectHtmlFile(realFile);
  if (spliced === null) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(spliced);
});

// Static mount for SVG artifacts. SVG files are loaded into the View
// and Preview as `<img src="/artifacts/svg/<name>.svg">`. Browsers
// refuse to execute `<script>` inside an SVG loaded via `<img>`, so
// the `<img>` tag itself is the sandbox for that consumer path.
//
// BUT `/artifacts/svg/<file>.svg` is also a directly addressable URL on
// the SPA's origin (loopback-only, bearer-auth bypassed for `<img src>`
// access), so a user who navigates straight to that URL — or is tricked
// into clicking a markdown link — would otherwise get the SVG rendered
// as a TOP-LEVEL document with full script execution in the app's
// origin (localStorage, /api/* with the user's session, etc.). Since
// the SVG body is LLM-generated and writable via the update route, a
// prompt-injected SVG becomes a stored-XSS vector.
//
// Mitigation: send a strict response CSP. The `sandbox` directive gives
// the response an opaque origin and disables script execution for the
// top-level navigation case; the other directives starve subresource
// loads (block external script/font/connect, only allow `<image>` refs
// to self / data URIs). CSP on a subresource response is mostly
// informational — `<img>` rendering ignores the bytes' CSP — so this
// header doesn't interfere with the normal View / Preview path.
const SVG_RESPONSE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox";

// Strict three-layer guard mirroring the `/artifacts/images` mount:
// extension allowlist, realpath traversal check, dotfiles deny +
// fallthrough false on `express.static`. Bearer auth bypassed for the
// same reason as `/artifacts/images` / `/artifacts/html`: an
// `<img src>` request can't carry an Authorization header. Loopback-
// only listener + `requireSameOrigin` remain the trust boundary.
const SVG_EXT_RE = /\.svg$/i;
const getSvgsDirReal = makeCachedRealpath(WORKSPACE_PATHS.svgs);
app.use(
  "/artifacts/svg",
  async (req, res, next) => {
    if (!SVG_EXT_RE.test(req.path)) {
      res.status(404).end();
      return;
    }
    const root = await getSvgsDirReal();
    if (!root) {
      res.status(404).end();
      return;
    }
    // denyDotfiles for the same reason as the html mount: this handler
    // sets headers and serves via a bearer-bypassed <img> path, so the
    // dotfile guard can't be left solely to `express.static`.
    if (resolveArtifactRequestPath(root, req.path, true) === null) {
      res.status(404).end();
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Content-Security-Policy", SVG_RESPONSE_CSP);
    next();
  },
  express.static(WORKSPACE_PATHS.svgs, { dotfiles: "deny", fallthrough: false }),
);

app.get(API_ROUTES.health, (_req: Request, res: Response) => {
  // `os.loadavg()[0]` is the kernel 1-minute load average. On Linux /
  // macOS it's the primary "is this machine busy" signal; on Windows
  // the array is `[0, 0, 0]` (platform has no equivalent), in which
  // case `load1` stays 0 and the favicon's overloaded rule silently
  // never fires there. `cores` lets the client normalise so a 16-core
  // box at load 8 reads the same intensity as an 8-core box at load 4.
  const [load1] = loadavg();
  const cores = cpus().length;
  res.json({
    status: "OK",
    version: APP_VERSION,
    geminiAvailable: isGeminiAvailable(),
    sandboxEnabled,
    // Local voice input: `capable` (platform + whisper binary) is
    // distinct from `enabled` (user opt-in) and `model.state` (download
    // readiness). The mic button gates on all three. See useHealth.ts.
    voiceInput: getVoiceInputStatus(loadSettings()),
    cpu: { load1, cores },
  });
});

// Sandbox credential-forwarding state (#329). Returns `{}` when the
// sandbox is disabled — the popup already renders a distinct
// "No sandbox" branch in that case and extra fields would be noise.
// When enabled, returns `{ sshAgent, mounts }`; full debug detail
// (host paths, skip reasons, unknown names) stays in the server log.
app.get(API_ROUTES.sandbox, (_req: Request, res: Response) => {
  const status = buildSandboxStatus({
    sandboxEnabled,
    sshAgentForward: env.sandboxSshAgentForward,
    configMountNames: env.sandboxMountConfigs,
    sshAuthSock: process.env.SSH_AUTH_SOCK,
  });
  res.json(status ?? {});
});

// Environment report for a bug report (#2571). Lives inline next to
// `/api/sandbox` for the same reason: it needs the boot-time `sandboxEnabled`,
// which isn't exported. The redaction decisions are in
// `server/utils/diagnostics/report.ts` — deliberately in code rather than in a
// prompt, because `googleMapsApiKey` is stored in plaintext and `mcp.json`
// carries provider tokens, and a prose instruction to the agent can't be tested.
app.get(API_ROUTES.diagnosticsReport, (_req: Request, res: Response) => {
  try {
    res.type("text/markdown; charset=utf-8").send(buildDiagnosticsMarkdown({ sandboxEnabled, workspacePath }));
  } catch (err) {
    // Generic reply on purpose: this endpoint's whole job is withholding local
    // detail, and `errorMessage(err)` on a config parse failure would hand back
    // the very paths and values the success path redacts. Detail stays in the log.
    log.warn("diagnostics", "report build failed", { error: errorMessage(err) });
    serverError(res, "Failed to build the diagnostics report");
  }
});

// Routers register FULL `/api/...` paths internally (see
// `src/config/apiRoutes.ts`), so they mount at root. The previous
// `app.use("/api", ...)` prefix was dropped when #289 part 1 moved
// the `/api` literal into each `router.post(API_ROUTES.…)` call.
app.use(agentRoutes);
// Configure the accounting backend's host seams (workspace root +
// logger) at module load — BEFORE app.listen — so a request landing in
// the gap before startRuntimeServices runs can't hit an unconfigured
// defaultWorkspaceRoot() and 500. Same rationale as the module-load
// route registration noted above. (Pub/sub init stays in
// startRuntimeServices, where the pubsub instance is created; a missed
// fire-and-forget event in the boot window is the same accepted
// tradeoff as the file-change / collection publishers.)
configureAccountingServer({ workspaceRoot: workspacePath, logger: log });
// Wire @mulmoclaude/core/feeds/server (workspace, logger, atomic writer, and the
// agent-ingest worker launcher) at module load — BEFORE app.listen — for the same
// reason as the accounting config above: a `POST /api/collections/:slug/refresh`
// landing in the gap before startRuntimeServices runs must not hit an unconfigured
// feeds host. `spawnSystemWorker` is injected here because workspace code must not
// import the routes layer.
configureFeeds(spawnSystemWorker);
app.use(createAccountingRouter());
app.use(photoLocationsRoutes);
app.use(schedulerRoutes);
app.use(sessionsRoutes);
app.use(chatIndexRoutes);
app.use(feedsRoutes);
app.use(pluginsRoutes);
app.use(imageRoutes);
app.use(attachmentRoutes);
app.use(transcribeRoutes);
app.use(presentHtmlRoutes);
app.use(shareRoutes);
app.use(remoteHostRoutes);
app.use(googleRoutes);
app.use(presentSvgRoutes);
app.use(chartRoutes);
app.use(rolesRoutes);
app.use(shortcutsRoutes);
app.use(dashboardRoutes);
app.use(mulmoScriptRoutes);
app.use(wikiRoutes);
// Mounted under /api/wiki so the inner router's relative paths
// (`/pages/:slug/history`, `/internal/snapshot`) line up with the
// API_ROUTES.wiki.* constants.
app.use("/api/wiki", wikiHistoryRoutes);
app.use(pdfRoutes);
app.use(marpThemesRoutes);
app.use(filesRoutes);
app.use(configRoutes);
app.use(configRefreshRoutes);
app.use(hookLogRoutes);
app.use(mcpBrokerReadyRoutes);
app.use(skillsRoutes);
app.use(collectionsRoutes);
app.use(collectionsRegistryRoutes);
app.use(runtimePluginRoutes);
async function listSessionsForBridge(opts: { limit: number; offset: number }) {
  const rows = await loadAllSessions();
  const sorted = rows.sort((leftSession, rightSession) => rightSession.changeMs - leftSession.changeMs);
  const total = sorted.length;
  const sessions = sorted.slice(opts.offset, opts.offset + opts.limit).map((row) => ({
    id: row.summary.id,
    roleId: row.summary.roleId,
    preview: row.summary.preview,
    updatedAt: row.summary.updatedAt,
  }));
  return { sessions, total };
}
// See `resolveBridgeSessionRole` for the safe-id shape check + IO-error
// degradation contract (extracted for direct unit testing under
// test/server/api/bridge/test_sessionRole.ts; codex review on #1895).
async function getSessionRoleForBridge(sessionId: string): Promise<string | null> {
  return resolveBridgeSessionRole(sessionId, readSessionMeta);
}
async function getSessionHistoryForBridge(sessionId: string, opts: { limit: number; offset: number }) {
  const content = await readSessionJsonl(sessionId);
  if (!content) return { messages: [], total: 0 };
  const allMessages = collectSessionEntriesNewestFirst(content, (entry) =>
    entry.type === EVENT_TYPES.text && typeof entry.message === "string"
      ? { source: isNonEmptyString(entry.source) ? entry.source : "unknown", text: entry.message }
      : undefined,
  );
  const total = allMessages.length;
  const messages = allMessages.slice(opts.offset, opts.offset + opts.limit);
  return { messages, total };
}
// Allowlist used by the bridge command handler: a slash command
// from a bridge (e.g. `/release-app` from Telegram) is forwarded to
// the agent only if it names a discoverable skill under
// ~/.claude/skills/ or <workspace>/.claude/skills/. The same list
// drives the "Skills:" section in the bridge `/help` reply, so the
// command handler calls this once per turn (membership check + help
// rendering share the result). fs is hit on every help/unknown
// bridge slash, which is fine because bridge slashes are infrequent
// and the workspace skill directory is small. Stays fresh against
// skill add/remove without any cache invalidation.
async function listRegisteredSkills(): Promise<{ name: string; description: string }[]> {
  const skills = await discoverSkills({ workspaceRoot: workspacePath });
  return skills.map((skill) => ({ name: skill.name, description: skill.description }));
}

const chatService = createChatService({
  startChat,
  onSessionEvent,
  loadAllRoles,
  getRole,
  defaultRoleId: DEFAULT_ROLE_ID,
  transportsDir: WORKSPACE_PATHS.transports,
  logger: log,
  // Socket.io handshake (see #268 Phase A) needs to validate the
  // same bearer token the HTTP middleware enforces.
  tokenProvider: getCurrentToken,
  listSessions: listSessionsForBridge,
  getSessionHistory: getSessionHistoryForBridge,
  getSessionRole: getSessionRoleForBridge,
  listRegisteredSkills,
});
app.use(chatService.router);

// Notifications router. The route file needs the pub-sub publisher
// (only created inside `startRuntimeServices` after `app.listen`) and
// the chat-service push handle (available at module scope). We mount
// the router now so it sits behind the same bearer middleware as
// every other /api route, and back-fill the pub-sub dep once
// `startRuntimeServices` has it. Calls that arrive before fill-in
// (impossible in practice — the HTTP server isn't listening yet)
// would no-op on publish but still queue the bridge push.
app.use(notifierRoutes);
app.use(createJournalRouter());
app.use(createTranslationRouter());
app.use(mcpToolsRouter);
app.use(schedulerTasksRoutes);
app.use(createShutdownRouter());

if (env.isProduction) {
  // `{ index: false }` so express.static doesn't intercept `GET /`
  // with the built index.html. We need our own handler that reads
  // the file and substitutes the bearer token placeholder on each
  // request — see the wildcard fallback below.
  //
  // Default `<__dirname>/../client/` is the layout
  // `packages/mulmoclaude/bin/prepare-dist.js` produces when packaging
  // the tarball. Fresh-user smoke specs spawn `tsx server/index.ts`
  // straight from source (no prepare-dist copy step) and override via
  // `MULMOCLAUDE_CLIENT_DIR=<repo-root>/dist/client/`. Empty string
  // env falls back to the default via `||` (empty is falsy).
  const clientDir = resolveClientDir(process.env.MULMOCLAUDE_CLIENT_DIR, path.join(__dirname, "../client"));
  app.use(express.static(clientDir, { index: false }));
  const indexHtmlPath = path.join(clientDir, "index.html");
  app.get("/{*splat}", (_req: Request, res: Response) => {
    let html: string;
    try {
      html = readFileSync(indexHtmlPath, "utf-8");
    } catch (err) {
      log.error("server", "failed to read index.html", { error: String(err) });
      serverError(res, "Internal Server Error");
      return;
    }
    const token = getCurrentToken() ?? "";
    html = html.replace(HTML_TOKEN_PLACEHOLDER, token);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });
}

app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  log.error("express", "unhandled error", {
    error: err.message,
    stack: err.stack,
  });
  // A partially-sent response can't take a status line. Without this guard
  // `serverError` throws ERR_HTTP_HEADERS_SENT from inside the error handler:
  // the socket still ends up destroyed (Express catches the secondary throw
  // and falls through to finalhandler), but the logs then show the real error
  // followed by a misleading second crash. Delegating instead reaches the same
  // destroy via the intended path, logging only what actually happened.
  //
  // Reachable since asyncHandler started forwarding `next(err)` on the
  // headersSent path (#2593) — before that, nothing routed a mid-response
  // failure here.
  if (res.headersSent) {
    next(err);
    return;
  }
  serverError(res, "Internal Server Error");
});

// True iff the user set `PORT` explicitly; empty string counts as "not
// set". We use this to decide between "walk forward when busy" (friendly
// dev behaviour) and "fail loudly" (respect the user's choice).
const portExplicit = typeof process.env.PORT === "string" && process.env.PORT.trim() !== "";

// Resolve the port we'll actually bind to. Default PORT (3001) + busy
// walks forward so a stale `yarn dev` or a parallel test run doesn't
// crash the launch. Explicit PORT + busy exits — matches the launcher's
// `--port` semantics so `PORT=3099 yarn dev` behaves the same as
// `npx mulmoclaude --port 3099`.
async function resolvePort(): Promise<number> {
  const requested = env.port;
  if (await isPortFree(requested)) return requested;
  if (portExplicit) {
    log.error("server", `Port ${requested} is already in use. Stop the other process or pick a different PORT.`);
    process.exit(1);
  }
  const fallback = await findAvailablePort(requested + 1);
  if (fallback === null) {
    log.error("server", `Port ${requested} is in use and no free port found in ${requested}..${requested + MAX_PORT_PROBES - 1}.`);
    process.exit(1);
  }
  // Info, not warn: the dev client FOLLOWS this now (#2981). `yarn dev` waits for
  // the port published below before starting Vite, and Vite reads it, so the
  // proxy lands here rather than on the port that was asked for. It stayed a
  // warning for as long as it did not — a second `yarn dev` without `PORT` used
  // to render the FIRST instance's data with nothing failing (#2650).
  //
  // Still worth saying out loud: two instances sharing a workspace overwrite each
  // other's `.session-token`, so `PORT` remains the right way to run a second one.
  log.info(
    "server",
    `Port ${requested} busy → using ${fallback} instead. The dev client follows this port; set PORT to run a second instance against its own workspace.`,
  );
  return fallback;
}

async function ensureCredentialsAvailable(): Promise<void> {
  const credentialsPath = claudeCredentialsPath();
  if (existsSync(credentialsPath)) return;

  if (process.platform === "darwin") {
    const { refreshCredentials } = await import("./system/credentials.js");
    const refreshSucceeded = await refreshCredentials();
    if (refreshSucceeded) return;
    log.error("sandbox", "Failed to export credentials from macOS Keychain. Run `npm run sandbox:login` manually.");
    process.exit(1);
  }
  log.error("sandbox", "Missing credentials file at ~/.claude/.credentials.json. Run `claude auth login` to authenticate Claude Code.");
  process.exit(1);
}

async function setupSandbox(): Promise<boolean> {
  if (env.disableSandbox) {
    log.info("sandbox", "DISABLE_SANDBOX=1 — running unrestricted (debug mode)");
    return false;
  }
  try {
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      log.info("sandbox", "Docker not found — claude will run unrestricted");
      return false;
    }
    await ensureCredentialsAvailable();
    log.info("sandbox", "Docker available — building sandbox image if needed");
    await ensureSandboxImage();
    log.info("sandbox", "Sandbox ready");
    return true;
  } catch (err) {
    log.error("sandbox", "Failed to set up sandbox, running unrestricted", {
      error: String(err),
    });
    return false;
  }
}

function logMcpStatus(): void {
  const enabledMcpTools = mcpTools.filter(isMcpToolEnabled);
  const disabledMcpTools = mcpTools.filter((toolDef) => !isMcpToolEnabled(toolDef));
  if (enabledMcpTools.length > 0) {
    log.info("mcp", "Available", {
      tools: enabledMcpTools.map((toolDef) => toolDef.definition.name).join(", "),
    });
  }
  if (disabledMcpTools.length > 0) {
    const names = disabledMcpTools.map((toolDef) => `${toolDef.definition.name} (${(toolDef.requiredEnv ?? []).join(", ")})`).join(", ");
    log.info("mcp", "Unavailable (missing env)", { tools: names });
  }
  logExternalMcpPreflight();
}

// External MCP servers (the `mcp.json` ones — Notion / GitHub /…)
// get a separate preflight pass that mirrors the built-in
// `Available / Unavailable` summary above. Servers with catalog
// entries whose `required: true` fields are unset are excluded from
// the config handed to Claude Code (filtered inside
// `prepareUserServers`); this boot-time log gives the operator one
// clear startup signal (#1352).
function logExternalMcpPreflight(): void {
  try {
    const userMcpRaw = loadMcpConfig().mcpServers;
    const preflight = preflightUserServers(userMcpRaw);
    logPreflightResult(preflight, "boot");
  } catch (err) {
    // Best-effort: a broken mcp.json shouldn't take down boot. The
    // per-agent-run path will still attempt the preflight and surface
    // any genuine issue when the user actually starts a chat.
    log.warn("mcp", "preflight at boot failed; will retry per-agent-run", {
      error: errorMessage(err),
    });
  }
}

function maybeForceJournalRun(): void {
  // Debug switch: set JOURNAL_FORCE_RUN_ON_STARTUP=1 to run a full
  // journal pass immediately without waiting for a session end or
  // the hourly interval. Fire-and-forget — journal errors never
  // propagate out of maybeRunJournal.
  if (!env.journalForceRunOnStartup) return;
  log.info("journal", "JOURNAL_FORCE_RUN_ON_STARTUP=1 — running now");
  maybeRunJournal({ force: true }).catch(logBackgroundError("journal", "forced startup run failed"));
}

function maybeForceChatIndexBackfill(): void {
  // Companion switch for the chat indexer: force-rebuild every
  // session's title summary on startup. Useful the first time the
  // feature is rolled out over an existing workspace, or when
  // debugging the indexer itself.
  if (!env.chatIndexForceRunOnStartup) return;
  log.info("chat-index", "CHAT_INDEX_FORCE_RUN_ON_STARTUP=1 — running now");
  // The startup switch is opt-in and its whole point is "regenerate
  // every summary now"; pass `force: true` so it doesn't silently
  // become a no-op after #1929's content-changed gate lands.
  backfillAllSessions({ force: true })
    .then((result) => {
      log.info("chat-index", "startup backfill complete", {
        indexed: result.indexed,
        total: result.total,
        skipped: result.skipped,
      });
    })
    .catch(logBackgroundError("chat-index", "forced startup backfill failed"));
}

async function initBootDiagnostics(): Promise<void> {
  // --- Plugin META aggregator diagnostics ---
  // After the notifier engine is initialized so the wrapper has a
  // working sink. Surfaces any host/plugin or plugin/plugin key
  // collision detected at module load via log.warn + a system
  // notification.
  await announcePluginMetaDiagnostics();

  // --- Shell-shadows-`.env` diagnostic (#2604, #2610) ---
  // Two `.env` files can lose to the shell: the user's launch dir, which
  // the launcher reports, and this process's own cwd, which `yarn dev`
  // lands in. Without this the user sees no reason why editing `.env`
  // changes nothing.
  await announceShadowedEnv(process.env[SHADOWED_ENV_KEYS_VAR], shadowedByServerLoad());

  // One settings read shared by the dep announce (gates the whisper warning on
  // voice-input opt-in) and the sidecar warm-up below.
  const bootSettings = loadSettings();

  // --- Optional host-dependency probe (#1385) ---
  // Probes docker / ffmpeg / … once, warns (log + bell) for any
  // missing one so a feature degrading is visible instead of a
  // later opaque crash. Never throws.
  await announceOptionalDeps(bootSettings);

  // --- Gemini key presence (#2081) ---
  announceGeminiKey();

  // --- Voice input sidecar warm-up ---
  // If local voice input is enabled and its model is already on disk,
  // pre-spawn the whisper-server sidecar now (deps were just probed) so
  // the user's first dictation doesn't pay the ~10s+ model-load cost
  // inside the request. No-op when voice input is off / not ready.
  warmupVoiceInput(bootSettings);

  // --- Billing-suite migration ---
  // The invoicing collections moved from bundled `mc-*` presets to
  // help-file recipes. Remove any lingering starred `mc-*` billing
  // skill from `.claude/skills/` (records preserved) and fire a
  // one-time bell. No-op once the dirs are gone. Never throws.
  migrateLegacyBillingPresets();

  // --- Collection completion watchers ---
  // Mount `fs.watch` over every discovered collection's dataDir so
  // schemas with `completionField` fire / clear bell notifications
  // regardless of whether the record was written via REST or directly
  // through the agent's Write tool. Runs a boot reconcile + sweep
  // first to catch up changes that landed while the server was down.
  // Errors are logged inside; fire-and-forget so a slow scan doesn't
  // hold up the rest of boot.
  if (isAblated("reconciler")) {
    log.warn("collections", "ABLATION ACTIVE: reconciler disabled — no watchers, bells, or spawn recurrence (evaluation only)");
  } else {
    startCollectionWatchers().catch((err: unknown) => {
      log.warn("collections", "watcher boot failed", { error: String(err) });
    });
  }
}

function attachTransports(httpServer: ReturnType<typeof app.listen>, pubsub: IPubSub): void {
  // --- Chat socket transport (Phase A of #268) ---
  chatService.attachSocket(httpServer);

  // --- Relay WebSocket client ---
  if (env.relayUrl && env.relayToken) {
    connectRelay({
      relayUrl: env.relayUrl,
      relayToken: env.relayToken,
      relay: chatService.relay,
      logger: log,
    });
  }

  // --- Session Store ---
  initSessionStore(pubsub);
}

// --- Runtime plugins (#1043 C-2 + #1110) ---
// Two sources of plugins, same RuntimePlugin shape:
//   1. Presets — server/plugins/preset-list.ts (loaded from node_modules)
//   2. User-installed — ~/mulmoclaude/plugins/plugins.json ledger
//
// Presets are merged FIRST so they win runtime-vs-runtime collision
// (first-loaded wins; static MCP built-ins still win over both via
// MCP_PLUGIN_NAMES).
//
// Factory-shape plugins (`export default definePlugin(...)`) receive a
// runtime constructed by `makePluginRuntime(...)` which closes over the
// live pubsub. Legacy `(context, args)` plugins are loaded unchanged.
//
// Failures don't abort boot — bad plugins are skipped, healthy ones
// still load.
async function loadRuntimePluginsFor(pubsub: IPubSub, taskManager: ITaskManager): Promise<void> {
  try {
    const runtimeFactory = (pkgName: string) =>
      makePluginRuntime({
        pkgName,
        pubsub,
        // v1: server-side locale is a static snapshot. The frontend
        // BrowserPluginRuntime carries the reactive ref. Future
        // enhancement: per-request locale from Accept-Language.
        locale: process.env.LANG?.split(/[._]/)[0] || "en",
        // `taskManager` is created synchronously below (see "Task
        // Manager" block) before this async IIFE awaits and yields.
        // By the time `runtimeFactory(pkgName)` is invoked from
        // inside `loadPresetPlugins` / `loadRuntimePlugins` /
        // `loadDevPlugins`, the synchronous initialisation has
        // completed and `taskManager` is ready. Backs
        // `runtime.tasks.register()` (Phase 1 of the Encore plan).
        taskManager,
      });
    const [presets, userInstalled, devLoad] = await Promise.all([
      loadPresetPlugins({ runtimeFactory }),
      loadRuntimePlugins({ runtimeFactory }),
      loadDevPlugins(parseDevPluginsEnv(process.env.MULMOCLAUDE_DEV_PLUGINS, process.cwd()), { runtimeFactory }),
    ]);
    // Dev plugin failures (missing dist/index.js, broken package.json,
    // …) are a setup error the dev needs to see and fix. Hard-exit
    // so the developer can't accidentally trial-and-error against a
    // server that silently dropped their plugin. Same policy for
    // collisions per #1159 PR2 spec.
    const devGate = evaluateDevPluginGate(devLoad, [...presets, ...userInstalled]);
    if (!devGate.ok) {
      for (const message of devGate.fatalMessages) log.error("plugins/dev", message);
      process.exit(1);
    }
    // Auto-reload (#1159 PR3): watch each dev plugin's dist/ and
    // publish on debounced change so the browser refreshes without
    // ⌘R. Server-side `dist/index.js` cannot be hot-replaced (Node
    // ESM cache), so the watcher logs an explicit hint when that
    // file is in the changed set.
    if (devLoad.plugins.length > 0) {
      const handle = watchDevPlugins(devLoad.plugins, {
        publish: (name, payload) =>
          pubsub.publish(PUBSUB_CHANNELS.devPluginChanged, {
            name,
            changedFiles: payload.changedFiles,
            serverSideChange: payload.serverSideChange,
          }),
        warnServerSideChange: (name) => log.warn("plugins/dev", `${name}: dist/index.js changed — restart mulmoclaude to pick up server-side changes`),
        onWatcherError: (name, error) =>
          log.warn("plugins/dev", `${name}: watcher error — auto-reload disabled for this plugin until restart`, { error: String(error) }),
      });
      registerShutdownHook(() => handle.close());
    }
    // Pass the full static-tool set (MCP plugins + ENABLED MCP tools
    // like readXPost / searchX) as the collision policy so the floor
    // matches the standalone mcp-server's STATIC_TOOL_NAMES exactly
    // (#1077 / #1116 review). Filter via `isMcpToolEnabled` so the
    // child process's `mcpToolDefs` (only enabled tools) and the
    // parent's reservation set agree — otherwise a runtime plugin
    // colliding with a disabled tool would be rejected here but
    // accepted by the child, and the child's `/dispatch` would 404
    // because the parent never registered a route for it.
    const staticToolNames = new Set([...MCP_PLUGIN_NAMES, ...mcpTools.filter(isMcpToolEnabled).map((tool) => tool.definition.name)]);
    const result = registerRuntimePlugins(staticToolNames, [...presets, ...userInstalled, ...devLoad.plugins]);
    log.info("plugins/runtime", "registered runtime plugins", {
      presets: presets.length,
      userInstalled: userInstalled.length,
      dev: devLoad.plugins.length,
      registered: result.registered.length,
      collisions: result.collisions.length,
      oauthAliasCollisions: result.oauthAliasCollisions.length,
    });
  } catch (err) {
    log.error("plugins/runtime", "registry init failed; runtime plugins disabled this session", { error: String(err) });
  }
}

function initEventPublishers(pubsub: IPubSub): void {
  // --- File-change publisher ---
  // Wired here (not at first publish) so the very first save after
  // boot already sees a live publisher.
  initFileChangePublisher(pubsub);
  // Accounting DI (workspace root + logger) is configured at module load
  // near the route mount; only the pub/sub instance is wired here.
  initAccountingEventPublisher(pubsub);
  initCollectionChangePublisher(pubsub);
  // Shared (firestore-backed) collections are NOT bound here, deliberately.
  //
  // They live in a project repository, one app.json per repo (the shareable
  // collection design's D5). This host is a single managed workspace holding
  // unrelated collections side by side, so one roster would govern all of
  // them — "the person you shared the client list with can read the blood
  // test results". MulmoTerminal, whose roots ARE project repositories, is
  // the host for them; it declares `sharedCollections: true` in its own host
  // binding and wires its own accessor.
  //
  // Nothing else is needed to keep them out: without a declared capability the
  // engine refuses a firestore-storage schema at the acceptance gate, with a
  // reason rather than a silent skip.
  initPhotoLocationsChangePublisher(pubsub);
  // MulmoScript generation events → plugin pubsub channel (the extracted
  // presentMulmoScript View's spinner/reload signal).
  initMulmoScriptGenerationPublisher(pubsub);
}

// System task defs + user-configurable schedule overrides. Split out
// of `registerSystemSchedules` so each stays under the max-lines cap.
function buildSystemTaskDefs(): SystemTaskDef[] {
  // --- Scheduler (Phase 1 of #357) ---
  // Register system tasks with persistence + catch-up. The journal
  // and chat-index also fire from the agent finally-hook for
  // responsiveness; the scheduler ensures catch-up after gaps.
  const systemTasks: SystemTaskDef[] = [
    {
      id: "system:journal",
      name: "Journal daily pass",
      description: "Summarize recent chat sessions into daily + topic files",
      schedule: { type: SCHEDULE_TYPES.interval, intervalMs: ONE_HOUR_MS },
      missedRunPolicy: MISSED_RUN_POLICIES.runOnce,
      run: () => maybeRunJournal({}),
    },
    {
      id: "system:chat-index",
      name: "Chat index backfill",
      description: "Generate AI titles + summaries for un-indexed sessions",
      // Every 6 hours. The primary trigger is the agent finally-hook
      // (per-turn, 15-min throttle), so the scheduler exists only to
      // catch strays: a turn skipped by isFresh whose session then
      // went idle, an out-of-band jsonl edit, or a mid-turn server
      // crash. Since #1929 the per-tick work is O(stat + entry read)
      // for unchanged sessions — cheap — but there's still no UX
      // reason to run it more often than every few hours, and less
      // frequent runs match a user's expectation of "quiet
      // background maintenance".
      schedule: { type: SCHEDULE_TYPES.interval, intervalMs: 6 * ONE_HOUR_MS },
      missedRunPolicy: MISSED_RUN_POLICIES.runOnce,
      run: () => backfillAllSessions().then(() => {}),
    },
    // Drives ALL scheduled ingest: declarative feeds (RSS / JSON) AND
    // skill-backed `ingest.kind: "agent"` collections (dispatch a hidden
    // worker). Shared with standalone MulmoTerminal/MulmoBooks via the core
    // factory so the id/schedule/run can't drift across hosts. The override
    // loop below still mutates `task.schedule` host-side.
    feedRefreshTaskDef(),
    googleCalendarSyncTaskDef(),
  ];

  // Apply user-configurable schedule overrides from
  // config/scheduler/overrides.json. Missing file or unknown keys
  // are silently ignored — the hardcoded defaults above remain.
  const overrides = loadSchedulerOverrides();
  for (const task of systemTasks) {
    const override = overrides[task.id];
    if (!override) continue;
    if (task.schedule.type === SCHEDULE_TYPES.interval && typeof override.intervalMs === "number" && override.intervalMs > 0) {
      log.info("scheduler", "applying override", {
        id: task.id,
        intervalMs: override.intervalMs,
      });
      task.schedule = {
        type: SCHEDULE_TYPES.interval,
        intervalMs: override.intervalMs,
      };
    }
    if (task.schedule.type === SCHEDULE_TYPES.daily && typeof override.time === "string" && UTC_HH_MM_RE.test(override.time)) {
      log.info("scheduler", "applying override", {
        id: task.id,
        time: override.time,
      });
      task.schedule = { type: SCHEDULE_TYPES.daily, time: override.time };
    }
  }

  return systemTasks;
}

function registerSystemSchedules(taskManager: ITaskManager): void {
  const systemTasks = buildSystemTaskDefs();

  // Feeds host is configured at module load (before app.listen) — see the
  // `configureFeeds(spawnSystemWorker)` call beside the accounting config — so it
  // is already wired by the time `initScheduler` catch-up can fire a feed refresh.
  initScheduler(taskManager, systemTasks).catch((err) => {
    log.error("scheduler", "init failed (non-fatal)", {
      error: String(err),
    });
  });

  // Register skills with schedule: frontmatter as scheduled tasks.
  // Fire-and-forget — skill scan errors are logged but don't block
  // server startup.
  registerScheduledSkills({
    taskManager,
    workspaceRoot: workspacePath,
    startChat,
  })
    .then((count) => {
      if (count > 0) {
        log.info("skills", "scheduled skills registered", { count });
      }
    })
    .catch(logBackgroundError("skills", "failed to register scheduled skills"));

  // Register user-created scheduled tasks from tasks.json.
  registerUserTasks({ taskManager, startChat })
    .then((count) => {
      if (count > 0) {
        log.info("user-tasks", "user tasks registered", { count });
      }
    })
    .catch(logBackgroundError("user-tasks", "failed to register user tasks"));
}

async function startRuntimeServices(httpServer: ReturnType<typeof app.listen>, port: number, pubsub: IPubSub): Promise<void> {
  log.info("server", "listening", { port });

  // The notifier engine + its pubsub are now wired in the listen
  // callback (see PR-#1196 follow-up) so requests arriving before
  // this function runs hit a fully-initialized engine. The pubsub
  // is forwarded in here so the rest of `startRuntimeServices` can
  // share the same instance.

  // macOS Reminder adapter wiring lives in the `app.listen` callback,
  // alongside `initNotifier`, so it's subscribed before the first
  // await opens a publish-can-fire-but-no-one's-listening window.

  await initBootDiagnostics();

  attachTransports(httpServer, pubsub);

  // --- Task Manager ---
  // Created BEFORE the runtime plugins block so plugin runtimes
  // (which receive `taskManager` via `MakePluginRuntimeDeps`) can
  // close over it. The `void (async () => ...)()` IIFE below would
  // also work via async-yield ordering, but the lint rule forbids
  // closing over a variable declared later in the same scope.
  const taskManager = createTaskManager({
    tickMs: debugMode ? ONE_SECOND_MS : ONE_MINUTE_MS,
  });

  if (debugMode) {
    registerDebugTasks(taskManager, pubsub);
  }

  void loadRuntimePluginsFor(pubsub, taskManager);

  initEventPublishers(pubsub);

  registerSystemSchedules(taskManager);

  taskManager.start();

  maybeForceJournalRun();
  maybeForceChatIndexBackfill();
}

// Graceful shutdown: best-effort cleanup of the auth token file so
// other readers (Vite plugin, future bridges) don't latch onto a
// dead token. Crashes that skip this are harmless — see
// plans/done/feat-bearer-token-auth.md; the next startup overwrites and
// the stale file's token no longer matches the live in-memory one.
const shutdownHooks: (() => void)[] = [stopWhisperSidecar];
function registerShutdownHook(hook: () => void): void {
  shutdownHooks.push(hook);
}
let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info("server", "shutting down", { signal });
  for (const hook of shutdownHooks) {
    try {
      hook();
    } catch (err) {
      log.warn("server", "shutdown hook threw", { error: String(err) });
    }
  }
  await deleteTokenFile();
  process.exit(0);
}
process.on("SIGINT", () => {
  gracefulShutdown("SIGINT").catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch(() => process.exit(1));
});

(async () => {
  const port = await resolvePort();

  // Generate the bearer token before `app.listen` so the first
  // request cannot race an uninitialised `getCurrentToken()`. The
  // middleware defensively handles the null case anyway (401).
  // `env.authTokenOverride` (#316) pins the token across restarts
  // when set; otherwise a fresh random one is written.
  await generateAndWriteToken(undefined, env.authTokenOverride);
  log.info("auth", "bearer token written", {
    path: WORKSPACE_PATHS.sessionToken,
    source: env.authTokenOverride ? "env" : "random",
  });

  sandboxEnabled = await setupSandbox();
  logMcpStatus();

  // Unified PostToolUse dispatcher (#763 PR 2, #1283, #1295). One
  // entry in `<workspace>/.claude/settings.json` that fans out to:
  //   - wiki-snapshot (page Writes → snapshot pipeline)
  //   - config-refresh (SKILL.md / scheduler tasks.json / data/skills/*.md → POST /api/config/refresh)
  //   - skill-bridge (data/skills/*.md ↔ .claude/skills/<slug>/SKILL.md)
  //
  // Done BEFORE the agent ever spawns a claude CLI subprocess so the
  // hook is in place from the first turn. The provisioner also strips
  // pre-unification entries (wikiHistory / configRefresh owner markers)
  // so existing workspaces upgrade cleanly without double-firing.
  await provisionDispatcherHook().catch((err) => {
    log.warn("hooks", "dispatcher provisioning failed; PostToolUse side-effects (snapshots, refresh, skill bridge) will not run this session", {
      error: String(err),
    });
  });

  // Runtime plugin loading moved into `startRuntimeServices` (#1110)
  // so factory-shape plugins (`export default definePlugin(...)`) can
  // receive a runtime that closes over the live pubsub instance.
  // Legacy `(context, args)` shape unaffected. The collision-set fix
  // from #1116 (use enabled-MCP-tools + plugin names, not just MCP
  // plugin names) is applied at the new location, line ~735 above.

  // Bind to localhost-only. Using `0.0.0.0` would expose the dev
  // server to the entire LAN (anyone on the same Wi-Fi could reach
  // `http://<laptop-ip>:3001/api/*`), which combined with the
  // workspace file API is a credential-theft risk. Personal dev
  // tool — localhost is the right default.
  // Express discards whatever the listen callback returns, so an async callback
  // would leave a throw in it as an unhandled rejection. The callback below
  // stays synchronous and hands the async setup off here. The server arrives as
  // a parameter rather than a closure variable — `httpServer` is this call's
  // own result and isn't defined yet at this point.
  const onListening = async (httpServer: ReturnType<typeof app.listen>): Promise<void> => {
    // Initialize the notifier engine synchronously, before any await
    // in this callback. The HTTP listener is already accepting
    // connections by the time this callback fires, so any awaited
    // I/O below (e.g. the `.server-port` write) opens a window where
    // `/api/notifier` requests would race against the engine's
    // `deps`-still-null state and silently drop the pub/sub event
    // (CodeRabbit review on PR #1196). Both `createPubSub` and
    // `initNotifier` are sync, so wiring them up here costs nothing
    // and closes the window.
    const earlyPubsub = createPubSub(httpServer);
    initNotifier({
      publish: (channel, payload) => earlyPubsub.publish(channel, payload),
    });
    // Subscribe the macOS Reminder side-channel BEFORE the first
    // await below — `initNotifier` opens the engine to publishes,
    // and any boot-time diagnostic that lands during the
    // `.server-port` write / `startRuntimeServices` setup would
    // otherwise miss the Reminder fan-out (CodeRabbit review on
    // PR #1358). The adapter is sync + no-op outside darwin, so
    // wiring it here costs nothing.
    startMacosReminderAdapter();

    // Publish the actually-bound port — the requested PORT may have
    // walked forward off a busy default, and `PORT=0` never named one
    // at all. Taken from the listener rather than the request for that
    // second reason. The hook script addresses us through this, and
    // `yarn dev` points Vite's proxy at it, so it has concurrent
    // readers and the write has to be atomic (see `publishServerPort`).
    // What the listener actually got — `port` is only the request, and under
    // `PORT=0` it stays 0 while the OS picks the real one.
    const boundPort = boundPortOf(httpServer.address(), port);
    // In-process readers need it too, not just the file: the agent route hands
    // this to the MCP broker as its `BASE_URL` (#3055).
    setBoundPort(boundPort);
    try {
      await publishServerPort(boundPort);
    } catch (err) {
      log.warn("server", "failed to write .server-port; the LLM wiki-write hook and the dev proxy will be unable to reach the server", {
        error: String(err),
      });
    }
    startRuntimeServices(httpServer, boundPort, earlyPubsub).catch((err: unknown) => {
      // Fail fast — a half-initialized runtime is worse than a
      // crashed one. Routes mounted at module load already accept
      // requests, so without this exit the app would respond with a
      // confusing mix of 200s (from already-mounted routes) and
      // 500s (from the agent / scheduler / plugins that never came
      // up). Exit so the supervisor (Electron / launcher) can show
      // a real error instead of the user staring at a half-broken
      // UI. (CodeRabbit review on PR #1201.)
      //
      // `httpServer.close(cb)` only fires `cb` once every existing
      // connection has drained. SSE streams + WebSocket upgrades
      // can hold connections open indefinitely, so the graceful
      // path alone isn't a fail-fast guarantee. Schedule a hard
      // exit on a short timer as the floor; whichever fires first
      // wins. `.unref()` keeps the timer from blocking the event
      // loop on its own. (Codex review on PR #1226.)
      log.error("server", "startRuntimeServices failed — exiting", { error: String(err) });
      httpServer.close(() => process.exit(1));
      setTimeout(() => process.exit(1), STARTUP_FAILURE_FORCE_EXIT_MS).unref();
    });
  };

  const httpServer = app.listen(port, "127.0.0.1", () => {
    // Terminal handler, not a bare `void`: `onListening` runs the whole
    // post-listen setup, and a rejection outside its own
    // `startRuntimeServices(...).catch(...)` branch would otherwise be an
    // unhandled rejection on a half-initialised server.
    onListening(httpServer).catch((err: unknown) => {
      log.error("server", "post-listen initialization failed — exiting", { error: String(err) });
      process.exit(1);
    });
  });
})().catch((err: unknown) => {
  // Anything thrown before the listener is up (port resolution, token write)
  // lands here. Without this the failure surfaced only as an unhandled
  // rejection — no log line, and the exit code depended on the Node version.
  log.error("server", "server startup failed — exiting", { error: String(err) });
  process.exit(1);
});

function registerDebugTasks(taskManager: ITaskManager, pubsub: IPubSub) {
  let tick = 0;

  taskManager.registerTask({
    id: "debug.auto-chat",
    description: "Debug — toggles title color 10 times then starts a General-mode chat, then self-removes",
    schedule: { type: SCHEDULE_TYPES.interval, intervalMs: ONE_SECOND_MS },
    run: async () => {
      tick++;
      const last = tick === 10;
      log.info("debug", `auto-chat countdown ${tick}/10`);
      pubsub.publish(PUBSUB_CHANNELS.debugBeat, { count: tick, last });

      if (!last) return;

      taskManager.removeTask("debug.auto-chat");
      const chatSessionId = makeUuid();
      log.info("debug", "starting auto-chat", { chatSessionId });
      const result = await startChat({
        message: "Tell me about this app, MulmoClaude.",
        roleId: DEFAULT_ROLE_ID,
        chatSessionId,
        origin: SESSION_ORIGINS.scheduler,
      });
      log.info("debug", "auto-chat result", { kind: result.kind });
    },
  });

  log.info("debug", "Debug mode active — registered debug tasks");
}
