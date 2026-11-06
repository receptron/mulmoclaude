// Named client tokens (#3618): who a presented bearer token belongs to, and the
// store edits `mulmoclaude token add|revoke` make. Pure — the caller injects the
// stored records, the clock and the randomness.
//
// Only a SHA-256 of each token is stored. A token is 256 random bits, so a
// plain hash is enough: there is nothing for a slow hash to stretch.

import { createHash } from "node:crypto";
import { isAuthorizedToken, tokenEquals } from "@mulmoclaude/common/token-guard";
import { isRecord, isUnknownArray } from "../../utils/types.js";
import { FULL_SCOPE, isClientTokenScope, isValidScopeSet, type ClientTokenScope } from "./clientTokenScope.js";

export const CLIENT_TOKEN_PREFIX = "mct_";
export const CLIENT_TOKEN_ID_BYTES = 8;
export const CLIENT_TOKEN_SECRET_BYTES = 32;
const CLIENT_TOKEN_RE = /^mct_([0-9a-f]{16})_[0-9a-f]{64}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const CLIENT_TOKEN_NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
const STORE_VERSION = 1;

export interface ClientTokenRecord {
  id: string;
  name: string;
  sha256: string;
  createdAt: string;
  scopes: ClientTokenScope[];
}

export type Principal = { kind: "owner" } | { kind: "client"; id: string; name: string; scopes: ClientTokenScope[] };

export const isClientTokenName = (name: string): boolean => CLIENT_TOKEN_NAME_RE.test(name);

export const hashClientToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const formatClientToken = (idHex: string, secretHex: string): string => `${CLIENT_TOKEN_PREFIX}${idHex}_${secretHex}`;

/** The id part of a well-formed client token, or null for anything else. */
export function clientTokenId(token: string): string | null {
  return CLIENT_TOKEN_RE.exec(token)?.[1] ?? null;
}

function toRecord(value: unknown): ClientTokenRecord | null {
  if (!isRecord(value)) return null;
  const { id, name, sha256, createdAt, scopes } = value;
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) return null;
  if (typeof name !== "string" || !isClientTokenName(name)) return null;
  if (typeof sha256 !== "string" || !SHA256_HEX_RE.test(sha256)) return null;
  if (typeof createdAt !== "string") return null;
  if (!isUnknownArray(scopes) || !scopes.every(isClientTokenScope) || !isValidScopeSet(scopes)) return null;
  return { id, name, sha256, createdAt, scopes: [...scopes] };
}

export interface ParsedClientTokenStore {
  records: ClientTokenRecord[];
  /** Entries that were not a valid record; they authorize nothing. */
  droppedCount: number;
}

/** The store file's parsed JSON. Throws on a file that is not a store at all,
 *  so the server accepts no client token and the CLI does not overwrite it. */
export function parseClientTokenStore(raw: unknown): ParsedClientTokenStore {
  if (!isRecord(raw) || raw.version !== STORE_VERSION || !isUnknownArray(raw.tokens)) throw new Error(`not a version ${STORE_VERSION} client-token store`);
  const parsed = raw.tokens.map(toRecord);
  const records = parsed.filter((record): record is ClientTokenRecord => record !== null);
  return { records, droppedCount: parsed.length - records.length };
}

export function serializeClientTokenStore(records: readonly ClientTokenRecord[]): string {
  return `${JSON.stringify({ version: STORE_VERSION, tokens: records }, null, 2)}\n`;
}

function findClientToken(token: string, records: readonly ClientTokenRecord[]): ClientTokenRecord | null {
  const tokenId = clientTokenId(token);
  const record = tokenId === null ? undefined : records.find((candidate) => candidate.id === tokenId);
  if (record === undefined) return null;
  return tokenEquals(hashClientToken(token), record.sha256) ? record : null;
}

/** Owner first, so the store is read only for a token in the client format.
 *  No owner token yet (pre-bootstrap) refuses everything, client tokens too. */
export function resolvePrincipal(provided: unknown, ownerToken: string | null, clientTokens: () => readonly ClientTokenRecord[]): Principal | null {
  if (ownerToken === null || ownerToken === "") return null;
  if (isAuthorizedToken(provided, ownerToken)) return { kind: "owner" };
  if (typeof provided !== "string" || !provided.startsWith(CLIENT_TOKEN_PREFIX)) return null;
  const record = findClientToken(provided, clientTokens());
  return record === null ? null : { kind: "client", id: record.id, name: record.name, scopes: record.scopes };
}

export type AddClientTokenResult =
  | { ok: true; records: ClientTokenRecord[]; token: string; record: ClientTokenRecord }
  | { ok: false; reason: "invalid-name" | "duplicate-name" | "invalid-scopes" };

export interface AddClientTokenParams {
  name: string;
  nowIso: string;
  randomHex: (bytes: number) => string;
  /** Defaults to `full`. */
  scopes?: readonly ClientTokenScope[];
}

export function addClientToken(records: readonly ClientTokenRecord[], params: AddClientTokenParams): AddClientTokenResult {
  if (!isClientTokenName(params.name)) return { ok: false, reason: "invalid-name" };
  if (records.some((record) => record.name === params.name)) return { ok: false, reason: "duplicate-name" };
  const scopes = [...new Set<ClientTokenScope>(params.scopes ?? [FULL_SCOPE])];
  if (!isValidScopeSet(scopes)) return { ok: false, reason: "invalid-scopes" };
  const tokenId = params.randomHex(CLIENT_TOKEN_ID_BYTES);
  const token = formatClientToken(tokenId, params.randomHex(CLIENT_TOKEN_SECRET_BYTES));
  const record: ClientTokenRecord = { id: tokenId, name: params.name, sha256: hashClientToken(token), createdAt: params.nowIso, scopes };
  return { ok: true, records: [...records, record], token, record };
}

/** The records without `name`, or null when no token has that name. */
export function revokeClientToken(records: readonly ClientTokenRecord[], name: string): ClientTokenRecord[] | null {
  const remaining = records.filter((record) => record.name !== name);
  return remaining.length === records.length ? null : remaining;
}
