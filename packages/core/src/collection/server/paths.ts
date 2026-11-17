// Path helpers + safe-slug guard for the collections module. Mirrors the
// pattern used by `server/workspace/skills/catalog.ts` so CodeQL's
// `js/path-injection` sanitiser recognises our taint-launder.

import path from "node:path";
import { realpathSync } from "node:fs";
import { getWorkspaceRoot } from "./host";
// The character rules live in ../core/ids so the isomorphic schema validator
// (../core/schemaZ) gates on the SAME patterns these sanitisers do.
import { SAFE_SLUG_PATTERN, SAFE_RECORD_ID_PATTERN } from "../core/ids";
import { isErrorWithCode } from "@mulmoclaude/common";
import { isInsideRoot, isWithinRoot } from "../../files/containment.js";

export const SCHEMA_FILE = "schema.json";

/** Sanitise a user-supplied slug into a safe directory-name leaf.
 *  Returns null for anything that fails the slug whitelist OR isn't a
 *  basename (i.e. survives `path.basename` round-trip unchanged).
 *  The basename round-trip is the pattern CodeQL recognises as a
 *  `js/path-injection` sanitiser. */
export function safeSlugName(slug: string): string | null {
  if (typeof slug !== "string") return null;
  if (!SAFE_SLUG_PATTERN.test(slug)) return null;
  const basename = path.basename(slug);
  if (basename !== slug) return null;
  return basename;
}

/** Sanitise a user-supplied record id into a safe filename stem. Like
 *  `safeSlugName` but tolerates interior dots (so natural keys work),
 *  while still rejecting any `..` substring, path separators, and
 *  leading/trailing dots. The `path.basename` round-trip is the same
 *  `js/path-injection` sanitiser CodeQL recognises on `safeSlugName`. */
export function safeRecordId(recordId: string): string | null {
  if (typeof recordId !== "string") return null;
  if (!SAFE_RECORD_ID_PATTERN.test(recordId)) return null;
  if (recordId.includes("..")) return null;
  const basename = path.basename(recordId);
  if (basename !== recordId) return null;
  return basename;
}

/** Realpath the closest existing ancestor of `absPath` and return it.
 *  Returns null if no ancestor exists or if the realpath call fails
 *  for a non-ENOENT reason (permissions, etc.). Used by
 *  `containedPath` to defend against symlinks pointing outside the
 *  workspace even when the leaf hasn't been created yet. */
function realpathClosestAncestor(absPath: string): string | null {
  let cursor = absPath;
  while (cursor !== path.dirname(cursor)) {
    try {
      return realpathSync(cursor);
    } catch (err) {
      if (isErrorWithCode(err) && err.code === "ENOENT") {
        cursor = path.dirname(cursor);
        continue;
      }
      return null;
    }
  }
  return null;
}

/** True iff the realpath'd closest existing ancestor of `absPath`
 *  resolves under `rootPath`'s realpath. Pure helper, takes both
 *  paths explicitly so tests can drive it against a `mkdtempSync`
 *  root without touching the user's workspace. Defends against the
 *  data dir or any ancestor being a symlink to a directory outside
 *  the workspace — lexical-only checks (`path.resolve` + prefix
 *  match) would miss this case, which is the class of bug the rest
 *  of this codebase uses realpath-based containment to avoid (see
 *  `server/utils/files/safe.ts#resolveWithinRoot`). */
export function isContainedInRoot(absPath: string, rootPath: string): boolean {
  let rootReal: string;
  try {
    rootReal = realpathSync(rootPath);
  } catch {
    return false;
  }
  const ancestorReal = realpathClosestAncestor(absPath);
  if (ancestorReal === null) return false;
  return isInsideRoot(rootReal, ancestorReal);
}

/** The containment comparison itself, on two paths a caller has ALREADY
 *  canonicalised. Exported because a caller holding a resolved path must not
 *  re-derive it: `isContainedInRoot` canonicalises with `realpathSync`, and a
 *  path resolved by a DIFFERENT api can be a different string for the same
 *  file — on Windows `fs/promises.realpath` expands an 8.3 short name that
 *  `realpathSync` leaves alone, so `C:\Users\runneradmin\…` was compared
 *  against `C:\Users\RUNNER~1\…` and every file under the workspace looked
 *  like it was outside it (#2972). Canonicalise both sides the same way, then
 *  come here. */
export function isUnderRealRoot(realPath: string, realRoot: string): boolean {
  return isWithinRoot(realRoot, realPath);
}

// NOTE: there is deliberately no `isContainedInWorkspace(absPath)` helper here.
// It existed, had zero callers, and was exactly the shape a contributor reaches
// for by reflex — at which point containment is checked against the AMBIENT
// root while the operation it guards runs under an explicit one. Pass the root
// you are operating on to `isContainedInRoot` instead.

/** Resolve a schema-declared dataPath against `rootPath` (default:
 *  the live workspace), refusing anything that escapes — absolute
 *  paths, `..`-segments, empty string, or symlinks pointing outside
 *  the root. Returns the absolute path on success, null on refusal.
 *  Does NOT require the directory to exist; the caller may create it
 *  on first write. The realpath containment check covers the symlink
 *  case at discovery time; io operations re-check before each write
 *  to defend against symlinks introduced between discovery and use.
 *
 *  `rootPath` exists as an optional override so a test (or a tool
 *  driving discovery against a `mkdtempSync` tree) gets a dataDir
 *  rooted at the same place it asked to scan, not the real workspace.
 *  Without this, `discoverApps({ workspaceRoot: tmpdir })` would
 *  discover skills in tmpdir but resolve every app's dataDir against
 *  `~/mulmoclaude/`, breaking isolation. */
export function resolveDataDir(dataPath: string, rootPath: string = getWorkspaceRoot()): string | null {
  if (typeof dataPath !== "string" || dataPath.length === 0) return null;
  if (path.isAbsolute(dataPath)) return null;
  const normalized = path.normalize(dataPath);
  if (normalized.startsWith("..") || normalized.includes(`${path.sep}..${path.sep}`)) return null;
  const resolved = path.resolve(rootPath, normalized);
  if (!isContainedInRoot(resolved, rootPath)) return null;
  return resolved;
}

/** Compose the absolute path to a single record file. Both arguments
 *  must have been passed through `safeSlugName` / `resolveDataDir`
 *  before reaching here so the join can't escape. */
export function itemFilePath(dataDir: string, itemId: string): string {
  return path.join(dataDir, `${itemId}.json`);
}

/** Resolve an action's skill-relative `template` path against
 *  `skillDir`, refusing escapes — absolute paths, `..`-segments, or a
 *  symlink pointing outside the skill dir. Mirrors `resolveDataDir`;
 *  the realpath containment is the hard guarantee. Returns the
 *  absolute path on success, null on refusal. */
export function resolveTemplatePath(skillDir: string, templateRelPath: string): string | null {
  if (typeof templateRelPath !== "string" || templateRelPath.length === 0) return null;
  if (path.isAbsolute(templateRelPath)) return null;
  const normalized = path.normalize(templateRelPath);
  if (normalized.startsWith("..") || normalized.includes(`${path.sep}..${path.sep}`)) return null;
  const resolved = path.resolve(skillDir, normalized);
  if (!isContainedInRoot(resolved, skillDir)) return null;
  return resolved;
}
