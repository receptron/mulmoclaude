// Runtime plugin loader (#1043 C-2).
//
// At server boot:
//   1. Read the install ledger (`plugins/plugins.json`).
//   2. For each entry, ensure the tgz is extracted to
//      `plugins/.cache/<name>/<version>/` (cache hit = skip).
//   3. Dynamic-import the plugin's `dist/index.js` to pull out
//      `TOOL_DEFINITION`. The plugin module is bundled (per the
//      contract documented in `docs/plugin-development.md`) so its
//      bare imports resolve against the on-disk chunk siblings, not
//      against a non-existent `node_modules/` underneath the cache.
//
// This module is called from BOTH the parent server (`server/index.ts`)
// and the spawned MCP child (`server/agent/mcp-server.ts`) — they share
// the cache, so the second call is fast (no re-extract).
//
// Failures don't abort boot. A bad ledger entry, missing tgz, or a
// definition that fails to import gets logged and skipped; healthy
// plugins still load.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isWithinRoot } from "@mulmoclaude/core/files";
import { pathToFileURL } from "node:url";
import type { PluginRuntime, ToolDefinition } from "gui-chat-protocol";
import { isPluginFactory } from "gui-chat-protocol";
import type { MulmoclaudeRuntime } from "../notifier/runtime-api.js";
import { WORKSPACE_PATHS } from "../workspace/paths.js";
import { readLedger, type LedgerEntry } from "../utils/files/plugins-io.js";
import { isRecord } from "../utils/types.js";
import { log } from "../system/logger/index.js";

const LOG_PREFIX = "plugins/runtime";

export interface RuntimePlugin {
  /** npm package name, e.g. `@gui-chat-plugin/weather`. */
  name: string;
  /** Semver string from the tgz's `package.json`. */
  version: string;
  /** Absolute path to the extracted plugin directory under
   *  `plugins/.cache/<name>/<version>/`. */
  cachePath: string;
  /** TOOL_DEFINITION export from the plugin's `dist/index.js`. The
   *  shape matches static plugins in `plugin-names.ts`, so the same
   *  MCP merge / dispatch path applies. */
  definition: ToolDefinition;
  /** Server-side handler the dispatch route calls. The convention
   *  across @gui-chat-plugin packages is to export it under the same
   *  key as `TOOL_DEFINITION.name` (e.g. weather → `fetchWeather`,
   *  browse → `browse`); we capture it at load time so the dispatch
   *  route doesn't have to re-resolve. The signature follows
   *  gui-chat-protocol's `ToolPluginCore.execute`:
   *  `(context: ToolContext, args) => Promise<ToolResult>` — context
   *  first, args second. `null` means the module shipped a
   *  TOOL_DEFINITION but no matching handler — the dispatch will 500
   *  with a useful message. */
  execute: ((context: unknown, args: unknown) => unknown) | null;
  /** Optional short, URL-safe alias for the OAuth callback route
   *  (#1162). When the plugin's module exports
   *  `OAUTH_CALLBACK_ALIAS = "<alias>"`, the host registers
   *  `/api/plugins/runtime/oauth-callback/<alias>` and forwards
   *  `kind: "oauthCallback"` dispatch args to this plugin. The
   *  package-name-in-path shape was rejected by Spotify Dashboard
   *  because of the percent-encoded `@` / `/` characters, so OAuth
   *  plugins declare a short alias (e.g. `"spotify"`) instead. Null
   *  for non-OAuth plugins. */
  oauthCallbackAlias: string | null;
}

interface PackageJson {
  name?: string | undefined;
  version?: string | undefined;
  /** Left unnarrowed because every legal Node.js `exports` value is
   *  accepted here — string sugar, array fallback chain, condition or
   *  subpath map. `pickExportsTarget` is what discriminates them. */
  exports?: unknown | undefined;
  main?: string | undefined;
  module?: string | undefined;
}

const isToolDefinition = (value: unknown): value is ToolDefinition => {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && typeof value.description === "string";
};

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Rebuild the fields the loader reads from arbitrary parsed JSON.
 *  Field-by-field rather than a predicate, so a plugin shipping a
 *  non-string `main` can't reach `path.join` as if it were one.
 *  Returns null when the parsed value isn't an object at all. */
