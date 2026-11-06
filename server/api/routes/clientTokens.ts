// Settings → client tokens (#3637): list them, revoke one. Issuing stays on the
// CLI so a token's value never reaches a browser. Under `/api/config`, which
// `clientTokenAccess.ts` keeps owner-only, so a client token cannot list or
// revoke tokens.

import { Router, type Request } from "express";

import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { log } from "../../system/logger/index.js";
import { errorMessage } from "../../utils/errors.js";
import { badRequest, conflict, notFound, serverError, type ApiResponse } from "../../utils/httpError.js";
import { listStoredClientTokens, type StoredClientTokenListing } from "../auth/principal.js";
import { ClientTokenLockBusyError, REVOKE_OUTCOMES, clientTokensPath, revokeStoredClientToken, type RevokeOutcome } from "../auth/clientTokenStore.js";

export type ClientTokensResponse = StoredClientTokenListing;

export interface RevokeClientTokenResponse {
  revoked: string;
}

export interface ClientTokensDeps {
  /** Throws when the store cannot be read. */
  list: () => StoredClientTokenListing;
  revoke: (target: { name: string; id: string }) => RevokeOutcome;
}

const defaultDeps: ClientTokensDeps = {
  list: listStoredClientTokens,
  revoke: (target) => revokeStoredClientToken(clientTokensPath(), target),
};

const REFUSALS: Record<Exclude<RevokeOutcome, typeof REVOKE_OUTCOMES.revoked>, { send: typeof conflict; message: string }> = {
  [REVOKE_OUTCOMES.notFound]: { send: notFound, message: "no client token by that name" },
  [REVOKE_OUTCOMES.changed]: { send: conflict, message: "that name now belongs to a different token; reload the list" },
  [REVOKE_OUTCOMES.unreadableEntries]: {
    send: conflict,
    message: "client-tokens.json has entries this server cannot read; revoking here would drop them, so use `mulmoclaude token revoke`",
  },
};

function answerRevoke(outcome: RevokeOutcome, name: string, res: ApiResponse<RevokeClientTokenResponse>): void {
  if (outcome === REVOKE_OUTCOMES.revoked) {
    log.info("auth", "client token revoked from Settings", { client: name });
    res.json({ revoked: name });
    return;
  }
  const refusal = REFUSALS[outcome];
  refusal.send(res, refusal.message);
}

function revokeOrRefuse(deps: ClientTokensDeps, target: { name: string; id: string }, res: ApiResponse<RevokeClientTokenResponse>): void {
  try {
    answerRevoke(deps.revoke(target), target.name, res);
  } catch (err) {
    if (err instanceof ClientTokenLockBusyError) {
      conflict(res, errorMessage(err));
      return;
    }
    log.warn("auth", "client token revoke failed", { client: target.name, error: errorMessage(err) });
    serverError(res, errorMessage(err));
  }
}

function listOrFail(deps: ClientTokensDeps, res: ApiResponse<ClientTokensResponse>): void {
  try {
    res.json(deps.list());
  } catch (err) {
    log.warn("auth", "client token list failed", { error: errorMessage(err) });
    serverError(res, errorMessage(err));
  }
}

export function createClientTokensRouter(deps: ClientTokensDeps = defaultDeps): Router {
  const router = Router();
  router.get(API_ROUTES.config.clientTokens, (_req: Request, res: ApiResponse<ClientTokensResponse>) => listOrFail(deps, res));
  router.delete(API_ROUTES.config.clientToken, (req: Request<{ name: string }>, res: ApiResponse<RevokeClientTokenResponse>) => {
    const { id } = req.query;
    if (typeof id !== "string" || id === "") {
      badRequest(res, "id is required");
      return;
    }
    revokeOrRefuse(deps, { name: req.params.name, id }, res);
  });
  return router;
}
