// Zod schemas for both the on-disk persisted shapes and the
// dispatch arg shape. Centralised so the parsers / type inference
// stay in lock-step.

import { z } from "zod";

/** Single source of truth for `manageSpotify`'s `kind` discriminator.
 *  `definition.ts` derives the LLM-facing enum from `LLM_CALLABLE_KINDS`,
 *  the Zod union below uses these same literals — the previous setup
 *  duplicated the strings across both surfaces and risked drift
 *  (CodeRabbit review on PR #1166). */
export const SPOTIFY_KINDS = {
  connect: "connect",
  oauthCallback: "oauthCallback",
  status: "status",
  diagnose: "diagnose",
  configure: "configure",
  liked: "liked",
  playlists: "playlists",
  playlistTracks: "playlistTracks",
  recent: "recent",
  nowPlaying: "nowPlaying",
  search: "search",
  // Player Controls (PR 3). All except `getDevices` require the
  // user to have Spotify Premium — the plugin gates them at the
  // dispatch boundary by reading `/v1/me/{product}` and refusing
  // with `premium_required` for free-tier accounts.
  play: "play",
  pause: "pause",
  next: "next",
  previous: "previous",
  seek: "seek",
  setVolume: "setVolume",
  transferPlayback: "transferPlayback",
  getDevices: "getDevices",
} as const;

/** Categories the `search` kind may include. Spotify's `/v1/search`
 *  accepts these four; centralising the list lets `definition.ts`
 *  reuse the same source for the JSON-schema enum (no drift between
 *  Zod and the LLM-facing schema). */
export const SEARCH_TYPES = ["track", "artist", "album", "playlist"] as const;

/** Kinds the LLM is allowed to invoke directly (= advertised in
 *  `TOOL_DEFINITION.parameters.kind.enum`). `configure` is omitted
 *  intentionally — it's a View-only action that writes the user's
 *  Client ID; exposing it to the LLM would invite the model to
 *  mutate user secrets. */
export const LLM_CALLABLE_KINDS = [
  SPOTIFY_KINDS.connect,
  SPOTIFY_KINDS.oauthCallback,
  SPOTIFY_KINDS.status,
  SPOTIFY_KINDS.diagnose,
  SPOTIFY_KINDS.liked,
  SPOTIFY_KINDS.playlists,
  SPOTIFY_KINDS.playlistTracks,
  SPOTIFY_KINDS.recent,
  SPOTIFY_KINDS.nowPlaying,
  SPOTIFY_KINDS.search,
  SPOTIFY_KINDS.play,
  SPOTIFY_KINDS.pause,
  SPOTIFY_KINDS.next,
  SPOTIFY_KINDS.previous,
  SPOTIFY_KINDS.seek,
  SPOTIFY_KINDS.setVolume,
  SPOTIFY_KINDS.transferPlayback,
  SPOTIFY_KINDS.getDevices,
] as const;

/** Persisted at `runtime.files.config/tokens.json`. Per-machine
 *  secret — not synced via mulmoclaude's backup story. */
export const TokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** ISO-8601 string. The client's proactive-refresh path treats
   *  anything within `EXPIRY_LEEWAY_MS` of this value as expired. */
  expiresAt: z.string().min(1),
  scopes: z.array(z.string()),
});

/** Persisted at `runtime.files.config/client.json`. The user
 *  registers their own Spotify Developer Dashboard app and writes
 *  the Client ID here (PKCE flow doesn't need a secret). */
export const ClientConfigSchema = z.object({
  clientId: z.string().min(1),
});

/** In-memory record kept between `connect` and `oauthCallback`. */
export const PendingAuthSchema = z.object({
  codeVerifier: z.string(),
  redirectUri: z.string(),
  /** Epoch ms. The OAuth helpers sweep entries older than the
   *  pending-auth TTL on each call. */
  createdAtMs: z.number(),
});

/** Dispatch argument shape — discriminated by `kind`. PR 1 covered
 *  only the OAuth-flavored kinds; PR 2 adds the listening-data
 *  kinds plus a View-only `configure` action.
 *
 *  `configure` is excluded from `TOOL_DEFINITION.parameters.kind`
 *  enum because it's intended for the View's "Configure" form, not
 *  for the LLM. It still rides the same dispatch surface so the
 *  View doesn't need a separate endpoint. */