export function toPackageJson(value: unknown): PackageJson | null {
  if (!isRecord(value)) return null;
  return {
    name: optionalString(value.name),
    version: optionalString(value.version),
    exports: value.exports,
    main: optionalString(value.main),
    module: optionalString(value.module),
  };
}

/** Resolve the entry-point path from a plugin's `package.json`. Covers
 *  the four legal `exports` shapes per the Node.js spec, then falls
 *  through to `module` / `main` for legacy packages.
 *
 *  Legal `exports` forms (Node.js docs):
 *    1. String sugar:     `"exports": "./index.js"`
 *    2. Conditional root: `"exports": { "import": "./esm.js", … }`
 *    3. Subpath map:      `"exports": { ".": "./index.js", "./util": "./util.js", … }`
 *    4. Subpath + cond.:  `"exports": { ".": { "import": "./esm.js", "require": "./cjs.js" } }`
 *
 *  Earlier the loader only matched form (4) and fell straight through
 *  to `module` / `main`. Real npm packages using forms (1)-(3) failed
 *  to load (#1077 review). */
function resolveEntrySpecifier(pkg: PackageJson): string | null {
  const fromExports = resolveExportsField(pkg.exports);
  if (fromExports) return fromExports;
  if (typeof pkg.module === "string") return pkg.module;
  if (typeof pkg.main === "string") return pkg.main;
  return null;
}

function resolveExportsField(exportsField: unknown): string | null {
  // Form 1: top-level string sugar.
  // Form A: array fallback chain (e.g. ["./dist/index.js", "./fallback.js"]).
  // Form 2: conditional root (e.g. `{ import, require, default }`).
  // Form 3 / 4: subpath map keyed by `.` — value can be a string,
  //   array, or condition object (Codex review iter-2 on #1116).
  const root = pickExportsTarget(exportsField);
  if (root) return root;
  if (isRecord(exportsField)) {
    return pickExportsTarget(exportsField["."]);
  }
  return null;
}

/** Walk a Node.js `exports` value and return the first string entry
 *  point this ESM loader can use. Handles every legal target shape:
 *
 *    - string: return it directly.
 *    - array: try each element in order; first resolvable wins.
 *      Per the spec arrays are a fallback chain — Node tries each
 *      until one resolves on disk. We don't probe disk here, so
 *      "first string-or-resolvable-condition" approximates that.
 *    - condition object: prefer `import` (ESM-specific), then
 *      `default` (universal fallback).
 *    - everything else (e.g. only `require`, only nested arrays of
 *      condition objects with no string targets): null. */
function pickExportsTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = pickExportsTarget(entry);
      if (resolved) return resolved;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  // Condition object — `import` first (the ESM-specific condition
  // match), then `default` (the universal fallback that "always
  // matches" per the Node.js spec).
  const fromImport = pickExportsTarget(value.import);
  if (fromImport) return fromImport;
  return pickExportsTarget(value.default);
}

/** Sentinel file written at the end of a successful extract. The
 *  loader uses its presence (not just `existsSync(cachePath)`) as the
 *  cache-validity check, so a partial extract (interrupted tar, ENOSPC
 *  half-write) is detected and re-extracted on the next boot instead
 *  of becoming a permanent broken state. */
export const EXTRACT_MARKER = ".extract-complete";

export function isCacheValid(cachePath: string): boolean {
  return existsSync(path.join(cachePath, EXTRACT_MARKER));
}

/** Run `tar xzf` to extract a tgz into the version-keyed cache slot.
 *  `--strip-components=1` drops the `package/` prefix that npm packs
 *  add. `execFileSync` (not `execSync`) so paths bypass shell parsing
 *  and never trip on metacharacters in workspace paths. Synchronous
 *  because boot is single-threaded and the alternative (a stream
 *  pipeline) adds dependencies for no benefit.
 *
 *  On failure, the partial directory is removed so the next boot
 *  re-extracts cleanly (no sticky broken state). The completion
 *  marker is written ONLY after tar exits 0 — readers should test
 *  `isCacheValid()`, not `existsSync(cachePath)`. */
