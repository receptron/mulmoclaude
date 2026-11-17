// Preset skills bundled with mulmoclaude.
//
// History: introduced in #1210 to ship launcher-managed "factory"
// skills like `mc-library`. Originally synced straight into
// `<workspaceRoot>/.claude/skills/<slug>/`, which made every preset
// auto-active and inflated the Claude system prompt as new presets
// landed.
//
// #1335 PR-A flipped the destination to the catalog
// (`<workspaceRoot>/data/skills/catalog/preset/<slug>/`). Catalog
// entries are visible to UI / tooling but NOT discovered by Claude
// Code's slash-command resolver — they don't enter the system
// prompt unless the user (or a later UI in PR-B) explicitly copies
// one into `.claude/skills/`.
//
// The launcher overwrites catalog entries unconditionally on every
// boot — they're factory defaults, not user state. Anything in
// `.claude/skills/` (active layer) is left untouched.
//
// `syncPresetSkills(...)` is exported as a pure-ish helper (takes
// paths + a logger sink, returns a summary) so tests can drive it
// against tmpdirs without touching a real workspace.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, type Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PRESET_SLUG_PREFIX, isPresetSlug } from "./slug.js";
import { errorMessage } from "../utils/errors.js";
import { isInsideRoot } from "../files/containment.js";

