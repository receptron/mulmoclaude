// Regression tests for the plugin-META aggregator collision helpers.
//
// Aggregators in src/config/* and server/workspace/paths.ts merge
// plugin-owned records into host records. Two collision classes:
//
//   1. host-vs-plugin — a plugin's key matches a host's reserved key
//      (e.g. `apiNamespace: "agent"`). Filtered + reported by
//      `filterPluginKeys` AFTER the cross-plugin merge.
//   2. plugin-vs-plugin — two plugins claim the same key in the same
//      dimension. Detected DURING the merge by `buildPluginAggregate`
//      (first-write-wins). Codex iter-3+ on PR #1125 caught that
//      pre-buildPluginAggregate this was last-write-wins via
//      `Object.fromEntries` / `Object.assign`, with the diagnostic
//      message contradicting actual runtime — these tests pin the
//      first-write-wins contract.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findHostPluginCollisions, buildPluginAggregate, defineHostAggregate, filterPluginKeys, BUILT_IN_PLUGIN_METAS } from "../../src/plugins/metas.js";
import { BUILT_IN_SERVER_BINDINGS } from "../../src/plugins/server.js";
import type { PluginMeta } from "../../src/plugins/meta-types.js";
// Type-only (no module side effects): the live aggregators are still loaded
// via `await import(...)` inside the tests that need their runtime values.
import type { ToolName } from "../../src/config/toolNames.js";
import type { WorkspaceDirKey } from "../../server/workspace/paths.js";

test("findHostPluginCollisions returns colliding keys", () => {
  const host = { agent: "/api/agent", roles: "/api/roles" };
  const plugin = { agent: "/api/some-plugin", brand: "/api/brand" };
  assert.deepEqual(findHostPluginCollisions(host, plugin), ["agent"]);
});

test("findHostPluginCollisions is empty when records are disjoint", () => {
  const host = { sessions: "sessions" };
  const plugin = { accountingBooks: "accounting:books" };
  assert.deepEqual(findHostPluginCollisions(host, plugin), []);
});

test("filterPluginKeys drops host-colliding keys and reports them attributed", () => {
  const hostKeys = new Set(["agent", "roles"]);
  const plugin = { agent: "x", brand: "y" };
  const owner = { agent: "manageX", brand: "manageY" };
  const { cleaned, dropped } = filterPluginKeys("API_ROUTES", hostKeys, plugin, owner);
  assert.deepEqual(cleaned, { brand: "y" });
  assert.deepEqual(dropped, [{ label: "API_ROUTES", key: "agent", plugin: "manageX" }]);
});

test("filterPluginKeys is a pass-through when there is no collision", () => {
  const hostKeys = new Set(["x"]);
  const plugin = { yyy: 1, zzz: 2 };
  const owner = { yyy: "a", zzz: "a" };
  const { cleaned, dropped } = filterPluginKeys("LBL", hostKeys, plugin, owner);
  assert.deepEqual(cleaned, plugin);
  assert.deepEqual(dropped, []);
});

test("buildPluginAggregate is first-write-wins on duplicate keys", () => {
  const first: PluginMeta = { toolName: "manageA", workspaceDirs: { shared: "data/a-shared", aOnly: "data/a-only" } };
  const second: PluginMeta = { toolName: "manageB", workspaceDirs: { shared: "data/b-shared", bOnly: "data/b-only" } };
  const { aggregate, owner, collisions } = buildPluginAggregate([first, second], (meta) => meta.workspaceDirs, "workspaceDirs");
  // First plugin's value wins.
  assert.equal(aggregate.shared, "data/a-shared");
  assert.equal(aggregate.aOnly, "data/a-only");
  assert.equal(aggregate.bOnly, "data/b-only");
  // Owner reflects first-write.
  assert.equal(owner.shared, "manageA");
  // Collision lists the second offender.
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0], { dimension: "workspaceDirs", key: "shared", plugins: ["manageA", "manageB"] });
});

