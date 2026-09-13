// SQLite-backed WRITABLE store (schema `storage: { type: "sqlite" }`) —
// the first non-file backend, added to validate the CollectionStore
// abstraction (plans/done/refactor-storage-virtualization.md, Stage 4).
//
// Layout: one database file (`schema.storage.path`, workspace-contained at
// discovery AND re-checked here), one table
// `records(id TEXT PRIMARY KEY, record TEXT NOT NULL)` holding each
// record's JSON. The schema's primaryKey value is the row id, gated by the
// SAME `safeRecordId` rule as the file store's `<id>.json` names, so ids
// stay portable across backends and remote-view preflights keep holding.
//
// Engine: `node:sqlite` — no native npm dependency (DuckDB pain avoided).
// The app's engines floor (Node >= 22.19) clears node:sqlite's own >= 22.5,
// so the LAZY import below is defensive: a Node built without the module
// degrades to a thrown, clearly-worded error and ONLY sqlite-backed
// collections break, exactly the DuckDB pattern in csvStore.ts. See
// packages/core/assets/helps/error-recovery.md.
//
// Order contract: list/page walk `ORDER BY id` (BINARY collation =
// codepoint order) — the same documented lexicographic-by-record-id order
// as the file store. Paging is NATIVE (LIMIT/OFFSET + COUNT(*)), the
// store's `nativePaging: true` flag is honest.
//
// Change events: io.ts is not involved here, so this store publishes its
// own `publishCollectionChange` after each successful write/delete —
// keeping the CollectionStore contract "a successful write/delete
// publishes" true for every backend.

import { lstat, mkdir } from "node:fs/promises";
import { closerFor, watchSingleFile } from "./watchFs";
import { BackendUnavailableError } from "./backendAvailability";
import path from "node:path";
import { hasNumberProp, isErrorWithCode, isRecord } from "@mulmoclaude/common";
import type { CollectionItem } from "../core/schema";
import type { LoadedCollection } from "./discoveredCollection";
import type { DeleteItemResult, IoOptions, WriteItemResult } from "./io";
import { collectionChangePayload, getWorkspaceRoot, log, publishCollectionChange } from "./host";
import { isContainedInRoot, safeRecordId } from "./paths";
import { projectItemFields, type ListOptions, type ListPage, type WriteOptions } from "./storePage";
import type { CollectionStore } from "./store";

// Minimal structural view of node:sqlite — typed locally so the build does
// not depend on @types/node shipping the (still experimental) module types.
interface SqliteStatement {
  all: (...params: (string | number)[]) => unknown[];
  get: (...params: (string | number)[]) => unknown;
  run: (...params: (string | number)[]) => { changes: number | bigint };
}
interface SqliteDatabase {
  prepare: (sql: string) => SqliteStatement;
  exec: (sql: string) => void;
  close: () => void;
}
interface SqliteModule {
  DatabaseSync: new (dbPath: string) => SqliteDatabase;
}

/** A constructor's parameter and return types are not observable at runtime,
 *  so the check stops at "DatabaseSync is constructible" — the only member of
 *  the module this store ever touches. */
function isSqliteModule(mod: unknown): mod is SqliteModule {
  return isRecord(mod) && typeof mod.DatabaseSync === "function";
}

let sqliteModule: Promise<SqliteModule> | null = null;

/** Drops the memo first so a later call can retry (e.g. tests stubbing the
 *  runtime), then reports why the backend is unusable. */
function sqliteUnavailable(reason: string): never {
  sqliteModule = null;
  throw new BackendUnavailableError(`sqlite storage needs the node:sqlite module (Node.js >= 22.5) — this runtime cannot load it: ${reason}`);
}

/** Lazy-load node:sqlite once. A runtime without it (Node < 22.5) throws a
 *  clearly-worded error the caller surfaces — never a bare MODULE_NOT_FOUND. */
function loadSqlite(): Promise<SqliteModule> {
  sqliteModule ??= import("node:sqlite").then(
    (mod) => (isSqliteModule(mod) ? mod : sqliteUnavailable("the module exposes no DatabaseSync constructor")),
    (err: unknown) => sqliteUnavailable(String(err)),
  );
  return sqliteModule;
}

