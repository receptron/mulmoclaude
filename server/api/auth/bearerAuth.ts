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
// - **One exemption**: `/api/files/*` is bearer-exempt because `<img>`
//   tags in rendered markdown (`presentDocument`, wiki) can't attach
//   an `Authorization` header — the browser makes a plain GET. These
//   endpoints are still CSRF-guarded (origin check) and the server
//   binds to loopback only, so the exposure is localhost-scoped.
//   The exemption is applied via a regex in `server/index.ts`.
// - **No token in logs**. Reject messages are generic ("unauthorized")
//   so a leaked log line doesn't reveal whether "no header" vs
//   "wrong token" — matches common auth-hardening guidance.
// - **The token rule lives in `tokenGuard.ts`** (`isAuthorizedToken`):
//   constant-time, byte-length-checked, and shared with the view-token
//   check and the `/ws/pubsub` handshake guard, so every surface refuses
//   the same way.

import type { Request, Response, NextFunction } from "express";
import { getCurrentToken } from "./token.js";
import { isAuthorizedToken, UNAUTHORIZED_MESSAGE } from "./tokenGuard.js";
import { unauthorized } from "../../utils/httpError.js";

const BEARER_PREFIX = "Bearer ";

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
    unauthorized(res, UNAUTHORIZED_MESSAGE);
    return;
  }
  // `getCurrentToken()` is null until bootstrap, which the rule refuses too:
  // a request that beats `generateAndWriteToken()` gets a 401, not a pass.
  if (!isAuthorizedToken(header.slice(BEARER_PREFIX.length), getCurrentToken())) {
    unauthorized(res, UNAUTHORIZED_MESSAGE);
    return;
  }
  next();
}
