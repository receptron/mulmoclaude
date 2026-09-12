// Plugin META aggregation diagnostics.
//
// At boot we collect every collision the aggregators dropped (host
// keys vs plugin keys) plus every intra-plugin duplicate
// (`BUILT_IN_PLUGIN_METAS` checked once at module load) and surface
// them via three channels:
//
//   1. `log.warn(...)`            — always, for stderr / journal
//   2. `publishNotification(...)` — pushed to live bell (entry lives
//                                    in notifier active.json until
//                                    cleared, so late-mount tabs
//                                    still see the warning)
//   3. module-level cache         — persisted so a UI mounting after
//                                    boot can still fetch the list
//                                    via GET /api/plugins/diagnostics
//
// PR 4 of feat-encore migrated the bell onto the notifier engine,
// whose `active.json` survives across restarts. To avoid republishing
// identical entries on every boot, `announcePluginMetaDiagnostics` is
// now async and dedupes against the existing active set via the
// stable `legacyId` carried on each entry's `pluginData`.
//
// Throwing was rejected because a single buggy plugin would brick
// the whole app — especially relevant once user-installed runtime
// plugins (#1043 / #1110) land. Filter-and-warn keeps the host
// running and gives the user a clear signal to fix or remove the
// offending plugin.

import type { HostPluginCollision, IntraPluginCollision } from "../../src/plugins/metas.js";
import type { NotificationI18n } from "../../src/types/notification.js";
import { TOOL_NAMES_HOST_COLLISIONS, TOOL_NAMES_INTRA_COLLISIONS } from "../../src/config/toolNames.js";
import { API_ROUTES_HOST_COLLISIONS, API_ROUTES_INTRA_COLLISIONS } from "../../src/config/apiRoutes.js";
import { PUBSUB_CHANNELS_HOST_COLLISIONS, PUBSUB_CHANNELS_INTRA_COLLISIONS } from "../../src/config/pubsubChannels.js";
import { WORKSPACE_DIRS_HOST_COLLISIONS, WORKSPACE_DIRS_INTRA_COLLISIONS } from "../workspace/paths.js";
import { log } from "../system/logger/index.js";
import { isLegacyNotifierPluginData, publishNotification } from "../events/notifications.js";
import { listAll as listActiveNotifications } from "../notifier/engine.js";
import { NOTIFICATION_ACTION_TYPES, NOTIFICATION_PRIORITIES } from "../../src/types/notification.js";

/** Shape returned by `GET /api/plugins/diagnostics`. */
export interface PluginMetaDiagnostic {
  /** Internal id, used for deduplication and toast keys. */
  id: string;
  /** Pre-rendered English message. Kept for log lines and any
   *  consumer that doesn't have vue-i18n; UI surfaces use `i18n`
   *  below to localize per active locale. */
  message: string;
  /** Type of issue — useful when the UI wants to group / icon them. */
  kind: "host-plugin" | "intra-plugin";
  /** Aggregator label (`API_ROUTES`, `WORKSPACE_DIRS`, …) for
   *  host-plugin collisions; the dimension name (`apiNamespace`,
   *  …) for intra-plugin duplicates. */
  scope: string;
  /** The colliding key. */
  key: string;
  /** Plugin(s) involved. Length 1 for host-plugin (the plugin that
   *  was dropped); length 2 for intra-plugin (first-registered,
   *  second-registered). */
  plugins: readonly string[];
  /** vue-i18n keys + params so the bell / toast can localize the
   *  title and body in any of the 8 supported locales without the
   *  server having to know which locale the user is on. */
  i18n: NotificationI18n;
}

const PLUGIN_DIAGNOSTICS_TITLE_KEY = "pluginDiagnostics.title";
const PLUGIN_DIAGNOSTICS_HOST_BODY_KEY = "pluginDiagnostics.hostBody";
const PLUGIN_DIAGNOSTICS_INTRA_BODY_KEY = "pluginDiagnostics.intraBody";

function describeHostCollision(collision: HostPluginCollision): PluginMetaDiagnostic {
  const plugin = collision.plugin || "<unknown plugin>";
  return {
    id: `host:${collision.label}:${collision.key}:${plugin}`,
    message: `Plugin "${plugin}" tried to register the ${collision.label} key "${collision.key}" but it is reserved by the host. The plugin's entry has been dropped.`,
    kind: "host-plugin",
    scope: collision.label,
    key: collision.key,
    plugins: [plugin],
    i18n: {
      titleKey: PLUGIN_DIAGNOSTICS_TITLE_KEY,
      bodyKey: PLUGIN_DIAGNOSTICS_HOST_BODY_KEY,
      bodyParams: { plugin, label: collision.label, key: collision.key },
    },
  };
}

