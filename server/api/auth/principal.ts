// The one check every bearer surface on the host applies — `/api/*`,
// `/ws/pubsub`, `/ws/chat`: the owner token, or a named client token from the
// store (#3618).

import { getCurrentToken } from "./token.js";
import { resolvePrincipal, type ClientTokenRecord, type Principal } from "./clientTokenRule.js";
import { clientTokensPath, createClientTokenSource } from "./clientTokenStore.js";

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

export const isAuthorizedBearer = (provided: unknown): boolean => resolveTokenPrincipal(provided) !== null;

// Who `bearerAuth` let in, for a handler whose rule depends on more than the
// path. A WeakMap so a finished request leaves nothing behind.
const requestPrincipals = new WeakMap<object, Principal>();

export function rememberRequestPrincipal(req: object, principal: Principal): void {
  requestPrincipals.set(req, principal);
}

export const isClientTokenRequest = (req: object): boolean => requestPrincipals.get(req)?.kind === "client";
