// Delete a user-authored collection, archiving a full restorable copy
// first. A collection spans three on-disk locations (see
// docs/papers/collections-architecture.md "Deleting a collection"):
//
//   1. data/skills/<slug>/    staging — the canonical skill source
//   2. .claude/skills/<slug>/ active mirror — what discovery scans
//   3. <schema.dataPath>/     the records (one <id>.json per record)
//
// Locations 1 and 2 are a source→mirror pair maintained by the
// skill-bridge hook, but that hook only fires on the agent's own tool
// calls — a server-side delete must remove BOTH explicitly. Before
// anything is removed we write a single skill copy (from the canonical
// staging dir), the records, and an LLM-runnable RESTORE.md to
// `archive/<date>-<uuid>/`.
//
// Only project-scope, non-preset collections are deletable: user-scope
// skills (`~/.claude/skills/`) are read-only from MulmoClaude, and a
// preset (`mc-*`) re-seeds on next boot so deleting it is futile.

import { cp, mkdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isWithinRoot } from "../../files/containment.js";
import { log, getWorkspaceRoot, isPresetSlug, stagingSkillDir, archiveDir as archiveRelDir } from "./host";
import { isContainedInRoot } from "./paths";
import { checkpointSqliteDatabase } from "./sqliteStore";
import { ingestStatePath } from "../../feeds/paths";
import type { LoadedCollection } from "./discoveredCollection";

export type DeleteCollectionResult =
  | { kind: "ok"; slug: string; archivePath: string }
  | { kind: "user-scope"; slug: string }
  | { kind: "preset"; slug: string }
  | { kind: "unsafe-data-path"; slug: string }
  | { kind: "path-escape"; slug: string }
  /** A `storage: firestore` collection: its records are documents of a SHARED
   *  app, which this delete can neither archive nor remove. Deleting the skill
   *  would leave them in `apps/{aid}/collections/{cid}/items` with no
   *  collection left to reach them through — and they are not only this
   *  machine's: other members' live views are served from the same documents.
   *  Refused outright rather than done partially. */
  | { kind: "unsupported-backend"; slug: string };

type DeleteRefusal = Exclude<DeleteCollectionResult, { kind: "ok" }>;

/** Human-readable reason for a non-`ok` delete result. Exported so the
 *  route maps `kind` → message without inlining the switch (keeps the
 *  handler short and the mapping unit-testable). The `Record` is
 *  exhaustive — a new refusal kind won't compile until it's added. */
export function deleteCollectionRefusalMessage(result: DeleteRefusal): string {
  const { slug } = result;
  const messages: Record<DeleteRefusal["kind"], string> = {
    "user-scope": `collection '${slug}' is user-scope (~/.claude/skills/) and is read-only from MulmoClaude`,
    preset: `collection '${slug}' is a preset (mc-*) and re-seeds on restart; unstar it from the catalog instead`,
    "unsafe-data-path": `collection '${slug}' declares a dataPath outside its own data/${slug}/ subtree; refusing to delete`,
    "path-escape": `a directory for collection '${slug}' escapes the workspace`,
    "unsupported-backend": `collection '${slug}' is a shared collection — its records are documents of its app, which this delete can neither archive nor remove, and other members read the same documents. Removing its records first does NOT unlock it. To retire the whole app, a Firestore project administrator deletes it recursively (\`firebase firestore:delete "apps/<aid>" --recursive\`, children first); the app owner's client credentials cannot do it.`,
  };
  return messages[result.kind];
}

