// Internal types — server + (future) browser side of the plugin
// share these. Persisted shapes go through Zod parsers; in-memory
// transient shapes (pending OAuth state) are plain interfaces.

import type { PluginRuntime } from "gui-chat-protocol";
import type { z } from "zod";
import type { TokensSchema, ClientConfigSchema, PendingAuthSchema } from "./schemas";

/** Dependencies the dispatcher (`index.ts`) hands every handler
 *  module (listening / search / playback). */
export interface SpotifyDeps {
  runtime: PluginRuntime;
  clientId: string;
  tokens: SpotifyTokens;
  /** Injectable clock — primarily for tests, where the default
   *  `() => new Date()` would race the proactive-refresh window
   *  whenever the fixture's `expiresAt` is close to wall-clock time.
   *  Production callers omit it. */
  now?: () => Date;
}

/** Persisted OAuth tokens (`tokens.json`). Refresh-token rotation
 *  policy: when Spotify omits `refreshToken` on a refresh response,
 *  the prior value is kept. `scopes` is the granted scope set so
 *  callers can fail fast on a kind-vs-scope mismatch. */
export type SpotifyTokens = z.infer<typeof TokensSchema>;

/** Persisted client config (`client.json`). User pastes their
 *  Spotify Developer Dashboard Client ID into this file (or
 *  configures it via the View). Per-machine secret. */
export type SpotifyClientConfig = z.infer<typeof ClientConfigSchema>;

/** In-memory record kept between `connect` and `oauthCallback`,
 *  keyed by single-use `state`. Lives in the host process only —
 *  not persisted. */
export type PendingAuthorization = z.infer<typeof PendingAuthSchema>;

/** Refresh-response fields after parsing the raw Spotify token
 *  response. `refreshToken` is optional because Spotify normally
 *  omits it (the prior token stays valid). */
export interface RefreshResponseFields {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresInSec: number;
  scopes?: readonly string[] | undefined;
}

/** Reason codes the plugin returns to the LLM / View when an
 *  operation can't proceed. The dispatch contract documented in
 *  plans/done/feat-spotify-plugin.md keeps these aligned with the
 *  user-facing `instructions` strings. */
export type SpotifyError =
  | { kind: "client_id_missing"; instructions: string; setupGuide: string }
  | { kind: "not_connected"; instructions: string }
  | { kind: "auth_expired"; detail: string; instructions: string }
  | { kind: "transient_error"; detail: string; instructions: string }
  | { kind: "unknown_state"; instructions: string }
  | { kind: "redirect_uri_mismatch"; instructions: string }
  | { kind: "rate_limited"; retryAfterSec: number; instructions: string }
  | { kind: "spotify_api_error"; status: number; body: string; instructions: string };

/** A track in a normalised, View-friendly shape. The full Spotify
 *  response carries dozens of fields the View doesn't render; we
 *  reduce it at the plugin boundary to (1) cap response size for
 *  the LLM context window, (2) decouple the View from Spotify's
 *  API drift. */
export interface NormalisedTrack {
  id: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  /** Spotify Web URL — the View uses `runtime.openUrl(track.url)`
   *  to open the track in the user's Spotify client. Optional
   *  because locally-uploaded tracks and podcast episodes carry no
   *  `external_urls.spotify`; the View must guard the click handler
   *  against an undefined value. */
  url?: string;
  /** Cover-art URL (smallest available). Optional: tracks under
   *  podcasts / locally-uploaded files don't carry album art. */
  imageUrl?: string;
  /** Spotify's own `spotify:track:<id>` URI; absent for a podcast
   *  episode, whose URI `play`'s `trackUris` does not take. */
  trackUri?: string;
}

export interface NormalisedPlaylist {
  id: string;
  name: string;
  /** Author-provided description; empty string when absent. */
  description: string;
  trackCount: number;
  /** Optional for the same reason as NormalisedTrack.url. */
  url?: string;
  imageUrl?: string;
}

/** A `recently-played` item carries a `playedAt` timestamp the
 *  Liked / Playlists endpoints don't. Composed of `NormalisedTrack`
 *  + the play timestamp. */
export interface RecentlyPlayedItem {
  track: NormalisedTrack;
  /** ISO-8601 timestamp from Spotify's `played_at`. */
  playedAt: string;
}

/** Search results return mixed entity types; Spotify groups them
 *  by category (`tracks.items[]`, `artists.items[]`, etc.). The
 *  plugin normalises each category separately. */
export interface NormalisedArtist {
  id: string;
  name: string;
  /** Spotify's `genres` field — usually empty for niche artists. */
  genres: string[];
  /** 0-100. Optional because some search results don't carry it. */
  popularity?: number;
  url?: string;
  imageUrl?: string;
}

export interface NormalisedAlbum {
  id: string;
  name: string;
  artists: string[];
  /** ISO date or year-only string Spotify returns ("2024" /
   *  "2024-05-15"). Stored verbatim — the View formats. */
  releaseDate: string;
  totalTracks: number;
  url?: string;
  imageUrl?: string;
}

/** Aggregate result from the `search` kind. Categories are present
 *  iff the caller asked for them; absent categories are simply
 *  omitted from the object. */
export interface SearchResult {
  tracks?: NormalisedTrack[];
  artists?: NormalisedArtist[];
  albums?: NormalisedAlbum[];
  playlists?: NormalisedPlaylist[];
}

/** Spotify Connect device (a place where the user can play music —
 *  desktop app, phone, web player, smart speaker). The View shows
 *  a dropdown so the user can pick a target device.
 *
 *  `id` may be null when Spotify returns a restricted device — for
 *  some account states / DRM restrictions, Spotify lists a device
 *  but withholds its ID, leaving it informational but un-targetable.
 *  Dropping these would underreport the user's setup; the View
 *  surfaces them but disables the Transfer button (Codex review on
 *  PR #1171). */
export interface NormalisedDevice {
  id: string | null;
  name: string;
  /** "Computer" / "Smartphone" / "Speaker" — Spotify's `type`. */
  type: string;
  isActive: boolean;
  /** 0-100, present when the device exposes volume control. */
  volumePercent?: number;
}

/** Persisted at `runtime.files.config/profile.json`. Caches
 *  `/v1/me`'s `product` field so we don't re-call Spotify on every
 *  `play` dispatch. TTL keeps the cache fresh enough that a user
 *  upgrading from Free → Premium sees controls within ~24h
 *  without manually reconnecting. */
export interface SpotifyProfile {
  /** Spotify user ID (`/v1/me`'s `id` field). Bound to the cache
   *  so reconnecting with a different Spotify account doesn't
   *  serve the previous account's `product` for the rest of the
   *  TTL — Codex review on PR #1171. Empty string for cache
   *  records persisted before the account-scoping fix landed. */
  userId: string;
  /** "premium" / "free" / "open" (open is a legacy free-tier
   *  marker Spotify still emits for some accounts), or `null` when
   *  `/v1/me` did not return the field. */
  product: string | null;
  /** Free-form display name from `/v1/me`; surfaced in `diagnose`. */
  displayName: string;
  /** Epoch ms when this snapshot was fetched. */
  fetchedAtMs: number;
}
