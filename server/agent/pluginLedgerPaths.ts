// Translating the Claude Code plugin ledgers' HOST paths into their container
// spelling (#3186).
//
// The CLI records where each marketplace and each installed plugin lives as an
// absolute path on the machine that installed it. The Docker sandbox mounts the
// config dir at a different place and runs with a different `HOME`, so every one
// of those paths is ENOENT inside the container and the CLI answers `cache-miss`
// for the marketplace — which takes the plugin's skills, slash commands, MCP
// servers and hooks with it, silently.
//
// Pure on purpose: no fs, no env, no platform sniffing. The separator is an
// argument so the Windows rule can be asserted from a POSIX runner, which is the
// only way that rule stays honest on a repo whose maintainers are on macOS.

import { hasTraversalSegment } from "../utils/files/safe.js";
import { isNonEmptyString, isRecord, isUnknownArray } from "../utils/types.js";

/** Where `dockerBindMountArgs` mounts the host's Claude config dir. The
 *  container's `HOME` is `/home/node`, so this is what `~/.claude` resolves to
 *  for the CLI running inside the sandbox. */
export const CONTAINER_CLAUDE_CONFIG_DIR = "/home/node/.claude";

/** The ledger key naming where a marketplace was cloned to. */
const MARKETPLACE_LOCATION_KEY = "installLocation";

/** The ledger key naming where a plugin's tree was installed to. */
const PLUGIN_INSTALL_PATH_KEY = "installPath";

const WINDOWS_SEPARATOR = "\\";

// Windows accepts either separator inside a path; POSIX has only `/`, where a
// backslash is an ordinary filename character. Splitting on both everywhere
// would turn the single POSIX directory `we\ird` into two segments.
//
// A trailing separator is spelling, not an extra empty segment.
function splitSegments(value: string, sep: string): string[] {
  const segments = sep === WINDOWS_SEPARATOR ? value.split(/[/\\]/) : value.split("/");
  const lastNonEmpty = segments.reduce((last, segment, index) => (segment === "" ? last : index), -1);
  return lastNonEmpty < 0 ? segments : segments.slice(0, lastNonEmpty + 1);
}

// Windows filesystems are case-insensitive, so `C:\Users\X` and `c:/users/x`
// name one directory; comparing verbatim would leave the other spelling
// untranslated and the plugin inert with nothing to show for it.
function sameSegment(left: string, right: string, sep: string): boolean {
  return sep === WINDOWS_SEPARATOR ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * The container spelling of a host path recorded in a plugin ledger, or `null`
 * when the value is not ours to rewrite.
 *
 * `null` covers three cases, and all three mean "leave it exactly as it is":
 * a value outside the config dir (a marketplace added from a local path is a
 * supported shape — its tree simply isn't mounted, so no spelling helps), a
 * value whose path BELOW the config dir carries `.` / `..` segments (the line
 * #3184 drew: a corrupt ledger), and anything that isn't a non-empty string.
 *
 * Compared segment by segment, and the result rebuilt from the ORIGINAL
 * segments, because case folding is NOT length-preserving: `İ`.toLowerCase()
 * is two code units, so slicing the original by a folded prefix's length eats
 * the first character of the relative path and `plugins` becomes `lugins`.
 */
export function toContainerConfigPath(hostConfigDir: string, value: unknown, sep: string): string | null {
  if (!isNonEmptyString(value) || !isNonEmptyString(hostConfigDir)) return null;

  const dirSegments = splitSegments(hostConfigDir, sep);
  const valueSegments = splitSegments(value, sep);
  if (valueSegments.length < dirSegments.length) return null;
  if (!dirSegments.every((segment, index) => sameSegment(segment, valueSegments[index] ?? "", sep))) return null;

  const relative = valueSegments.slice(dirSegments.length).join("/");
  if (relative.length === 0) return CONTAINER_CLAUDE_CONFIG_DIR;

  // Only the part BELOW the config dir is asked about: that is the half which
  // could escape, since the prefix is replaced wholesale. Guarding the whole
  // value instead would let a `CLAUDE_CONFIG_DIR` spelled with a `.` segment
  // reject every plugin under it — silently, which is this bug's own shape.
  if (hasTraversalSegment(relative)) return null;

  return `${CONTAINER_CLAUDE_CONFIG_DIR}/${relative}`;
}

// A value we cannot translate is kept VERBATIM, never dropped. This file
// produces what the CLI reads, so dropping an entry would uninstall a plugin;
// keeping it reproduces exactly the behaviour that entry has today.
function translatedOr(original: unknown, hostConfigDir: string, sep: string): unknown {
  return toContainerConfigPath(hostConfigDir, original, sep) ?? original;
}

function rewriteMarketplaceEntry(entry: unknown, hostConfigDir: string, sep: string): unknown {
  if (!isRecord(entry) || !(MARKETPLACE_LOCATION_KEY in entry)) return entry;
  return { ...entry, [MARKETPLACE_LOCATION_KEY]: translatedOr(entry[MARKETPLACE_LOCATION_KEY], hostConfigDir, sep) };
}

/** `known_marketplaces.json` — a flat map of marketplace name to a record
 *  carrying `installLocation`. Anything that doesn't match that shape is
 *  returned untouched: this is CLI-internal state, not a published contract. */
export function rewriteKnownMarketplaces(ledger: unknown, hostConfigDir: string, sep: string): unknown {
  if (!isRecord(ledger)) return ledger;
  const entries = Object.entries(ledger).map(([name, entry]): [string, unknown] => [name, rewriteMarketplaceEntry(entry, hostConfigDir, sep)]);
  return Object.fromEntries(entries);
}

function rewriteInstallEntry(install: unknown, hostConfigDir: string, sep: string): unknown {
  if (!isRecord(install) || !(PLUGIN_INSTALL_PATH_KEY in install)) return install;
  return { ...install, [PLUGIN_INSTALL_PATH_KEY]: translatedOr(install[PLUGIN_INSTALL_PATH_KEY], hostConfigDir, sep) };
}

function rewriteInstallList(installs: unknown, hostConfigDir: string, sep: string): unknown {
  if (!isUnknownArray(installs)) return installs;
  return installs.map((install) => rewriteInstallEntry(install, hostConfigDir, sep));
}

/** `installed_plugins.json` — `{ version, plugins: { "<plugin>@<marketplace>":
 *  [{ installPath, ... }] } }`. The `version` field and any other sibling key
 *  ride through unchanged so a future shape change costs nothing here. */
export function rewriteInstalledPlugins(ledger: unknown, hostConfigDir: string, sep: string): unknown {
  if (!isRecord(ledger) || !isRecord(ledger.plugins)) return ledger;
  const plugins = Object.entries(ledger.plugins).map(([key, installs]): [string, unknown] => [key, rewriteInstallList(installs, hostConfigDir, sep)]);
  return { ...ledger, plugins: Object.fromEntries(plugins) };
}