function extractTgz(tgzAbs: string, destDir: string): void {
  // Wipe any leftover from a previous failed extract before writing.
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", tgzAbs, "-C", destDir, "--strip-components=1"], { stdio: "pipe" });
    writeFileSync(path.join(destDir, EXTRACT_MARKER), "");
  } catch (err) {
    // Tear down the partial tree so isCacheValid() stays false next boot.
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

function readPackageJson(cachePath: string): PackageJson | null {
  const pkgPath = path.join(cachePath, "package.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const pkg = toPackageJson(parsed);
    if (!pkg) log.warn(LOG_PREFIX, "package.json is not an object — skipping", { path: pkgPath });
    return pkg;
  } catch (err) {
    log.warn(LOG_PREFIX, "package.json read/parse failed", { path: pkgPath, error: String(err) });
    return null;
  }
}

/** Optional per-plugin runtime factory (#1110). When provided, plugins
 *  whose `dist/index.js` exports a factory via `export default
 *  definePlugin(...)` get the constructed runtime injected at load
 *  time. When omitted, factory plugins are loaded with a stub runtime
 *  whose handler call throws — fine for the MCP child process which
 *  only needs `TOOL_DEFINITION` for `tools/list`; not OK for the
 *  parent server which actually invokes the handler. The parent
 *  always passes `runtimeFactory`; the child does not. */
export interface LoaderDeps {
  runtimeFactory?: (pkgName: string) => PluginRuntime;
}

/** Naming the operation in the message is what lets a plugin author
 *  tell "the host is a definition-only loader" apart from a bug in
 *  their own setup code. */
const unavailable = (name: string, operation: string) => (): never => {
  throw new Error(`plugin/${name}: runtime.${operation} unavailable in this process (definition-only load)`);
};

function makeStubFileOps(name: string): MulmoclaudeRuntime["files"]["data"] {
  return {
    read: unavailable(name, "files.read"),
    readBytes: unavailable(name, "files.readBytes"),
    write: unavailable(name, "files.write"),
    readDir: unavailable(name, "files.readDir"),
    stat: unavailable(name, "files.stat"),
    exists: unavailable(name, "files.exists"),
    unlink: unavailable(name, "files.unlink"),
  };
}

function makeStubNotifier(name: string): MulmoclaudeRuntime["notifier"] {
  return {
    publish: unavailable(name, "notifier.publish"),
    update: unavailable(name, "notifier.update"),
    clear: unavailable(name, "notifier.clear"),
    get: unavailable(name, "notifier.get"),
  };
}

/** Stub runtime — the factory pattern requires SOME runtime to call,
 *  even if we only care about extracting `TOOL_DEFINITION`. Methods
 *  throw rather than silently no-op so a plugin that mistakenly does
 *  I/O at setup time fails loudly during boot instead of at first
 *  call.
 *
 *  Two host extensions (`tasks`, `chat` — Phase 1 of the Encore plan)
 *  are also stubbed here so plugins that destructure `runtime as
 *  MulmoclaudeRuntime` and call `tasks.register(...)` at setup time
 *  don't crash the definition-only load (e.g. the MCP child
 *  extracting `tools/list`). `tasks.register` is a SILENT no-op
 *  because tick registration is parent-only by design — the child
 *  process has no task manager to register against. `chat.start`
 *  matches the throw pattern of `fetch` / `files`, since starting a
 *  chat is a parent-only side effect a plugin should never trigger
 *  at setup time.
 *
 *  Typed as the full `MulmoclaudeRuntime` so the compiler — not a
 *  reviewer — notices when the real runtime grows a member the stub
 *  lacks (`files.artifacts` and `notifier.update` / `.get` had each
 *  drifted out of it, surfacing to plugins as `undefined`). */
function makeStubRuntime(name: string): MulmoclaudeRuntime {
  const fileOps = makeStubFileOps(name);
  const noop = () => undefined;
  return {
    pubsub: { publish: noop },
    locale: "en",
    files: { data: fileOps, config: fileOps, artifacts: fileOps },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    fetch: unavailable(name, "fetch"),
    fetchJson: unavailable(name, "fetchJson"),
    notifier: makeStubNotifier(name),
    // Silent no-op: definition-only loads (MCP child) shouldn't fail
    // just because the plugin declared a tick at setup time.
    tasks: { register: noop },
    chat: { start: unavailable(name, "chat.start") },
  };
}

/** Two carrier shapes (#1110 backward compatibility):
 *
 *   1. **Factory** (`export default definePlugin(setup)`) — `mod.default`
 *      is a function. Call it with the plugin's runtime; the return
 *      value carries `TOOL_DEFINITION` and the handler keyed by
 *      `TOOL_DEFINITION.name`. Closure over runtime gives the handler
 *      access to scoped pubsub / files / log without per-call context
 *      threading.
 *   2. **Legacy** (`export const TOOL_DEFINITION = ...; export async
 *      function <name>(context, args) ...`) — `mod.TOOL_DEFINITION` and
 *      `mod[<name>]` directly. Continues to work; existing
 *      @gui-chat-plugin packages don't need to migrate.
 */
function resolveCarrier(name: string, mod: Record<string, unknown>, deps: LoaderDeps): { carrier: Record<string, unknown>; usingFactory: boolean } {
  const defaultExport = mod.default;
  if (isPluginFactory(defaultExport)) {
    const runtime = deps.runtimeFactory ? deps.runtimeFactory(name) : makeStubRuntime(name);
    return { carrier: defaultExport(runtime), usingFactory: true };
  }
  return { carrier: mod, usingFactory: false };
}

/** Callability is the whole of what a dynamically imported export can be
 *  proved to have, so parameters and result stay `unknown` — the loader
 *  never inspects either. */
const isPluginHandler = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === "function";

/** Pull the executable from a carrier. Factory-shape handlers take
 *  `(args)` only (runtime is closed over) so we wrap to discard the
 *  legacy `context` arg the dispatch route passes. Legacy-shape
 *  handlers keep the `(context, args)` signature unchanged. Returns
 *  null when no function is exported under `definition.name` — the
 *  plugin still appears in `tools/list` but dispatch logs + 500s. */
export function resolveExecute(
  carrier: Record<string, unknown>,
  definitionName: string,
  usingFactory: boolean,
): ((context: unknown, args: unknown) => unknown) | null {
  // Own-property guard: a bare `carrier[definitionName]` for a plugin naming its
  // tool `constructor` / `toString` resolves to an Object.prototype function,
  // defeating the `typeof … !== "function"` gate below (#2319).
  const handler = Object.hasOwn(carrier, definitionName) ? carrier[definitionName] : undefined;
  if (!isPluginHandler(handler)) return null;
  if (usingFactory) return (_context, args) => handler(args);
  return handler;
}

/** Read the optional `OAUTH_CALLBACK_ALIAS` named export. Validated
 *  against `^[a-z0-9][a-z0-9-]{0,30}$` — short, lowercase,
 *  URL-friendly, can't be `..` or contain `/`. A bad alias is logged
 *  and ignored (the plugin still loads; just skips the OAuth route
 *  registration). */
const OAUTH_CALLBACK_ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
function resolveOauthCallbackAlias(name: string, mod: Record<string, unknown>): string | null {
  const raw = mod.OAUTH_CALLBACK_ALIAS;
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !OAUTH_CALLBACK_ALIAS_RE.test(raw)) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- this branch exists BECAUSE `raw` is the wrong shape; echoing whatever it stringifies to is the diagnostic.
    log.warn(LOG_PREFIX, "OAUTH_CALLBACK_ALIAS export is not a valid alias — ignoring", { name, raw: String(raw) });
    return null;
  }
  return raw;
}