test("buildPluginAggregate detects duplicate apiNamespace across plugins", () => {
  const dispatch = { method: "POST", path: "" } as const;
  const first: PluginMeta = { toolName: "manageA", apiNamespace: "shared", apiRoutes: { dispatch } };
  const second: PluginMeta = { toolName: "manageB", apiNamespace: "shared", apiRoutes: { dispatch } };
  const { aggregate, collisions } = buildPluginAggregate(
    [first, second],
    (meta) => (meta.apiRoutes !== undefined ? { [meta.apiNamespace ?? meta.toolName]: meta.apiRoutes } : undefined),
    "apiNamespace",
  );
  // First plugin wins.
  assert.deepEqual(aggregate.shared, { dispatch });
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0]?.key, "shared");
  assert.deepEqual(collisions[0]?.plugins, ["manageA", "manageB"]);
});

test("buildPluginAggregate is empty / collision-free for disjoint plugin records", () => {
  const first: PluginMeta = { toolName: "manageA", staticChannels: { aChan: "a:chan" } };
  const second: PluginMeta = { toolName: "manageB", staticChannels: { bChan: "b:chan" } };
  const { aggregate, owner, collisions } = buildPluginAggregate([first, second], (meta) => meta.staticChannels, "staticChannels");
  assert.deepEqual(aggregate, { aChan: "a:chan", bChan: "b:chan" });
  assert.deepEqual(owner, { aChan: "manageA", bChan: "manageB" });
  assert.deepEqual(collisions, []);
});

test("buildPluginAggregate skips plugins where extract returns undefined", () => {
  const withDirs: PluginMeta = { toolName: "manageA", workspaceDirs: { x: "data/x" } };
  const withoutDirs: PluginMeta = { toolName: "manageB" };
  const { aggregate, collisions } = buildPluginAggregate([withoutDirs, withDirs, withoutDirs], (meta) => meta.workspaceDirs, "workspaceDirs");
  assert.deepEqual(aggregate, { x: "data/x" });
  assert.deepEqual(collisions, []);
});

// Sync-invariant (one-way): every BUILT_IN_SERVER_BINDINGS entry
// for a *built-in* plugin must have a matching META in
// `BUILT_IN_PLUGIN_METAS`. Catches the "I added an MCP binding but
// forgot the META" footgun.
//
// Two directions intentionally NOT asserted:
//   - META → binding: GUI-only / deprecated plugins (wiki — MCP tool
//     removed #963 but the plugin entry stays for legacy chat replay)
//     have META without binding.
//   - external-package binding → META: plugins shipped as npm
//     packages (createMindMap from @gui-chat-plugin/mindmap, etc.)
//     are registered in BUILT_IN_SERVER_BINDINGS without a local
//     meta.ts because they aren't co-located in this source tree.
const EXTERNAL_PACKAGE_TOOL_NAMES = new Set(["createMindMap", "putQuestions", "mapControl"]);

test("every built-in BUILT_IN_SERVER_BINDINGS entry has a matching toolName in BUILT_IN_PLUGIN_METAS", () => {
  const metaToolNames: ReadonlySet<string> = new Set(BUILT_IN_PLUGIN_METAS.map((meta) => meta.toolName));
  for (const binding of BUILT_IN_SERVER_BINDINGS) {
    if (EXTERNAL_PACKAGE_TOOL_NAMES.has(binding.def.name)) continue;
    assert.ok(
      metaToolNames.has(binding.def.name),
      `BUILT_IN_SERVER_BINDINGS row for "${binding.def.name}" has no matching META in BUILT_IN_PLUGIN_METAS. ` +
        `Either add the plugin's META to src/plugins/metas.ts, or drop the row from BUILT_IN_SERVER_BINDINGS.`,
    );
  }
});

