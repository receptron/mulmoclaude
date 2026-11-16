// Minimal ENOENT-swallowing fs wrappers for the wiki read-engine.
// Self-contained (core can't reach the host's `server/utils/files/safe.ts`);
// only the handful of helpers the wiki engine needs. Same "return
// null / [] on any error" contract so callers branch on the value
// instead of try/catch.

import type { BigIntStats, Dirent, Stats } from "node:fs";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";

// A FIFO must not block the server, and a link is refused at open where the OS can; both flags are undefined on
// Windows, where `isSameRegularFile` is what refuses a link.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// The path, not followed, must be a regular file and the very file that was opened: a page swapped for a link after
// the page index listed it is refused, as is one swapped back between the open and this check.
function isSameRegularFile(onDisk: BigIntStats, opened: BigIntStats): boolean {
  return onDisk.isFile() && opened.isFile() && onDisk.dev === opened.dev && onDisk.ino === opened.ino;
}

/** Text of a regular file, or null when it is missing, a link, a FIFO or any other non-file, or unreadable. */
export async function readTextSafe(absPath: string): Promise<string | null> {
  try {
    const handle = await open(absPath, READ_FLAGS);
    try {
      const opened = await handle.stat({ bigint: true });
      return isSameRegularFile(await lstat(absPath, { bigint: true }), opened) ? await handle.readFile("utf-8") : null;
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
      const opened = fstatSync(descriptor, { bigint: true });
      return isSameRegularFile(lstatSync(absPath, { bigint: true }), opened) ? readFileSync(descriptor, "utf-8") : null;
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
