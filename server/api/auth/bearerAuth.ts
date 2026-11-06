// Bearer token middleware (#272). Reject any `/api/*` request whose
// `Authorization: Bearer <token>` header doesn't match the current
// server token.
//
// This is the local-process isolation layer. `csrfGuard.ts` handles
// cross-origin browser attacks (layered on top, both must pass). This
// middleware handles the case a sibling process on the same machine
// (malicious program, another user, confused script) tries to hit
// `/api/*`: without the startup-regenerated token, every request is
// 401'd.
//
// Design choices:
// - **Exemptions** for requests the browser makes without a header
//   (`GET /api/files/*` for `<img>`, among others) are decided in
//   `./bearerExemption.ts` and applied in `server/index.ts`.
// - **No token in logs**. Reject messages are generic ("unauthorized")
//   so a leaked log line doesn't reveal whether "no header" vs
//   "wrong token" — matches common auth-hardening guidance.
// - **The token rule lives in `./principal.ts`**: the owner token or a named
//   client token (#3618), shared with the `/ws/pubsub` and `/ws/chat`
//   handshake guards, so every surface refuses the same way. A client token
//   is then refused (403) on the owner-only paths in `./clientTokenAccess.ts`,
//   and outside its scopes (`./clientTokenScope.ts`).

import type { Request, Response, NextFunction } from "express";
import { rememberRequestPrincipal, resolveTokenPrincipal } from "./principal.js";
import { isOwnerOnlyApiPath } from "./clientTokenAccess.js";
import { isWithinClientTokenScopes, type ClientTokenScope } from "./clientTokenScope.js";
import type { Principal } from "./clientTokenRule.js";
import { UNAUTHORIZED_MESSAGE } from "@mulmoclaude/common/token-guard";
import { forbidden, unauthorized } from "../../utils/httpError.js";
import { log } from "../../system/logger/index.js";

const BEARER_PREFIX = "Bearer ";

function clientRefusalReason(scopes: ClientTokenScope[], req: Request): string | null {
  if (isOwnerOnlyApiPath(req.path)) return "client token refused on an owner-only path";
  if (!isWithinClientTokenScopes(scopes, { method: req.method, path: req.path })) return "client token refused outside its scopes";
  return null;
}

/** True when the request was refused; the owner is never refused here. */
function refuseClientOutOfReach(principal: Principal, req: Request, res: Response): boolean {
  if (principal.kind !== "client") return false;
  const reason = clientRefusalReason(principal.scopes, req);
  if (reason === null) return false;
  log.warn("auth", reason, { client: principal.name, method: req.method, path: req.path });
  forbidden(res, "forbidden");
  return true;
}

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
    unauthorized(res, UNAUTHORIZED_MESSAGE);
    return;
  }
  // The owner token is null until bootstrap, which the rule refuses too: a
  // request that beats `generateAndWriteToken()` gets a 401, not a pass.
  const principal = resolveTokenPrincipal(header.slice(BEARER_PREFIX.length));
  if (principal === null) {
    unauthorized(res, UNAUTHORIZED_MESSAGE);
    return;
  }
  if (refuseClientOutOfReach(principal, req, res)) return;
  rememberRequestPrincipal(req, principal);
  next();
}
