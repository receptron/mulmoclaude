// Normalisers: shrink raw Spotify responses to the
// `Normalised{Track,Playlist}` shapes the View renders. Pure —
// no runtime / fetch / I/O — so unit tests run without mocks.

import type { NormalisedAlbum, NormalisedArtist, NormalisedPlaylist, NormalisedTrack, RecentlyPlayedItem } from "./types";

interface SpotifyArtist {
  name?: unknown;
}

interface SpotifyImage {
  url?: unknown;
}

interface SpotifyAlbum {
  name?: unknown;
  images?: unknown;
}

interface SpotifyExternalUrls {
  spotify?: unknown;
}

interface SpotifyTrack {
  id?: unknown;
  name?: unknown;
  artists?: unknown;
  album?: unknown;
  duration_ms?: unknown;
  external_urls?: unknown;
  uri?: unknown;
}

interface SpotifyPlaylist {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  /** Legacy field — Spotify's older `SimplifiedPlaylistObject`
   *  carried `tracks: { href, total }` here. Still present on
   *  individual-playlist endpoints. */
  tracks?: unknown;
  /** Newer field — `/v1/me/playlists` now returns
   *  `items: { href, total }` on each playlist (Spotify renamed
   *  the field 2024-2025 to align with the new
   *  `/v1/playlists/{id}/items` endpoint that handles tracks
   *  AND episodes). Read both for forward-compat (#1162 PR 2). */
  items?: unknown;
  external_urls?: unknown;
  images?: unknown;
}

// Kept local: this plugin has no `@mulmoclaude/core` dependency. Must stay
// identical to the canonical guard in `server/utils/types.ts` — `!Array.isArray`
// is what stops an array narrowing to `Record` and being indexed by string key
// (#2220).
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function smallestImageUrl(images: unknown): string | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  // Spotify orders `images` largest-first; pick the last one with a
  // valid URL so we don't hammer mobile data plans on cover-art-heavy
  // playlists.
  for (let i = images.length - 1; i >= 0; i -= 1) {
    const candidate = images[i] as SpotifyImage;
    if (typeof candidate?.url === "string" && candidate.url.length > 0) return candidate.url;
  }
  return undefined;
}

function spotifyUrl(externalUrls: unknown): string | undefined {
  if (!isRecord(externalUrls)) return undefined;
  const candidate = (externalUrls as SpotifyExternalUrls).spotify;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

// Playlist and now-playing items can be podcast episodes, which still pass `normaliseTrack`;
// only Spotify's own track URI is kept, so an episode never gets a `spotify:track:` URI.
const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]+$/;

function trackUriOf(uri: unknown): string | undefined {
  return typeof uri === "string" && TRACK_URI_RE.test(uri) ? uri : undefined;
}

function artistNames(artists: unknown): string[] {
  if (!Array.isArray(artists)) return [];
  return artists
    .map((a) => (isRecord(a) && typeof (a as SpotifyArtist).name === "string" ? ((a as SpotifyArtist).name as string) : ""))
    .filter((n) => n.length > 0);
}

/** Normalise one Spotify track. Returns null when the response is
 *  missing required scalar fields — caller should drop it from the
 *  list rather than render a half-broken row. */
export function normaliseTrack(raw: unknown): NormalisedTrack | null {
  if (!isRecord(raw)) return null;
  const track = raw as SpotifyTrack;
  if (typeof track.id !== "string" || track.id.length === 0) return null;
  if (typeof track.name !== "string") return null;
  const album = isRecord(track.album) ? (track.album as SpotifyAlbum) : null;
  const url = spotifyUrl(track.external_urls);
  const imageUrl = smallestImageUrl(album?.images);
  const trackUri = trackUriOf(track.uri);
  return {
    id: track.id,
    name: track.name,
    artists: artistNames(track.artists),
    album: typeof album?.name === "string" ? album.name : "",
    durationMs: typeof track.duration_ms === "number" && Number.isFinite(track.duration_ms) ? track.duration_ms : 0,
    ...(url !== undefined ? { url } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(trackUri !== undefined ? { trackUri } : {}),
  };
}

/** Walk a paginated `items[]` response, normalise each entry's
 *  nested track, and drop entries that fail validation. */
export function normaliseTrackList(raw: unknown, trackPath: "track" | "self"): NormalisedTrack[] {
  if (!isRecord(raw)) return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: NormalisedTrack[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const candidate = trackPath === "track" ? item.track : item;
    const normalised = normaliseTrack(candidate);
    if (normalised) out.push(normalised);
  }
  return out;
}

/** `recently-played` items wrap the track in an object that carries
 *  the `played_at` timestamp. The View renders timestamps so we
 *  preserve them at this layer. */
export function normaliseRecentlyPlayed(raw: unknown): RecentlyPlayedItem[] {
  if (!isRecord(raw)) return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: RecentlyPlayedItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const track = normaliseTrack(item.track);
    if (!track) continue;
    const playedAt = typeof item.played_at === "string" ? item.played_at : "";
    out.push({ track, playedAt });
  }
  return out;
}

