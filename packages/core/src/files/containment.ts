// The containment rule every realpath check in `@mulmoclaude/core/files` shares. A leaf: imports nothing from the
// other file modules, so they can all depend on it.

import { realpathSync } from "node:fs";
import path from "node:path";

// A case-preserving prefix test: `path.win32.relative` folds case, which on a case-sensitive Windows folder would take
// `C:\root\x` as inside `C:\Root`. A root that already ends in a separator (`/`, `C:\`) is used as the prefix as is.
export function isWithinRoot(rootReal: string, candidateReal: string, separator: string = path.sep): boolean {
  if (candidateReal === rootReal) return true;
  const prefix = rootReal.endsWith(separator) ? rootReal : rootReal + separator;
  return candidateReal.startsWith(prefix);
}

const isMissing = (err: unknown): boolean => typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";

// Native first: the JS realpath keeps a link's letter case, so on a case-insensitive disk an inside link looks outside.
// The JS one is the fallback for drives where the native call throws (EISDIR on some Windows RAM disks).
export function realpathSyncOrNull(absPath: string): string | null {
  try {
    return realpathSync.native(absPath);
  } catch (err) {
    return isMissing(err) ? null : jsRealpathOrNull(absPath);
  }
}

function jsRealpathOrNull(absPath: string): string | null {
  try {
    return realpathSync(absPath);
  } catch {
    return null;
  }
}

/** `candidateReal` re-spelled under `rootReal` when both, at their on-disk spelling, are one inside the other; null
 *  otherwise. The second look for a check that compared two realpaths taken with different letter case (a JS realpath
 *  keeps the case it was given, or a link's), so a target truly inside is not refused. */
export function respelledWithinRoot(rootReal: string, candidateReal: string): string | null {
  const rootOnDisk = realpathSyncOrNull(rootReal);
  const candidateOnDisk = realpathSyncOrNull(candidateReal);
  if (rootOnDisk === null || candidateOnDisk === null || !isWithinRoot(rootOnDisk, candidateOnDisk)) return null;
  return path.join(rootReal, path.relative(rootOnDisk, candidateOnDisk));
}