export interface DeleteCollectionOptions {
  /** Override the workspace root for containment checks + archive
   *  placement. Default: the live `workspacePath`. Tests point this at
   *  a `mkdtempSync` tree (same pattern as the IO helpers). */
  workspaceRoot?: string;
  /** Override the `<date>` half of the archive folder name. Tests pass
   *  a fixed stamp so the asserted path is deterministic; production
   *  leaves it unset and the current UTC date (YYYY-MM-DD) is used. */
  dateStamp?: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** UTC `YYYY-MM-DD` — keeps the archive folder human-sortable. */
function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Every directory the delete will touch must resolve under the
 *  workspace root — guards against a symlinked ancestor escaping it. */
function deleteTargets(collection: LoadedCollection, workspaceRoot: string): string[] {
  const staging = stagingSkillDir(workspaceRoot, collection.slug);
  return [
    ...(staging === null ? [] : [staging]),
    collection.skillDir,
    collection.dataDir,
    ingestStatePath(collection.slug, workspaceRoot),
    ...(collection.storageFile !== undefined ? [collection.storageFile] : []),
  ];
}

/** The records directory the delete recursively archives + removes
 *  (`collection.dataDir`) must live in this collection's OWN per-slug
 *  subtree. `dataDir` is normally derived from `schema.dataPath`, but
 *  `deleteCollection` accepts a `LoadedCollection` whose fields could be
 *  inconsistent — so we validate the RESOLVED target the destructive ops
 *  actually touch, not the schema string. A shared root like `data` or
 *  `data/skills` would otherwise turn the recursive removal into a
 *  workspace-wide wipe whose archive captures only this collection.
 *  `path.resolve` collapses any `..` before the prefix test (symlink
 *  escapes are caught separately by the realpath containment check in
 *  `deleteTargets`).
 *
 *  TWO acceptable per-slug subtrees:
 *    - `data/<slug>/...` — the convention authored collections default to.
 *    - `data/collections/<slug>/...` — what `normalizedDataPath` in the
 *      registry-import path stamps onto every imported schema (so imported
 *      collections never collide with `data/<slug>/`-shaped authored ones).
 *  Both are equally per-collection and equally safe; a delete that targets
 *  anything else (e.g. raw `data/`, `data/wiki/`, a sibling slug) is
 *  refused. */
function isDataDirSafe(dataDir: string, slug: string, workspaceRoot: string): boolean {
  const acceptableRoots = [path.resolve(workspaceRoot, "data", slug), path.resolve(workspaceRoot, "data", "collections", slug)];
  const resolved = path.resolve(dataDir);
  return acceptableRoots.some((root) => isWithinRoot(root, resolved));
}

/** Step 2 of the restore doc — how to bring the records back. A
 *  `dataSource` collection has no record files to copy (its rows live in
 *  the external data file, which the delete never touches). */
function restoreRecordsStep(schema: LoadedCollection["schema"]): string {
  if (schema.storage?.type === "firestore") {
    // Unreachable while `deleteCollection` refuses shared collections (see
    // below); kept honest in case that gate ever moves.
    return `2. Records: NOT archived. This is a shared collection: its records are
   documents at \`apps/<aid>/collections/<cid>/items\`, which this delete did
   not touch or export. They are still there, and other members still read
   them.`;
  }
  if (schema.storage !== undefined) {
    return `2. Records: copy the archived database file
   \`${path.basename(schema.storage.path)}\` (next to this document) back to
   \`${schema.storage.path}\` (workspace-relative, \`cp\`). It holds every
   record. If \`-wal\`/\`-journal\` sidecar files were archived alongside
   it, copy them back too.`;
  }
  if (schema.dataPath === undefined) {
    return `2. Records: nothing to copy. This is a \`dataSource\` collection —
   its records are the rows of \`${schema.dataSource?.path}\`, which the
   delete never touched.`;
  }
  return `2. Copy the item data: \`cp\` every file under \`records/\` into
   \`${schema.dataPath}/\`. The records are part of the collection and
   must be restored. They are plain data files (NOT bridged), so use
   \`cp\` — the Write-tool rule in step 1 applies ONLY to the skill
   files, not to these records (there may be many; copy them, do not
   Write them one by one).`;
}

/** Step 1 of the restore doc, which depends on the root's authoring layout.
 *
 *  A staged root routes around the `.claude/` permission gate and relies on the
 *  bridge hook; a root with no staging tree has neither, so the same
 *  instructions would have the user restore into `data/skills/<slug>/`, where
 *  nothing would ever read it — the collection would stay deleted while the
 *  document said it was restored. */
function restoreSkillStep(slug: string, staged: boolean): string {
  if (!staged) {
    return `1. Recreate the skill files in \`.claude/skills/${slug}/\`: read each
   file under \`skill/\` and write it to the matching path — \`SKILL.md\`,
   \`schema.json\`, any \`templates/*\`, and any \`views/*\`.

   This project has no \`data/skills/\` staging tree and no bridge hook, so
   the skill directory is read directly and no mirroring step follows. Do
   NOT restore into \`data/skills/${slug}/\` — nothing reads it there.`;
  }
  return `1. Recreate the skill files in \`data/skills/${slug}/\` using the **Write
   tool**: read each file under \`skill/\` and Write it to the matching
   path — \`SKILL.md\`, \`schema.json\`, and any \`templates/*\`.

   IMPORTANT — use the Write tool, NOT \`cp\` / \`mv\` / a shell redirect.
   The skill-bridge hook mirrors \`data/skills/${slug}/\` into
   \`.claude/skills/${slug}/\`, and that mirror is what actually registers
   the collection. The hook only fires on Write/Edit tool calls, so a
   \`cp\` would leave the files in staging with no \`.claude/skills/\`
   mirror — the collection would stay invisible. (Writing
   \`.claude/skills/\` directly is not an option either: that path is
   permission-gated.)`;
}

function buildRestoreDoc(collection: LoadedCollection, staged: boolean): string {
  const { slug, schema } = collection;
  return `# Restore "${schema.title}" (collection \`${slug}\`)

This folder is an automatic backup made when the collection was deleted.
Follow these steps to restore it.

${restoreSkillStep(slug, staged)}

${restoreRecordsStep(schema)}

3. Confirm the collection reappears at \`/collections/${slug}\`.

- slug: \`${slug}\`
- title: ${schema.title}
- dataPath: \`${schema.dataPath ?? recordLocationLabel(schema)}\`
`;
}

/** Where a non-`dataPath` collection's records live, for the restore doc's
 *  header line. */
function recordLocationLabel(schema: LoadedCollection["schema"]): string {
  if (schema.storage?.type === "firestore") return "(storage) shared app";
  if (schema.storage !== undefined) return `(storage) ${schema.storage.path}`;
  return `(dataSource) ${schema.dataSource?.path}`;
}

/** Copy one skill copy + the records + RESTORE.md into `archiveDir`. */
async function writeArchive(collection: LoadedCollection, archiveDir: string, workspaceRoot: string): Promise<void> {
  // Prefer the canonical staging dir; fall back to the active mirror
  // for a project collection that was created without the bridge.
  const staging = stagingSkillDir(workspaceRoot, collection.slug);
  const skillSrc = staging !== null && (await pathExists(staging)) ? staging : collection.skillDir;
  await cp(skillSrc, path.join(archiveDir, "skill"), { recursive: true });
  if (await pathExists(collection.dataDir)) {
    await cp(collection.dataDir, path.join(archiveDir, "records"), { recursive: true });
  }
  // A `storage` collection's records live in its database file (the
  // dataDir is a phantom) — archive it under its own basename so RESTORE
  // can point `storage.path` back at it. Checkpoint first so the main file
  // alone is a complete snapshot (in WAL mode, committed rows can live
  // only in `<db>-wal`); if the checkpoint fails (older Node, locked db),
  // archive the sidecars too — either way no committed data is lost.
  // (`dataSourceFile` is deliberately NOT archived or removed: an external
  // dataSource file is user-owned.)
  if (collection.storageFile !== undefined && (await pathExists(collection.storageFile))) {
    const checkpointed = await checkpointSqliteDatabase(collection.storageFile);
    await cp(collection.storageFile, path.join(archiveDir, path.basename(collection.storageFile)));
    if (!checkpointed) {
      for (const suffix of ["-wal", "-journal", "-shm"]) {
        const sidecar = `${collection.storageFile}${suffix}`;
        if (await pathExists(sidecar)) await cp(sidecar, path.join(archiveDir, path.basename(sidecar)));
      }
    }
  }
  await writeFile(path.join(archiveDir, "RESTORE.md"), buildRestoreDoc(collection, staging !== null), "utf-8");
}

/** Remove all three locations. `rm -rf`-style (force) so a missing dir
 *  is a no-op; the now-empty data parent (`data/<slug>/` after its
 *  `items/` is gone) is swept too, but only when empty. */
async function removeLocations(collection: LoadedCollection, workspaceRoot: string): Promise<void> {
  // Only when the root HAS a staging tree. A host that returned the skill dir
  // here instead of null would have this `rm -rf` delete the committed skill
  // under the name "staging" — see the `skillsStagingDir` contract.
  const staging = stagingSkillDir(workspaceRoot, collection.slug);
  if (staging !== null) await rm(staging, { recursive: true, force: true });
  await rm(collection.skillDir, { recursive: true, force: true });
  await rm(collection.dataDir, { recursive: true, force: true });
  await rmdir(path.dirname(collection.dataDir)).catch(() => undefined);
  // The retrieval cursor lives in a SHARED dir (`data/ingest-state/<slug>.json`),
  // outside every per-collection location above, so nothing else would remove
  // it. Left behind, a collection recreated under the same slug inherits the old
  // `lastFetchedAt` and takes the "wait for the interval" branch in
  // `isDailyAtHourDue` instead of fetching immediately — it just sits empty
  // (#2550). Deliberately not archived: the archive restores user data, and
  // restoring a stale cursor would reintroduce exactly this bug.
  await rm(ingestStatePath(collection.slug, workspaceRoot), { force: true });
  // The archived copy above is the backup; remove the live db (+ sqlite
  // sidecars) so a deleted collection doesn't leave orphaned data behind.
  if (collection.storageFile !== undefined) {
    await rm(collection.storageFile, { force: true });
    await rm(`${collection.storageFile}-wal`, { force: true });
    await rm(`${collection.storageFile}-journal`, { force: true });
    await rm(`${collection.storageFile}-shm`, { force: true });
  }
}

export async function deleteCollection(collection: LoadedCollection, opts: DeleteCollectionOptions = {}): Promise<DeleteCollectionResult> {
  const { slug } = collection;
  const workspaceRoot = opts.workspaceRoot ?? getWorkspaceRoot();
  if (collection.source === "user") return { kind: "user-scope", slug };
  if (isPresetSlug(slug)) return { kind: "preset", slug };
  if (collection.schema.storage?.type === "firestore") {
    log.warn("collections", "deleteCollection refused: a shared collection's records can be neither archived nor removed here", { slug });
    return { kind: "unsupported-backend", slug };
  }
  if (!isDataDirSafe(collection.dataDir, slug, workspaceRoot)) {
    log.warn("collections", "deleteCollection refused: dataDir is not under the per-collection root", { slug, dataDir: collection.dataDir });
    return { kind: "unsafe-data-path", slug };
  }
  if (deleteTargets(collection, workspaceRoot).some((target) => !isContainedInRoot(target, workspaceRoot))) {
    log.warn("collections", "deleteCollection refused: a target escapes the workspace", { slug });
    return { kind: "path-escape", slug };
  }
  const archiveRel = path.join(archiveRelDir(), `${opts.dateStamp ?? todayStamp()}-${randomUUID()}`);
  const archiveDir = path.join(workspaceRoot, archiveRel);
  await mkdir(archiveDir, { recursive: true });
  await writeArchive(collection, archiveDir, workspaceRoot);
  await removeLocations(collection, workspaceRoot);
  log.info("collections", "collection deleted + archived", { slug, archive: archiveRel });
  return { kind: "ok", slug, archivePath: archiveRel };
}