export const DispatchArgsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(SPOTIFY_KINDS.connect),
    /** Absolute URL the browser will be redirected back to after the
     *  consent screen. Computed by the View as
     *  `${window.location.origin}/api/plugins/runtime/oauth-callback/<alias>`
     *  where `<alias>` matches the plugin's `OAUTH_CALLBACK_ALIAS`
     *  named export. */
    redirectUri: z.string().url(),
  }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.oauthCallback),
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({ kind: z.literal(SPOTIFY_KINDS.status) }),
  z.object({ kind: z.literal(SPOTIFY_KINDS.diagnose) }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.configure),
    /** Spotify Developer Dashboard Client ID. PKCE flow needs no
     *  Client Secret. Validated lightly — Spotify's IDs are
     *  alphanumeric, but we trust the user not to paste random
     *  garbage and let the token endpoint reject malformed values. */
    clientId: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.liked),
    /** 1-50, default 50 (the Spotify endpoint's hard cap). */
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({ kind: z.literal(SPOTIFY_KINDS.playlists) }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.playlistTracks),
    /** Spotify playlist ID (the bare ID, not a URI). The View
     *  obtains it from the prior `playlists` response. */
    playlistId: z.string().min(1).max(64),
    /** 1-100, default 100 (the Spotify endpoint's hard cap). */
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.recent),
    /** 1-50, default 50 (the Spotify endpoint's hard cap). */
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({ kind: z.literal(SPOTIFY_KINDS.nowPlaying) }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.search),
    /** Free-form query — Spotify supports field filters
     *  (`artist:Bach`, `year:2020`) and quoted phrases. `.trim()`
     *  before `min(1)` so a whitespace-only query (like `"   "`)
     *  fails validation here instead of slipping through to
     *  Spotify and coming back as a 4xx (Codex review on
     *  PR #1168). */
    query: z.string().trim().min(1).max(200),
    /** Categories to include. Spotify's `/v1/search` accepts
     *  `track`, `artist`, `album`, `playlist`. Default is all four
     *  so a casual `manageSpotify({ kind: "search", query })` from
     *  the LLM gets a useful spread without needing to specify. */
    types: z.array(z.enum(SEARCH_TYPES)).min(1).max(SEARCH_TYPES.length).optional(),
    /** 1-50, default 10 (per category). Lower than the listening
     *  kinds because search results are more diverse + the LLM
     *  context window holds N results × M categories. */
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.play),
    /** Optional: target a specific device. Defaults to the user's
     *  active device. */
    deviceId: z.string().min(1).max(128).optional(),
    /** Optional: a Spotify URI for an album / playlist / artist
     *  context to play (e.g. `spotify:playlist:abc123`). Mutually
     *  exclusive with `trackUris` — the dispatcher in `index.ts`
     *  rejects when both are set, because Zod's
     *  `discriminatedUnion` doesn't accept refined arms (refining
     *  this arm would corrupt the kind discriminator). */
    contextUri: z.string().min(1).max(256).optional(),
    /** Optional: explicit list of track URIs to queue
     *  (`spotify:track:abc123`). Mutually exclusive with
     *  `contextUri` (see comment above). */
    trackUris: z.array(z.string().min(1).max(256)).min(1).max(100).optional(),
  }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.pause),
    deviceId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.next),
    deviceId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.previous),
    deviceId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.seek),
    /** Position in milliseconds. Spotify caps at the track length;
     *  positions past the end stop playback. */
    positionMs: z.number().int().min(0).max(86_400_000),
    deviceId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.setVolume),
    /** 0-100 inclusive. */
    volumePercent: z.number().int().min(0).max(100),
    deviceId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    kind: z.literal(SPOTIFY_KINDS.transferPlayback),
    /** Spotify ID of the device to transfer to. Get from `getDevices`. */
    deviceId: z.string().min(1).max(128),
    /** When true, playback continues after transfer. Default false
     *  (matches Spotify's API default). */
    play: z.boolean().optional(),
  }),
  z.object({ kind: z.literal(SPOTIFY_KINDS.getDevices) }),
]);

