// Cross-platform resolver for the `claude` CLI binary used by every
// `child_process.spawn(...)` call site that talks to Claude Code (the
// main agent, the journal pass, the chat-index summariser, and the
// translation service).
//
// Context: on Windows, `child_process.spawn("claude", …)` falls into
// a triple-bind that takes MulmoClaude offline as soon as it is
// installed on a Windows host (#1757):
//
//   - `spawn("claude", args)`            → ENOENT (extensionless)
//   - `spawn("claude.cmd", args)`        → EINVAL since CVE-2024-27980
//   - `spawn("claude", args, {shell:true})`
//                                        → cmd.exe wraps the call and
//                                          trips the 8191-char limit
//                                          once MCP args land
//
// The only escape that respects all three constraints is to spawn the
// native `claude.exe` directly (no wrapper, no shell, full Win32
// command-line headroom). On every non-Windows platform the literal
// string "claude" works fine — there is no .cmd / cmd.exe involvement
// and PATH lookup behaves the way Node's documentation describes.

import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync as nodeExistsSync, readdirSync as nodeReaddirSync } from "node:fs";
import path from "node:path";

// All Windows-side path joins go through `path.win32` so the candidates
// we generate use backslash separators even when the host running this
// code is Posix (e.g. unit tests on macOS). On a real Windows host
// `path.win32` and `path` are the same module.
const winPath = path.win32;

const PACKAGE_REL_PATH = winPath.join("@anthropic-ai", "claude-code", "bin", "claude.exe");
const PARENT_WALK_DEPTH = 4;
const INSTALL_HINT = "Install with: npm install -g @anthropic-ai/claude-code";

// Typed "claude CLI is not on this machine" error. Consumers across
// the codebase (journal, memory, chat-index, translation) use
// `err instanceof ClaudeCliNotFoundError` to self-disable for the
// rest of the process lifetime instead of retrying with a generic
// ENOENT. Lives here (not in `archivist-cli.ts`) so the synchronous
// throw from `claudeBinPath()` produces the same typed contract as
// the existing async ENOENT detection at every spawn site —
// archivist-cli re-exports for backward compatibility.
export class ClaudeCliNotFoundError extends Error {
  constructor(message?: string) {
    super(message ?? "`claude` CLI is not available on PATH");
    this.name = "ClaudeCliNotFoundError";
  }
}

export interface ResolveOptions {
  /** Defaults to `process.platform`. */
  readonly platform?: typeof process.platform;
  /** Defaults to `node:child_process` `spawnSync`. */
  readonly spawnSync?: typeof nodeSpawnSync;
  /** Defaults to `node:fs` `existsSync`. */
  readonly existsSync?: typeof nodeExistsSync;
  /** Defaults to `node:fs` `readdirSync`. Used to enumerate pnpm's
   *  `global/<version>/` directories so the probe stays version-
   *  agnostic (pnpm bumps the global-store major every few releases). */
  readonly readdirSync?: typeof nodeReaddirSync;
  /** Defaults to `process.env`. */
  readonly env?: typeof process.env;
  /** Tests reset the module-level cache between cases. */
  readonly resetCache?: boolean;
}

let cachedBin: string | null | undefined;

/**
 * Returns the binary to hand to `child_process.spawn(...)` for the
 * claude CLI. On non-Windows this is the string "claude" (PATH lookup);
 * on Windows this is the absolute path to a `claude.exe` we located
 * via PATH probing or known package-manager prefixes.
 *
 * Throws a descriptive `Error` (with install hint) when every probe on
 * Windows misses — that surfaces a clear "install the CLI" message
 * instead of an opaque ENOENT later inside `spawn`.
 */
export function claudeBinPath(options: ResolveOptions = {}): string {
  if (options.resetCache) cachedBin = undefined;
  if (typeof cachedBin === "string") return cachedBin;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    cachedBin = "claude";
    return cachedBin;
  }
  const resolved = resolveOnWindows(options);
  if (resolved) {
    cachedBin = resolved.path;
    return resolved.path;
  }
  cachedBin = null;
  throw new ClaudeCliNotFoundError(formatNotFoundError(options));
}

interface Resolved {
  readonly path: string;
}

function resolveOnWindows(options: ResolveOptions): Resolved | null {
  for (const candidate of windowsCandidates(options)) {
    if (callExistsSync(options, candidate)) return { path: candidate };
  }
  return null;
}

// Generator of candidate `claude.exe` paths to probe, in priority
// order. Lazy so we stop the moment `resolveOnWindows` finds a hit.
function* windowsCandidates(options: ResolveOptions): Generator<string> {
  yield* candidatesFromWhereProbe(options);
  yield* candidatesFromNpmPrefix(options);
  yield* candidatesFromEnvDefaults(options);
}

// 1. `where claude` — the canonical PATH probe, in the same PATH order
//    the launcher's `claude --version` check resolves. A `claude.exe`
//    line (native installer, WinGet) is spawnable as-is; any other line
//    is a package-manager shim, so walk up PARENT_WALK_DEPTH levels
//    looking for `node_modules/@anthropic-ai/claude-code/bin/claude.exe`.
//    Covers npm-global, yarn-global, pnpm-global, nvm-windows, Volta,
//    and any custom `npm prefix -g` because we are starting from a
//    real PATH entry.
function* candidatesFromWhereProbe(options: ResolveOptions): Generator<string> {
  const out = runSpawnSync(options, "where", ["claude"]);
  if (!out) return;
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isExePath(trimmed)) {
      yield trimmed;
      continue;
    }
    yield* walkUpForPackage(options, winPath.dirname(trimmed));
  }
}

