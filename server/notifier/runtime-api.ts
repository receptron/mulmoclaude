// Plugin-facing notifier API. The host attaches a per-plugin
// instance of `NotifierRuntimeApi` to the `PluginRuntime` it
// constructs for each plugin (see `server/plugins/runtime.ts`).
// `pluginPkg` is auto-bound to the calling plugin's pkg name so
// plugins cannot publish under another plugin's namespace.
//
// Plugin authors access this surface via type assertion:
//
//   import type { PluginRuntime } from "gui-chat-protocol";
//   import type { MulmoclaudeRuntime } from "<mulmoclaude>/notifier/runtime-api";
//   export default definePlugin((runtime: PluginRuntime) => {
//     const { notifier } = runtime as MulmoclaudeRuntime;
//     // notifier.publish(...) / notifier.clear(...)
//   });
//
// Once the API stabilises, this is a candidate for upstreaming
// into gui-chat-protocol so the cast goes away.

import type { PluginRuntime } from "gui-chat-protocol";
import type { NotifierEntry, NotifierLifecycle, NotifierSeverity } from "./types.js";
import type { TasksRuntimeApi } from "../plugins/runtime-tasks-api.js";
import type { ChatRuntimeApi } from "../plugins/runtime-chat-api.js";

export type { TasksRuntimeApi, PluginTaskRegistration, PluginTaskSchedule } from "../plugins/runtime-tasks-api.js";
export type { ChatRuntimeApi, ChatStartInput, ChatStartResult } from "../plugins/runtime-chat-api.js";

/** Caller-supplied input for the plugin-facing `publish`. Same shape
 *  as `PublishInput` minus `pluginPkg`, which the host fills in
 *  automatically from the calling plugin's pkg name.
 *
 *  Two publish-time rules apply to `action` lifecycle, enforced by the
 *  engine — the only place they can be, since publish has no HTTP
 *  surface (see `server/api/routes/notifier.ts`):
 *
 *    - `navigateTarget` MUST be a non-empty string.
 *    - `severity` MUST NOT be `"info"`.
 *
 *  Violations cause `publish()` to throw. The runtime check exists in
 *  addition to (not instead of) any future type-level discriminated
 *  union; for now it's plain runtime validation. */
export interface PluginPublishInput<TPluginData = unknown> {
  severity: NotifierSeverity;
  title: string;
  body?: string;
  lifecycle?: NotifierLifecycle;
  navigateTarget?: string;
  pluginData?: TPluginData;
}

export interface NotifierRuntimeApi {
  /** Publish a notification scoped to this plugin. The engine assigns
   *  a UUID synchronously and returns it. **Throws** if the input
   *  violates the `action` lifecycle rules (see `PluginPublishInput`):
   *  `action` requires a non-empty `navigateTarget` and cannot pair
   *  with `info` severity. */
  publish: <TPluginData = unknown>(input: PluginPublishInput<TPluginData>) => Promise<{ id: string }>;
  /** In-place update of an existing entry's presentation. Only the
   *  fields present on `patch` are rewritten; `id`, `pluginPkg`,
   *  `lifecycle`, and `createdAt` stay fixed. Emits an `updated`
   *  event — no history record is written.
   *
   *  Use this rather than clear-then-publish when the underlying
   *  obligation is the same and only its presentation has shifted
   *  (e.g. todo text renamed, Encore obligation `displayName`
   *  amended, severity escalated). Preserves the entry's id, keeps
   *  the bell history free of supersede noise, and avoids the
   *  disappear/reappear that subscribers would otherwise see.
   *
   *  No-op (no throw) on unknown id, cross-plugin id, or a merged
   *  shape that would violate publish-time invariants (action + info
   *  severity, empty title, etc.). The silent skip matches `clear`'s
   *  isolation semantics — plugin authors can't tell the failure
   *  reasons apart, and we don't leak them by throwing differently. */
  update: <TPluginData = unknown>(
    id: string,
    patch: {
      severity?: NotifierSeverity;
      title?: string;
      body?: string;
      navigateTarget?: string;
      pluginData?: TPluginData;
    },
  ) => Promise<void>;
  /** Clear an entry by id. No-op (no throw) when:
   *   - the id is unknown, OR
   *   - the entry exists but belongs to a different plugin.
   *
   *  The latter keeps per-plugin isolation: a plugin holding another
   *  plugin's id (e.g. via a future leak) silently can't dismiss it.
   *  Internally backed by `engine.clearForPlugin(pluginPkg, id)`. */
  clear: (id: string) => Promise<void>;
  /** Point lookup for an active entry the caller owns. Returns the
   *  entry, or `undefined` when the id is unknown OR belongs to
   *  another plugin (same isolation contract as `clear`).
   *
   *  Use this to detect ghost-bell ids — entries the plugin
   *  published whose bell was dismissed via the bell UI or wiped
   *  by a crash. A reconciler that calls `update` on a ghost id
   *  gets a silent no-op back (the bell is gone, the patch has
   *  nothing to land on), so without this check the plugin's
   *  ticket store would falsely converge to "in sync" and the bell
   *  would never come back. Encore's reconciler relies on the
   *  engine equivalent (`engine.get`) for the same purpose. */
  get: (id: string) => Promise<NotifierEntry | undefined>;
}

/** The runtime shape MulmoClaude actually provides — the
 *  gui-chat-protocol `PluginRuntime` plus the host's extensions:
 *  notifier (publish/clear), tasks (one periodic tick per plugin),
 *  and chat (seed a new chat with an instruction prompt). */
export type MulmoclaudeRuntime = PluginRuntime & {
  notifier: NotifierRuntimeApi;
  tasks: TasksRuntimeApi;
  chat: ChatRuntimeApi;
};
