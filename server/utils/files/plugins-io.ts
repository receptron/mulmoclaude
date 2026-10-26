// Install ledger I/O for runtime-loaded plugins (#1043 C-2).
//
// The ledger is `~/mulmoclaude/plugins/plugins.json`, listing every
// plugin the user has installed via the install CLI / web UI. Each
// entry pairs the npm package id with the on-disk tgz filename; the
// loader replays this at boot to know what to extract from
// `plugins/` into `plugins/.cache/<name>/<version>/`.
//
// Truncating or deleting this file removes nothing on disk but
// "uninstalls" all runtime plugins on the next boot — the tgz files
// in `plugins/` and the cache mirror are GC'd on the following start.
// Editing it by hand is a supported recovery path.
//
// Reads tolerate missing / malformed JSON (returns []), so a half-
// written ledger never bricks server boot. Writes go through the
// atomic helper, so a crashed install can't leave a corrupt file.

import path from "node:path";
import type { VerifiedScope } from "@mulmoclaude/core/files";
import { openArtifactFile } from "./artifactMount.js";
import { loadJsonFile } from "./json.js";
import { hasStringProp } from "../types.js";
import { WORKSPACE_PATHS } from "../../workspace/paths.js";

export interface LedgerEntry {
  /** npm package name, e.g. `@gui-chat-plugin/weather`. */
  name: string;
  /** Semver string from the tgz's `package.json`, e.g. `0.1.0`. */
  version: string;
  /** Basename of the tgz inside `plugins/`. Joined with
   *  `WORKSPACE_PATHS.plugins` to read. */
  tgz: string;
  /** ISO 8601 timestamp of the install. */
  installedAt: string;
}

const isLedgerEntry = (value: unknown): value is LedgerEntry =>
  hasStringProp(value, "name") && hasStringProp(value, "version") && hasStringProp(value, "tgz") && hasStringProp(value, "installedAt");

const sanitiseLedger = (raw: unknown): LedgerEntry[] => {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isLedgerEntry);
};

export function readLedger(): LedgerEntry[] {
  const raw = loadJsonFile<unknown>(WORKSPACE_PATHS.pluginsLedger, []);
  return sanitiseLedger(raw);
}

/** Read a runtime-plugin asset (extracted under
 *  `plugins/.cache/<name>/<version>/`) and return its bytes plus
 *  the inferred Content-Type. The route handler in
 *  `runtime-plugin.ts` was previously calling `fs.readFile` directly
 *  — per `CLAUDE.md` route handlers must go through a domain helper,
 *  so the lookup table + read live here (#1077 review). */
export interface PluginAsset {
  data: Buffer;
  contentType: string;
}

/** Null for a path that is missing, not a regular file, or outside the scope (also when swapped mid-read); other
 *  read errors propagate. The bytes come from the verified handle (#3573). */
export async function readPluginAsset(scope: VerifiedScope, relPath: string): Promise<PluginAsset | null> {
  const handle = await openArtifactFile(scope, relPath);
  if (handle === null) return null;
  try {
    const data = await handle.readFile();
    return { data, contentType: pluginAssetContentType(path.extname(relPath).toLowerCase()) };
  } finally {
    await handle.close();
  }
}

// Lookup table over a switch — flat data structure stays under
// `sonarjs/cognitive-complexity` while keeping the per-extension
// mapping easy to scan.
const PLUGIN_ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function pluginAssetContentType(ext: string): string {
  return PLUGIN_ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream";
}