// Recursively mirror `srcDir` into `destDir`. Used by the preset
// sync so a preset skill that ships sibling assets (e.g.
// `schema.json` for schema-driven apps, `templates/*.html`) gets
// copied alongside `SKILL.md` rather than silently dropped. Only
// regular files and directories are followed — symlinks / FIFOs /
// sockets are skipped because the preset tree is launcher-managed
// and shouldn't contain them.
function copyDirTreeSync(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirTreeSync(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}

const SKILL_FILENAME = "SKILL.md";

export interface SyncPresetSkillsOptions {
  /** Source directory: `<launcher>/server/workspace/skills-preset/`. */
  sourceDir: string;
  /** Destination directory:
   *  `<workspaceRoot>/data/skills/catalog/preset/`. The catalog
   *  half of the catalog-vs-active split — entries here are visible
   *  to UI but NOT to Claude Code's prompt-time skill resolver. */
  destDir: string;
  /** Logger callbacks — kept injectable so tests don't need to
   *  spin up the structured logger. The boot-side wrapper threads
   *  these through to `log.info` / `log.warn`. */
  onInfo?: (message: string, data?: Record<string, unknown>) => void;
  onWarn?: (message: string, data?: Record<string, unknown>) => void;
}

export interface SyncPresetSkillsResult {
  /** Slugs successfully copied (or refreshed) from source to dest. */
  copied: string[];
  /** Slugs removed from dest because they no longer exist in source.
   *  Bounded to `mc-*` entries — user-authored slugs are never
   *  considered for removal. */
  removed: string[];
  /** Source entries that failed validation (wrong prefix, missing
   *  SKILL.md, etc.) and were skipped. Each entry is human-readable. */
  skipped: string[];
}

// Classification of one source entry. `silent` distinguishes
// structural skips (hidden files, non-directory entries — not the
// dev's fault) from misconfigurations (bad slug, missing or
// non-regular SKILL.md — the dev WANTS to know). The boolean lives
// on the verdict so the caller never has to string-match `reason`,
// which would silently drop warnings if reason wording changed
// (CodeRabbit review).
type Verdict = { ok: true } | { ok: false; reason: string; silent: boolean };

function classifySourceEntry(sourceDir: string, entry: string): Verdict {
  if (entry.startsWith(".")) return { ok: false, reason: "hidden", silent: true };
  const slugDir = path.join(sourceDir, entry);
  let dirInfo;
  try {
    dirInfo = statSync(slugDir);
  } catch {
    return { ok: false, reason: "stat failed", silent: true };
  }
  if (!dirInfo.isDirectory()) return { ok: false, reason: "not a directory", silent: true };
  if (!isPresetSlug(entry)) return { ok: false, reason: `slug must start with "${PRESET_SLUG_PREFIX}"`, silent: false };
  // Validate SKILL.md is a regular file — `existsSync` alone
  // accepts a directory at that path, which would then crash
  // copyFileSync. Codex review caught this edge case.
  const skillPath = path.join(slugDir, SKILL_FILENAME);
  let skillInfo;
  try {
    skillInfo = statSync(skillPath);
  } catch {
    return { ok: false, reason: `missing ${SKILL_FILENAME}`, silent: false };
  }
  if (!skillInfo.isFile()) return { ok: false, reason: `${SKILL_FILENAME} must be a regular file`, silent: false };
  return { ok: true };
}

/** Prepare the destination slug dir. Returns false if the slot is
 *  occupied by a regular file (local corruption / hand edits) — the
 *  caller logs + skips so one bad entry can't crash the whole boot
 *  (Codex review iter-1). */
function ensureDestSlugDir(destSlugDir: string): boolean {
  let info;
  try {
    info = statSync(destSlugDir);
  } catch {
    mkdirSync(destSlugDir, { recursive: true });
    return true;
  }
  return info.isDirectory();
}

/** Filesystem ops `_replaceSlugTree` depends on — injectable so the
 *  mid-swap failure path can be regression-tested without real IO faults. */
export interface SlugTreeFsOps {
  copyTree: (src: string, dest: string) => void;
  rename: (from: string, dest: string) => void;
  remove: (target: string) => void;
  exists: (target: string) => boolean;
}

const REAL_FS_OPS: SlugTreeFsOps = {
  copyTree: copyDirTreeSync,
  rename: renameSync,
  remove: (target) => rmSync(target, { recursive: true, force: true }),
  exists: existsSync,
};

/** Refresh one preset slot as a rollback-safe stage-and-swap. Wipe-and-replace
 *  (not merge) so stale sibling assets — e.g. a schema.json dropped between
 *  releases — don't linger; the catalog preset slot is launcher-owned, so user
 *  edits there are not preserved across boots.
 *
 *  The live slot is never left without a recoverable copy:
 *    1. Stage: copy the source into a temp sibling. A copy failure leaves the
 *       existing preset untouched (temp dir removed).
 *    2. Move the existing tree ASIDE to a backup (rename, not delete), so the
 *       old contents survive even if the next step fails.
 *    3. Move the staged copy into place. On failure, restore from the backup;
 *       if even the restore fails, BOTH backup and staging are preserved for
 *       manual recovery rather than deleted.
 *    4. On success, drop the backup.
 *
 *  Exported with a `_` prefix only so the rename-failure-after-move path can be
 *  regression-tested via the injected `fsOps`. Throws on failure (caller records
 *  + skips). */
export function _replaceSlugTree(sourceSlugDir: string, destSlugDir: string, fsOps: SlugTreeFsOps = REAL_FS_OPS): void {
  const staging = `${destSlugDir}.tmp-${randomUUID()}`;
  try {
    fsOps.copyTree(sourceSlugDir, staging);
  } catch (err) {
    fsOps.remove(staging); // dest untouched
    throw err;
  }
  const backup = `${destSlugDir}.bak-${randomUUID()}`;
  let backedUp = false;
  if (fsOps.exists(destSlugDir)) {
    try {
      fsOps.rename(destSlugDir, backup);
      backedUp = true;
    } catch (err) {
      fsOps.remove(staging); // dest untouched; nothing was moved
      throw err;
    }
  }
  try {
    fsOps.rename(staging, destSlugDir);
  } catch (err) {
    if (backedUp) {
      try {
        fsOps.rename(backup, destSlugDir); // roll back to the previous tree
        fsOps.remove(staging);
      } catch {
        // Rollback failed — preserve BOTH backup and staging for manual
        // recovery rather than leaving the slot empty.
      }
    } else {
      fsOps.remove(staging); // dest never existed; nothing to restore
    }
    throw err;
  }
  if (backedUp) fsOps.remove(backup);
}

function copySourcesIntoDest(sourceDir: string, destDir: string, opts: SyncPresetSkillsOptions, result: SyncPresetSkillsResult): Set<string> {
  // `keep` is the set of slugs the retirement pass must NOT prune. It tracks
  // valid SOURCE slugs (present + usable dest slot), NOT successful copies — so
  // a slug whose refresh fails transiently keeps its existing contents (left
  // intact by the stage-and-swap above) instead of being pruned as "retired".
  const keep = new Set<string>();
  for (const entry of readdirSync(sourceDir)) {
    const verdict = classifySourceEntry(sourceDir, entry);
    if (!verdict.ok) {
      if (!verdict.silent) {
        result.skipped.push(`${entry}: ${verdict.reason}`);
        opts.onWarn?.("preset entry skipped", { slug: entry, reason: verdict.reason });
      }
      continue;
    }
    const destSlugDir = path.join(destDir, entry);
    if (!ensureDestSlugDir(destSlugDir)) {
      const reason = "destination slot occupied by a non-directory; skipping";
      result.skipped.push(`${entry}: ${reason}`);
      opts.onWarn?.("preset entry skipped", { slug: entry, reason, destSlugDir });
      continue;
    }
    // The slug exists in source with a usable dest slot — keep it regardless of
    // whether the refresh below succeeds, so a transient failure doesn't get it
    // pruned by `removeRetiredPresets`.
    keep.add(entry);
    // Per-slug isolation: a transient IO error / permission issue / partial
    // corruption on one preset must not abort syncing the rest, nor destroy
    // the existing copy. Skip the offender (recorded) and continue.
    try {
      _replaceSlugTree(path.join(sourceDir, entry), destSlugDir);
      result.copied.push(entry);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.skipped.push(`${entry}: ${reason}`);
      opts.onWarn?.("preset copy failed, skipping", { slug: entry, reason });
    }
  }
  return keep;
}

function removeRetiredPresets(destDir: string, keep: ReadonlySet<string>, opts: SyncPresetSkillsOptions, result: SyncPresetSkillsResult): void {
  for (const entry of readdirSync(destDir)) {
    if (!isPresetSlug(entry)) continue;
    if (keep.has(entry)) continue;
    const stalePath = path.join(destDir, entry);
    try {
      if (!statSync(stalePath).isDirectory()) continue;
    } catch {
      continue;
    }
    rmSync(stalePath, { recursive: true, force: true });
    result.removed.push(entry);
    opts.onInfo?.("removed retired preset skill", { slug: entry });
  }
}

/** Copy every preset slug from `sourceDir` into `destDir` (the
 *  preset slot under the catalog root), then remove any `mc-*`
 *  entries in `destDir` that no longer have a source. The catalog
 *  preset subdir is fully launcher-owned, so the `mc-*` prefix
 *  check at destination is defence-in-depth: a stray non-preset
 *  slug landing in `catalog/preset/` is unexpected, and we'd
 *  rather skip it than silently delete a directory we don't
 *  recognise. */
export function syncPresetSkills(opts: SyncPresetSkillsOptions): SyncPresetSkillsResult {
  const result: SyncPresetSkillsResult = { copied: [], removed: [], skipped: [] };
  if (!existsSync(opts.sourceDir)) {
    // No preset directory in the launcher tarball — nothing to do.
    // This is the legitimate "no presets shipped yet" state.
    return result;
  }
  // Source-side validation: the launcher's preset path COULD exist
  // as a regular file (a packaging bug, a corrupted install). Without
  // this guard, `readdirSync(sourceDir)` would throw ENOTDIR and
  // crash boot. Codex review iter-3.
  let sourceInfo;
  try {
    sourceInfo = statSync(opts.sourceDir);
  } catch (err) {
    const reason = `source path stat failed: ${errorMessage(err)}`;
    result.skipped.push(`${opts.sourceDir}: ${reason}`);
    opts.onWarn?.("preset sync aborted", { sourceDir: opts.sourceDir, reason });
    return result;
  }
  if (!sourceInfo.isDirectory()) {
    const reason = "source path exists as a non-directory; preset sync skipped";
    result.skipped.push(`${opts.sourceDir}: ${reason}`);
    opts.onWarn?.("preset sync aborted", { sourceDir: opts.sourceDir, reason });
    return result;
  }
  // The root dest itself can be corrupted into a regular file by a
  // user / external tool; mkdirSync would throw EEXIST and crash
  // boot. Treat it as a recoverable "skip the entire sync" state
  // — log a clear warning so the user sees what to fix.
  // (Codex review iter-2.)
  if (!ensureDestSlugDir(opts.destDir)) {
    const reason = "root dest exists as a non-directory; preset sync skipped";
    result.skipped.push(`${opts.destDir}: ${reason}`);
    opts.onWarn?.("preset sync aborted", { destDir: opts.destDir, reason });
    return result;
  }
  const keep = copySourcesIntoDest(opts.sourceDir, opts.destDir, opts, result);
  removeRetiredPresets(opts.destDir, keep, opts, result);
  if (result.copied.length > 0 || result.removed.length > 0) {
    opts.onInfo?.("preset skills synced", {
      copied: result.copied.length,
      removed: result.removed.length,
      skipped: result.skipped.length,
    });
  }
  return result;
}

// ---------------------------------------------------------------
// Active-layer sync: keep starred mc-* presets in lockstep with
// their launcher-bundled source.
//
// Motivation: the catalog sync above refreshes
// `data/skills/catalog/preset/<slug>/` on every boot, but once a
// user stars an entry the active copy in
// `<workspace>/.claude/skills/<slug>/` is never updated even when
// the launcher ships a new SKILL.md (e.g. a typo fix or, as the
// trigger for this code, the schema-driven-apps → collections
// rename). The SKILL.md front-matter explicitly says
// "do not edit this file in the workspace, it is overwritten on
// every server boot" — until this function existed, that was a
// promise the active layer didn't keep.
//
// Safety model:
//   - Only `mc-*` slugs are touched (defensive prefix check —
//     never touches user-authored skills).
//   - Per-file diff: a file is overwritten only if its bytes
//     differ from the source. No-op when already up to date.
//   - User-added files inside an active slug dir are left alone
//     (we walk the source tree, not the dest tree).
//   - If a file IS overwritten, the previous contents are first
//     renamed to `<file>.bak.<timestamp>` so a user who had
//     locally tweaked the preset can recover.
//   - A slug whose active dir doesn't exist (= not starred yet)
//     is skipped entirely, never auto-starred.
// ---------------------------------------------------------------

export interface SyncActivePresetSkillsOptions {
  /** Source directory: `<launcher>/server/workspace/skills-preset/`. */
  sourceDir: string;
  /** Active skills directory: `<workspaceRoot>/.claude/skills/`. */
  activeDir: string;
  onInfo?: (message: string, data?: Record<string, unknown>) => void;
  onWarn?: (message: string, data?: Record<string, unknown>) => void;
}

export interface SyncActivePresetSkillsResult {
  /** Slugs whose active copy had at least one file overwritten. */
  updated: string[];
  /** Slugs whose active copy already matched the source — no-op. */
  unchanged: string[];
  /** Slugs that haven't been starred yet (no active dir present).
   *  Listed for diagnostics; the function never auto-stars. */
  notActive: string[];
  /** Active `mc-*` slugs pruned because the launcher no longer ships a
   *  source preset for them (a retired preset). Bounded to `mc-*` —
   *  user-authored skills are never removed. */
  removed: string[];
  /** Per-slug failure messages (permission errors, etc.). */
  skipped: string[];
  /** Common timestamp suffix used for every backup file produced by
   *  this run. Exposed so the boot-time log can point a user at the
   *  exact glob to inspect. */
  backupSuffix: string | null;
}

type FileSyncOutcome = "updated" | "unchanged" | "skipped";

function filesEqual(left: string, right: string): boolean {
  try {
    return readFileSync(left).equals(readFileSync(right));
  } catch {
    return false;
  }
}

/** Copy `srcPath` over `destPath`. If `destPath` already exists and
 *  differs, rename it to `destPath + backupExt` first so the user's
 *  prior contents are recoverable. If `destPath` doesn't exist, just
 *  copy (no backup needed). Pure: no logging here — caller decides. */
function syncOneFile(srcPath: string, destPath: string, backupExt: string): FileSyncOutcome {
  let destExists: boolean;
  try {
    destExists = statSync(destPath).isFile();
  } catch {
    destExists = false;
  }
  if (!destExists) {
    try {
      copyFileSync(srcPath, destPath);
      return "updated";
    } catch {
      return "skipped";
    }
  }
  if (filesEqual(srcPath, destPath)) return "unchanged";
  try {
    renameSync(destPath, destPath + backupExt);
    copyFileSync(srcPath, destPath);
    return "updated";
  } catch {
    return "skipped";
  }
}

interface DirSyncStats {
  updated: number;
  unchanged: number;
  skipped: number;
}

function syncDirTreeDiff(srcDir: string, destDir: string, backupExt: string): DirSyncStats {
  const stats: DirSyncStats = { updated: 0, unchanged: 0, skipped: 0 };
  try {
    mkdirSync(destDir, { recursive: true });
  } catch {
    stats.skipped++;
    return stats;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch {
    stats.skipped++;
    return stats;
  }
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      const sub = syncDirTreeDiff(srcPath, destPath, backupExt);
      stats.updated += sub.updated;
      stats.unchanged += sub.unchanged;
      stats.skipped += sub.skipped;
    } else if (entry.isFile()) {
      const outcome = syncOneFile(srcPath, destPath, backupExt);
      stats[outcome]++;
    }
    // Symlinks / sockets / FIFOs intentionally ignored (the launcher
    // preset tree shouldn't contain them).
  }
  return stats;
}