/** The db file's on-disk state. A symlink or non-regular file is refused
 *  (file-disclosure defense, same rule as io.ts record files); ENOENT is
 *  just "no records yet". Any OTHER lstat failure (EACCES, EIO, …) is
 *  rethrown so reads surface a real filesystem problem instead of
 *  silently reporting an empty collection. */
async function dbFileState(absPath: string): Promise<"missing" | "file" | "refused"> {
  try {
    const info = await lstat(absPath);
    return info.isFile() ? "file" : "refused";
  } catch (err) {
    if (isErrorWithCode(err) && err.code === "ENOENT") return "missing";
    throw err;
  }
}

const CREATE_TABLE = "CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, record TEXT NOT NULL)";

type DbHandle = { kind: "ok"; database: SqliteDatabase } | { kind: "missing" } | { kind: "refused" };

/** Open the database for one operation, classifying the two unavailable
 *  states so callers can map them honestly (`refused` ⇒ path-escape,
 *  `missing` ⇒ empty / not-found — conflating them would misreport a
 *  containment escape as "item not found"). The containment pre-check runs
 *  BEFORE mkdir even when the file is missing — `isContainedInRoot`
 *  resolves through the closest existing ancestor, so a symlinked-away
 *  parent can never make the recursive mkdir create directories outside
 *  the workspace (same pre/post belt-and-suspenders as io.ts writes). */
async function openDb(absPath: string, workspaceRoot: string, mode: "read" | "write"): Promise<DbHandle> {
  const state = await dbFileState(absPath);
  if (state === "refused") {
    log.warn("collections", "sqlite database refused: not a regular file", { path: absPath });
    return { kind: "refused" };
  }
  if (!isContainedInRoot(path.dirname(absPath), workspaceRoot)) {
    log.warn("collections", "sqlite refused: database dir escapes workspace via symlink", { path: absPath });
    return { kind: "refused" };
  }
  if (mode === "read" && state === "missing") return { kind: "missing" };
  if (mode === "write") {
    await mkdir(path.dirname(absPath), { recursive: true });
    if (!isContainedInRoot(path.dirname(absPath), workspaceRoot)) {
      log.warn("collections", "sqlite write refused: database dir escapes workspace via symlink (post-mkdir)", { path: absPath });
      return { kind: "refused" };
    }
  }
  const { DatabaseSync } = await loadSqlite();
  const database = new DatabaseSync(absPath);
  // Wait for a concurrent writer's lock instead of failing fast with
  // SQLITE_BUSY. PRAGMA (not the constructor's `timeout` option, which
  // only exists on Node >= 22.16 — our sqlite floor is 22.5).
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(CREATE_TABLE);
  return { kind: "ok", database };
}

/** Run `operation` against the database and always close it; unavailable
 *  states resolve through `onUnavailable` so each caller maps `missing`
 *  vs `refused` to its own result kind. */
async function withDb<T>(
  absPath: string,
  workspaceRoot: string,
  mode: "read" | "write",
  onUnavailable: (reason: "missing" | "refused") => T,
  operation: (database: SqliteDatabase) => T | Promise<T>,
): Promise<T> {
  const handle = await openDb(absPath, workspaceRoot, mode);
  if (handle.kind !== "ok") return onUnavailable(handle.kind);
  try {
    return await operation(handle.database);
  } finally {
    handle.database.close();
  }
}

