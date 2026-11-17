// Import a registry collection into the active workspace. The writer fetches
// the bundle, re-validates the schema with the host's own gates (R7 — the
// index is not a trust boundary), writes the bundle into `data/skills/<localSlug>/`
// with a host-owned dataPath (R3), materializes any seed records into that
// dataPath when it's empty, and records provenance in `.origin.json` for
// update detection (R5/R8). After the data-skills swap, the bundle's
// allowlisted files (SKILL.md, schema.json, templates/<safe>) are mirrored
// 1:1 into `.claude/skills/<localSlug>/` via the same skill-bridge rules an
// agent-authored skill would go through — so an authored and an imported
// collection live in EXACTLY the same place on disk, and the user can edit
// either one identically.
//
// `.origin.json` lives ONLY in `data/skills/<slug>/.origin.json` and is NOT
// mirrored — the skill-bridge allowlist deliberately excludes host
// bookkeeping. Its presence is what distinguishes "imported" from
// "user-authored" in every downstream tool.
//
// `writeImportedCollection` takes the already-fetched bundle + an explicit
// workspaceRoot/clock so it is unit-testable against a temp workspace with
// no network; `performImport` is the thin glue that fetches and calls it.

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { acceptParsedSchema, CollectionSchemaZ, isSafeActionTemplatePath, safeRecordId } from "../../server/index.js";
import type { CollectionSchema } from "../../index.js";
import { claudeSkillDir, dataSkillDir, mirrorSkillWrite } from "../../../skill-bridge/index.js";

import { log, projectSkillsDir, skillsStagingDir } from "../../server/host.js";
import { errorMessage } from "../../server/util.js";
import { writeFileAtomic } from "../../../files/atomic.js";
import { isWithinRoot } from "../../../files/containment.js";
import { isRecord } from "../guards.js";
import { fetchAllRegistries } from "./client.js";
import { fetchBundle, fetchManifest, normalizedDataPath } from "./importCollection.js";
import type { RegistryEntry } from "../registryIndex.js";

const ORIGIN_FILE = ".origin.json";
const SEED_PREFIX = "seed/items/";
const SCHEMA_FILE = "schema.json";
const SKILL_FILE = "SKILL.md";
const STATUS_NOT_FOUND = 404;
const STATUS_CONFLICT = 409;
const STATUS_UNPROCESSABLE = 422;

export interface ImportOrigin {
  registry: string;
  author: string;
  slug: string;
  version: string;
  contentSha: string;
  importedAt: string;
}

export type ImportResult =
  { ok: true; localSlug: string; updated: boolean; seedWritten: number; seedSkipped: boolean } | { ok: false; status: number; error: string };

async function statType(target: string): Promise<"dir" | "other" | "absent"> {
  try {
    return (await stat(target)).isDirectory() ? "dir" : "other";
  } catch (err) {
    // EACCES etc. are path-shape conflicts mkdir would later throw on → "other".
    // A file ancestor surfaces as ENOTDIR on POSIX but ENOENT on Windows (which
    // reports the whole path as missing), so ENOENT can't be trusted as "absent"
    // until we've confirmed no existing ancestor is a non-directory file.
    if (!(isRecord(err) && err.code === "ENOENT")) return "other";
    return (await hasNonDirAncestor(target)) ? "other" : "absent";
  }
}

// Walk up from `target` to the nearest ancestor that exists: a non-directory
// file there means `target` can never be mkdir'd (a path-shape conflict → 409),
// whichever errno the platform's `stat(target)` chose. An all-absent-or-directory
// chain up to the filesystem root is a genuine "absent".
async function hasNonDirAncestor(target: string): Promise<boolean> {
  let current = path.dirname(target);
  while (current !== path.dirname(current)) {
    try {
      return !(await stat(current)).isDirectory();
    } catch (err) {
      if (isRecord(err) && err.code === "ENOENT") {
        current = path.dirname(current);
        continue;
      }
      return true;
    }
  }
  return false;
}

async function isEmptyOrAbsentDir(target: string): Promise<boolean> {
  try {
    return (await readdir(target)).length === 0;
  } catch {
    return true;
  }
}