function abortActiveSync(opts: SyncActivePresetSkillsOptions, result: SyncActivePresetSkillsResult, reason: string): SyncActivePresetSkillsResult {
  result.skipped.push(`${opts.sourceDir}: ${reason}`);
  opts.onWarn?.("active preset sync aborted", { sourceDir: opts.sourceDir, reason });
  return result;
}

/** True iff `absPath`'s realpath resolves inside `rootPath`'s
 *  realpath. Defends `processActiveSlug` against a starred `mc-*`
 *  slug that's actually a symlink to somewhere outside
 *  `activeDir`: without this check, the recursive copy below would
 *  follow the symlink and write through to the link's target
 *  (potentially anywhere on disk). Returns false on any error so
 *  the caller treats unreadable paths as "refused" rather than
 *  "OK to write". */
function isRealpathInside(absPath: string, rootPath: string): boolean {
  try {
    const real = realpathSync(absPath);
    const rootReal = realpathSync(rootPath);
    return isInsideRoot(rootReal, real);
  } catch {
    return false;
  }
}

type DestVerdict = { ok: true } | { ok: false; reason: string } | { kind: "not-active" };

/** Validate the active dest slug dir before writing through it.
 *  Returns:
 *   - `{ ok: true }`           — proceed with the sync
 *   - `{ kind: "not-active" }` — slug hasn't been starred yet
 *   - `{ ok: false; reason }`  — refuse to write (symlink escape,
 *                                non-directory, ancestor escape)
 *
 *  Symlink defenses (Codex P1 review on PR #1490): `statSync`
 *  follows symlinks, so a starred `mc-*` slug that's actually a
 *  symlink to /etc would let the recursive copy below write
 *  outside the workspace. Two-layer defense:
 *   1. `lstatSync` to see the link itself; if it's a symlink,
 *      only accept when its target stays inside `activeDir`.
 *   2. Always realpath-verify the full path (catches the case
 *      where an ancestor like `.claude/` is symlinked even when
 *      the slug dir itself is a regular directory). */