test("apiNamespace defaults to toolName when omitted from META", () => {
  // Synthetic plugin without `apiNamespace` — the aggregator should
  // key it under `toolName`. This pins the documented default in
  // `src/plugins/meta-types.ts#PluginMeta.apiNamespace` so a future
  // refactor can't silently drop the fallback.
  const dispatch = { method: "POST", path: "" } as const;
  const meta: PluginMeta = {
    toolName: "manageWidget",
    apiRoutes: { dispatch },
  };
  const { aggregate } = buildPluginAggregate(
    [meta],
    (entry) => (entry.apiRoutes !== undefined ? { [entry.apiNamespace ?? entry.toolName]: entry.apiRoutes } : undefined),
    "apiNamespace",
  );
  assert.deepEqual(aggregate, { manageWidget: { dispatch } });
});

// Importing the live aggregators triggers `filterPluginKeys` +
// `buildPluginAggregate` at module load. They should not throw and
// the current built-in plugins should produce empty collision arrays.
test("live aggregator modules load without host-vs-plugin or intra-plugin collisions", async () => {
  const toolNames = await import("../../src/config/toolNames.js");
  const apiRoutes = await import("../../src/config/apiRoutes.js");
  const pubsub = await import("../../src/config/pubsubChannels.js");
  const paths = await import("../../server/workspace/paths.js");
  // Host-vs-plugin
  assert.deepEqual([...toolNames.TOOL_NAMES_HOST_COLLISIONS], []);
  assert.deepEqual([...apiRoutes.API_ROUTES_HOST_COLLISIONS], []);
  assert.deepEqual([...pubsub.PUBSUB_CHANNELS_HOST_COLLISIONS], []);
  assert.deepEqual([...paths.WORKSPACE_DIRS_HOST_COLLISIONS], []);
  // Intra-plugin
  assert.deepEqual([...toolNames.TOOL_NAMES_INTRA_COLLISIONS], []);
  assert.deepEqual([...apiRoutes.API_ROUTES_INTRA_COLLISIONS], []);
  assert.deepEqual([...pubsub.PUBSUB_CHANNELS_INTRA_COLLISIONS], []);
  assert.deepEqual([...paths.WORKSPACE_DIRS_INTRA_COLLISIONS], []);
});

// `additionalReservedKeys` (CR review #1125 follow-up) — used by
// `WORKSPACE_DIRS` to also reserve `WORKSPACE_FILES` keys so a
// plugin can't smuggle in a `workspaceDirs.<sameKey>` that would
// silently disagree with `WORKSPACE_PATHS` (file-side wins on the
// final spread).
test("defineHostAggregate honours additionalReservedKeys for collision filtering", () => {
  const hostMeta: PluginMeta = {
    toolName: "host",
    apiNamespace: "host",
    workspaceDirs: { reservedFile: "data/reserved", legitDir: "data/legit" },
  };
  const result = defineHostAggregate<string>([hostMeta], {
    label: "WORKSPACE_DIRS",
    hostRecord: { hostKey: "data/host" },
    extract: (meta) => meta.workspaceDirs,
    dimension: "workspaceDirs",
    additionalReservedKeys: new Set(["reservedFile"]),
  });
  // `legitDir` survives, `reservedFile` is dropped + reported.
  assert.equal(result.merged.legitDir, "data/legit");
  assert.equal("reservedFile" in result.merged, false);
  // The reserved key must NOT leak into `merged` — the helper only
  // uses it for filtering, not for spreading into the output.
  assert.equal("reservedFile" in result.merged, false);
  const droppedKeys = result.hostCollisions.map((collision) => collision.key);
  assert.ok(droppedKeys.includes("reservedFile"));
});

