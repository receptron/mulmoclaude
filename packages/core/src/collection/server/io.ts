// Read / write item files for schema-driven collections. Records live at
// `<dataDir>/<itemId>.json`, one JSON object per file. Writes are
// atomic; deletes are idempotent enough to expose a clear 404 when
// the file is missing.

import { lstat, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { collectionChangePayload, getWorkspaceRoot, log, publishCollectionChange } from "./host";
import { writeFileAtomic } from "../../files/atomic.js";
import { newItemId } from "../core/itemId";
import { isContainedInRoot, itemFilePath, safeRecordId } from "./paths";
import type { CollectionItem, CollectionSchema } from "../core/schema";
import { isErrorWithCode, isRecord, mapWithConcurrency } from "@mulmoclaude/common";

// Caps the lstat + readFile pairs, and so the file handles, one listing holds open.
const LIST_READ_CONCURRENCY = 64;

export interface IoOptions {
  /** Override the workspace root for containment checks. Default:
   *  the live `workspacePath`. Tests point this at a `mkdtempSync`
   *  tree so the realpath-based escape detection can be exercised
   *  without touching `~/mulmoclaude/`. Same pattern as
   *  `server/workspace/skills/catalog.ts#CatalogOptions`. */
  workspaceRoot?: string | undefined;
  /** Collection slug this write/delete belongs to. When provided, a
   *  successful write/delete publishes a record-change event (see
   *  `publishCollectionChange`) so live views refetch. `writeItem` has no
   *  slug of its own (it's keyed by `dataDir`), so callers thread it through;
   *  omitting it just means no event is published (internal / test writes). */
  slug?: string | undefined;
}

/** True iff `filePath` exists and is a regular file (NOT a symlink).
 *  Defends `listItems` / `readItem` against `*.json` symlinks placed
 *  inside an otherwise-contained data dir — without this, a record
 *  file could symlink to /etc/passwd and the detail endpoint would
 *  happily serve it. Returns false on ENOENT and on any other lstat
 *  failure so the caller's "missing" branch covers those cases too.
 *  Exported so `ontology.ts`'s record COUNT classifies entries with the
 *  SAME lstat logic — the two must agree on what a record file is. */
export async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

/** Read one JSON record file. Returns null when the file is missing,
 *  is a symlink (file-disclosure defense), parses to a non-object,
 *  or has a read/parse error. Caller logs the per-entry skip — this
 *  helper just classifies. Split out to keep `listItems` under the
 *  `sonarjs/cognitive-complexity` threshold. */
/** Parse a record file's text into a plain-object `CollectionItem`, or
 *  null when it isn't a JSON object (array / scalar / null). */
function parseRecordJson(raw: string): CollectionItem | null {
  const parsed: unknown = JSON.parse(raw);
  return isRecord(parsed) ? parsed : null;
}

async function tryReadRecord(filePath: string): Promise<CollectionItem | null> {
  if (!(await isRegularFile(filePath))) return null;
  try {
    return parseRecordJson(await readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Read every record under `dataDir`. Returns [] if the dir doesn't
 *  exist yet (legitimate first-use state). Malformed JSON files and
 *  symlinked records are skipped (the latter is a file-disclosure
 *  defense — see `isRegularFile`). Re-validates the realpath
 *  containment to defend against a symlinked data dir appearing
 *  between discovery and use. */
export async function listItems(dataDir: string, opts: IoOptions = {}): Promise<CollectionItem[]> {
  const workspaceRoot = opts.workspaceRoot ?? getWorkspaceRoot();
  if (!isContainedInRoot(dataDir, workspaceRoot)) {
    log.warn("collections", "listItems refused: dataDir escapes workspace via symlink", { dataDir });
    return [];
  }
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch (err) {
    if (isErrorWithCode(err) && err.code === "ENOENT") return [];
    throw err;
  }
  const filePaths = entries.filter(isRecordFileName).map((name) => path.join(dataDir, name));
  const records = await mapWithConcurrency(filePaths, LIST_READ_CONCURRENCY, tryReadRecord);
  return records.filter((record, index): record is CollectionItem => {
    if (record !== null) return true;
    log.warn("collections", "skipping record (missing, symlink, or unreadable)", { path: filePaths[index] });
    return false;
  });
}

function isRecordFileName(name: string): boolean {
  return name.endsWith(".json") && !name.startsWith(".");
}

/** Read one record by id. Returns null when the file is missing,
 *  when the resolved path escapes the workspace via a symlink, or
 *  when the record file itself is a symlink (file-disclosure
 *  defense — see `isRegularFile`). */
export async function readItem(dataDir: string, itemId: string, opts: IoOptions = {}): Promise<CollectionItem | null> {
  const safeId = safeRecordId(itemId);
  if (safeId === null) return null;
  const workspaceRoot = opts.workspaceRoot ?? getWorkspaceRoot();
  if (!isContainedInRoot(dataDir, workspaceRoot)) return null;
  const filePath = itemFilePath(dataDir, safeId);
  if (!(await isRegularFile(filePath))) return null;
  try {
    return parseRecordJson(await readFile(filePath, "utf-8"));
  } catch (err) {
    if (isErrorWithCode(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

export interface WriteItemOptions extends IoOptions {
  /** When true (POST/create), refuse to overwrite an existing file
   *  and return `kind: "conflict"`. Update flow (PUT) leaves it false. */
  refuseOverwrite?: boolean | undefined;
}

export type WriteItemResult =
  | { kind: "ok"; itemId: string; item: CollectionItem }
  | { kind: "invalid-id"; itemId: string }
  | { kind: "conflict"; itemId: string }
  | { kind: "path-escape"; itemId: string };

/** The symlink-containment refusal every record path shares: one check, one
 *  warn, one answer. Extracted because this is a security RULE applied at
 *  three sites (write pre-mkdir, write post-mkdir, delete) — a fix to the
 *  check must not be able to land at only one of them.
 *
 *  `stage` names the call site so the warn stays as diagnosable as the three
 *  hand-written copies were.
 *
 *  Scope, stated explicitly because a reviewer asks every time: this catches
 *  a symlink that EXISTS when we look — `isContainedInRoot` realpaths the
 *  closest existing ancestor, so a pre-planted escape is refused. It does not
 *  and cannot close the check-then-use race, where an ancestor is swapped for
 *  a symlink between this call and the `mkdir` / `open` / `unlink` that
 *  follows. Closing that needs directory-handle I/O anchored at the workspace
 *  (`openat` + `O_NOFOLLOW`), which `node:fs` does not expose — it would mean
 *  a different I/O layer, not a tighter check here.
 *
 *  That race is deliberately outside this app's threat model: the process is
 *  loopback-bound and bearer-authed, so anyone able to swap directories inside
 *  the workspace is already the workspace owner — the same trust principal the
 *  writes belong to. Revisit if collections ever serve a lower-trust caller. */
function escapesWorkspace(dataDir: string, workspaceRoot: string, itemId: string, stage: string): boolean {
  if (isContainedInRoot(dataDir, workspaceRoot)) return false;
  log.warn("collections", `${stage} refused: dataDir escapes workspace via symlink`, { dataDir, itemId });
  return true;
}

/** Write a record. Ensures the directory exists, validates the id,
 *  re-checks symlink containment after mkdir, and writes atomically.
 *
 *  Create path (`refuseOverwrite: true`) uses an O_EXCL `wx` open
 *  rather than `stat` + `writeFileAtomic` to close a check-then-write
 *  race: two concurrent POSTs would otherwise both pass the existence
 *  check and one would silently overwrite the other. The trade-off
 *  is that the create path is not crash-atomic (a partial file could
 *  remain if the process dies mid-write); acceptable here because
 *  records are small JSON blobs and the next read either parses or
 *  is skipped via the "malformed JSON" branch in `listItems`.
 *
 *  Update path (`refuseOverwrite: false`) uses `writeFileAtomic` so
 *  PUT remains crash-atomic. No race there — the URL pins the id. */
export async function writeItem(dataDir: string, itemId: string, item: CollectionItem, opts: WriteItemOptions = {}): Promise<WriteItemResult> {
  const safeId = safeRecordId(itemId);
  if (safeId === null) return { kind: "invalid-id", itemId };
  const workspaceRoot = opts.workspaceRoot ?? getWorkspaceRoot();
  // Containment check runs BEFORE mkdir so we never create
  // directories outside the workspace even if a symlink ancestor
  // was swapped after discovery. We re-check AFTER mkdir to catch
  // a symlink racing in between the two — belt + suspenders, cheap
  // and the only honest defense against TOCTOU on directory creation.
  if (escapesWorkspace(dataDir, workspaceRoot, safeId, "writeItem (pre-mkdir)")) return { kind: "path-escape", itemId: safeId };
  await mkdir(dataDir, { recursive: true });
  if (escapesWorkspace(dataDir, workspaceRoot, safeId, "writeItem (post-mkdir)")) return { kind: "path-escape", itemId: safeId };
  const filePath = itemFilePath(dataDir, safeId);
  const payload = `${JSON.stringify(item, null, 2)}\n`;

  if (opts.refuseOverwrite) {
    let handle;
    try {
      handle = await open(filePath, "wx");
    } catch (err) {
      if (isErrorWithCode(err) && err.code === "EEXIST") return { kind: "conflict", itemId: safeId };
      throw err;
    }
    try {
      await handle.writeFile(payload);
    } finally {
      await handle.close();
    }
  } else {
    await writeFileAtomic(filePath, payload);
  }
  // Publish AFTER the write lands so a live subscriber that refetches always
  // sees the new record (never a read-before-write race).
  if (opts.slug) publishCollectionChange(collectionChangePayload({ slug: opts.slug, ids: [safeId], op: "upsert" }, opts.workspaceRoot));
  return { kind: "ok", itemId: safeId, item };
}

export type DeleteItemResult =
  { kind: "ok"; itemId: string } | { kind: "invalid-id"; itemId: string } | { kind: "not-found"; itemId: string } | { kind: "path-escape"; itemId: string };

export async function deleteItem(dataDir: string, itemId: string, opts: IoOptions = {}): Promise<DeleteItemResult> {
  const safeId = safeRecordId(itemId);
  if (safeId === null) return { kind: "invalid-id", itemId };
  const workspaceRoot = opts.workspaceRoot ?? getWorkspaceRoot();
  if (escapesWorkspace(dataDir, workspaceRoot, safeId, "deleteItem")) return { kind: "path-escape", itemId: safeId };
  const filePath = itemFilePath(dataDir, safeId);
  try {
    await unlink(filePath);
    if (opts.slug) publishCollectionChange(collectionChangePayload({ slug: opts.slug, ids: [safeId], op: "delete" }, opts.workspaceRoot));
    return { kind: "ok", itemId: safeId };
  } catch (err) {
    if (isErrorWithCode(err) && err.code === "ENOENT") return { kind: "not-found", itemId: safeId };
    throw err;
  }
}

/** Generate a record id. Used by POST when the form doesn't carry a
 *  primary-key value (UI shortcut — Claude normally derives a semantic
 *  id from the record's name). Delegates to the isomorphic generator, so
 *  the id the UI pre-fills and the id a blank-id POST mints stay the
 *  same thing rather than two implementations that have to agree. */
export function generateItemId(): string {
  return newItemId();
}

/** The item id a CREATE should use for `schema`, or null when the
 *  caller should generate one. A singleton collection pins every
 *  create to its fixed `schema.singleton` id, so the "at most one
 *  record" contract is enforced server-side (a second create targets
 *  the same file and hits `writeItem`'s refuseOverwrite conflict) —
 *  not only in the UI. Otherwise the record's own primaryKey value
 *  wins, falling back to a generated id (null = "generate"). */
export function resolveCreateItemId(schema: CollectionSchema, record: CollectionItem): string | null {
  if (schema.singleton) return schema.singleton;
  const primaryRaw = record[schema.primaryKey];
  return typeof primaryRaw === "string" && primaryRaw.length > 0 ? primaryRaw : null;
}
