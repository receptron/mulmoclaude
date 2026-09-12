// Notification payload — shared by server (publish) and frontend (subscribe).
//
// The discriminator hierarchy is:
//   NotificationPayload.action.type       — "navigate" | "none"
//   NotificationPayload.action.target.view — which feature page
// Each `target.view` variant carries the typed identifier(s) needed
// to deep-link the user to a specific item on that page (todoId,
// taskId, slug, …). Missing identifier fields are fine — the
// dispatcher falls back to the feature's index view, which matches
// the pre-permalink behaviour.

export const NOTIFICATION_KINDS = {
  todo: "todo",
  scheduler: "scheduler",
  agent: "agent",
  journal: "journal",
  push: "push",
  bridge: "bridge",
  // System diagnostics — server boot warnings (e.g. plugin META key
  // collisions). Surfaced through the same bell + toast pipeline so
  // a user with a buggy plugin sees the issue instead of staring at
  // a silently mis-routed app.
  system: "system",
} as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[keyof typeof NOTIFICATION_KINDS];

export const NOTIFICATION_ACTION_TYPES = {
  navigate: "navigate",
  none: "none",
} as const;

export type NotificationActionType = (typeof NOTIFICATION_ACTION_TYPES)[keyof typeof NOTIFICATION_ACTION_TYPES];

// Views a notification can target. Kept in sync with `PAGE_ROUTES`
// in src/router/index.ts. Automations is where scheduled tasks live
// (the Calendar view was removed).
export const NOTIFICATION_VIEWS = {
  chat: "chat",
  automations: "automations",
  files: "files",
  wiki: "wiki",
  collections: "collections",
} as const;

export type NotificationView = (typeof NOTIFICATION_VIEWS)[keyof typeof NOTIFICATION_VIEWS];

export const NOTIFICATION_PRIORITIES = {
  normal: "normal",
  high: "high",
} as const;

export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[keyof typeof NOTIFICATION_PRIORITIES];

// Deep-link target per feature page. Every variant identifies which
// page the notification refers to, plus any optional identifier the
// router / page component needs to jump to a specific item. Omitting
// the identifier lands on the feature's index view.
export type NotificationTarget =
  | { view: typeof NOTIFICATION_VIEWS.chat; sessionId: string }
  | { view: typeof NOTIFICATION_VIEWS.automations; taskId?: string }
  | { view: typeof NOTIFICATION_VIEWS.files; path?: string }
  | { view: typeof NOTIFICATION_VIEWS.wiki; slug?: string; anchor?: string }
  | { view: typeof NOTIFICATION_VIEWS.collections; slug: string; itemId?: string };

export type NotificationAction =
  | {
      type: typeof NOTIFICATION_ACTION_TYPES.navigate;
      target: NotificationTarget;
    }
  | { type: typeof NOTIFICATION_ACTION_TYPES.none };

/** Optional i18n contract for notifications whose title/body the
 *  client should localize. The server publishes vue-i18n keys + the
 *  variable substitutions; clients resolve via `t(key, params)`.
 *  `title` / `body` stay set to the rendered English so logs and
 *  non-i18n consumers (the macOS Reminder push) still get a readable
 *  string. Bridge messages used to be on that list; the notifier's
 *  bridge fan-out was removed as dead code in f522dc101.
 *
 *  Used by the plugin META diagnostics (#1125) to keep all 8 locales
 *  in lockstep without the server having to know which locale each
 *  client is on. Other notification kinds may opt in later. */
export interface NotificationI18n {
  titleKey: string;
  titleParams?: Readonly<Record<string, string | number | readonly string[]>> | undefined;
  bodyKey?: string | undefined;
  bodyParams?: Readonly<Record<string, string | number | readonly string[]>> | undefined;
}

export interface NotificationPayload {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  icon?: string;
  action: NotificationAction;
  firedAt: string;
  priority: NotificationPriority;
  sessionId?: string;
  transportId?: string;
  i18n?: NotificationI18n;
}