function readPlaylistTotal(playlist: SpotifyPlaylist): number {
  // Read the new `items.total` first (current Spotify response
  // shape), fall back to `tracks.total` for the legacy shape.
  const candidates = [playlist.items, playlist.tracks];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const total = (candidate as { total?: unknown }).total;
    if (typeof total === "number" && Number.isFinite(total)) return total;
  }
  return 0;
}

export function normalisePlaylist(raw: unknown): NormalisedPlaylist | null {
  if (!isRecord(raw)) return null;
  const playlist = raw as SpotifyPlaylist;
  if (typeof playlist.id !== "string" || playlist.id.length === 0) return null;
  if (typeof playlist.name !== "string") return null;
  const url = spotifyUrl(playlist.external_urls);
  const imageUrl = smallestImageUrl(playlist.images);
  return {
    id: playlist.id,
    name: playlist.name,
    description: typeof playlist.description === "string" ? playlist.description : "",
    trackCount: readPlaylistTotal(playlist),
    ...(url !== undefined ? { url } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
  };
}

export function normalisePlaylistList(raw: unknown): NormalisedPlaylist[] {
  if (!isRecord(raw)) return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: NormalisedPlaylist[] = [];
  for (const item of items) {
    const normalised = normalisePlaylist(item);
    if (normalised) out.push(normalised);
  }
  return out;
}

interface SpotifyArtistFull {
  id?: unknown;
  name?: unknown;
  genres?: unknown;
  popularity?: unknown;
  external_urls?: unknown;
  images?: unknown;
}

export function normaliseArtist(raw: unknown): NormalisedArtist | null {
  if (!isRecord(raw)) return null;
  const artist = raw as SpotifyArtistFull;
  if (typeof artist.id !== "string" || artist.id.length === 0) return null;
  if (typeof artist.name !== "string") return null;
  const url = spotifyUrl(artist.external_urls);
  const imageUrl = smallestImageUrl(artist.images);
  const popularity = typeof artist.popularity === "number" && Number.isFinite(artist.popularity) ? artist.popularity : undefined;
  return {
    id: artist.id,
    name: artist.name,
    genres: Array.isArray(artist.genres) ? artist.genres.filter((g): g is string => typeof g === "string") : [],
    ...(popularity !== undefined ? { popularity } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
  };
}

export function normaliseArtistList(raw: unknown): NormalisedArtist[] {
  if (!isRecord(raw)) return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: NormalisedArtist[] = [];
  for (const item of items) {
    const normalised = normaliseArtist(item);
    if (normalised) out.push(normalised);
  }
  return out;
}

interface SpotifyAlbumFull {
  id?: unknown;
  name?: unknown;
  artists?: unknown;
  release_date?: unknown;
  total_tracks?: unknown;
  external_urls?: unknown;
  images?: unknown;
}

export function normaliseAlbum(raw: unknown): NormalisedAlbum | null {
  if (!isRecord(raw)) return null;
  const album = raw as SpotifyAlbumFull;
  if (typeof album.id !== "string" || album.id.length === 0) return null;
  if (typeof album.name !== "string") return null;
  const url = spotifyUrl(album.external_urls);
  const imageUrl = smallestImageUrl(album.images);
  return {
    id: album.id,
    name: album.name,
    artists: artistNames(album.artists),
    releaseDate: typeof album.release_date === "string" ? album.release_date : "",
    totalTracks: typeof album.total_tracks === "number" && Number.isFinite(album.total_tracks) ? album.total_tracks : 0,
    ...(url !== undefined ? { url } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
  };
}

export function normaliseAlbumList(raw: unknown): NormalisedAlbum[] {
  if (!isRecord(raw)) return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: NormalisedAlbum[] = [];
  for (const item of items) {
    const normalised = normaliseAlbum(item);
    if (normalised) out.push(normalised);
  }
  return out;
}
