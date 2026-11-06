// The one check every bearer surface on the host applies — `/api/*`,
// `/ws/pubsub`, `/ws/chat`: the owner token, or a named client token from the
// store (#3618).

import { getCurrentToken } from "./token.js";
import { resolvePrincipal, type ClientTokenRecord, type Principal } from "./clientTokenRule.js";
import { clientTokenUsagePath, clientTokensPath, createClientTokenSource, readClientTokenFile } from "./clientTokenStore.js";
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

function usageTracker(): ClientTokenUsageTracker {
  const filePath = clientTokenUsagePath();
  const tracker = usageTrackers.get(filePath) ?? createClientTokenUsageTracker({ filePath, liveIds: () => storedClientTokens().map((record) => record.id) });
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

export const isAuthorizedBearer = (provided: unknown): boolean => resolveTokenPrincipal(provided) !== null;

// Who `bearerAuth` let in, for a handler whose rule depends on more than the
// path. A WeakMap so a finished request leaves nothing behind.
const requestPrincipals = new WeakMap<object, Principal>();

export function rememberRequestPrincipal(req: object, principal: Principal): void {
  requestPrincipals.set(req, principal);
}

export const isClientTokenRequest = (req: object): boolean => requestPrincipals.get(req)?.kind === "client";
