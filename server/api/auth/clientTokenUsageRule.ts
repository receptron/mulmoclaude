// When each client token was last used (#3637), and what Settings lists. Pure —
// the clock and the store's records are passed in.
//
// Minute resolution, so the map changes at most once a minute per token and a
// busy client does not keep the file dirty.

import { isRecord } from "../../utils/types.js";
import { ONE_MINUTE_MS } from "../../utils/time.js";
import type { ClientTokenRecord } from "./clientTokenRule.js";

const USAGE_FILE_VERSION = 1;
const CLIENT_TOKEN_ID_RE = /^[0-9a-f]{16}$/;

/** Token id → the minute it was last used, as an ISO string. */
export type ClientTokenUsage = Map<string, string>;

export interface ClientTokenListing {
  name: string;
  id: string;
  createdAt: string;
  scopes: ClientTokenRecord["scopes"];
  lastUsedAt: string | null;
}

export const usageMinuteIso = (nowMs: number): string => new Date(Math.floor(nowMs / ONE_MINUTE_MS) * ONE_MINUTE_MS).toISOString();

/** True when this use moved the token's minute, i.e. the file needs writing. */
export function noteClientTokenUse(usage: ClientTokenUsage, tokenId: string, nowMs: number): boolean {
  const minute = usageMinuteIso(nowMs);
  if (usage.get(tokenId) === minute) return false;
  usage.set(tokenId, minute);
  return true;
}

const isUsageEntry = (entry: [string, unknown]): entry is [string, string] =>
  CLIENT_TOKEN_ID_RE.test(entry[0]) && typeof entry[1] === "string" && !Number.isNaN(Date.parse(entry[1]));

/** The usage file's JSON. Anything malformed is dropped rather than thrown:
 *  these times are advisory and must never stand in the way of a request. */
export function parseClientTokenUsage(raw: unknown): ClientTokenUsage {
  if (!isRecord(raw) || raw.version !== USAGE_FILE_VERSION || !isRecord(raw.lastUsed)) return new Map();
  const entries = Object.entries(raw.lastUsed).filter(isUsageEntry);
  return new Map(entries);
}

/** Only ids still in the store, so a revoked token's entry is dropped. `null`
 *  means the store was not read completely: nothing is dropped on a guess. */
export function pruneClientTokenUsage(usage: ClientTokenUsage, liveIds: readonly string[] | null): ClientTokenUsage {
  if (liveIds === null) return new Map(usage);
  return new Map([...usage].filter(([tokenId]) => liveIds.includes(tokenId)));
}

export function serializeClientTokenUsage(usage: ClientTokenUsage): string {
  return `${JSON.stringify({ version: USAGE_FILE_VERSION, lastUsed: Object.fromEntries(usage) }, null, 2)}\n`;
}

export function listClientTokens(records: readonly ClientTokenRecord[], usage: ReadonlyMap<string, string>): ClientTokenListing[] {
  return records.map(({ name, id, createdAt, scopes }) => ({ name, id, createdAt, scopes: [...scopes], lastUsedAt: usage.get(id) ?? null }));
}
