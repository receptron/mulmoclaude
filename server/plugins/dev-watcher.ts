// Watch each dev plugin's `dist/` and emit one event per change burst
// (PR3 of #1159). Vite writes 4-5 files within ~100ms on a single
// rebuild, so debounce → 1 reload per save instead of 5.
//
// Uses Node's built-in `fs.watch` with `recursive: true` rather than
// chokidar to avoid pulling another runtime dependency. Recursive
// watching is reliable on macOS / Linux / Windows starting from Node
// 20.12 (Linux had race conditions and crash-on-delete bugs in earlier
// 20.x patches), which engines.node (>=22.19) clears comfortably.
//
// The publish + warnServerSideChange callbacks are injected so tests
// can exercise the debounce + classification logic without booting the
// pubsub or hitting the structured logger. `onWatcherError` is also
// injectable so tests can verify the crash-isolation path; production
// wiring routes it through the structured logger.

import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

import type { RuntimePlugin } from "./runtime-loader.js";
import { DEV_PLUGIN_WATCH_DEBOUNCE_MS } from "../utils/time.js";

// Relative path (within `dist/`) of the server entry. Only the root
// `dist/index.js` triggers the "restart mulmoclaude" warning — vite
// also emits chunks like `dist/assets/index.js` for code-split Vue
// components, and those don't need a launcher restart.
const SERVER_ENTRY_RELATIVE_PATH = "index.js";

function isServerEntry(relativePath: string): boolean {
  // `fs.watch` reports filenames with the platform path separator —
  // backslashes on Windows. Normalize before comparison so a match
  // is cross-platform, not just POSIX.
  return relativePath.split(/[\\/]/).join("/") === SERVER_ENTRY_RELATIVE_PATH;
}

export interface DevPluginChangedPayload {
  /** Files changed during the debounce window (relative to dist/). */
  changedFiles: string[];
  /** True iff `dist/index.js` was among them — caller surfaces a
   *  prominent log so the dev knows server-side hot-reload is not
   *  possible and they need to restart mulmoclaude. */
  serverSideChange: boolean;
}

/** Sort the debounced file set and flag whether the server entry
 *  (`dist/index.js`) is among the changes. */
export function summarizeChangedFiles(files: ReadonlySet<string>): DevPluginChangedPayload {
  const changedFiles = Array.from(files).sort();
  const serverSideChange = changedFiles.some(isServerEntry);
  return { changedFiles, serverSideChange };
}

/** Binds a watcher to `absDistPath` and forwards each changed relative
 *  path to `onChange`. Injectable so tests drive synthetic file events
 *  without touching the real filesystem. */
type WatcherFactory = (absDistPath: string, onChange: (relativePath: string) => void) => FSWatcher;

export interface WatchDevPluginsOptions {
  /** Called once per debounce burst per plugin. */
  publish: (pluginName: string, payload: DevPluginChangedPayload) => void;
  /** Called when `dist/index.js` is in the burst. The watcher still
   *  publishes (the browser reload is harmless), but the dev needs
   *  this hint to know why their server-side change didn't take. */
  warnServerSideChange?: (pluginName: string) => void;
  /** Called when an `fs.watch` instance emits an `error` event
   *  (e.g. ENOENT after a `rm -rf dist/` clean-rebuild, mount
   *  unavailability, etc.). The watcher closes itself and stops
   *  firing for that plugin so the rest of mulmoclaude keeps
   *  running. Without this handler, the unhandled `error` event
   *  would propagate as an uncaught exception and crash the
   *  server. */
  onWatcherError?: (pluginName: string, error: Error) => void;
  /** Override for testing. */
  debounceMs?: number;
  /** Override the watcher factory for tests. Default uses node:fs. */
  watcherFactory?: WatcherFactory;
}

export interface DevWatcherHandle {
  /** Stop every watcher. Safe to call multiple times. */
  close: () => void;
}

function defaultWatcherFactory(absDistPath: string, onChange: (relativePath: string) => void): FSWatcher {
  return watch(absDistPath, { recursive: true }, (_eventType, filename) => {
    if (typeof filename === "string" && filename.length > 0) {
      onChange(filename);
    }
  });
}

interface PluginWatchContext {
  factory: WatcherFactory;
  opts: WatchDevPluginsOptions;
  debounceMs: number;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  pendingFiles: Map<string, Set<string>>;
}

/** Watch one plugin's `dist/`, debouncing each burst of file writes
 *  into a single publish. Mutates the shared `timers` / `pendingFiles`
 *  maps keyed by plugin name so `close()` can cancel every plugin's
 *  in-flight burst. */
function createPluginWatcher(plugin: RuntimePlugin, ctx: PluginWatchContext): FSWatcher {
  const { factory, opts, debounceMs, timers, pendingFiles } = ctx;
  const absDistPath = path.join(plugin.cachePath, "dist");
  const watcher = factory(absDistPath, (relativePath) => {
    const buffer = pendingFiles.get(plugin.name) ?? new Set<string>();
    buffer.add(relativePath);
    pendingFiles.set(plugin.name, buffer);

    const existing = timers.get(plugin.name);
    if (existing) clearTimeout(existing);
    timers.set(
      plugin.name,
      setTimeout(() => {
        const files = pendingFiles.get(plugin.name);
        pendingFiles.delete(plugin.name);
        timers.delete(plugin.name);
        if (!files || files.size === 0) return;
        const summary = summarizeChangedFiles(files);
        if (summary.serverSideChange) opts.warnServerSideChange?.(plugin.name);
        opts.publish(plugin.name, summary);
      }, debounceMs),
    );
  });
  // Isolate each watcher's failure: log + close just this one instead
  // of letting the unhandled `error` event terminate the whole server.
  // Real-world trigger: `rm -rf dist && yarn build` emits ENOENT
  // mid-watch (fs.watch surfaces it as an `error`, not a `change`).
  // Production wires onWatcherError through the structured logger.
  watcher.on("error", (err) => {
    opts.onWatcherError?.(plugin.name, err);
    try {
      watcher.close();
    } catch {
      // Already torn down — nothing to do.
    }
    const pending = timers.get(plugin.name);
    if (pending) clearTimeout(pending);
    timers.delete(plugin.name);
    pendingFiles.delete(plugin.name);
  });
  return watcher;
}

/** Attach a debounced watcher to each dev plugin's `dist/`. Returns a
 *  handle whose `close()` shuts every watcher down — call it from the
 *  graceful shutdown path. */
export function watchDevPlugins(plugins: readonly RuntimePlugin[], opts: WatchDevPluginsOptions): DevWatcherHandle {
  const debounceMs = opts.debounceMs ?? DEV_PLUGIN_WATCH_DEBOUNCE_MS;
  const factory = opts.watcherFactory ?? defaultWatcherFactory;
  const watchers: FSWatcher[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingFiles = new Map<string, Set<string>>();

  for (const plugin of plugins) {
    watchers.push(createPluginWatcher(plugin, { factory, opts, debounceMs, timers, pendingFiles }));
  }

  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pendingFiles.clear();
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // Ignore — the watcher might have already errored out.
        }
      }
    },
  };
}