function classifyActiveDest(slug: string, destSlugDir: string, activeDir: string): DestVerdict {
  let destInfo;
  try {
    destInfo = lstatSync(destSlugDir);
  } catch {
    return { kind: "not-active" };
  }
  if (destInfo.isSymbolicLink()) {
    if (!isRealpathInside(destSlugDir, activeDir)) {
      return { ok: false, reason: "active slot is a symlink whose target escapes activeDir; refusing to write through it" };
    }
    return { ok: true };
  }
  if (!destInfo.isDirectory()) {
    return { ok: false, reason: "active slot is occupied by a non-directory; skipping" };
  }
  if (!isRealpathInside(destSlugDir, activeDir)) {
    return { ok: false, reason: "active slug dir escapes activeDir via an ancestor symlink" };
  }
  return { ok: true };
}

/** Per-slug worker for `syncActivePresetSkills`. Extracted to keep
 *  the outer function under the `sonarjs/cognitive-complexity`
 *  threshold; no behavior difference vs the inline loop. */
function processActiveSlug(slug: string, opts: SyncActivePresetSkillsOptions, result: SyncActivePresetSkillsResult, backupExt: string): void {
  const srcSlugDir = path.join(opts.sourceDir, slug);
  try {
    if (!statSync(srcSlugDir).isDirectory()) return;
  } catch {
    return;
  }
  const destSlugDir = path.join(opts.activeDir, slug);
  const verdict = classifyActiveDest(slug, destSlugDir, opts.activeDir);
  if ("kind" in verdict) {
    result.notActive.push(slug);
    return;
  }
  if (!verdict.ok) {
    result.skipped.push(`${slug}: ${verdict.reason}`);
    opts.onWarn?.("active preset sync skipped", { slug, reason: verdict.reason, destSlugDir });
    return;
  }
  const stats = syncDirTreeDiff(srcSlugDir, destSlugDir, backupExt);
  if (stats.updated > 0) {
    result.updated.push(slug);
    opts.onInfo?.("active preset skill updated from source", { slug, files: stats.updated, backupSuffix: backupExt });
  } else if (stats.skipped === 0) {
    result.unchanged.push(slug);
  }
  if (stats.skipped > 0) {
    result.skipped.push(`${slug}: ${stats.skipped} file(s) skipped`);
    opts.onWarn?.("active preset skill partial update", { slug, skipped: stats.skipped });
  }
}