function isExePath(candidate: string): boolean {
  return winPath.extname(candidate).toLowerCase() === ".exe";
}

// 2. `npm config get prefix` — covers the case where the npm prefix
//    is not on PATH (rare, but happens when shells are configured
//    without the npm bin shim).
function* candidatesFromNpmPrefix(options: ResolveOptions): Generator<string> {
  const out = runSpawnSync(options, "npm", ["config", "get", "prefix"]);
  if (!out) return;
  const prefix = out.trim();
  if (prefix) yield winPath.join(prefix, "node_modules", PACKAGE_REL_PATH);
}

// 3. Standard env-var-anchored defaults for npm / yarn / pnpm.
function* candidatesFromEnvDefaults(options: ResolveOptions): Generator<string> {
  const env = options.env ?? process.env;
  const appData = env.APPDATA;
  const localAppData = env.LOCALAPPDATA;
  if (appData) {
    // npm default global prefix.
    yield winPath.join(appData, "npm", "node_modules", PACKAGE_REL_PATH);
  }
  if (localAppData) {
    // Yarn classic global node_modules layout.
    yield winPath.join(localAppData, "Yarn", "config", "global", "node_modules", PACKAGE_REL_PATH);
    // pnpm global is `<root>/global/<version>/node_modules/...` —
    // enumerate `<root>/global/` so every current and future major
    // (5, 6, 7, 8, …) is picked up automatically.
    yield* pnpmGlobalCandidates(options, winPath.join(localAppData, "pnpm"));
  }
  // Native installer (`install.ps1`) default, for when its bin dir is not on PATH yet.
  if (env.USERPROFILE) yield winPath.join(env.USERPROFILE, ".local", "bin", "claude.exe");
}

// Walk up from `startDir` looking for the @anthropic-ai/claude-code
// package's `claude.exe`. Yields candidate paths; the outer loop
// checks `existsSync` to keep the test seam small.
//
// At each level we probe a handful of subpaths to cover the three
// package managers' layouts:
//   - npm:   `<bin-dir>/node_modules/...`               (same dir as cmd)
//   - yarn:  `<prefix>/config/global/node_modules/...`  (sibling of bin/)
//   - pnpm:  `<prefix>/global/<version>/node_modules/...`
// `<bin-dir>` here is the dir that contained the `.cmd` wrapper, so
// step 0 catches npm immediately and step 1 catches the typical yarn
// classic install one level up.
function* walkUpForPackage(options: ResolveOptions, startDir: string): Generator<string> {
  let dir = startDir;
  for (let depth = 0; depth <= PARENT_WALK_DEPTH; depth++) {
    yield winPath.join(dir, "node_modules", PACKAGE_REL_PATH);
    yield winPath.join(dir, "config", "global", "node_modules", PACKAGE_REL_PATH);
    yield* pnpmGlobalCandidates(options, dir);
    const parent = winPath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

// pnpm's global store lives at `<root>/global/<major-version>/...` and
// the major bumps every few releases (5, 6, 7, 8, ...). Hard-coding a
// version list ages badly — enumerate the `global/` dir at probe time
// instead so any current and future major picks up automatically.
// Silent-skip when `<dir>/global/` doesn't exist or isn't readable;
// readdirSync throwing must not abort the wider candidate walk.
function* pnpmGlobalCandidates(options: ResolveOptions, dir: string): Generator<string> {
  const readdirSync = options.readdirSync ?? nodeReaddirSync;
  const globalDir = winPath.join(dir, "global");
  let result: unknown;
  try {
    result = readdirSync(globalDir);
  } catch {
    return;
  }
  // `readdirSync`'s overload union (`string[] | Buffer[] | Dirent[]`)
  // can't be narrowed by the default invocation alone; filter for the
  // string case we care about so the helper stays robust even if a
  // caller (test mock or alternate fs adapter) hands back a different
  // shape.
  if (!Array.isArray(result)) return;
  for (const entry of result) {
    if (typeof entry !== "string") continue;
    yield winPath.join(globalDir, entry, "node_modules", PACKAGE_REL_PATH);
  }
}

// Probe helper for the small `where claude.cmd` / `npm config get
// prefix` lookups during resolution. `shell: true` on Windows so the
// `.cmd` shim for `npm` resolves cleanly (same CVE-2024-27980 reason
// we're avoiding for the agent calls — but these probes are fixed,
// short commands well below the cmd.exe 8191-char limit, so the
// shell wrap is safe here).
function runSpawnSync(options: ResolveOptions, command: string, args: readonly string[]): string | null {
  const spawnSync = options.spawnSync ?? nodeSpawnSync;
  const useShell = (options.platform ?? process.platform) === "win32";
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(command, args, { encoding: "utf8", shell: useShell });
  } catch {
    return null;
  }
  if (result.error || result.status !== 0) return null;
  if (typeof result.stdout !== "string") return null;
  return result.stdout;
}

function callExistsSync(options: ResolveOptions, candidate: string): boolean {
  const existsSync = options.existsSync ?? nodeExistsSync;
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}

function formatNotFoundError(options: ResolveOptions): string {
  const probed = [...windowsCandidates(options)];
  const lines = ["claude CLI binary not found. Tried:"];
  for (const probe of probed) lines.push(`  - ${probe}`);
  lines.push(INSTALL_HINT);
  return lines.join("\n");
}