export type DispatchArgs = z.infer<typeof DispatchArgsSchema>;

// ── Dispatch response schemas ───────────────────────────────────────
//
// The mirror of `DispatchArgsSchema`. Protocol 2.0.0 makes `dispatch`
// return `unknown` unless it is handed a reader, because naming the
// result type at the call site never checked anything — the View had not
// seen the response, the server had. These are what make the View's
// `NormalisedTrack[]` a fact rather than a claim.
//
// Kept beside the arg schemas so the two halves of one contract cannot
// drift apart, which is the reason this file exists.

const TrackSchema = z.object({
  id: z.string(),
  name: z.string(),
  artists: z.array(z.string()),
  album: z.string(),
  durationMs: z.number(),
  url: z.string().optional(),
  imageUrl: z.string().optional(),
  trackUri: z.string().optional(),
});

const PlaylistSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  trackCount: z.number(),
  url: z.string().optional(),
  imageUrl: z.string().optional(),
});

const ArtistSchema = z.object({
  id: z.string(),
  name: z.string(),
  genres: z.array(z.string()),
  popularity: z.number().optional(),
  url: z.string().optional(),
  imageUrl: z.string().optional(),
});

const AlbumSchema = z.object({
  id: z.string(),
  name: z.string(),
  artists: z.array(z.string()),
  releaseDate: z.string(),
  totalTracks: z.number(),
  url: z.string().optional(),
  imageUrl: z.string().optional(),
});

const SearchResultSchema = z.object({
  tracks: z.array(TrackSchema).optional(),
  artists: z.array(ArtistSchema).optional(),
  albums: z.array(AlbumSchema).optional(),
  playlists: z.array(PlaylistSchema).optional(),
});

/** `id` is nullable on purpose: Spotify lists restricted devices without
 *  one, and dropping them would underreport the user's setup. */
const DeviceSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  type: z.string(),
  isActive: z.boolean(),
  volumePercent: z.number().optional(),
});

/** Every dispatch answers in this envelope; only `data` varies. */
const envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ ok: z.boolean(), data: data.optional(), message: z.string().optional() });

const StatusDataSchema = z.object({
  clientIdConfigured: z.boolean(),
  connected: z.boolean(),
  expiresAt: z.string().nullable(),
  scopes: z.array(z.string()),
  isPremium: z.boolean().nullable().optional(),
  displayName: z.string().optional(),
});
export const StatusResponseSchema = z.object({ ok: z.boolean(), data: StatusDataSchema });
export type StatusData = z.infer<typeof StatusDataSchema>;
export const ConnectResponseSchema = envelope(z.object({ authorizeUrl: z.string().optional() }));
export const LikedResponseSchema = envelope(z.array(TrackSchema));
export const PlaylistsResponseSchema = envelope(z.array(PlaylistSchema));
const RecentItemSchema = z.object({ track: TrackSchema, playedAt: z.string() });
export const RecentResponseSchema = envelope(z.array(RecentItemSchema));
export const NowPlayingResponseSchema = envelope(TrackSchema.nullable());
export const SearchResponseSchema = envelope(SearchResultSchema);
export const DevicesResponseSchema = envelope(z.array(DeviceSchema));
export const AckResponseSchema = z.object({ ok: z.boolean(), message: z.string().optional() });

// Inferred from the wire schemas above, not from `types.ts`. The two differ
// under `exactOptionalPropertyTypes`: an absent optional survives JSON as
// absent, and zod models that as `| undefined`. The View holds parsed values,
// so it holds THESE — `types.ts` stays the server's shape.
export type WireTrack = z.infer<typeof TrackSchema>;
export type WirePlaylist = z.infer<typeof PlaylistSchema>;
export type WireRecentItem = z.infer<typeof RecentItemSchema>;
export type WireSearchResult = z.infer<typeof SearchResultSchema>;
export type WireDevice = z.infer<typeof DeviceSchema>;