function originMatches(origin: unknown, registry: string, author: string, slug: string): boolean {
  return isRecord(origin) && origin.registry === registry && origin.author === author && origin.slug === slug;
}

async function readOrigin(targetDir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(targetDir, ORIGIN_FILE), "utf-8"));
  } catch {
    return null;
  }
}

type TargetResolution = { targetDir: string; localSlug: string; updated: boolean } | { conflict: string };

// Only bounds the fresh-slug search (a safety cap, far above any realistic
// number of same-named collections — the first free slug is normally found in
// 1–2 iterations). An EXISTING install is found via the directory scan below,
// not this loop, so updates are never missed regardless of how high the rename
// suffix is.
const MAX_SLUG_ATTEMPTS = 10000;

const renameCandidate = (slug: string, attempt: number): string => (attempt === 0 ? slug : `${slug}-${attempt + 1}`);

// True when `name` is the registry slug or a `<slug>-<n>` rename of it.
function isRenameOf(name: string, slug: string): boolean {
  if (name === slug) return true;
  if (!name.startsWith(`${slug}-`)) return false;
  const suffix = name.slice(slug.length + 1);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}

// Find an existing install of this registry collection at ANY rename suffix
// by scanning `data/skills/` — independent of any candidate bound, so a
// re-import always updates the existing install rather than duplicating it
// (even if an earlier slug freed up). An authored skill without `.origin.json`
// is invisible to this scan and so never collides with an update.
async function findMatchingInstall(skillsDir: string, registry: string, entry: RegistryEntry): Promise<string | null> {
  const names = await readdir(skillsDir).catch((): string[] => []);
  for (const name of names) {
    if (!isRenameOf(name, entry.slug)) continue;
    const dir = path.join(skillsDir, name);
    if ((await statType(dir)) === "dir" && originMatches(await readOrigin(dir), registry, entry.author, entry.slug)) return name;
  }
  return null;
}

// Pick the local install slug (rename-on-collision, R8). First reuse an
// existing matching install (update). Otherwise install fresh at the first
// free slug — the registry slug, else `<slug>-2`, `-3`, … — never clobbering
// a user's own same-named collection.
//
// A slug is "free" only when BOTH `data/skills/<slug>/` AND
// `.claude/skills/<slug>/` are absent. The mirror check matters because
// `mirrorToClaudeSkills` overwrites the mirror dir's allowlisted files and
// prunes anything else — if the user has a manually-installed Claude skill
// at `.claude/skills/<slug>/` with no corresponding `data/skills/<slug>/`
// (e.g. installed by the Claude CLI directly, or a legacy pre-refactor
// import we never migrated), picking that slug would silently overwrite
// their SKILL.md/schema.json and prune the rest of their files (CodeRabbit
// review on #1839).
/** Where an import INSTALLS in this root, and whether a mirror step follows.
 *
 *  With a staging tree the install is the usual two-step: write
 *  `data/skills/<slug>/` and mirror the allowlist into `.claude/skills/<slug>/`.
 *  A root with NO staging tree has no bridge to mirror through, so the active
 *  skill dir IS the install — and installing into `data/skills/` there would be
 *  worse than useless: the mirror makes the collection discoverable, but its
 *  `.origin.json` and every non-allowlisted asset (notably `views/`) stay in a
 *  tree that reads and deletes now deliberately ignore. Update would not find
 *  the provenance, and delete would leave the install behind. */
function importInstall(workspaceRoot: string): { skillsDir: string; mirrors: boolean } {
  const staging = skillsStagingDir(workspaceRoot);
  return staging === null ? { skillsDir: projectSkillsDir(workspaceRoot), mirrors: false } : { skillsDir: staging, mirrors: true };
}

const installDir = (workspaceRoot: string, slug: string): string => path.join(importInstall(workspaceRoot).skillsDir, slug);

