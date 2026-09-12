// Legacy host-side `publishNotification()` entry point — now a thin
// wrapper over the new notifier engine (PR 4 of feat-encore).
//
// The signature is preserved so the existing host call sites
// (`server/agent/mcp-tools/notify.ts`,
// `server/plugins/diagnostics.ts`) keep working without source changes.
// Internally it now:
//   1. Maps the legacy `NotificationKind` source category to a
//      `pluginPkg` ("todo"/"scheduler"/"agent"/"journal" keep their
//      names; "push"/"bridge"/"system" collapse under "host").
//   2. Maps `priority` to engine `severity` ("normal" → "nudge",
//      "high" → "urgent").
//   3. Flattens the typed `NotificationAction` to a relative URL
//      string for `navigateTarget` (forwarded only as metadata —
//      legacy entries publish with `lifecycle: "fyi"`, so the
//      `action`-lifecycle rules don't apply and clicking still routes).
//   4. Stashes the legacy fields (`kind`, `priority`, `action`,
//      `i18n`, `sessionId`, the caller-supplied dedup `id`) on
//      `pluginData` so the bell can preserve icon, i18n localization,
//      and dedup.
//
// macOS Reminder push happens via the `macosReminderAdapter` listener
// subscribed to the notifier pubsub channel. The previous bridge
// fan-out path was removed (#1351 follow-up): the only callers
// setting `transportId` were the PoC `/api/notifications/test` route
// and `scheduleTestNotification`, both deleted in the same change.
// Production callers never set `transportId`, so the entire bridge
// side-channel was dead code.

import { PAGE_ROUTES } from "../../src/router/pageRoutes.js";
import {
  NOTIFICATION_ACTION_TYPES,
  NOTIFICATION_KINDS,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_VIEWS,
  type NotificationAction,
  type NotificationI18n,
  type NotificationKind,
  type NotificationPriority,
} from "../../src/types/notification.js";
import { publish as notifierPublish } from "../notifier/engine.js";
import type { NotifierSeverity } from "../notifier/types.js";
import { log } from "../system/logger/index.js";
import { makeUuid } from "../utils/id.js";
import { isRecord } from "../utils/types.js";

// ── Public types ────────────────────────────────────────────────

export interface PublishNotificationOpts {
  kind: NotificationKind;
  title: string;
  body?: string | undefined;
  action?: NotificationAction | undefined;
  priority?: NotificationPriority | undefined;
  sessionId?: string | undefined;
  /** Override the auto-generated UUID with a caller-supplied stable
   *  id. Used by the plugin-meta diagnostics: the same diagnostic
   *  id is returned from `/api/plugins/diagnostics`, and `pluginData`
   *  carries it so `announcePluginMetaDiagnostics` can dedupe across
   *  reboots without piling identical entries into `active.json`. */
  id?: string | undefined;
  /** vue-i18n keys + params for clients to localize the title/body.
   *  Server-side `title` / `body` stay set as English fallbacks for
   *  logs and the macOS Reminder push. */
  i18n?: NotificationI18n | undefined;
}

/** Discriminated marker on `NotifierEntry.pluginData` for entries
 *  produced by the legacy `publishNotification()` wrapper. The bell
 *  reads this to preserve the legacy icon (`kind`), i18n localization,
 *  the caller-supplied dedup id and the originating session. NOT
 *  transport routing — there is no `transportId` here and no bridge
 *  path left to route to (see the file header). New direct callers of
 *  `notifier.publish()` publish without this shape. */
export interface LegacyNotifierPluginData {
  legacy: true;
  /** Caller-supplied stable id (e.g. plugin-meta diagnostic id), or
   *  the auto-generated UUID otherwise. Distinct from
   *  `NotifierEntry.id`, which the engine assigns. */
  legacyId: string;
  kind: NotificationKind;
  priority: NotificationPriority;
  action: NotificationAction;
  i18n?: NotificationI18n | undefined;
  sessionId?: string | undefined;
}

export function isLegacyNotifierPluginData(value: unknown): value is LegacyNotifierPluginData {
  if (!isRecord(value)) return false;
  return value.legacy === true && typeof value.legacyId === "string" && typeof value.kind === "string";
}

// ── Mapping helpers ─────────────────────────────────────────────

