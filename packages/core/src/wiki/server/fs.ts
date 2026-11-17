// Minimal ENOENT-swallowing fs wrappers for the wiki read-engine.
// Self-contained (core can't reach the host's `server/utils/files/safe.ts`);
// only the handful of helpers the wiki engine needs. Same "return
// null / [] on any error" contract so callers branch on the value
// instead of try/catch.

import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";

export async function statSafeAsync(absPath: string): Promise<Stats | null> {
  try {
    return await stat(absPath);
  } catch {
    return null;
  }
}

export async function readDirSafeAsync(absPath: string): Promise<Dirent[]> {
  try {
    return await readdir(absPath, { withFileTypes: true });
  } catch {
    return [];
  }
}