/** Load a plugin from an already-extracted cache directory. Pure
 *  function — accepts paths explicitly, so tests don't need a real
 *  workspace. Returns null on any structural failure (missing
 *  package.json, missing TOOL_DEFINITION, broken import); the caller
 *  treats nulls as "skip". */
export async function loadPluginFromCacheDir(name: string, version: string, cachePath: string, deps: LoaderDeps = {}): Promise<RuntimePlugin | null> {
  const pkg = readPackageJson(cachePath);
  if (!pkg) return null;
  const entrySpec = resolveEntrySpecifier(pkg);
  if (!entrySpec) {
    log.warn(LOG_PREFIX, "no entry specifier in package.json — skipping", { name });
    return null;
  }
  const entryAbs = path.join(cachePath, entrySpec);
  try {
    const mod: unknown = await import(pathToFileURL(entryAbs).href);
    if (!isRecord(mod)) {
      log.warn(LOG_PREFIX, "plugin module namespace is not an object — skipping", { name, entrySpec });
      return null;
    }
    const { carrier, usingFactory } = resolveCarrier(name, mod, deps);
    const definition = carrier.TOOL_DEFINITION;
    if (!isToolDefinition(definition)) {
      log.warn(LOG_PREFIX, "no TOOL_DEFINITION export — skipping", { name, entrySpec, shape: usingFactory ? "factory" : "legacy" });
      return null;
    }
    const execute = resolveExecute(carrier, definition.name, usingFactory);
    if (!execute) {
      log.warn(LOG_PREFIX, "no execute handler matching TOOL_DEFINITION.name — dispatch will fail", {
        name,
        expectedExport: definition.name,
        shape: usingFactory ? "factory" : "legacy",
      });
    }
    const oauthCallbackAlias = resolveOauthCallbackAlias(name, mod);
    return { name, version, cachePath, definition, execute, oauthCallbackAlias };
  } catch (err) {
    log.error(LOG_PREFIX, "import failed", { name, entrySpec, error: String(err) });
    return null;
  }
}

