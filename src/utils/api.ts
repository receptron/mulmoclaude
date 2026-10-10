// Single source of truth for Vue → MulmoClaude server HTTP calls.
//
// Before this module existed there were 56 scattered `fetch("/api/...")`
// calls across 29 files, each doing its own JSON serialization, its own
// `!res.ok` check, and its own ad-hoc error extraction. This made any
// cross-cutting concern — auth headers, error formatting, retry policy,
// logging — impossible to add without touching every call site.
//
// All HTTP traffic from the Vue app should now go through one of:
//
//   apiGet<T>(path, query?)
//   apiPost<T>(path, body?)
//   apiPut<T>(path, body?)
//   apiDelete<T>(path, body?)
//   apiCall<T>(path, opts)        ← generic, for methods not above
//   apiFetchRaw(path, opts)       ← when you need the raw Response
//                                   (binary, streaming, etc.)
//
// Return type is a discriminated union `ApiResult<T>`:
//
//   { ok: true, data: T }
//   { ok: false, error: string, status: number }
//
// Callers pattern-match on `result.ok` — no more mixing try/catch with
// `!res.ok` branches. Network errors and HTTP errors surface through the
// same `{ ok: false }` shape.
//
// Future extension hooks (see #272 for auth token):
//   - setAuthToken() populates a module-level token used by every call
//   - interceptors could go here for logging, retry, metrics

import { ref, type Ref } from "vue";
import { errorMessage } from "./errors";
import { hasStringProp } from "./types";

// ── Backend reachability signal (#1479) ─────────────────────────────
//
// `apiCall` returns `{ ok:false, status:0 }` when `fetch` itself
// throws — the classic "network error" / `ERR_CONNECTION_REFUSED`
// shape. That used to be silently swallowed feature-by-feature; now
// we flip a module-level ref so any consumer (App.vue's banner) can
// react. Eager: surfaces backend-down at the FIRST failing user-
// triggered fetch, no need to wait for the 15s health poll.

/** True while the backend appears reachable. Flipped to false on a
 *  `fetch` throw (network error, server stopped, DNS, etc.) and back
 *  to true on any successful HTTP response. */
export const backendReachable: Ref<boolean> = ref(true);

/** Last network-error message observed when `backendReachable` was
 *  flipped to false. Useful for the offline banner's small print. */
export const lastBackendError: Ref<string | null> = ref(null);

/** The backend is talking — re-arm the signal. Any real reply does this,
 *  HTTP-level 4xx/5xx included; only an outage (a `fetch` throw, or a
 *  proxy that could not reach it) flips it the other way. */
function markBackendReachable(): void {
  if (backendReachable.value) return;
  backendReachable.value = true;
  lastBackendError.value = null;
}

/** The backend could not be reached. `message` is the small print the
 *  offline banner appends to its own copy. */
function markBackendUnreachable(message: string): void {
  backendReachable.value = false;
  lastBackendError.value = message;
}

/** Small print for the banner, and the error every caller sees instead of
 *  the bare `Bad Gateway` that `res.statusText` used to hand them.
 *
 *  A protocol constant and nothing else, deliberately. The banner renders
 *  this after its own translated copy ("Can't reach the backend / the
 *  server may not be running"), so English prose here would be both
 *  redundant with that sentence and untranslated in the other seven
 *  locales — the only thing it adds is the status code. The banner's
 *  other source, a `fetch` rejection, is untranslated too, but that text
 *  is the browser's; this one would be ours. */
function proxyUnreachableDetail(status: number): string {
  return `HTTP ${status}`;
}

/** A `fetch` rejection that came from caller-driven `AbortController`
 *  cancellation (the spec says it's a `DOMException` with `name ===
 *  "AbortError"`). Normal flow — must NOT flip `backendReachable`. */
function isAbortError(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") return true;
  return hasStringProp(err, "name") && err.name === "AbortError";
}

// ── Auth token (populated by bootstrap; consumed by every call) ─────

let authToken: string | null = null;

/**
 * Set the bearer token used on every API call. Call once during app
 * bootstrap, typically after reading a `<meta>` tag or window global
 * populated by the server.
 */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

