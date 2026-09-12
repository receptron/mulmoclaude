// Plugin-facing task scheduler API. The host attaches a per-plugin
// instance of `TasksRuntimeApi` to the `PluginRuntime` it constructs
// for each plugin (`server/plugins/runtime.ts`). One periodic tick
// per plugin — the registry id is `plugin:<pkg>`, derived from the
// caller's pkg name; the plugin doesn't supply one.
//
// Plugin authors mirror the shape and narrow to it, identical to the
// notifier extension — they cannot import this type, since a plugin
// may not reach uphill into `server/`:
//
//   import type { PluginRuntime } from "gui-chat-protocol";
//   type MulmoclaudeRuntime = PluginRuntime & { tasks: … };
//   export default definePlugin((runtime) => {
//     const { tasks } = runtime as MulmoclaudeRuntime;
//     tasks.register({ schedule: { ... }, run: async () => { ... } });
//   });
//
// Once the API stabilises (Phase 3 of the Encore plan), this is a
// candidate for upstreaming into gui-chat-protocol so the cast goes
// away.

/** Same shape as the host task manager's `TaskSchedule`
 *  (`server/events/task-manager/index.ts`). Forwarded verbatim to the
 *  task manager — no richer types layered at the plugin runtime
 *  level. Plugins build "remind 3 weeks before" / "weekly on
 *  Tuesdays" logic inside `run()` against their own files. */
export type PluginTaskSchedule = { type: "interval"; intervalMs: number } | { type: "daily"; time: string }; // "HH:MM" UTC

export interface PluginTaskRegistration {
  /** When to fire. Forwarded verbatim to the host task manager. */
  schedule: PluginTaskSchedule;
  /** Tick handler. Errors are caught and logged by the host task
   *  manager (`task-manager/index.ts:89`); they do not propagate. */
  run: () => Promise<void>;
}

export interface TasksRuntimeApi {
  /** Register the plugin's single periodic tick.
   *
   *  - Registry id is `plugin:<pkg>`; the plugin does not supply one.
   *  - Cap-at-1: the second call from the same plugin throws with a
   *    friendly message ("Plugin <pkg> already registered a task —
   *    only one tick per plugin is allowed").
   *  - No `unregister()`. Plugins load once at boot
   *    (`server/index.ts:723-`); server-side hot-reload is not
   *    supported, so a clean lifecycle hook isn't needed.
   *
   *  Throws synchronously on duplicate registration so plugin authors
   *  see the failure during setup, not at first tick. */
  register: (task: PluginTaskRegistration) => void;
}
