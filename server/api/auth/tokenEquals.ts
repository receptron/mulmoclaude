import { timingSafeEqual } from "node:crypto";

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