/** Realpath targets of active symlinks. Used so the prune below never
 *  deletes a directory that's serving as a symlink target (e.g. a
 *  git-managed checkout the user symlinks an active slug to). */
function collectSymlinkTargets(activeDir: string, entries: readonly string[]): Set<string> {
  const targets = new Set<string>();
  for (const slug of entries) {
    const entryPath = path.join(activeDir, slug);
    try {
      if (lstatSync(entryPath).isSymbolicLink()) targets.add(realpathSync(entryPath));
    } catch {
      /* unreadable — ignore */
    }
  }
  return targets;
}

/** True iff the active `slug` is a retired preset safe to delete: an
 *  `mc-*` real directory inside `activeDir`, with no source preset, and
 *  not itself a symlink or a symlink target. */
function isRetiredActiveSlug(slug: string, activeDir: string, sourceSlugs: ReadonlySet<string>, symlinkTargets: ReadonlySet<string>): boolean {
  if (!isPresetSlug(slug) || sourceSlugs.has(slug)) return false;
  const destSlugDir = path.join(activeDir, slug);
  let info;
  try {
    info = lstatSync(destSlugDir);
  } catch {
    return false;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return false;
  if (!isRealpathInside(destSlugDir, activeDir)) return false;
  try {
    return !symlinkTargets.has(realpathSync(destSlugDir));
  } catch {
    return false;
  }
}

/** Prune active `mc-*` slugs whose launcher source preset no longer
 *  exists (a retired preset). Without this, an upgraded workspace that
 *  had starred a since-removed preset (e.g. `mc-manage-sources`) keeps
 *  the active copy forever — Claude would still discover a skill whose
 *  backend was deleted. Bounded to `mc-*` real directories that stay
 *  inside `activeDir` (never a symlink escape, never a user skill). */
function removeRetiredActivePresets(opts: SyncActivePresetSkillsOptions, result: SyncActivePresetSkillsResult, sourceSlugs: ReadonlySet<string>): void {
  let activeEntries: string[];
  try {
    activeEntries = readdirSync(opts.activeDir);
  } catch {
    return; // no active dir yet → nothing to prune
  }
  const symlinkTargets = collectSymlinkTargets(opts.activeDir, activeEntries);
  for (const slug of activeEntries) {
    if (!isRetiredActiveSlug(slug, opts.activeDir, sourceSlugs, symlinkTargets)) continue;
    try {
      rmSync(path.join(opts.activeDir, slug), { recursive: true, force: true });
      result.removed.push(slug);
      opts.onInfo?.("removed retired active preset skill", { slug });
    } catch (err) {
      result.skipped.push(`${slug}: prune failed: ${errorMessage(err)}`);
      opts.onWarn?.("active preset prune failed", { slug, reason: errorMessage(err) });
    }
  }
}

/** Refresh every already-starred `mc-*` preset's active copy in
 *  `<workspaceRoot>/.claude/skills/<slug>/` to match the source.
 *  Per-file diff with `.bak.<timestamp>` backup on overwrite. Slugs
 *  that aren't starred yet are listed in `notActive` but never
 *  auto-created. */
export function syncActivePresetSkills(opts: SyncActivePresetSkillsOptions): SyncActivePresetSkillsResult {
  const result: SyncActivePresetSkillsResult = { updated: [], unchanged: [], notActive: [], removed: [], skipped: [], backupSuffix: null };
  if (!existsSync(opts.sourceDir)) return result;
  let sourceInfo;
  try {
    sourceInfo = statSync(opts.sourceDir);
  } catch (err) {
    return abortActiveSync(opts, result, `source path stat failed: ${errorMessage(err)}`);
  }
  if (!sourceInfo.isDirectory()) {
    return abortActiveSync(opts, result, "source path exists as a non-directory; active preset sync skipped");
  }
  let sourceEntries: string[];
  try {
    sourceEntries = readdirSync(opts.sourceDir);
  } catch (err) {
    return abortActiveSync(opts, result, `source readdir failed: ${errorMessage(err)}`);
  }
  // Single timestamp per run so a multi-file update produces sibling
  // backups with a matching suffix — easier to grep / restore.
  const backupExt = `.bak.${Date.now()}`;
  result.backupSuffix = backupExt;
  const sourceSlugs = new Set<string>();
  for (const slug of sourceEntries) {
    if (slug.startsWith(".")) continue;
    if (!isPresetSlug(slug)) continue;
    sourceSlugs.add(slug);
    processActiveSlug(slug, opts, result, backupExt);
  }
  // Prune active copies of presets the launcher no longer ships.
  removeRetiredActivePresets(opts, result, sourceSlugs);
  if (result.updated.length > 0 || result.removed.length > 0) {
    opts.onInfo?.("active preset skills synced", {
      updated: result.updated.length,
      unchanged: result.unchanged.length,
      notActive: result.notActive.length,
      removed: result.removed.length,
      skipped: result.skipped.length,
      backupSuffix: backupExt,
    });
  }
  return result;
}
