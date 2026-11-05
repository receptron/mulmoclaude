// The client-token store on disk (#3618): `~/.mulmoclaude/client-tokens.json`,
// beside `secrets/` and outside the workspace — the workspace is the agent's
// data space and may be synced, and this file decides who may call the API.

import { closeSync, fstatSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileAtomicSync } from "../../utils/files/atomic.js";
import { log } from "../../system/logger/index.js";
import { errorMessage } from "../../utils/errors.js";
import { isErrorWithCode } from "../../utils/types.js";
import { ONE_SECOND_MS } from "../../utils/time.js";
import { parseClientTokenStore, serializeClientTokenStore, type ClientTokenRecord } from "./clientTokenRule.js";

const STORE_FILE_MODE = 0o600;
const STORE_DIR_MODE = 0o700;
// Each record is a few hundred bytes; a file this large is not one we wrote.
const STORE_MAX_BYTES = 1024 * 1024;

export function clientTokensPath(home: string = homedir()): string {
  return path.join(home, ".mulmoclaude", "client-tokens.json");
}

const isMissing = (err: unknown): boolean => isErrorWithCode(err) && err.code === "ENOENT";

function readBoundedFile(filePath: string): string {
  const handle = openSync(filePath, "r");
  try {
    const { size } = fstatSync(handle);
    if (size > STORE_MAX_BYTES) throw new Error(`larger than ${STORE_MAX_BYTES} bytes`);
    const buffer = Buffer.alloc(size);
    const bytes = readSync(handle, buffer, 0, size, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(handle);
  }
}

/** The stored records. A missing file is an empty store; anything unreadable
 *  throws, with the path in the message. */
export function readClientTokenFile(filePath: string): { records: ClientTokenRecord[]; droppedCount: number } {
  try {
    return parseClientTokenStore(JSON.parse(readBoundedFile(filePath)));
  } catch (err) {
    if (isMissing(err)) return { records: [], droppedCount: 0 };
    throw new Error(`${filePath}: ${errorMessage(err)}`);
  }
}

/** Refuses a store it could not read back, rather than locking every client out. */
export function writeClientTokenFile(filePath: string, records: readonly ClientTokenRecord[]): void {
  const text = serializeClientTokenStore(records);
  if (Buffer.byteLength(text, "utf8") > STORE_MAX_BYTES) throw new Error(`${filePath}: the store would exceed ${STORE_MAX_BYTES} bytes`);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: STORE_DIR_MODE });
  writeFileAtomicSync(filePath, text, { mode: STORE_FILE_MODE });
}

// A lock left by a killed command is taken over after this long.
const LOCK_STALE_MS = 30 * ONE_SECOND_MS;

function isStaleLock(lockPath: string, nowMs: number): boolean {
  try {
    return nowMs - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function acquireLock(lockPath: string, nowMs: number): number {
  try {
    return openSync(lockPath, "wx", STORE_FILE_MODE);
  } catch (err) {
    if (!isErrorWithCode(err) || err.code !== "EEXIST" || !isStaleLock(lockPath, nowMs)) {
      throw new Error(`${lockPath}: another token command is running; retry once it finishes`);
    }
    rmSync(lockPath, { force: true });
    return openSync(lockPath, "wx", STORE_FILE_MODE);
  }
}

/** Runs a read-modify-write of the store with no other token command in between,
 *  so two commands cannot drop each other's add or undo each other's revoke. */
export function withClientTokenLock<T>(filePath: string, run: () => T, nowMs: number = Date.now()): T {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: STORE_DIR_MODE });
  const lockPath = `${filePath}.lock`;
  const handle = acquireLock(lockPath, nowMs);
  try {
    return run();
  } finally {
    closeSync(handle);
    rmSync(lockPath, { force: true });
  }
}

const MISSING_KEY = "missing";

// `ctimeMs` so a chmod alone is noticed. Any stat failure other than ENOENT
// gets its own key and goes on to the read, which logs why it failed.
function statKey(filePath: string): string {
  try {
    const stats = statSync(filePath);
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch (err) {
    return isMissing(err) ? MISSING_KEY : `stat-error:${isErrorWithCode(err) ? err.code : "unknown"}`;
  }
}

function loadForServer(filePath: string): ClientTokenRecord[] {
  try {
    const { records, droppedCount } = readClientTokenFile(filePath);
    if (droppedCount > 0) log.warn("auth", "client-token store has invalid entries; they authorize nothing", { path: filePath, droppedCount });
    return records;
  } catch (err) {
    log.warn("auth", "client-token store unreadable; no client token is accepted", { error: errorMessage(err) });
    return [];
  }
}

/** The records, re-read whenever the file changes (an atomic write replaces
 *  the inode), so `token revoke` applies to the next request. */
export function createClientTokenSource(filePath: string): () => readonly ClientTokenRecord[] {
  const cache: { key: string | null; records: readonly ClientTokenRecord[] } = { key: null, records: [] };
  return () => {
    const key = statKey(filePath);
    if (key !== cache.key) {
      cache.records = key === MISSING_KEY ? [] : loadForServer(filePath);
      cache.key = key;
    }
    return cache.records;
  };
}