function describeIntraCollision(collision: IntraPluginCollision): PluginMetaDiagnostic {
  const [first, second] = collision.plugins;
  // Message matches actual runtime: each aggregator now uses
  // `buildPluginAggregate` which is first-write-wins, so the
  // second plugin's registration is genuinely dropped (was
  // last-write-wins via Object.assign before Codex iter-7's #1125
  // catch).
  return {
    id: `intra:${collision.dimension}:${collision.key}:${first}:${second}`,
    message: `Plugins "${first}" and "${second}" both register ${collision.dimension} "${collision.key}". "${first}" claimed it first, so "${second}"'s registration is ignored.`,
    kind: "intra-plugin",
    scope: collision.dimension,
    key: collision.key,
    plugins: [first, second],
    i18n: {
      titleKey: PLUGIN_DIAGNOSTICS_TITLE_KEY,
      bodyKey: PLUGIN_DIAGNOSTICS_INTRA_BODY_KEY,
      bodyParams: { first, second, dimension: collision.dimension, key: collision.key },
    },
  };
}

let cachedDiagnostics: readonly PluginMetaDiagnostic[] | null = null;

/** Build (and cache) the full diagnostic list for this process. */
export function collectPluginMetaDiagnostics(): readonly PluginMetaDiagnostic[] {
  if (cachedDiagnostics !== null) return cachedDiagnostics;
  const hostCollisions = [...TOOL_NAMES_HOST_COLLISIONS, ...API_ROUTES_HOST_COLLISIONS, ...PUBSUB_CHANNELS_HOST_COLLISIONS, ...WORKSPACE_DIRS_HOST_COLLISIONS];
  const intraCollisions = [
    ...TOOL_NAMES_INTRA_COLLISIONS,
    ...API_ROUTES_INTRA_COLLISIONS,
    ...PUBSUB_CHANNELS_INTRA_COLLISIONS,
    ...WORKSPACE_DIRS_INTRA_COLLISIONS,
  ];
  const list: PluginMetaDiagnostic[] = [...hostCollisions.map(describeHostCollision), ...intraCollisions.map(describeIntraCollision)];
  cachedDiagnostics = Object.freeze(list);
  return cachedDiagnostics;
}

/** Run at server boot after the notifier engine is initialized.
 *  Logs every diagnostic via `log.warn` and publishes one notification
 *  per item so the bell shows them. Dedupes against the engine's
 *  active set by `legacyId` so a reboot with the same diagnostics
 *  doesn't pile fresh entries on top of the ones the user already
 *  saw (the new engine's `active.json` survives across restarts —
 *  the legacy in-memory store didn't). Returns the diagnostics so
 *  the caller can choose to expose them via an HTTP endpoint. */
export async function announcePluginMetaDiagnostics(): Promise<readonly PluginMetaDiagnostic[]> {
  const diagnostics = collectPluginMetaDiagnostics();
  if (diagnostics.length === 0) {
    log.debug("[plugin-meta]", "no aggregator collisions detected");
    return diagnostics;
  }
  // Snapshot the engine's active entries once and build a set of
  // `legacyId`s already present. Cheaper than calling listAll() per
  // diagnostic, and the small race window (entries added between
  // snapshot and publish) is harmless — a duplicate diag landing
  // because the snapshot lagged is no worse than the legacy
  // in-memory dedup behaviour.
  const existingLegacyIds = new Set<string>();
  try {
    const active = await listActiveNotifications();
    for (const entry of active) {
      const legacy = isLegacyNotifierPluginData(entry.pluginData) ? entry.pluginData : null;
      if (legacy) existingLegacyIds.add(legacy.legacyId);
    }
  } catch (err) {
    // Failing to read active.json shouldn't block diagnostics — the
    // worst case is a duplicate entry the user can dismiss.
    log.warn("[plugin-meta]", "failed to snapshot active notifier state for dedup", { error: String(err) });
  }
  for (const diag of diagnostics) {
    log.warn("[plugin-meta]", diag.message, { id: diag.id, scope: diag.scope, key: diag.key, plugins: diag.plugins });
    if (existingLegacyIds.has(diag.id)) {
      log.debug("[plugin-meta]", "diagnostic already in active set; skipping republish", { id: diag.id });
      continue;
    }
    publishNotification({
      // Use the deterministic diagnostic id so the engine's
      // `legacyId` carries it across restarts and the dedup check
      // above can spot existing entries.
      id: diag.id,
      kind: "system",
      // English `title` / `body` are kept as fallbacks for the log
      // line and the macOS Reminder push; the
      // UI prefers `i18n` below (8 locales in lockstep, Codex iter-8
      // #1125).
      title: "Plugin configuration issue",
      body: diag.message,
      action: { type: NOTIFICATION_ACTION_TYPES.none },
      priority: NOTIFICATION_PRIORITIES.high,
      i18n: diag.i18n,
    });
  }
  return diagnostics;
}
