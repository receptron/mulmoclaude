import { timingSafeEqual } from "node:crypto";
import { isNonEmptyString } from "../../utils/types.js";

// Every bearer surface refuses with this one message, so neither a reply nor
// a log line says whether the token was missing or wrong.
export const UNAUTHORIZED_MESSAGE = "unauthorized";

// Constant-time comparison of a presented bearer token against the server's.
// Byte lengths are compared first (not string lengths): `timingSafeEqual`
// throws on a buffer-length mismatch, so a candidate with the same character
// count but multi-byte characters would otherwise turn a refusal into a
// crash. The lengths are not secret, so the early return leaks nothing.
export function tokenEquals(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

// The one rule every guard applies to a presented token: the server must hold
// a token (it has none until bootstrap, and an empty one never authorizes),
// the candidate must be a non-empty string, and the two must match in
// constant time. `unknown` because a socket.io `auth` payload is client-shaped.
export function isAuthorizedToken(provided: unknown, expected: string | null): boolean {
  if (!isNonEmptyString(expected)) return false;
  if (!isNonEmptyString(provided)) return false;
  return tokenEquals(provided, expected);
}
