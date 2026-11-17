// Synchronous containment and whole-file reads for callers that cannot await (prompt assembly, the wiki engine's
// sync readers). The read opens first and then proves where the path leads, like `openVerifiedWithinScope`.

import type { BigIntStats } from "node:fs";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "./safe.js";

// A FIFO must not block the server, and a link is refused at open where the OS can; both flags are undefined on
// Windows, where the check after the open is what refuses a link out.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// `path.relative` rather than a `rootReal + sep` prefix, which a root at a filesystem root (`/`, `C:\`) would fail.
export function isWithinRoot(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(rootReal, candidateReal);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Native first: the JS realpath keeps a link's letter case, so on a case-insensitive disk an inside link looks outside.
// The JS one is the fallback for drives where the native call throws (EISDIR on some Windows RAM disks).
export function realpathSyncOrNull(absPath: string): string | null {
  try {
    return realpathSync.native(absPath);
  } catch (err) {
    return isEnoent(err) ? null : jsRealpathOrNull(absPath);
  }
}

function jsRealpathOrNull(absPath: string): string | null {
  try {
    return realpathSync(absPath);
  } catch {
    return null;
  }
}

// Checked after the open, so a folder or file swapped for a link out between the caller's check and the open, or
// swapped back before this check, is refused: where the path leads now must be inside and be the opened file.
function isOpenedFileInside(rootReal: string, absPath: string, opened: BigIntStats): boolean {
  const real = realpathSyncOrNull(absPath);
  if (real === null || !isWithinRoot(rootReal, real) || !opened.isFile()) return false;
  const onDisk = lstatSync(real, { bigint: true });
  return onDisk.isFile() && onDisk.dev === opened.dev && onDisk.ino === opened.ino;
}

/** Text of a regular file inside `rootReal` (a realpath), or null when it is missing, leads outside, is a FIFO or
 *  other non-file, or is unreadable. */
export async function readTextWithinRoot(rootReal: string, absPath: string): Promise<string | null> {
  try {
    const handle = await open(absPath, READ_FLAGS);
    try {
      return isOpenedFileInside(rootReal, absPath, await handle.stat({ bigint: true })) ? await handle.readFile("utf-8") : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Sync twin of `readTextWithinRoot`. */
export function readTextWithinRootSync(rootReal: string, absPath: string): string | null {
  try {
    const descriptor = openSync(absPath, READ_FLAGS);
    try {
      return isOpenedFileInside(rootReal, absPath, fstatSync(descriptor, { bigint: true })) ? readFileSync(descriptor, "utf-8") : null;
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return null;
  }
}
