// Single source of truth for every tool name (= MCP tool / plugin key)
// the app knows about. Centralised here so:
//
//   - `Role.availablePlugins` can be typed as `ToolName[]` and typos
//     get caught at compile time instead of silently dropping a
//     plugin at runtime
//   - grep for "every place that handles this tool" returns a list
//     of `TOOL_NAMES.x` references rather than free-form strings
//
// Naming is intentionally the literal string the server / MCP
// protocol / jsonl files expect.
//
// **Aggregator shape**: plugins that own their identity export their
// `toolName` from their `meta.ts` (via `BUILT_IN_PLUGIN_METAS`). This
// file auto-merges them into `TOOL_NAMES` so adding a plugin =
// register its META in `src/plugins/metas.ts`; this file untouched.
// Host-only tool names (textResponse, MCP tools, plus plugins not yet
// migrated to META) keep their literals in `HOST_TOOL_NAMES` below.
//
// First slice of issue #289 (item 4: tool name literals).

import { BUILT_IN_PLUGIN_METAS, defineHostAggregate, type BuiltInPluginMetas, type HostPluginCollision, type IntraPluginCollision } from "../plugins/metas";

const HOST_TOOL_NAMES = {
  // Text / base
  textResponse: "text-response",

  // Management plugins (not yet migrated to META)
  // manageAutomations migrated — see `src/plugins/scheduler/automationsMeta.ts`.
  // manageSkills migrated — see `src/plugins/manageSkills/meta.ts`.
  // manageWiki migrated — see `src/plugins/wiki/meta.ts`. Plugin is
  // GUI-only (no MCP binding — deprecated #963), so the sync test
  // pins "every binding → META", not the reverse.

  // Presentational plugins
  // presentMulmoScript migrated — see `src/plugins/presentMulmoScript/meta.ts`.
  // presentDocument migrated — see `src/plugins/markdown/meta.ts`.
  // presentSpreadsheet migrated — see `src/plugins/spreadsheet/meta.ts`.
  // presentHtml migrated — see `src/plugins/presentHtml/meta.ts`.
  // presentChart migrated to META — see `src/plugins/chart/meta.ts`.
  // presentForm migrated — see `src/plugins/presentForm/meta.ts`.
  // presentShapeScript migrated — see `src/plugins/presentShapeScript/meta.ts`.

  // Creation / generation
  createMindMap: "createMindMap",
  // generateImage migrated — see `src/plugins/generateImage/meta.ts`.
  // editImages migrated — see `src/plugins/editImages/meta.ts`.
  // openCanvas migrated — see `src/plugins/canvas/meta.ts`.

  // Interactive / media
  putQuestions: "putQuestions",
  // mapControl — Google Map render + Places + Directions, supplied by
  // `@gui-chat-plugin/google-map`. Wired through `src/plugins/_extras.ts`
  // (external-package binding pattern, same as mindmap / quiz).
  mapControl: "mapControl",
  weather: "weather",

  // MCP tools (server-side, not GUI plugins — registered in
  // `server/mcp-tools/`). Listed here because they appear in a
  // role's `availablePlugins` alongside GUI plugins.
  readXPost: "readXPost",
  searchX: "searchX",
  notify: "notify",
  // Generic host primitives — always active for every role (not gated
  // by `availablePlugins`). See `McpTool.alwaysActive`.
  spawnBackgroundChat: "spawnBackgroundChat",
  manageCollection: "manageCollection",

  // Preset runtime plugins (`server/plugins/preset-list.ts`).
  // Their `toolName` comes from the plugin package's
  // `TOOL_DEFINITION.name` and is stable across versions. Listing
  // them here gives `TOOL_NAMES.<x>` type safety in `roles.ts`,
  // mirroring static GUI / MCP tools.
  //
  // Runtime plugins are now gated by `role.availablePlugins`
  // (server/agent/activeTools.ts) — the previous "auto-included
  // regardless of role" rule made `manageRecipes` etc. leak into
  // every role and was a real bug. User-installed (non-preset)
  // runtime plugins are accepted in `availablePlugins` as bare
  // strings via the schema's permissive branch — see
  // `availablePluginsSchema` in `src/config/roles.ts`.
  manageSpotify: "manageSpotify",
  // manageRecipes removed (#1286) — recipe-book-plugin dropped from
  // PRESET_PLUGINS; recipe management moved to the `mc-cooking-coach`
  // preset skill which drives files directly via Read/Write/Edit.
  manageDebug: "manageDebug",
  edgar: "edgar",
  manageEmail: "manageEmail",
  google: "google",
} as const;

// Plugin-owned tool names auto-merged from each plugin's META.
// The mapped type below preserves each plugin's literal toolName
// (e.g. `"manageAccounting"`) so `TOOL_NAMES.manageAccounting` is
// typed as the literal, not just `string`.
type PluginToolNamesMap<T extends BuiltInPluginMetas> = {
  readonly [K in T[number]["toolName"]]: K;
};

// First-write-wins host+plugin aggregate (see `defineHostAggregate`).
// Plugin keys colliding with a host literal are dropped (host wins —
// silent override would route the LLM's calls to the wrong handler).
// Diagnostics flow through `TOOL_NAMES_*_COLLISIONS` for boot warnings.
const TOOL_NAMES_AGGREGATE = defineHostAggregate<string, typeof HOST_TOOL_NAMES, PluginToolNamesMap<BuiltInPluginMetas>>(BUILT_IN_PLUGIN_METAS, {
  label: "TOOL_NAMES",
  hostRecord: HOST_TOOL_NAMES,
  extract: (meta) => ({ [meta.toolName]: meta.toolName }),
  dimension: "toolName",
});
export const TOOL_NAMES_HOST_COLLISIONS: readonly HostPluginCollision[] = TOOL_NAMES_AGGREGATE.hostCollisions;
export const TOOL_NAMES_INTRA_COLLISIONS: readonly IntraPluginCollision[] = TOOL_NAMES_AGGREGATE.intraCollisions;

export const TOOL_NAMES = TOOL_NAMES_AGGREGATE.merged;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/** Runtime predicate — useful when string input (URL param, JSON
 *  payload) needs to be narrowed to a known tool. */
export function isToolName(value: unknown): value is ToolName {
  if (typeof value !== "string") return false;
  return Object.values(TOOL_NAMES).some((toolName) => toolName === value);
}

/** Array of all known tool names, in declaration order. */
export const ALL_TOOL_NAMES: readonly ToolName[] = Object.values(TOOL_NAMES);