test("defineHostAggregate without additionalReservedKeys preserves original behaviour", () => {
  const meta: PluginMeta = {
    toolName: "noop",
    apiNamespace: "noop",
    workspaceDirs: { reservedFile: "data/x" },
  };
  // Without the reservation, `reservedFile` survives because it
  // doesn't collide with the (empty) host record.
  const result = defineHostAggregate<string>([meta], {
    label: "TEST",
    hostRecord: {},
    extract: (entry) => entry.workspaceDirs,
    dimension: "workspaceDirs",
  });
  assert.equal(result.merged.reservedFile, "data/x");
  assert.equal(result.hostCollisions.length, 0);
});

// A key named after an `Object.prototype` member used to read a function out
// of the bare `{}` used as the owner map, so the FIRST plugin to claim it was
// reported as colliding with a plugin that does not exist — and its entry was
// dropped. The warning even named `null` as the prior claimant (#2315).
test("a key named after an Object.prototype member is registered, not dropped as a collision", () => {
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    const meta: PluginMeta = { toolName: "only", apiNamespace: "only", workspaceDirs: { [key]: "data/x" } };
    const result = buildPluginAggregate<string>([meta], (entry) => entry.workspaceDirs, "workspaceDirs");
    assert.equal(result.aggregate[key], "data/x", `${key} should be registered`);
    assert.deepEqual(result.collisions, [], `${key} should not be reported as a collision`);
    assert.equal(result.owner[key], "only");
  }
});

test("two plugins claiming an Object.prototype-named key still collide, attributed to the first", () => {
  const first: PluginMeta = { toolName: "first", apiNamespace: "first", workspaceDirs: { constructor: "data/a" } };
  const second: PluginMeta = { toolName: "second", apiNamespace: "second", workspaceDirs: { constructor: "data/b" } };
  const result = buildPluginAggregate<string>([first, second], (entry) => entry.workspaceDirs, "workspaceDirs");
  assert.equal(result.aggregate.constructor, "data/a", "first write wins");
  assert.deepEqual(result.collisions, [{ dimension: "workspaceDirs", key: "constructor", plugins: ["first", "second"] }]);
});

// `__proto__` is the one prototype key `hasOwnKey` alone can't save: with a
// plain `{}` target, `aggregate["__proto__"] = value` hits the inherited
// SETTER — the entry silently vanishes (no collision report) and an object
// value would replace the aggregate's prototype with plugin data.
test("__proto__ entry survives the full aggregate pipeline without polluting Object.prototype", () => {
  const meta: PluginMeta = { toolName: "only", apiNamespace: "only", workspaceDirs: { ["__proto__"]: "data/x" } };
  const result = defineHostAggregate<string>([meta], {
    label: "TEST",
    hostRecord: { existing: "data/host" },
    extract: (entry) => entry.workspaceDirs,
    dimension: "workspaceDirs",
  });
  const PROTO_KEY = "__proto__";
  assert.equal(Object.prototype.hasOwnProperty.call(result.merged, PROTO_KEY), true, "__proto__ kept as an own key");
  assert.equal(result.merged[PROTO_KEY], "data/x");
  assert.equal(result.merged.existing, "data/host");
  assert.deepEqual(result.intraCollisions, []);
  // Object.prototype must be untouched — a fresh object's prototype is the
  // real Object.prototype, not the plugin's "data/x" string.
  const probe: Record<string, unknown> = {};
  assert.equal(Object.getPrototypeOf(probe), Object.prototype, "Object.prototype untouched");
});

// ────────────────────────────────────────────────────────────────
// The declared merged type vs. the record that actually ships
// ────────────────────────────────────────────────────────────────
//
// `defineHostAggregate` proves the HOST half of `merged` (it is a spread of
// the caller's own `hostRecord`) but takes the PLUGIN half on the caller's
// word: `buildPluginAggregate` walks `readonly PluginMeta[]`, which has
// already widened every plugin's literal keys to `string`, so the compiler
// cannot re-derive them from the value. The tests below are what checks that
// claim — a key the type promises but the merge drops would otherwise reach
// call sites as a silent `undefined` rather than a type error.

/** Read a key out of a literal-keyed aggregator without indexing it by a
 *  `string` (which the narrow key union rejects). */