/**
 * The token `setAuthToken` stored, for a client that authenticates outside
 * `apiCall` — the `/ws/pubsub` socket.io handshake presents it as `auth.token`.
 */
export function getAuthToken(): string | null {
  return authToken;
}

// ── Types ────────────────────────────────────────────────────────────

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export type ApiQuery = Record<string, string | number | boolean | undefined>;

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined;
  /** JSON-serialized into the request body. Omit for GET/DELETE. */
  body?: unknown;
  /** Appended as a query string. `undefined` values are dropped. */
  query?: ApiQuery | undefined;
  /** AbortSignal — pass through to fetch. */
  signal?: AbortSignal | undefined;
  /**
   * Extra headers. Content-Type is set automatically for JSON bodies;
   * Authorization is injected from `authToken`.
   */
  headers?: Record<string, string> | undefined;
}

// Use Parameters<typeof fetch> rather than global DOM lib types so
// this module doesn't depend on DOM lib being in the ESLint globals.
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type FetchBody = FetchInit["body"];

// ── Internals ────────────────────────────────────────────────────────

function buildQueryString(query: ApiQuery | undefined): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function buildHeaders(opts: { headers?: Record<string, string> | undefined }, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (hasBody && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (authToken && headers["Authorization"] === undefined) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return headers;
}

interface ExtractedError {
  error: string;
  status: number;
  /** True when the body was the server's own `{ error: string }` shape.
   *  `isProxyUnreachable` uses this to tell an app-authored 502 from one
   *  a proxy invented — see there. */
  fromAppBody: boolean;
}

async function extractError(res: Response): Promise<ExtractedError> {
  const { status } = res;
  // Try to parse a `{ error: string }` body first — that's the server's
  // standard error shape. `in` narrowing lets us read `body.error`
  // without any type assertion.
  try {
    const body: unknown = await res.clone().json();
    if (hasStringProp(body, "error")) {
      return { error: body.error, status, fromAppBody: true };
    }
  } catch {
    // Body wasn't JSON — fall through.
  }
  return {
    error: res.statusText || `Request failed (${status})`,
    status,
    fromAppBody: false,
  };
}

// Statuses a reverse proxy invents when it cannot reach the upstream at
// all. Vite's dev proxy answers ECONNREFUSED with a body-less 502 — see
// `isProxyUnreachable`.
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * True when a response is a proxy saying "I could not reach the backend",
 * rather than the backend saying anything at all (#2975).
 *
 * Without this, `yarn dev` before the backend finishes booting produced a
 * 502 that read as "the server replied": the offline banner stayed hidden
 * and `res.statusText` — the bare string `Bad Gateway` — surfaced as the
 * error the user saw. In production (no proxy) the same outage makes
 * `fetch` throw, which is why the banner only ever worked there.
 *
 * `fromAppBody` is the discriminator, and it is load-bearing: the backend
 * itself emits one 502 (`server/api/routes/skills.ts`, external skill
 * install failed) and it always carries a JSON `{ error }` body, so that
 * case must NOT read as an outage. Nothing in the app emits 503 or 504.
 */
export function isProxyUnreachable(status: number, fromAppBody: boolean): boolean {
  return GATEWAY_STATUSES.has(status) && !fromAppBody;
}

// ── Core call ───────────────────────────────────────────────────────

/**
 * Generic HTTP call. Returns a discriminated union on success vs
 * failure. Network errors are caught and surfaced as
 * `{ ok: false, status: 0 }`. Assumes JSON response bodies (all
 * MulmoClaude `/api/*` endpoints return JSON on success); use
 * `apiFetchRaw` for binary / streaming / non-JSON responses.
 */
/** `fetch`'s init rejects an explicit `undefined` signal, so only set it
 *  when the caller passed one. */
function buildInit(opts: ApiOptions): FetchInit {
  const hasBody = opts.body !== undefined;
  const init: FetchInit = {
    method: opts.method ?? "GET",
    headers: buildHeaders(opts, hasBody),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
  if (hasBody) {
    init.body = JSON.stringify(opts.body);
  }
  return init;
}

/**
 * `fetch` itself threw. That happens on EITHER a true network failure
 * (server stopped, DNS, CORS preflight) OR a caller-driven
 * AbortController cancellation. The second is a normal flow (file/plugin
 * refresh races, navigation cancel) — flipping the global offline flag
 * for those would surface a false banner, so only the first signals.
 */
function transportFailure<T>(err: unknown): ApiResult<T> {
  const message = errorMessage(err);
  if (!isAbortError(err)) {
    markBackendUnreachable(message);
  }
  return { ok: false, error: message, status: 0 };
}

/** A reply the server refused (or a proxy invented on its behalf). */
async function failureResult<T>(res: Response): Promise<ApiResult<T>> {
  const { error, status, fromAppBody } = await extractError(res);
  // A proxy that could not reach the backend is an outage, not a reply,
  // even though it arrives as one (#2975).
  if (isProxyUnreachable(status, fromAppBody)) {
    const detail = proxyUnreachableDetail(status);
    markBackendUnreachable(detail);
    return { ok: false, error: detail, status };
  }
  markBackendReachable();
  return { ok: false, error, status };
}

/** A 2xx. The reachable flag is re-armed before the body is read, so a
 *  malformed payload from a live server still counts as reachable. */
async function successResult<T>(res: Response): Promise<ApiResult<T>> {
  markBackendReachable();
  try {
    // `res.json()` returns `Promise<any>`, which is assignable to T
    // without a cast.
    const data: T = await res.json();
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON response: ${errorMessage(err)}`,
      status: res.status,
    };
  }
}

export async function apiCall<T = unknown>(path: string, opts: ApiOptions = {}): Promise<ApiResult<T>> {
  const url = `${path}${buildQueryString(opts.query)}`;
  let res: Response;
  try {
    res = await fetch(url, buildInit(opts));
  } catch (err) {
    return transportFailure<T>(err);
  }
  return res.ok ? successResult<T>(res) : failureResult<T>(res);
}

// ── Convenience verbs ───────────────────────────────────────────────

export function apiGet<T = unknown>(path: string, query?: ApiQuery, extra: Omit<ApiOptions, "method" | "body" | "query"> = {}): Promise<ApiResult<T>> {
  return apiCall<T>(path, { ...extra, method: "GET", query });
}

export function apiPost<T = unknown>(path: string, body?: unknown, extra: Omit<ApiOptions, "method" | "body"> = {}): Promise<ApiResult<T>> {
  return apiCall<T>(path, { ...extra, method: "POST", body });
}

export function apiPut<T = unknown>(path: string, body?: unknown, extra: Omit<ApiOptions, "method" | "body"> = {}): Promise<ApiResult<T>> {
  return apiCall<T>(path, { ...extra, method: "PUT", body });
}

export function apiDelete<T = unknown>(path: string, body?: unknown, extra: Omit<ApiOptions, "method" | "body"> = {}): Promise<ApiResult<T>> {
  return apiCall<T>(path, { ...extra, method: "DELETE", body });
}

// ── Raw Response escape hatch ───────────────────────────────────────

export interface RawOptions {
  method?: string | undefined;
  /** Accepts any value fetch accepts (string / Blob / FormData / …).
   *  `FetchBody` already includes `undefined`; the member keeps `null`
   *  (a body fetch does accept) plus the explicit `undefined` callers
   *  pass for "no body". */
  body?: Exclude<FetchBody, undefined> | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  query?: ApiQuery | undefined;
}

/**
 * Escape hatch for endpoints returning binary / streaming / non-JSON
 * bodies (PDF download, audio blob, SSE, etc.). Auth header is still
 * applied; other handling is the caller's responsibility.
 *
 * Throws on network errors. Does NOT check `res.ok`.
 */
export async function apiFetchRaw(path: string, opts: RawOptions = {}): Promise<Response> {
  const url = `${path}${buildQueryString(opts.query)}`;
  const init: FetchInit = {
    method: opts.method ?? "GET",
    headers: buildHeaders(opts, false),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
  return fetch(url, init);
}
