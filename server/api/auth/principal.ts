// The one check every bearer surface on the host applies — `/api/*`,
// `/ws/pubsub`, `/ws/chat`: the owner token, or a named client token from the
// store (#3618).

import { getCurrentToken } from "./token.js";
import { resolvePrincipal, type ClientTokenRecord, type Principal } from "./clientTokenRule.js";
import { clientTokensPath, createClientTokenSource } from "./clientTokenStore.js";
import { hasFullScope, isCollectionInScope } from "./clientTokenScope.js";

// Keyed by path because the path follows `homedir()`, which a test moves.
const sources = new Map<string, () => readonly ClientTokenRecord[]>();

function storedClientTokens(): readonly ClientTokenRecord[] {
  const filePath = clientTokensPath();
  const source = sources.get(filePath) ?? createClientTokenSource(filePath);
  sources.set(filePath, source);
  return source();
}

export function resolveTokenPrincipal(provided: unknown): Principal | null {
  return resolvePrincipal(provided, getCurrentToken(), storedClientTokens);
}

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
