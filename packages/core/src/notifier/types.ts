// Notifier value types. Kept dependency-free (no node, no fs, no
// pubsub) so the host's API-route layer and any future browser
// consumer can validate inbound payloads against the same enum
// constants the engine accepts without pulling in the engine's I/O.

/** Two notification shapes, distinguished by who fires the close call:
 *
 *    `fyi`    — informational. The host (bell panel) clears it when the
 *               user dismisses the row. MAY carry a `navigateTarget`
 *               (the legacy wrapper publishes fyi entries with one);
 *               the row then navigates and clears.
 *    `action` — pending obligation. The plugin clears it when the
 *               underlying domain state changes (the user paid the tax,
 *               viewed the digest, etc.). The bell row navigates to
 *               `navigateTarget` on click.
 *
 *  The engine reads `lifecycle` only to enforce two publish-time rules
 *  (everything downstream — pubsub fan-out, persistence, history — is
 *  lifecycle-blind):
 *
 *    1. `action` requires a non-empty `navigateTarget`. Without one,
 *       clicking the row does nothing and the entry is a degraded fyi.
 *    2. `action` cannot use `info` severity. A low-priority obligation
 *       is incoherent — fyi if it's a ping, `nudge`/`urgent` if it's a
 *       real obligation worth a landing page.
 *
 *  Both rules live in `validate.ts`, which `publish` and
 *  `updateForPlugin` share — there is no HTTP publish path for them to
 *  be mirrored into (see `server/api/routes/notifier.ts`). */
export const NOTIFIER_LIFECYCLES = ["fyi", "action"] as const;
export type NotifierLifecycle = (typeof NOTIFIER_LIFECYCLES)[number];

/** Severity drives badge color (gray / amber / red, worst-wins) and
 *  in a future iteration channel routing. Mostly stored verbatim by
 *  the engine; the one engine-visible interaction is the rule that
 *  `action` lifecycle cannot pair with `info` severity (see
 *  `NotifierLifecycle` above). */
export const NOTIFIER_SEVERITIES = ["info", "nudge", "urgent"] as const;
export type NotifierSeverity = (typeof NOTIFIER_SEVERITIES)[number];

export interface NotifierEntry<TPluginData = unknown> {
  /** Engine-assigned UUID. Generated synchronously inside `publish()`
   *  so the caller can use it before persistence completes. */
  id: string;
  /** Plugin namespace (e.g. `"encore"`, `"debug__system"`). The
   *  engine never inspects it — used only for `listFor()` filtering
   *  and as a UI grouping key. */
  pluginPkg: string;
  severity: NotifierSeverity;
  lifecycle?: NotifierLifecycle;
  title: string;
  body?: string;
  /** Optional in-app deep-link target (relative URL). The bell popup
   *  routes here on row click, splicing in `notificationId=<id>` so the
   *  landing page can identify which entry to clear — with `?` or `&`
   *  as the target requires, and before any `#fragment`
   *  (`appendNotificationId` in `NotificationBell.vue`). The engine
   *  doesn't read this — it's a UI hint stored on the entry. */
  navigateTarget?: string;
  /** Opaque to the engine. Round-trips through JSON unchanged; only
   *  the originating plugin's UI knows the shape. */
  pluginData?: TPluginData;
  /** ISO-8601 timestamp set at `publish()` time. */
  createdAt: string;
}

/** A history entry — a `NotifierEntry` after it has been cleared or
 *  cancelled, with the terminal type and timestamp recorded. The
 *  bell popup's "History" section renders these read-only. */
export interface NotifierHistoryEntry<TPluginData = unknown> extends NotifierEntry<TPluginData> {
  terminalType: "cleared" | "cancelled";
  terminalAt: string;
}

/** Caller-supplied input for `publish()`. The engine fills in `id`
 *  and `createdAt`; everything else flows through verbatim.
 *
 *  Two publish-time rules apply to `action` lifecycle (see
 *  `NotifierLifecycle`):
 *
 *    - `navigateTarget` MUST be a non-empty string.
 *    - `severity` MUST NOT be `"info"`.
 *
 *  Violations cause `publish()` to throw. Currently expressed as
 *  runtime validation rather than a discriminated-union type, so the
 *  fields below are all individually optional / loose at the
 *  type-level. */
export interface PublishInput<TPluginData = unknown> {
  pluginPkg: string;
  severity: NotifierSeverity;
  title: string;
  body?: string | undefined;
  lifecycle?: NotifierLifecycle | undefined;
  navigateTarget?: string | undefined;
  pluginData?: TPluginData | undefined;
}

/** On-disk shape of `~/mulmoclaude/data/notifier/active.json`. Holds
 *  only entries that haven't been cleared or cancelled — the file is
 *  a snapshot, not an event log. */
export interface NotifierFile {
  entries: Record<string, NotifierEntry>;
}

/** On-disk shape of `~/mulmoclaude/data/notifier/history.json`. Array
 *  of terminated entries newest-first, capped at `HISTORY_CAP` with
 *  FIFO eviction (push at index 0, slice from the tail). */
export interface NotifierHistoryFile {
  entries: NotifierHistoryEntry[];
}

/** History size cap — how many terminated entries the FILE keeps, not
 *  how many the UI shows: older ones fall off when new terminations
 *  land. The bell popup renders `HISTORY_INITIAL_VISIBLE` of them and
 *  reveals the rest behind "Show more" (`NotificationBell.vue`). */
export const HISTORY_CAP = 50;

/** Pub-sub event published on the host's notifier channel after every
 *  successful state change. Discriminated union — subscribers switch
 *  on `type` to keep TypeScript narrowing the rest of the payload.
 *
 *  `updated` carries the post-mutation entry — the receiver swaps
 *  the matching `id` in their local active set. Reserved for in-
 *  place edits via `updateForPlugin`; no history record is written
 *  because the entry is still active, just with refreshed content. */
export type NotifierEvent =
  { type: "published"; entry: NotifierEntry } | { type: "cleared"; id: string } | { type: "cancelled"; id: string } | { type: "updated"; entry: NotifierEntry };