/** Lexical anchor: confirm `candidate` resolves inside `base`. Catches
 *  malformed ledger entries (`name` containing `../../etc`) before we
 *  touch the disk. The asset route trusts registry membership, so a
 *  registered cachePath that escaped the base would expose arbitrary
 *  files via the unauthenticated GET — this check is the first
 *  line of defence (defence-in-depth: realpath after extract is the
 *  symlink-escape backstop). Exported for testing. */
export function ensureInsideBase(candidate: string, base: string): boolean {
  return isWithinRoot(path.resolve(base), path.resolve(candidate));
}

async function loadOne(entry: LedgerEntry, deps: LoaderDeps = {}): Promise<RuntimePlugin | null> {
  const tgzAbs = path.join(WORKSPACE_PATHS.plugins, entry.tgz);
  const cachePath = path.join(WORKSPACE_PATHS.pluginCache, entry.name, entry.version);
  // Anchor checks BEFORE any disk probe (`existsSync` / `realpath`).
  // The ledger has two separate user-controlled fields — `tgz` and
  // (`name`, `version`) — and each joins against a different base
  // (`WORKSPACE_PATHS.plugins` vs. `pluginCache`). Both must stay
  // inside their respective bases; otherwise even a stat-only probe
  // would touch a path outside the intended roots.
  if (!ensureInsideBase(tgzAbs, WORKSPACE_PATHS.plugins)) {
    log.warn(LOG_PREFIX, "ledger entry tgz escapes plugins root — skipping", { name: entry.name, tgz: entry.tgz });
    return null;
  }
  if (!ensureInsideBase(cachePath, WORKSPACE_PATHS.pluginCache)) {
    log.warn(LOG_PREFIX, "ledger entry escapes plugin cache root — skipping", {
      name: entry.name,
      version: entry.version,
    });
    return null;
  }
  if (!existsSync(tgzAbs)) {
    log.warn(LOG_PREFIX, "tgz missing — skipping", { name: entry.name, tgz: entry.tgz });
    return null;
  }
  if (!isCacheValid(cachePath)) {
    try {
      extractTgz(tgzAbs, cachePath);
      log.info(LOG_PREFIX, "extracted", { name: entry.name, version: entry.version });
    } catch (err) {
      log.error(LOG_PREFIX, "extract failed", { name: entry.name, error: String(err) });
      return null;
    }
  }
  return loadPluginFromCacheDir(entry.name, entry.version, cachePath, deps);
}

/** Read the ledger and load every healthy plugin. Returns the loaded
 *  set; failures are logged and silently skipped (see module
 *  comment).
 *
 *  Pass `deps.runtimeFactory` from the parent server so factory-shape
 *  plugins (`export default definePlugin(...)`) get a real runtime.
 *  The MCP child can call without deps — its only consumer is
 *  `tools/list` which needs `TOOL_DEFINITION` only. */
export async function loadRuntimePlugins(deps: LoaderDeps = {}): Promise<RuntimePlugin[]> {
  const entries = readLedger();
  if (entries.length === 0) return [];
  const loaded: RuntimePlugin[] = [];
  for (const entry of entries) {
    const plugin = await loadOne(entry, deps);
    if (plugin) loaded.push(plugin);
  }
  log.info(LOG_PREFIX, "loaded", { requested: entries.length, succeeded: loaded.length });
  return loaded;
}