/** Map legacy `NotificationKind` → `pluginPkg`. Source categories
 *  that come from a domain feature (todo / scheduler / agent /
 *  journal) keep their names so a future runtime plugin can adopt the
 *  pluginPkg unchanged; the host-internal categories (push, bridge,
 *  system) collapse to "host". */
export function legacyKindToPluginPkg(kind: NotificationKind): string {
  switch (kind) {
    case NOTIFICATION_KINDS.todo:
    case NOTIFICATION_KINDS.scheduler:
    case NOTIFICATION_KINDS.agent:
    case NOTIFICATION_KINDS.journal:
      return kind;
    case NOTIFICATION_KINDS.push:
    case NOTIFICATION_KINDS.bridge:
    case NOTIFICATION_KINDS.system:
    default:
      return "host";
  }
}

/** Map legacy `priority` → engine `severity`. The legacy badge was
 *  red unconditionally; mapping `normal` → `nudge` keeps the bell
 *  visibly amber so users still see "you have notifications," while
 *  `high` → `urgent` preserves the red escalation for diagnostics
 *  and similar attention-grabbing items. `info` is reserved for
 *  future non-bell-coloring callers. */
export function legacyPriorityToSeverity(priority: NotificationPriority | undefined): NotifierSeverity {
  return priority === NOTIFICATION_PRIORITIES.high ? "urgent" : "nudge";
}

// ── Per-view URL builders ───────────────────────────────────────
//
// Split out from `legacyActionToNavigateTarget` so the dispatcher
// stays under the cognitive-complexity threshold. Each builder takes
// the typed target slice it cares about and returns either a relative
// URL or `undefined` (the latter only when a required field is
// missing — chat without sessionId).

type NavigateTarget = Extract<NotificationAction, { type: "navigate" }>["target"];

// User/content-derived path segments (slugs, anchors, item ids) ride
// through `encodeURIComponent` so reserved characters like `?`, `#`,
// `/`, `%`, `&`, ` ` don't change the URL's structure when interpolated.
// `PAGE_ROUTES.*` and the literal `pages` segment are static literals
// — encoding them is unnecessary noise.
//
// Dot segments (`.` and `..`) survive `encodeURIComponent` (the dots
// aren't reserved characters) and would let a slug or path component
// jump out of its view's namespace once the browser / router applies
// path normalization. `/files/../chat/sess` collapses to `/chat/sess`,
// for example. `isSafePathComponent` rejects those segments; consumers
// either fall back to the view's index (single-component fields like
// `slug` / `itemId`) or drop the navigate target entirely (chat,
// where `sessionId` is required, has no usable index).

function isSafePathComponent(segment: string): boolean {
  return segment !== "." && segment !== "..";
}

function buildChatTarget(target: Extract<NavigateTarget, { view: typeof NOTIFICATION_VIEWS.chat }>): string | undefined {
  // No sessionId → drop the action; bouncing off the catch-all
  // redirect is worse UX than a non-clickable entry. Dot-segment
  // sessionId would normalize off /chat, so drop too.
  if (!target.sessionId || !isSafePathComponent(target.sessionId)) return undefined;
  return `/${PAGE_ROUTES.chat}/${encodeURIComponent(target.sessionId)}`;
}

function buildFilesTarget(target: Extract<NavigateTarget, { view: typeof NOTIFICATION_VIEWS.files }>): string {
  // Files uses a catch-all (`/files/:pathMatch(.*)`); empty path
  // lands on the index. Each segment is encoded so spaces / special
  // characters don't break the URL. A path containing `.` or `..`
  // segments would normalize out of /files, so refuse to build a
  // path target for it — the index is the safest fallback.
  if (!target.path) return `/${PAGE_ROUTES.files}`;
  const segments = target.path.split("/").filter(Boolean);
  if (segments.some((segment) => !isSafePathComponent(segment))) return `/${PAGE_ROUTES.files}`;
  return `/${PAGE_ROUTES.files}/${segments.map(encodeURIComponent).join("/")}`;
}

function buildWikiTarget(target: Extract<NavigateTarget, { view: typeof NOTIFICATION_VIEWS.wiki }>): string {
  // Slug rides as a path component → dot-segment-check it. The
  // anchor lives in the URL fragment, which doesn't participate in
  // path normalization, so it doesn't need the same guard.
  const slug = target.slug && isSafePathComponent(target.slug) ? `/pages/${encodeURIComponent(target.slug)}` : "";
  const hash = target.anchor ? `#${encodeURIComponent(target.anchor)}` : "";
  return `/${PAGE_ROUTES.wiki}${slug}${hash}`;
}

