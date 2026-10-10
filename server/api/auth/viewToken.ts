// Capability tokens for custom collection views (see
// plans/done/feat-collections-custom-views.md).
//
// A custom view is LLM-authored HTML rendered in a sandboxed
// (`allow-scripts`, opaque-origin) iframe. It must NOT receive the global
// bearer token — that would grant it the whole `/api/*` surface. Instead the
// authenticated parent mints a **scoped, short-lived, signed** token that
// authorizes only the collection's `view-data` endpoint, for one slug, with
// an explicit capability set (`read` and/or `write`). The view sends it as
// `Authorization: Bearer <token>`; `requireViewToken` verifies it.
//
// Stateless + signed: the token is `base64url(payload).HMAC`, keyed by the
// per-startup bearer token (`getCurrentToken`). No server-side store, and a
// restart invalidates every outstanding view token (the key changes) — the
// same lifecycle as the global token. Forging requires the key, which an
// attacker on a loopback-bound server cannot read.
//
// This is the ONLY guard on the view-data routes: they are exempted from the
// global bearer + CSRF middleware (the iframe carries no global token and
// sends `Origin: null`), so the unguessable scoped token is what stands in
// for both. See the exemptions in `server/index.ts`.

import { createHmac } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { getCurrentToken } from "./token.js";
import { tokenEquals, UNAUTHORIZED_MESSAGE } from "./tokenGuard.js";
import { unauthorized } from "../../utils/httpError.js";
import { ONE_HOUR_MS } from "../../utils/time.js";
import { isRecord, isUnknownArray } from "../../utils/types.js";

export type ViewCapability = "read" | "write";

function isCapability(value: unknown): value is ViewCapability {
  return value === "read" || value === "write";
}

/** How long a minted view token stays valid. The parent re-mints on each
 *  render, so a view that outlives this reloads with a fresh token. */
export const VIEW_TOKEN_TTL_MS = ONE_HOUR_MS;

const BEARER_PREFIX = "Bearer ";

interface ViewTokenPayload {
  /** The one collection slug this token authorizes. */
  slug: string;
  /** What the token may do against the data endpoint. */
  caps: ViewCapability[];
  /** Absolute expiry, ms since epoch. */
  exp: number;
}

function signPayload(payloadB64: string, key: string): string {
  return createHmac("sha256", key).update(payloadB64).digest("base64url");
}

/** Clamp a view's *requested* capabilities to what the view *declared* in
 *  its schema registration — a view registered `["read"]` can never be
 *  minted a `write` token, even if the frontend asks. Undefined declared ⇒
 *  the least-privilege default `["read"]`; undefined requested ⇒ grant the
 *  full declared set. The result is `declared ∩ requested`. */
export function clampCapabilities(declared: ViewCapability[] | undefined, requested: ViewCapability[] | undefined): ViewCapability[] {
  const declaredCaps: ViewCapability[] = declared && declared.length > 0 ? declared : ["read"];
  const requestedCaps = requested && requested.length > 0 ? requested : declaredCaps;
  return declaredCaps.filter((cap) => requestedCaps.includes(cap));
}

/** Mint a signed token for `slug` granting `caps`, valid for
 *  {@link VIEW_TOKEN_TTL_MS}. Returns null when the server has no bearer
 *  key yet (pre-bootstrap) — callers surface that as "token unavailable". */
export function mintViewToken(slug: string, caps: ViewCapability[], nowMs: number = Date.now()): { token: string; exp: number } | null {
  const key = getCurrentToken();
  if (key === null) return null;
  const exp = nowMs + VIEW_TOKEN_TTL_MS;
  const payload: ViewTokenPayload = { slug, caps, exp };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { token: `${payloadB64}.${signPayload(payloadB64, key)}`, exp };
}

/** Verify a token's signature + expiry and return its payload, or null for
 *  any failure (bad shape, tampered payload, wrong signature, expired, or
 *  no server key). Never throws. */
export function verifyViewToken(token: string, nowMs: number = Date.now()): ViewTokenPayload | null {
  const key = getCurrentToken();
  if (key === null) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = signPayload(payloadB64, key);
  if (!tokenEquals(providedSig, expectedSig)) return null;
  const payload = decodePayload(payloadB64);
  if (payload === null || nowMs >= payload.exp) return null;
  return payload;
}

/** Decode the (already signature-verified) payload segment. The payload is
 *  rebuilt field by field from what was actually checked, so a token minted by
 *  a different version of this file can never smuggle an unvalidated shape
 *  through. Expiry is the caller's check — this is pure decoding. */
function decodePayload(payloadB64: string): ViewTokenPayload | null {
  const parsed = parseJson(Buffer.from(payloadB64, "base64url").toString("utf8"));
  if (!isRecord(parsed)) return null;
  const { slug, caps, exp } = parsed;
  if (typeof slug !== "string" || typeof exp !== "number") return null;
  if (!isUnknownArray(caps) || !caps.every(isCapability)) return null;
  return { slug, caps, exp };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Express middleware factory guarding a `view-data` route: require a valid
 *  scoped token whose `slug` matches the route param and whose capability
 *  set includes `action`. 401 (generic message, like `bearerAuth`) on any
 *  failure. */
export function requireViewToken(action: ViewCapability) {
  return function requireViewTokenMiddleware(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
      unauthorized(res, UNAUTHORIZED_MESSAGE);
      return;
    }
    const payload = verifyViewToken(header.slice(BEARER_PREFIX.length));
    if (!payload || payload.slug !== req.params.slug || !payload.caps.includes(action)) {
      unauthorized(res, UNAUTHORIZED_MESSAGE);
      return;
    }
    next();
  };
}

// Matches a view-data request path with or without the `/api` mount prefix:
// the global CSRF middleware sees `/api/collections/<slug>/view-data` while
// the `/api`-mounted bearer closure sees `/collections/<slug>/view-data`.
// Anchored both ends; `[^/]+` is the slug segment. Two separate regexes
// (base path / the token-scoped mutate-action endpoint) rather than one
// with an optional tail — the combined form trips the unsafe-regex lint.
const VIEW_DATA_PATH_RE = /^\/(?:api\/)?collections\/[^/]+\/view-data$/;
const VIEW_DATA_ACTION_PATH_RE = /^\/(?:api\/)?collections\/[^/]+\/view-data\/actions\/[^/]+$/;
const VIEW_DATA_QUERY_PATH_RE = /^\/(?:api\/)?collections\/[^/]+\/view-data\/query$/;
const VIEW_DATA_IMAGE_PATH_RE = /^\/(?:api\/)?collections\/[^/]+\/view-data\/image$/;

/** True for the view-data endpoint paths (either mount base): the record
 *  read/write base path, the token-scoped mutate-action endpoint, and the
 *  aggregation-query endpoint. Used in `server/index.ts` to exempt these
 *  routes from the global bearer + CSRF guards — they are guarded instead
 *  by {@link requireViewToken}. A path missing here makes its endpoint
 *  UNREACHABLE from a sandboxed view (the global guards reject first) —
 *  add every new `/view-data/...` route to this matcher AND to the
 *  coverage in `test/server/test_viewToken.ts`. */
export function isViewDataPath(pathname: string): boolean {
  return (
    VIEW_DATA_PATH_RE.test(pathname) ||
    VIEW_DATA_ACTION_PATH_RE.test(pathname) ||
    VIEW_DATA_QUERY_PATH_RE.test(pathname) ||
    VIEW_DATA_IMAGE_PATH_RE.test(pathname)
  );
}
