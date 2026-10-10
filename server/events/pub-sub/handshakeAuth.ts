import { isAuthorizedToken } from "../../api/auth/tokenGuard.js";
import { isRecord } from "../../utils/types.js";

// `auth` is whatever the socket.io client put in `io({ auth })`. Only a record
// whose `token` passes the shared bearer rule connects; a server with no token
// yet refuses everything, as `bearerAuth` does for HTTP.
export function isAuthorizedPubSubHandshake(auth: unknown, expectedToken: string | null): boolean {
  return isRecord(auth) && isAuthorizedToken(auth.token, expectedToken);
}