function buildSingleSegmentTarget(view: string, segment: string | undefined): string {
  // Helper for views with a single optional path component:
  // automations (taskId), sources (slug). Unsafe values
  // fall back to the view's index — a soft-fail since these views
  // all have a usable index page.
  if (segment && isSafePathComponent(segment)) return `/${view}/${encodeURIComponent(segment)}`;
  return `/${view}`;
}

function buildNavigateTarget(target: NavigateTarget): string | undefined {
  switch (target.view) {
    case NOTIFICATION_VIEWS.chat:
      return buildChatTarget(target);
    case NOTIFICATION_VIEWS.automations:
      return buildSingleSegmentTarget(PAGE_ROUTES.automations, target.taskId);
    case NOTIFICATION_VIEWS.files:
      return buildFilesTarget(target);
    case NOTIFICATION_VIEWS.wiki:
      return buildWikiTarget(target);
    case NOTIFICATION_VIEWS.collections: {
      // /collections/:slug?selected=<itemId> — the `?selected=` query
      // param is the documented convention for deep-linking to a
      // specific record (see `helps/collection-skills.md`). Dot-segment
      // slug would normalize out of /collections, so fall back to the
      // index; itemId is a query param so it doesn't participate in
      // path normalization and doesn't need the same guard.
      if (!isSafePathComponent(target.slug)) return `/${PAGE_ROUTES.collections}`;
      const base = `/${PAGE_ROUTES.collections}/${encodeURIComponent(target.slug)}`;
      if (!target.itemId) return base;
      return `${base}?selected=${encodeURIComponent(target.itemId)}`;
    }
    default:
      return undefined;
  }
}

/** Flatten a typed `NotificationAction` to a relative URL string the
 *  bell can hand straight to `router.push`. Returns `undefined` for
 *  `action: { type: "none" }`, missing required fields (e.g. a chat
 *  navigate without `sessionId`), or unknown views. The engine's
 *  `navigateTarget` validation requires same-origin paths starting
 *  with a single "/", which every branch below satisfies. */
export function legacyActionToNavigateTarget(action: NotificationAction | undefined): string | undefined {
  if (!action || action.type !== NOTIFICATION_ACTION_TYPES.navigate) return undefined;
  return buildNavigateTarget(action.target);
}

// ── Publish ─────────────────────────────────────────────────────

/**
 * Host-only entry point for firing notifications.
 *
 * **Plugins MUST NOT call this directly.** Plugin code (anything under
 * `packages/*-plugin/`) MUST publish through `runtime.notifier.publish`
 * (see `server/notifier/runtime-api.ts`), which auto-binds `pluginPkg`
 * to the calling plugin so plugins cannot impersonate each other.
 *
 * This wrapper exists for host-side callers (`server/agent/`,
 * `server/workspace/`, `server/plugins/diagnostics.ts`) that don't
 * have a `PluginRuntime` to hand. It forwards into `notifier.publish`
 * with `lifecycle: "fyi"` and stashes legacy fields on `pluginData`
 * so the bell can preserve icon / i18n / dedup semantics. macOS
 * Reminder push is owned by the adapter subscribed to the notifier
 * pubsub channel, not by this function.
 */
export function publishNotification(opts: PublishNotificationOpts): void {
  const legacyId = opts.id ?? makeUuid();
  const action: NotificationAction = opts.action ?? { type: NOTIFICATION_ACTION_TYPES.none };
  const pluginData: LegacyNotifierPluginData = {
    legacy: true,
    legacyId,
    kind: opts.kind,
    priority: opts.priority ?? NOTIFICATION_PRIORITIES.normal,
    action,
    i18n: opts.i18n,
    sessionId: opts.sessionId,
  };
  // Fire-and-forget — the engine queues writes through its own
  // coordinator. A persistence failure logs but never throws to the
  // caller (matches the legacy try/catch contract that protected
  // call sites like endRun).
  notifierPublish({
    pluginPkg: legacyKindToPluginPkg(opts.kind),
    severity: legacyPriorityToSeverity(opts.priority),
    lifecycle: "fyi",
    title: opts.title,
    body: opts.body,
    navigateTarget: legacyActionToNavigateTarget(action),
    pluginData,
  }).catch((err) => {
    log.warn("notifications", "publish failed", { error: String(err), legacyId, kind: opts.kind });
  });
}