function lookup(record: object, key: string): unknown {
  return new Map(Object.entries(record)).get(key);
}

test("every plugin META contribution reaches the live aggregators", async () => {
  const toolNames = await import("../../src/config/toolNames.js");
  const apiRoutes = await import("../../src/config/apiRoutes.js");
  const pubsub = await import("../../src/config/pubsubChannels.js");
  const paths = await import("../../server/workspace/paths.js");
  // Widening assignment (not a cast): the aggregators consume the METAs
  // through exactly this `readonly PluginMeta[]` view, so the optional
  // dimensions read the same way here as they do in the pipeline.
  const metas: readonly PluginMeta[] = BUILT_IN_PLUGIN_METAS;
  for (const meta of metas) {
    assert.equal(lookup(toolNames.TOOL_NAMES, meta.toolName), meta.toolName, `TOOL_NAMES.${meta.toolName}`);
    for (const [key, value] of Object.entries(meta.workspaceDirs ?? {})) {
      assert.equal(lookup(paths.WORKSPACE_DIRS, key), value, `WORKSPACE_DIRS.${key}`);
    }
    for (const [key, value] of Object.entries(meta.staticChannels ?? {})) {
      assert.equal(lookup(pubsub.PUBSUB_CHANNELS, key), value, `PUBSUB_CHANNELS.${key}`);
    }
    if (meta.apiRoutes === undefined) continue;
    const namespace = meta.apiNamespace ?? meta.toolName;
    const group = lookup(apiRoutes.API_ROUTES, namespace);
    assert.ok(group, `API_ROUTES.${namespace} present`);
    for (const [key, spec] of Object.entries(meta.apiRoutes)) {
      assert.deepEqual(lookup(Object(group), key), { method: spec.method, url: `/api/${namespace}${spec.path}` }, `API_ROUTES.${namespace}.${key}`);
    }
  }
});

// Compile-time half of the same contract: `yarn typecheck:test` fails if a
// merged aggregator ever widens a literal to `string`. Widening type-checks
// fine at every call site (a literal is assignable to `string`), so nothing
// else in the suite would notice — but `WORKSPACE_PATHS.<key>` lookups and
// `role.availablePlugins` typo-checking both rest on these staying narrow.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type ToolNamesMap = (typeof import("../../src/config/toolNames.js"))["TOOL_NAMES"];
type ApiRoutesMap = (typeof import("../../src/config/apiRoutes.js"))["API_ROUTES"];
type PubSubMap = (typeof import("../../src/config/pubsubChannels.js"))["PUBSUB_CHANNELS"];
type WorkspaceDirsMap = (typeof import("../../server/workspace/paths.js"))["WORKSPACE_DIRS"];

test("merged aggregator types keep their string literals", () => {
  // Plugin-contributed keys.
  const pluginToolName: Exact<ToolNamesMap["manageAccounting"], "manageAccounting"> = true;
  const pluginChannel: Exact<PubSubMap["accountingBooks"], "accounting:books"> = true;
  const pluginDir: Exact<WorkspaceDirsMap["accountingBooks"], "data/accounting/books"> = true;
  // Host-owned keys.
  const hostToolName: Exact<ToolNamesMap["textResponse"], "text-response"> = true;
  const hostRoute: Exact<ApiRoutesMap["health"], "/api/health"> = true;
  const hostDir: Exact<WorkspaceDirsMap["chat"], "conversations/chat"> = true;
  // Derived unions must never collapse to bare `string`.
  const toolNameUnion: Exact<ToolName, string> = false;
  const dirKeyUnion: Exact<WorkspaceDirKey, string> = false;
  assert.deepEqual(
    [pluginToolName, pluginChannel, pluginDir, hostToolName, hostRoute, hostDir, toolNameUnion, dirKeyUnion],
    [true, true, true, true, true, true, false, false],
  );
});