async function resolveTarget(workspaceRoot: string, registry: string, entry: RegistryEntry): Promise<TargetResolution> {
  const { skillsDir, mirrors } = importInstall(workspaceRoot);
  const existing = await findMatchingInstall(skillsDir, registry, entry);
  if (existing) return { targetDir: path.join(skillsDir, existing), localSlug: existing, updated: true };
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const localSlug = renameCandidate(entry.slug, attempt);
    const sourceAbsent = (await statType(path.join(skillsDir, localSlug))) === "absent";
    // Without a mirror the two checks are the same directory, so the install
    // dir being free is the whole condition.
    const mirrorAbsent = !mirrors || (await statType(claudeSkillDir(workspaceRoot, localSlug))) === "absent";
    if (sourceAbsent && mirrorAbsent) {
      return { targetDir: path.join(skillsDir, localSlug), localSlug, updated: false };
    }
  }
  return { conflict: `couldn't find an available slug for '${entry.slug}'` };
}

type SchemaResolution = { schema: CollectionSchema } | { error: string };

function validateAndNormalize(bundle: Map<string, string>, localSlug: string, workspaceRoot: string): SchemaResolution {
  // SKILL.md is required: `mirrorToClaudeSkills` calls
  // `mirrorSkillWrite({slug, relSegments: [SKILL_FILE]})` unconditionally
  // after the data-side swap, which throws if SKILL.md is missing. Caught
  // outside, that throw is logged but the data-side write still succeeds and
  // the function returns `ok: true` for an unusable import. Reject up front
  // so a missing SKILL.md surfaces as a clean 422 instead (CodeRabbit review
  // on #1839).
  if (bundle.get(SKILL_FILE) === undefined) return { error: "bundle is missing SKILL.md" };
  const schemaText = bundle.get(SCHEMA_FILE);
  if (schemaText === undefined) return { error: "bundle is missing schema.json" };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(schemaText);
  } catch {
    return { error: "schema.json is not valid JSON" };
  }
  const parsed = CollectionSchemaZ.safeParse(parsedJson);
  if (!parsed.success) return { error: `schema.json failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  // A `dataSource` collection can't be imported: its records are the rows of
  // a machine-local data file the bundle doesn't (and can't) carry — and the
  // R3 dataPath stamp below would collide with the exactly-one-of rule.
  if (parsed.data.dataSource !== undefined) {
    return { error: "schema.json declares `dataSource` — external-data collections are machine-local and cannot be imported from a registry" };
  }
  const schema: CollectionSchema = { ...parsed.data, dataPath: normalizedDataPath(localSlug) };
  const acceptance = acceptParsedSchema(schema, { source: "project", workspaceRoot, slug: localSlug });
  if (!acceptance.ok) return { error: `schema.json rejected: ${acceptance.reason}` };
  return { schema };
}

async function writeBundleFiles(targetDir: string, bundle: Map<string, string>, schema: CollectionSchema): Promise<void> {
  for (const [rel, content] of bundle) {
    if (rel.startsWith(SEED_PREFIX)) continue; // seed goes to dataPath, not the skill dir
    const dest = path.join(targetDir, ...rel.split("/"));
    if (!isWithinRoot(targetDir, dest)) continue; // belt-and-suspenders (paths pre-validated)
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, rel === SCHEMA_FILE ? `${JSON.stringify(schema, null, 2)}\n` : content, "utf-8");
  }
}

async function materializeSeed(dataDir: string, bundle: Map<string, string>): Promise<{ written: number; skipped: boolean }> {
  const seedEntries = [...bundle].filter(([rel]) => rel.startsWith(SEED_PREFIX));
  if (seedEntries.length === 0) return { written: 0, skipped: false };
  if (!(await isEmptyOrAbsentDir(dataDir))) return { written: 0, skipped: true };
  await mkdir(dataDir, { recursive: true });
  let written = 0;
  for (const [rel, content] of seedEntries) {
    const fileName = rel.slice(SEED_PREFIX.length);
    if (fileName.includes("/") || safeRecordId(fileName.replace(/\.json$/, "")) === null) {
      log.warn("collections-registry", "skipped unsafe seed record", { rel });
      continue;
    }
    await writeFile(path.join(dataDir, fileName), content, "utf-8");
    written += 1;
  }
  return { written, skipped: false };
}

/** Compute the set of bundle-relative paths that should land in `.claude/skills/<slug>/`.
 *  Matches the bridge allowlist exactly — SKILL.md, schema.json,
 *  `templates/<safe>` — so anything else (seed, meta.json, views, README,
 *  assets) stays source-side. */
function bridgeAllowlistFiles(bundle: Map<string, string>): Set<string> {
  const wanted = new Set<string>([SKILL_FILE, SCHEMA_FILE]);
  for (const rel of bundle.keys()) {
    if (rel === SKILL_FILE || rel === SCHEMA_FILE) continue;
    if (rel.startsWith(SEED_PREFIX)) continue;
    if (!isSafeActionTemplatePath(rel)) continue;
    wanted.add(rel);
  }
  return wanted;
}

/** Recursively list every file under `root`, returned as forward-slash paths
 *  relative to `root`. Empty list when `root` doesn't exist. Used to spot
 *  mirror files left over from a previous install so we can prune them after
 *  writing the new ones. */
async function listFilesRecursive(root: string, prefix = ""): Promise<string[]> {
  const dir = prefix ? path.join(root, ...prefix.split("/")) : root;
  const entries: Dirent[] = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile()) out.push(rel);
    else if (entry.isDirectory()) out.push(...(await listFilesRecursive(root, rel)));
  }
  return out;
}

// Mirror the just-written `data/skills/<slug>/` into `.claude/skills/<slug>/`
// using the shared bridge package — exactly the set of files an
// agent-authored skill would mirror, no more (SKILL.md, schema.json,
// templates/<safe>). `.origin.json` is host bookkeeping and stays only on the
// data side.
//
// **Write-then-prune ordering** (Codex review on #1839): write the new
// bundle's allowlisted files FIRST (each is a per-file tmp+rename, atomic),
// THEN prune mirror files that aren't in the new bundle. A transient mirror
// failure during the writes leaves the previous mirror's files in place —
// agent discovery keeps working with the prior state instead of finding an
// empty `.claude/skills/<slug>/`. The prune step is best-effort: a failure
// there leaves harmless stale leftovers but doesn't break the new install.
// Compare with the old `mirrorSkillDelete`-first ordering, which could
// silently leave an empty mirror if a subsequent write threw.
async function mirrorToClaudeSkills(workspaceRoot: string, localSlug: string, bundle: Map<string, string>): Promise<void> {
  const wanted = bridgeAllowlistFiles(bundle);
  // 1. Write the new set first (overwrites existing via tmp+rename).
  for (const rel of wanted) {
    mirrorSkillWrite(workspaceRoot, { slug: localSlug, relSegments: rel.split("/") });
  }
  // 2. Prune files that exist in the mirror but aren't in the new bundle.
  const mirrorRoot = claudeSkillDir(workspaceRoot, localSlug);
  const existing = await listFilesRecursive(mirrorRoot);
  for (const rel of existing) {
    if (wanted.has(rel)) continue;
    await rm(path.join(mirrorRoot, ...rel.split("/")), { force: true }).catch(() => undefined);
  }
}

export async function writeImportedCollection(params: {
  registry: string;
  entry: RegistryEntry;
  bundle: Map<string, string>;
  workspaceRoot: string;
  nowIso: string;
}): Promise<ImportResult> {
  const { registry, entry, bundle, workspaceRoot, nowIso } = params;
  const target = await resolveTarget(workspaceRoot, registry, entry);
  if ("conflict" in target) return { ok: false, status: STATUS_CONFLICT, error: target.conflict };

  const { localSlug } = target;

  // Pre-flight the data dir before schema validation: a non-directory at the dataPath
  // (or an ancestor that's a file → ENOTDIR) would otherwise surface as a generic 500
  // on mkdir. statType maps ENOTDIR/other to a deterministic 409 path-shape conflict.
  const dataDir = path.join(workspaceRoot, ...normalizedDataPath(localSlug).split("/"));
  if ((await statType(dataDir)) === "other") {
    return { ok: false, status: STATUS_CONFLICT, error: `data path for slug '${localSlug}' exists and is not a directory` };
  }

  const validated = validateAndNormalize(bundle, localSlug, workspaceRoot);
  if ("error" in validated) return { ok: false, status: STATUS_UNPROCESSABLE, error: validated.error };

  // Build the replacement fully in a hidden sibling staging dir under
  // `data/skills/` (bundle + origin), so the prior install is untouched until
  // everything is durably written. Leftover staging/backup dirs from a
  // crashed import are cleaned first, keeping retries possible.
  const skillsParent = path.dirname(target.targetDir);
  await mkdir(skillsParent, { recursive: true }); // first-import case — data/skills/ may not exist
  const staging = path.join(skillsParent, `.importing-${localSlug}`);
  const backup = path.join(skillsParent, `.backup-${localSlug}`);
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeBundleFiles(staging, bundle, validated.schema);
  const origin: ImportOrigin = { registry, author: entry.author, slug: entry.slug, version: entry.version, contentSha: entry.contentSha, importedAt: nowIso };
  await writeFileAtomic(path.join(staging, ORIGIN_FILE), `${JSON.stringify(origin, null, 2)}\n`);

  // Swap with rollback: move the old install aside (rename), move the new in
  // (rename), then discard the old. If the swap fails, restore the old so we
  // never end up with no installed collection. Records live in dataPath (a
  // separate dir) and are untouched.
  if (target.updated) await rename(target.targetDir, backup);
  try {
    await rename(staging, target.targetDir);
  } catch (err) {
    if (target.updated) await rename(backup, target.targetDir).catch(() => undefined);
    throw err;
  }
  await rm(backup, { recursive: true, force: true });

  // Replicate the new `data/skills/<slug>/` set into `.claude/skills/<slug>/`
  // via the shared bridge package — same allowlist + tmp+rename semantics the
  // hook uses for agent-authored writes. Write-then-prune ordering inside
  // mirrorToClaudeSkills means a transient failure here can't leave the mirror
  // empty (Codex review on #1839); the worst case is a half-written mirror
  // where the new install's SKILL.md/schema.json may not have updated, but the
  // prior install remains accessible to the agent until the next mirror
  // attempt. Logged-not-thrown matches the hook's posture for agent writes.
  try {
    // Skipped where the install already IS the active skill dir — there is
    // nothing to mirror to, and `mirrorSkillWrite` would read a staging file
    // that never exists.
    if (importInstall(workspaceRoot).mirrors) await mirrorToClaudeSkills(workspaceRoot, localSlug, bundle);
  } catch (err) {
    log.warn("collections-registry", "mirror to .claude/skills/ failed (data/skills write succeeded; prior mirror left intact)", {
      localSlug,
      error: errorMessage(err),
    });
  }

  const seed = await materializeSeed(dataDir, bundle);
  return { ok: true, localSlug, updated: target.updated, seedWritten: seed.written, seedSkipped: seed.skipped };
}

export async function performImport(author: string, slug: string, workspaceRoot: string, registry: string | null = null): Promise<ImportResult> {
  // The import's target workspace is also the registry scope — a multi-root
  // host's per-project `collections-registries.json` must be the one consulted.
  const merged = await fetchAllRegistries({ workspaceRoot });
  let entry: RegistryEntry | undefined;
  for (const reg of merged) {
    if (registry !== null && reg.name !== registry) continue;
    entry = reg.entries.find((candidate) => candidate.author === author && candidate.slug === slug);
    if (entry) break;
  }
  if (!entry) return { ok: false, status: STATUS_NOT_FOUND, error: `unknown collection: ${author}/${slug}` };
  const manifest = await fetchManifest(entry, { workspaceRoot });
  if (!manifest.ok) return { ok: false, status: manifest.status, error: manifest.error };
  const bundle = await fetchBundle(entry, manifest.files, { workspaceRoot });
  if (!bundle.ok) return { ok: false, status: bundle.status, error: bundle.error };
  try {
    return await writeImportedCollection({
      registry: entry.registryName,
      entry,
      bundle: bundle.files,
      workspaceRoot,
      nowIso: new Date().toISOString(),
    });
  } catch (err) {
    log.warn("collections-registry", "import write failed", { author, slug, registry: entry.registryName, error: errorMessage(err) });
    return { ok: false, status: 500, error: `import failed: ${errorMessage(err)}` };
  }
}

// Exported for downstream code that wants the path conventions without
// importing skill-bridge directly.
export { claudeSkillDir, dataSkillDir, installDir, hasNonDirAncestor };
