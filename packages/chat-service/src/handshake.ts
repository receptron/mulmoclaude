// The `/ws/chat` handshake rule, pure so it is checked without a socket.
//
// `auth` is whatever the bridge put in `io({ auth })`. Only a record whose
// `token` passes the shared bearer rule connects, and every refusal of the
// token — missing, empty, wrong, or a server that has no token yet — is the
// same generic `unauthorized` that `/api/*` and `/ws/pubsub` send, so the
// reply says nothing about which it was. The token is checked before any
// other field, so an unauthenticated peer learns nothing about the rest of
// the payload either.

import { isRecord } from "@mulmoclaude/common";
import { isAuthorizedToken, UNAUTHORIZED_MESSAGE } from "@mulmoclaude/common/token-guard";

// Flat primitives only — matches protocol's BridgeOptions. The
// chat-service type is duplicated rather than imported to keep this
// package free of a hard dep on protocol-as-a-value (it has always
// been types-only there, and the re-declaration is one line).
export type BridgeOptions = Readonly<Record<string, string | number | boolean>>;

export type HandshakeResult = { ok: true; transportId: string; options: BridgeOptions } | { ok: false; error: string };

// The one refusal that is not about the token. It is only ever sent to a
// peer whose token already passed, so it reveals nothing to anyone else.
export const TRANSPORT_ID_REQUIRED_MESSAGE = "transportId is required";

// `options` on the handshake is reduced to a FLAT PRIMITIVE bag:
// string / number / boolean only. This serves two purposes —
//   1. Rejects nested objects / arrays / functions so a downstream
//      merge in the host app can't reintroduce prototype-pollution
//      via a deeply-nested `__proto__` (top-level `__proto__` is
//      stripped separately as a belt-and-braces guard).
//   2. Makes the wire contract explicit: every value the host sees
//      is something you could put in an env var.
// Anything else (objects, arrays, null, undefined, functions,
// symbols, bigints) is dropped silently. The bridge author is
// responsible for flattening complex config into primitives before
// sending.
export function sanitiseOptions(raw: unknown): BridgeOptions {
  if (!isRecord(raw)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      // Drop non-finite numbers (NaN / Infinity) — they serialise
      // oddly and the host app shouldn't be asked to distinguish
      // "valid zero" from "broken input".
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      out[key] = value;
    }
  }
  return out;
}

export function validateHandshake(auth: unknown, expectedToken: string | null): HandshakeResult {
  return validateHandshakeWith(auth, (token) => isAuthorizedToken(token, expectedToken));
}

/** As {@link validateHandshake}, with the host deciding which tokens pass. */
export function validateHandshakeWith(auth: unknown, authorizeToken: (token: unknown) => boolean): HandshakeResult {
  if (!isRecord(auth) || !authorizeToken(auth.token)) {
    return { ok: false, error: UNAUTHORIZED_MESSAGE };
  }
  const transportId = typeof auth.transportId === "string" ? auth.transportId.trim() : "";
  if (transportId.length === 0) {
    return { ok: false, error: TRANSPORT_ID_REQUIRED_MESSAGE };
  }
  return { ok: true, transportId, options: sanitiseOptions(auth.options) };
}
