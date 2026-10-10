import { tokenEquals } from "../../api/auth/tokenEquals.js";
import { isNonEmptyString, isRecord } from "../../utils/types.js";

// The `/ws/pubsub` handshake is refused with the same generic message
// `bearerAuth` sends, so neither surface says whether the token was
// missing or wrong.
export const PUBSUB_HANDSHAKE_REFUSED = "unauthorized";

// `auth` is whatever the socket.io client put in `io({ auth })`. Only a
// record whose `token` is a string equal to the server's current token
// passes; a server with no token yet refuses everything, as `bearerAuth`
// does for HTTP.
export function isAuthorizedPubSubHandshake(auth: unknown, expectedToken: string | null): boolean {
  if (!isNonEmptyString(expectedToken)) return false;
  if (!isRecord(auth)) return false;
  const provided = auth.token;
  if (!isNonEmptyString(provided)) return false;
  return tokenEquals(provided, expectedToken);
}
