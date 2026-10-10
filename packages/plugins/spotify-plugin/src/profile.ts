// Spotify user profile cache (PR 3). Reads `/v1/me` once and
// caches the `product` field so the player-control gate doesn't
// need a fresh API roundtrip on every `play` dispatch.
//
// TTL is 24 h: long enough that a typical user paying for Premium
// once doesn't get rate-limited extra GETs to `/v1/me`, short
// enough that a Free → Premium upgrade is reflected within a day
// without manually reconnecting.
//
// On a stale cache miss the loader fires `/v1/me` once and writes
// the result to `profile.json`. If the API call fails we keep the
// stale snapshot rather than locking the user out — the player
// gate then errs on the side of "let them try" with a softer error
// message. This intentionally trades strict correctness for UX:
// a network blip on Spotify's side shouldn't break playback.

import type { FileOps, PluginRuntime } from "gui-chat-protocol";

import { spotifyApi } from "./client";
import type { SpotifyClientError } from "./client";
import { ONE_SECOND_MS } from "./time";
import type { SpotifyProfile, SpotifyTokens } from "./types";

const PROFILE_FILE = "profile.json";
const PROFILE_TTL_MS = 24 * 60 * 60 * ONE_SECOND_MS;

const PREMIUM_PRODUCT = "premium";

// Snapshots written before this marker existed stored a fabricated "free" when `/v1/me` omitted
// `product`, indistinguishable from a real one — so a snapshot without it is re-fetched.
const PROFILE_CACHE_VERSION = 2;

interface RawProfile {
  id?: unknown;
  product?: unknown;
  display_name?: unknown;
}

export interface ProfileDeps {
  runtime: PluginRuntime;
  clientId: string;
  tokens: SpotifyTokens;
  now?: () => Date;
}

export async function readProfile(files: FileOps): Promise<SpotifyProfile | null> {
  if (!(await files.exists(PROFILE_FILE))) return null;
  try {
    const raw = await files.read(PROFILE_FILE);
    const parsed = JSON.parse(raw) as Partial<SpotifyProfile> & { cacheVersion?: unknown };
    if (parsed.cacheVersion !== PROFILE_CACHE_VERSION) return null;
    if (typeof parsed.product !== "string" && parsed.product !== null) return null;
    if (typeof parsed.fetchedAtMs !== "number" || !Number.isFinite(parsed.fetchedAtMs)) return null;
    return {
      // userId may be missing from caches written before the
      // account-scoping fix landed; treat as empty so a
      // reconnect-then-replay doesn't trip the equality check
      // until the next /v1/me round-trip refreshes it.
      userId: typeof parsed.userId === "string" ? parsed.userId : "",
      product: parsed.product,
      displayName: typeof parsed.displayName === "string" ? parsed.displayName : "",
      fetchedAtMs: parsed.fetchedAtMs,
    };
  } catch {
    return null;
  }
}

export async function writeProfile(files: FileOps, profile: SpotifyProfile): Promise<void> {
  await files.write(PROFILE_FILE, JSON.stringify({ ...profile, cacheVersion: PROFILE_CACHE_VERSION }, null, 2));
}

function isCacheFresh(profile: SpotifyProfile, now: Date): boolean {
  return now.getTime() - profile.fetchedAtMs < PROFILE_TTL_MS;
}

/** Get the cached profile if fresh; otherwise fetch + persist a
 *  new snapshot. On API failure with a stale cache we keep the
 *  stale value (better than locking the user out — a network blip
 *  shouldn't break playback).
 *
 *  Account scoping: cache is invalidated by `clearProfileCache`
 *  whenever new tokens are written (i.e. after `oauthCallback`),
 *  so reconnecting with a different Spotify account starts with a
 *  fresh fetch and never serves the previous account's `product`
 *  (Codex review on PR #1171). */
export async function getProfile(deps: ProfileDeps): Promise<{ ok: true; profile: SpotifyProfile } | { ok: false; error: SpotifyClientError }> {
  const now = deps.now ?? (() => new Date());
  const cached = await readProfile(deps.runtime.files.config);
  if (cached && isCacheFresh(cached, now())) return { ok: true, profile: cached };
  const fresh = await fetchProfile(deps);
  if (fresh.ok) {
    await writeProfile(deps.runtime.files.config, fresh.profile);
    return { ok: true, profile: fresh.profile };
  }
  if (cached) {
    deps.runtime.log.warn("profile fetch failed; serving stale cache", { detail: formatClientError(fresh.error) });
    return { ok: true, profile: cached };
  }
  return fresh;
}

async function fetchProfile(deps: ProfileDeps): Promise<{ ok: true; profile: SpotifyProfile } | { ok: false; error: SpotifyClientError }> {
  const result = await spotifyApi<RawProfile>(deps.runtime, deps.clientId, deps.tokens, "GET", "/v1/me", {}, deps.now);
  if (!result.ok) return result;
  const raw = result.data;
  const userId = typeof raw.id === "string" ? raw.id : "";
  const product = typeof raw.product === "string" ? raw.product : null;
  const displayName = typeof raw.display_name === "string" ? raw.display_name : "";
  const now = deps.now ?? (() => new Date());
  return { ok: true, profile: { userId, product, displayName, fetchedAtMs: now().getTime() } };
}

/** `null` when Spotify did not say: `/v1/me` omits `product` without `user-read-private`, and
 *  for Development Mode apps since Spotify's February 2026 change. */
export function isPremium(profile: SpotifyProfile): boolean | null {
  if (profile.product === null) return null;
  return profile.product === PREMIUM_PRODUCT;
}

// Not the shared `errorMessage(err: unknown)` from `@mulmoclaude/common` — this
// renders an already-typed `SpotifyClientError` union. Named apart (#2483) so a
// grep for the shared helper's copies doesn't keep rediscovering it.
function formatClientError(error: SpotifyClientError): string {
  switch (error.kind) {
    case "auth_expired":
      return error.detail;
    case "transient_error":
      return error.detail;
    case "rate_limited":
      return `rate limited (retry ${error.retryAfterSec}s)`;
    case "spotify_api_error":
      return `${error.status}: ${error.body}`;
    case "not_connected":
      return "not connected";
  }
}

/** Test-only: clear the cache. Production callers should not need
 *  this — the TTL handles it. */
export async function clearProfileCache(files: FileOps): Promise<void> {
  if (await files.exists(PROFILE_FILE)) await files.unlink(PROFILE_FILE);
}
