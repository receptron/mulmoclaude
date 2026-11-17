import { realpathSync } from "node:fs";
import path from "node:path";
import { isWithinRoot, respelledWithinRoot } from "./containment.js";

/** True for a `not found` filesystem error (ENOENT) — lets callers treat a
 *  missing file as an empty/default result instead of a thrown error. */
export function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/** Realpath-based read-time containment: resolve `relPath` against the root's
 *  realpath and require the target's realpath to stay inside it. Returns null
 *  on ENOENT or traversal (symlink escapes included). `rootReal` MUST already
 *  be a realpath. The one implementation for host and plugins (#2461) — this
 *  security-critical primitive must not drift per consumer. */
export function resolveWithinRoot(rootReal: string, relPath: string): string | null {
  const normalized = path.normalize(relPath || "");
  const resolved = path.resolve(rootReal, normalized);
  const resolvedReal = realpathOrNull(resolved);
  if (resolvedReal === null) return null;
  return isWithinRoot(rootReal, resolvedReal) ? resolvedReal : respelledWithinRoot(rootReal, resolvedReal);
}

function realpathOrNull(absPath: string): string | null {
  try {
    return realpathSync(absPath);
  } catch {
    return null;
  }
}
