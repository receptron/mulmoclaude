// The client-token store on disk (#3618): `~/.mulmoclaude/client-tokens.json`,
// beside `secrets/` and outside the workspace — the workspace is the agent's
// data space and may be synced, and this file decides who may call the API.

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileAtomicSync } from "../../utils/files/atomic.js";
import { log } from "../../system/logger/index.js";
import { errorMessage } from "../../utils/errors.js";
import { isErrorWithCode } from "../../utils/types.js";
import { ONE_SECOND_MS } from "../../utils/time.js";
import { parseClientTokenStore, revokeClientToken, serializeClientTokenStore, type ClientTokenRecord } from "./clientTokenRule.js";
import { parseClientTokenUsage, type ClientTokenUsage } from "./clientTokenUsageRule.js";

const STORE_FILE_MODE = 0o600;
const STORE_DIR_MODE = 0o700;
// Each record is a few hundred bytes; a file this large is not one we wrote.
const STORE_MAX_BYTES = 1024 * 1024;

export function clientTokensPath(home: string = homedir()): string {
  return path.join(home, ".mulmoclaude", "client-tokens.json");
}

/** Last-used times (#3637). A file of its own, so recording a use never
 *  rewrites the store the server watches and the CLI locks. */
export function clientTokenUsagePath(home: string = homedir()): string {
  return path.join(home, ".mulmoclaude", "client-tokens-usage.json");
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

// A lock with no readable owner pid (written by a command killed before it
// recorded one) is taken over after this long.
const LOCK_STALE_MS = 30 * ONE_SECOND_MS;

interface LockState {
  ownerPid: number | null;
  ageMs: number;
}

/** A lock is abandoned when its recorded owner is gone; age decides only when
 *  no owner was recorded, so a paused but live command keeps its lock. */
export function isAbandonedLock(lock: LockState, isOwnerAlive: (pid: number) => boolean): boolean {
  return lock.ownerPid === null ? lock.ageMs > LOCK_STALE_MS : !isOwnerAlive(lock.ownerPid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isErrorWithCode(err) && err.code === "EPERM";
  }
}

function readLockState(lockPath: string, nowMs: number): LockState | null {
  try {
    const ageMs = nowMs - statSync(lockPath).mtimeMs;
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return { ownerPid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, ageMs };
  } catch {
    return null;
  }
}

export class ClientTokenLockBusyError extends Error {}

const busyError = (lockPath: string): Error => new ClientTokenLockBusyError(`${lockPath}: another token command is running; retry once it finishes`);

function openLock(lockPath: string): number {
  const handle = openSync(lockPath, "wx", STORE_FILE_MODE);
  writeSync(handle, `${process.pid}\n`);
  return handle;
}

function acquireLock(lockPath: string, nowMs: number): number {
  try {
    return openLock(lockPath);
  } catch (err) {
    if (!isErrorWithCode(err) || err.code !== "EEXIST") throw busyError(lockPath);
    const state = readLockState(lockPath, nowMs);
    if (state !== null && !isAbandonedLock(state, isProcessAlive)) throw busyError(lockPath);
    rmSync(lockPath, { force: true });
    try {
      return openLock(lockPath);
    } catch {
      throw busyError(lockPath);
    }
  }
}

// Only the lock this command created: if it was taken over, the new owner's
// lock must survive this command's cleanup.
function releaseLock(lockPath: string, handle: number): void {
  const { dev, ino } = fstatSync(handle);
  closeSync(handle);
  try {
    const current = statSync(lockPath);
    if (current.dev === dev && current.ino === ino) rmSync(lockPath, { force: true });
  } catch {
    // Already gone.
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
    releaseLock(lockPath, handle);
  }
}

export const REVOKE_OUTCOMES = {
  revoked: "revoked",
  notFound: "not-found",
  /** The name now belongs to a different token than the one the page listed. */
  changed: "changed",
  /** A rewrite would drop entries this server cannot read, e.g. ones a newer version wrote. */
  unreadableEntries: "unreadable-entries",
} as const;
export type RevokeOutcome = (typeof REVOKE_OUTCOMES)[keyof typeof REVOKE_OUTCOMES];

/** `token revoke` for the Settings page: same lock, same rule, but only the token
 *  the page showed. Throws `ClientTokenLockBusyError` while a CLI command runs. */
export function revokeStoredClientToken(filePath: string, target: { name: string; id: string }): RevokeOutcome {
  return withClientTokenLock(filePath, () => {
    const { records, droppedCount } = readClientTokenFile(filePath);
    const record = records.find((candidate) => candidate.name === target.name);
    if (record === undefined) return REVOKE_OUTCOMES.notFound;
    if (record.id !== target.id) return REVOKE_OUTCOMES.changed;
    if (droppedCount > 0) return REVOKE_OUTCOMES.unreadableEntries;
    writeClientTokenFile(filePath, revokeClientToken(records, target.name) ?? records);
    return REVOKE_OUTCOMES.revoked;
  });
}

/** Missing or unreadable reads as empty, logged: losing these times costs only the times. */
export function readClientTokenUsageFile(filePath: string): ClientTokenUsage {
  try {
    return parseClientTokenUsage(JSON.parse(readBoundedFile(filePath)));
  } catch (err) {
    if (!isMissing(err)) log.warn("auth", "client-token usage file unreadable; last-used times start over", { path: filePath, error: errorMessage(err) });
    return new Map();
  }
}

export function writeClientTokenUsageFile(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: STORE_DIR_MODE });
  writeFileAtomicSync(filePath, text, { mode: STORE_FILE_MODE });
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
