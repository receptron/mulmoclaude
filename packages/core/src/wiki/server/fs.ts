// Minimal ENOENT-swallowing fs wrappers for the wiki read-engine.
// Self-contained (core can't reach the host's `server/utils/files/safe.ts`);
// only the handful of helpers the wiki engine needs. Same "return
// null / [] on any error" contract so callers branch on the value
// instead of try/catch.

import type { Dirent, Stats } from "node:fs";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";

// A page swapped for a link after the page index listed it must not be followed, and a FIFO must not block the
// server; both flags are undefined on Windows.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Text of a regular file, or null when it is missing, a link, a FIFO or any other non-file, or unreadable. */
export async function readTextSafe(absPath: string): Promise<string | null> {
  try {
    const handle = await open(absPath, READ_FLAGS);
    try {
      return (await handle.stat()).isFile() ? await handle.readFile("utf-8") : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Sync twin of `readTextSafe`. */
export function readTextSafeSync(absPath: string): string | null {
  try {
    const descriptor = openSync(absPath, READ_FLAGS);
    try {
      return fstatSync(descriptor).isFile() ? readFileSync(descriptor, "utf-8") : null;
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return null;
  }
}

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
