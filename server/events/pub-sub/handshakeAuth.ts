import { isRecord } from "../../utils/types.js";

// `auth` is whatever the socket.io client put in `io({ auth })`. Only a record
// whose `token` passes `authorizeToken` (the host's bearer rule) connects.
export function isAuthorizedPubSubHandshake(auth: unknown, authorizeToken: (token: unknown) => boolean): boolean {
  return isRecord(auth) && authorizeToken(auth.token);
}
