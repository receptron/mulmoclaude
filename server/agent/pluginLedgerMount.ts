// Docker mounts that give the sandboxed CLI a plugin ledger it can actually
// follow (#3186). The path translation itself is in `pluginLedgerPaths.ts` and
// is pure; this module is the fs half — read, rewrite, write a copy, mount it.
//
// The copies go over the originals read-only. That is not only about protecting
// the host's ledger from a container-side edit: a write-back from the container
// would put CONTAINER paths into the file the HOST reads, which is the same bug
// this fixes, pointing the other way.

import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomicSync } from "../utils/files/atomic.js";
import { claudeConfigDir } from "../utils/claudeConfigPath.js";
import { log } from "../system/logger/index.js";
import { errorMessage } from "../utils/errors.js";
import { isErrorWithCode } from "../utils/types.js";
import { CONTAINER_CLAUDE_CONFIG_DIR, rewriteInstalledPlugins, rewriteKnownMarketplaces } from "./pluginLedgerPaths.js";
import type { Platform } from "./config.js";

/** A ledger is a short index the CLI maintains, not a data file — a megabyte of
 *  it is a corrupt or hostile file rather than a big install, and reading it
 *  whole would be the one read on this path that isn't bounded. */
const MAX_LEDGER_BYTES = 1024 * 1024;

const KNOWN_MARKETPLACES_FILE = "known_marketplaces.json";
const INSTALLED_PLUGINS_FILE = "installed_plugins.json";

interface LedgerSpec {
  /** Basename inside `<claudeConfigDir>/plugins/`. */
  file: string;
  rewrite: (ledger: unknown, hostConfigDir: string, sep: string) => unknown;
}

const LEDGERS: readonly LedgerSpec[] = [
  { file: KNOWN_MARKETPLACES_FILE, rewrite: rewriteKnownMarketplaces },
  { file: INSTALLED_PLUGINS_FILE, rewrite: rewriteInstalledPlugins },
];

export interface PluginLedgerMountParams {
  /** `process.platform` at the call site. Only `win32` differs, and only in
   *  which separator the host's recorded paths use. */
  platform: Platform;
  /** Test seam. Production passes nothing and gets the real config dir. */
  hostConfigDir?: string;
  /** Test seam for where the rewritten copies land. */
  outputDir?: string;
}

export interface PluginLedgerMounts {
  /** `-v` pairs to splice into the docker argv, after the config-dir mount. */
  args: string[];
  /** Where the staged copies were written, for the caller to remove once the
   *  container has exited. `null` when nothing was staged and so nothing needs
   *  removing. Deleting it EARLIER is not safe: the container bind-mounts these
   *  files, so they must outlive its start. */
  stagingDir: string | null;
}

function readLedger(path: string): unknown {
  const stat = statSync(path);
  if (stat.size > MAX_LEDGER_BYTES) {
    log.warn("sandbox", "plugin ledger too large to translate, leaving it as-is", { path, bytes: stat.size });
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

// A missing ledger is the ordinary "no plugins installed" state and must stay
// silent; anything else is logged so a permissions problem is findable rather
// than reading as "this user has no plugins".
function readLedgerTolerant(path: string): unknown {
  try {
    return readLedger(path);
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") return null;
    log.warn("sandbox", "could not read plugin ledger, leaving it as-is", { path, error: errorMessage(error) });
    return null;
  }
}

interface StagedLedger {
  /** Basename, shared by the source copy and the container-side target. */
  file: string;
  content: string;
}

// Deciding WHAT to stage before creating anywhere to put it: a user with no
// plugins, or with all of them outside the config dir, must not leave an empty
// directory behind for every sandbox turn.
function stageableLedgers(hostConfigDir: string, sep: string): StagedLedger[] {
  return LEDGERS.flatMap((spec) => {
    const ledger = readLedgerTolerant(join(hostConfigDir, "plugins", spec.file));
    if (ledger === null) return [];
    const translated = spec.rewrite(ledger, hostConfigDir, sep);
    // Nothing under the config dir to translate (every plugin lives elsewhere,
    // or the file is already container-shaped). Mounting an identical copy would
    // only add a way for this to go wrong.
    if (JSON.stringify(translated) === JSON.stringify(ledger)) return [];
    return [{ file: spec.file, content: JSON.stringify(translated, null, 2) }];
  });
}

function mountArg(outputDir: string, file: string): string[] {
  return ["-v", `${join(outputDir, file).replace(/\\/g, "/")}:${CONTAINER_CLAUDE_CONFIG_DIR}/plugins/${file}:ro`];
}

/**
 * `-v` pairs that overlay container-shaped copies of the two plugin ledgers.
 *
 * Returns no arguments when there is nothing to translate, so a user with no
 * plugins — or with all of them installed outside the config dir — runs exactly
 * the argv they ran before. Never throws: a sandbox that starts without plugins
 * beats one that does not start.
 *
 * The caller MUST pass `stagingDir` to `removePluginLedgerStaging` once the
 * container has exited, INCLUDING when the spawn it was built for never
 * happened — otherwise every turn leaves two files behind in `tmpdir()`.
 *
 * MUST be spliced in AFTER the config-dir bind mount, since these overlay files
 * that live inside it.
 */
export function pluginLedgerMountArgs(params: PluginLedgerMountParams): PluginLedgerMounts {
  const hostConfigDir = params.hostConfigDir ?? claudeConfigDir();
  const sep = params.platform === "win32" ? "\\" : "/";
  const staged = stageableLedgers(hostConfigDir, sep);
  if (staged.length === 0) return { args: [], stagingDir: null };

  // One directory per SPAWN, not per session: a turn then owns its staging
  // outright and can delete it on exit without checking whether a sibling turn
  // of the same session is still reading the same files.
  const generated = params.outputDir === undefined;
  const outputDir = params.outputDir ?? join(tmpdir(), "mulmoclaude-plugin-ledger", randomUUID());
  try {
    mkdirSync(outputDir, { recursive: true });
    staged.forEach((ledger) => writeFileAtomicSync(join(outputDir, ledger.file), ledger.content));
  } catch (error) {
    log.warn("sandbox", "could not stage translated plugin ledgers, plugins will not load in the sandbox", {
      path: outputDir,
      error: errorMessage(error),
    });
    // Only a directory this function generated is ours to delete; a caller that
    // named the location owns whatever else is in it.
    if (generated) removePluginLedgerStaging(outputDir);
    return { args: [], stagingDir: null };
  }
  return { args: staged.flatMap((ledger) => mountArg(outputDir, ledger.file)), stagingDir: outputDir };
}

/**
 * Run the spawn-and-register step, removing the staging if it throws before a
 * child process exists to own that cleanup. `spawn` throws synchronously for a
 * malformed argument, which is early enough that no `close` listener is
 * registered yet.
 */
export function withPluginLedgerCleanup<T>(stagingDir: string | null, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (stagingDir !== null) removePluginLedgerStaging(stagingDir);
    throw error;
  }
}

/** Remove a turn's staged ledger copies. Best-effort: a staging directory that
 *  outlives its turn is litter in `tmpdir()`, never a correctness problem, so a
 *  failure here must not surface as a turn failure. */
export function removePluginLedgerStaging(stagingDir: string): void {
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch (error) {
    log.warn("sandbox", "could not remove plugin ledger staging dir", { path: stagingDir, error: errorMessage(error) });
  }
}
