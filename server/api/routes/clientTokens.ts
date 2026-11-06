// Settings → client tokens (#3637): list them, revoke one. Issuing stays on the
// CLI so a token's value never reaches a browser. Under `/api/config`, which
// `clientTokenAccess.ts` keeps owner-only, so a client token cannot list or
// revoke tokens.

import { Router, type Request } from "express";

import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { log } from "../../system/logger/index.js";
import { errorMessage } from "../../utils/errors.js";
import { conflict, notFound, serverError, type ApiResponse } from "../../utils/httpError.js";
import { listStoredClientTokens } from "../auth/principal.js";
import { ClientTokenLockBusyError, clientTokensPath, revokeStoredClientToken } from "../auth/clientTokenStore.js";
import type { ClientTokenListing } from "../auth/clientTokenUsageRule.js";

export interface ClientTokensResponse {
  tokens: ClientTokenListing[];
}

export interface RevokeClientTokenResponse {
  revoked: string;
}

export interface ClientTokensDeps {
  list: () => ClientTokenListing[];
  /** False when no token has that name. */
  revoke: (name: string) => boolean;
}

const defaultDeps: ClientTokensDeps = {
  list: listStoredClientTokens,
  revoke: (name) => revokeStoredClientToken(clientTokensPath(), name),
};

function revokeOrRefuse(deps: ClientTokensDeps, name: string, res: ApiResponse<RevokeClientTokenResponse>): void {
  try {
    if (!deps.revoke(name)) {
      notFound(res, `no client token named "${name}"`);
      return;
    }
    log.info("auth", "client token revoked from Settings", { client: name });
    res.json({ revoked: name });
  } catch (err) {
    if (err instanceof ClientTokenLockBusyError) {
      conflict(res, errorMessage(err));
      return;
    }
    log.warn("auth", "client token revoke failed", { client: name, error: errorMessage(err) });
    serverError(res, errorMessage(err));
  }
}

export function createClientTokensRouter(deps: ClientTokensDeps = defaultDeps): Router {
  const router = Router();
  router.get(API_ROUTES.config.clientTokens, (_req: Request, res: ApiResponse<ClientTokensResponse>) => {
    res.json({ tokens: deps.list() });
  });
  router.delete(API_ROUTES.config.clientToken, (req: Request<{ name: string }>, res: ApiResponse<RevokeClientTokenResponse>) => {
    revokeOrRefuse(deps, req.params.name, res);
  });
  return router;
}
