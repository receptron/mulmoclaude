// The client-token store on disk (#3618): `~/.mulmoclaude/client-tokens.json`,
// beside `secrets/` and outside the workspace — the workspace is the agent's
// data space and may be synced, and this file decides who may call the API.

import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileAtomicSync } from "../../utils/files/atomic.js";
import { log } from "../../system/logger/index.js";
import { errorMessage } from "../../utils/errors.js";
import { isErrorWithCode } from "../../utils/types.js";
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

export function writeClientTokenFile(filePath: string, records: readonly ClientTokenRecord[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: STORE_DIR_MODE });
  writeFileAtomicSync(filePath, serializeClientTokenStore(records), { mode: STORE_FILE_MODE });
}

const statKey = (stats: Stats | null): string => (stats === null ? "missing" : `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`);

function statOrNull(filePath: string): Stats | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
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
    const key = statKey(statOrNull(filePath));
    if (key !== cache.key) {
      cache.records = key === "missing" ? [] : loadForServer(filePath);
      cache.key = key;
    }
    return cache.records;
  };
}
