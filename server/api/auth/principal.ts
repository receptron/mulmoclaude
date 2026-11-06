// The one check every bearer surface on the host applies — `/api/*`,
// `/ws/pubsub`, `/ws/chat`: the owner token, or a named client token from the
// store (#3618).

import { getCurrentToken } from "./token.js";
import { resolvePrincipal, type ClientTokenRecord, type Principal } from "./clientTokenRule.js";
import { clientTokenUsagePath, clientTokensPath, createClientTokenSource, readClientTokenFile } from "./clientTokenStore.js";
import { hasFullScope, isCollectionInScope } from "./clientTokenScope.js";
import { createClientTokenUsageTracker, type ClientTokenUsageTracker } from "./clientTokenUsage.js";
import { listClientTokens, type ClientTokenListing } from "./clientTokenUsageRule.js";
import { log } from "../../system/logger/index.js";
import { errorMessage } from "../../utils/errors.js";

// Keyed by path because the path follows `homedir()`, which a test moves.
const sources = new Map<string, () => readonly ClientTokenRecord[]>();
const usageTrackers = new Map<string, ClientTokenUsageTracker>();

function storedClientTokens(): readonly ClientTokenRecord[] {
  const filePath = clientTokensPath();
  const source = sources.get(filePath) ?? createClientTokenSource(filePath);
  sources.set(filePath, source);
  return source();
}

// Read fresh rather than through the cached source, which serves an unreadable
// store as an empty one. Null unless the read was complete: an entry this server
// cannot read may be a live token whose last use must survive the flush.
function liveClientTokenIds(): string[] | null {
  try {
    const { records, droppedCount } = readClientTokenFile(clientTokensPath());
    return droppedCount > 0 ? null : records.map((record) => record.id);
  } catch {
    return null;
  }
}

function usageTracker(): ClientTokenUsageTracker {
  const filePath = clientTokenUsagePath();
  const tracker = usageTrackers.get(filePath) ?? createClientTokenUsageTracker({ filePath, liveIds: liveClientTokenIds });
  usageTrackers.set(filePath, tracker);
  return tracker;
}

// Last-used times are advisory: recording one must never fail the request.
function noteUse(tokenId: string): void {
  try {
    usageTracker().note(tokenId);
  } catch (err) {
    log.warn("auth", "could not record client-token use", { error: errorMessage(err) });
  }
}

export function resolveTokenPrincipal(provided: unknown): Principal | null {
  const principal = resolvePrincipal(provided, getCurrentToken(), storedClientTokens);
  if (principal?.kind === "client") noteUse(principal.id);
  return principal;
}

export interface StoredClientTokenListing {
  tokens: ClientTokenListing[];
  /** Entries in the store this server cannot read; they authorize nothing. */
  unreadableEntryCount: number;
}

/** What Settings shows: never a token's value or hash. Read fresh, and throws on
 *  an unreadable store, so the page reports it instead of showing no tokens. */
export function listStoredClientTokens(): StoredClientTokenListing {
  const { records, droppedCount } = readClientTokenFile(clientTokensPath());
  return { tokens: listClientTokens(records, usageTracker().snapshot()), unreadableEntryCount: droppedCount };
}

export const flushClientTokenUsage = (): void => usageTracker().flush();

/** The sockets carry every collection's events and the bridge chat, which no
 *  scope narrows, so only the owner and a `full` client token connect (#3636). */
export function isSocketAuthorizedBearer(provided: unknown): boolean {
  const principal = resolveTokenPrincipal(provided);
  return principal !== null && (principal.kind === "owner" || hasFullScope(principal.scopes));
}

// Who `bearerAuth` let in, for a handler whose rule depends on more than the
// path. A WeakMap so a finished request leaves nothing behind.
const requestPrincipals = new WeakMap<object, Principal>();

export function rememberRequestPrincipal(req: object, principal: Principal): void {
  requestPrincipals.set(req, principal);
}

export const isClientTokenRequest = (req: object): boolean => requestPrincipals.get(req)?.kind === "client";

export function isCollectionVisibleToRequest(req: object, slug: string): boolean {
  const principal = requestPrincipals.get(req);
  return principal?.kind !== "client" || isCollectionInScope(principal.scopes, slug);
}