// SQLite extended result codes for the duplicate-id failure our INSERT hits:
// a PRIMARY KEY clash, and the plain-UNIQUE-index equivalent.
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** node:sqlite throws ERR_SQLITE_ERROR with the SQLite extended result
 *  code on `errcode`. Checked structurally (message text kept only as a
 *  fallback for runtimes that don't expose `errcode`). */
function isUniqueConstraintError(err: unknown): boolean {
  if (hasNumberProp(err, "errcode")) return err.errcode === SQLITE_CONSTRAINT_PRIMARYKEY || err.errcode === SQLITE_CONSTRAINT_UNIQUE;
  return String(err).includes("UNIQUE constraint");
}

function parseRow(raw: unknown): CollectionItem | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** One column of a result row. node:sqlite types rows as `unknown`, so a
 *  value that is not a row object yields no column at all. */
function readColumn(row: unknown, column: string): unknown {
  return isRecord(row) ? row[column] : undefined;
}

function rowsToItems(rows: unknown[]): CollectionItem[] {
  return rows.map((row) => parseRow(readColumn(row, "record"))).filter((item): item is CollectionItem => item !== null);
}

/** node:sqlite hands back an integer column as `number`, or as `bigint` once
 *  it leaves the safe-integer range — COUNT(*) can be either. */
function countRecords(database: SqliteDatabase): number {
  const count = readColumn(database.prepare("SELECT COUNT(*) AS n FROM records").get(), "n");
  if (typeof count === "number") return count;
  if (typeof count === "bigint") return Number(count);
  throw new Error(`sqlite COUNT(*) returned no numeric row count (got ${typeof count})`);
}

async function sqliteList(absPath: string, workspaceRoot: string): Promise<CollectionItem[]> {
  return withDb<CollectionItem[]>(
    absPath,
    workspaceRoot,
    "read",
    () => [],
    (database) => rowsToItems(database.prepare("SELECT record FROM records ORDER BY id").all()),
  );
}

async function sqlitePage(absPath: string, primaryKey: string, opts: ListOptions, workspaceRoot: string): Promise<ListPage> {
  const emptyPage: ListPage = { items: [], total: 0, truncated: false };
  return withDb(
    absPath,
    workspaceRoot,
    "read",
    () => emptyPage,
    (database) => {
      const total = countRecords(database);
      const offset = Math.max(0, opts.offset ?? 0);
      const limit = opts.limit === undefined ? -1 : Math.max(0, opts.limit); // LIMIT -1 = unbounded in SQLite
      const rows = database.prepare("SELECT record FROM records ORDER BY id LIMIT ? OFFSET ?").all(limit, offset);
      return { items: projectItemFields(rowsToItems(rows), opts.fields, primaryKey), total, truncated: false };
    },
  );
}

async function sqliteRead(absPath: string, itemId: string, workspaceRoot: string): Promise<CollectionItem | null> {
  const safeId = safeRecordId(itemId);
  if (safeId === null) return null;
  return withDb<CollectionItem | null>(
    absPath,
    workspaceRoot,
    "read",
    () => null,
    (database) => {
      const row = database.prepare("SELECT record FROM records WHERE id = ?").get(safeId);
      return parseRow(readColumn(row, "record"));
    },
  );
}

async function sqliteWrite(
  absPath: string,
  itemId: string,
  item: CollectionItem,
  opts: { workspaceRoot: string; publishRoot?: string | undefined; slug?: string | undefined; refuseOverwrite?: boolean | undefined },
): Promise<WriteItemResult> {
  const safeId = safeRecordId(itemId);
  if (safeId === null) return { kind: "invalid-id", itemId };
  const outcome = await withDb<WriteItemResult>(
    absPath,
    opts.workspaceRoot,
    "write",
    () => ({ kind: "path-escape", itemId: safeId }),
    (database) => {
      const payload = JSON.stringify(item);
      if (opts.refuseOverwrite) {
        // The PRIMARY KEY constraint is the race-safe create gate — the
        // sqlite twin of the file store's O_EXCL open.
        try {
          database.prepare("INSERT INTO records (id, record) VALUES (?, ?)").run(safeId, payload);
        } catch (err) {
          if (isUniqueConstraintError(err)) return { kind: "conflict", itemId: safeId };
          throw err;
        }
      } else {
        database.prepare("INSERT INTO records (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record").run(safeId, payload);
      }
      return { kind: "ok", itemId: safeId, item };
    },
  );
  // Publish AFTER the write lands (same ordering rule as io.ts) so a live
  // subscriber that refetches always sees the new record.
  if (outcome.kind === "ok" && opts.slug) publishCollectionChange(collectionChangePayload({ slug: opts.slug, ids: [safeId], op: "upsert" }, opts.publishRoot));
  return outcome;
}

async function sqliteDelete(
  absPath: string,
  itemId: string,
  opts: { workspaceRoot: string; publishRoot?: string | undefined; slug?: string },
): Promise<DeleteItemResult> {
  const safeId = safeRecordId(itemId);
  if (safeId === null) return { kind: "invalid-id", itemId };
  // `missing` db = nothing was ever written ⇒ not-found; `refused`
  // (containment/symlink) must surface as path-escape, never as a 404.
  const outcome = await withDb<DeleteItemResult>(
    absPath,
    opts.workspaceRoot,
    "read",
    (reason) => (reason === "refused" ? { kind: "path-escape", itemId: safeId } : { kind: "not-found", itemId: safeId }),
    (database) => {
      const { changes } = database.prepare("DELETE FROM records WHERE id = ?").run(safeId);
      return Number(changes) === 0 ? { kind: "not-found", itemId: safeId } : { kind: "ok", itemId: safeId };
    },
  );
  if (outcome.kind === "ok" && opts.slug) publishCollectionChange(collectionChangePayload({ slug: opts.slug, ids: [safeId], op: "delete" }, opts.publishRoot));
  return outcome;
}

/** Best-effort full WAL checkpoint so the MAIN db file alone is a
 *  complete snapshot (committed pages in `<db>-wal` are folded in and the
 *  WAL truncated). Used by `deleteCollection` before archiving. Returns
 *  false on any failure (runtime without node:sqlite, locked db, missing
 *  file) — the caller then archives the sidecar files alongside the db so
 *  no committed data is lost either way. */
export async function checkpointSqliteDatabase(absPath: string): Promise<boolean> {
  try {
    const { DatabaseSync } = await loadSqlite();
    const database = new DatabaseSync(absPath);
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
    return true;
  } catch {
    return false;
  }
}

/** A `storage: sqlite` store over `collection.storageFile`. A schema whose
 *  `storageFile` failed to resolve yields a read-only EMPTY store rather
 *  than a writable one — same fail-closed rule as the CSV store. */
export function sqliteStoreFor(collection: LoadedCollection, opts: IoOptions): CollectionStore {
  const file = collection.storageFile;
  const key = collection.schema.primaryKey;
  const slug = opts.slug ?? collection.slug;
  const root = (): string => opts.workspaceRoot ?? getWorkspaceRoot();
  // The EXPLICIT root (undefined when the caller relied on the host default) —
  // `root()` has already collapsed that distinction, and the change payload
  // must report only a root the caller actually named.
  const publishRoot = opts.workspaceRoot;
  if (file === undefined) {
    return {
      capabilities: { writable: false, nativeQuery: false, nativePaging: false },
      list: () => Promise.resolve([]),
      page: () => Promise.resolve({ items: [], total: 0, truncated: false }),
      read: () => Promise.resolve(null),
    };
  }
  return {
    capabilities: { writable: true, nativeQuery: false, nativePaging: true },
    list: () => sqliteList(file, root()),
    page: (pageOpts = {}) => sqlitePage(file, key, pageOpts, root()),
    read: (itemId: string) => sqliteRead(file, itemId, root()),
    write: (itemId: string, item: CollectionItem, writeOpts: WriteOptions = {}) =>
      sqliteWrite(file, itemId, item, { workspaceRoot: root(), publishRoot, slug, refuseOverwrite: writeOpts.refuseOverwrite }),
    delete: (itemId: string) => sqliteDelete(file, itemId, { workspaceRoot: root(), publishRoot, slug }),
    // One db file holds every record, so an event can't name a record. The
    // sidecars count as hits: sqlite writes land in `<db>-wal` first, and a
    // change that only touched the WAL is still a change.
    watch: async (onChange) =>
      closerFor(
        await watchSingleFile(
          file,
          (base, name) => name.startsWith(base),
          () => onChange({ kind: "collection" }),
        ),
      ),
  };
}
