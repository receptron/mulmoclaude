// Search-result text summarisation. Lives in its own module so the
// formatters are unit-testable directly (CodeRabbit review on PR
// #1168) without going through the full dispatch path. Pure
// functions, no side effects.

import { withTrackUri, withUri } from "./spotifyUri";
import type { NormalisedAlbum, NormalisedArtist, NormalisedPlaylist, NormalisedTrack, SearchResult } from "./types";

/** Build the LLM-facing message string for a search result. The
 *  plain text mirrors the View's grouped sections, one entity per
 *  line.
 *
 *  `query` is user-influenced on the tool path — both the LLM and
 *  a manual View submission can put arbitrary strings in there.
 *  Embedding it raw lets a hostile query smuggle line breaks and
 *  control characters into the LLM's context window (a
 *  prompt-injection vector via tool output: `query: "x\n\nIgnore
 *  all previous instructions and …"`). Strip control chars and
 *  bound the length before interpolating (Codex review on PR
 *  #1168). */
export function summariseSearch(query: string, result: SearchResult): string {
  const safeQuery = sanitiseQueryForSummary(query);
  const sections: string[] = [];
  if (result.tracks?.length) sections.push(formatSearchSection("Tracks", result.tracks, formatTrackLine));
  if (result.artists?.length) sections.push(formatSearchSection("Artists", result.artists, formatArtistLine));
  if (result.albums?.length) sections.push(formatSearchSection("Albums", result.albums, formatAlbumLine));
  if (result.playlists?.length) sections.push(formatSearchSection("Playlists", result.playlists, formatPlaylistLine));
  if (sections.length === 0) return `Search "${safeQuery}": no results.`;
  return `Search "${safeQuery}":\n${sections.join("\n\n")}`;
}

/** Cap and strip control characters so a hostile or accidentally
 *  multi-line query can't break out of the `Search "..."` quoting
 *  or smuggle `\n\nIgnore previous instructions ...` into the
 *  LLM-facing text. Exported for tests.
 *
 *  Coverage: C0 (0x00-0x1F), DEL (0x7F), C1 (0x80-0x9F), and the
 *  Unicode line/paragraph separators (U+2028, U+2029). Each maps
 *  to a single space so adjacent words don't fuse together; runs
 *  of whitespace then collapse to one space. */
const SUMMARY_QUERY_MAX_LEN = 100;

function isControlCodepoint(code: number): boolean {
  if (code <= 0x1f) return true;
  if (code >= 0x7f && code <= 0x9f) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  return false;
}

export function sanitiseQueryForSummary(query: string): string {
  let cleaned = "";
  for (const char of query) {
    const code = char.codePointAt(0) ?? 0;
    cleaned += isControlCodepoint(code) ? " " : char;
  }
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SUMMARY_QUERY_MAX_LEN) return collapsed;
  return `${collapsed.slice(0, SUMMARY_QUERY_MAX_LEN)}…`;
}

export function formatSearchSection<T>(label: string, items: T[], formatter: (item: T, idx: number) => string): string {
  return `${label} (${items.length}):\n${items.map(formatter).join("\n")}`;
}

export function formatTrackLine(track: NormalisedTrack, idx: number): string {
  return withTrackUri(`${idx + 1}. ${track.name} — ${track.artists.join(", ")}`, track);
}

export function formatArtistLine(artist: NormalisedArtist, idx: number): string {
  const genres = artist.genres.length > 0 ? ` [${artist.genres.slice(0, 3).join(", ")}]` : "";
  return withUri(`${idx + 1}. ${artist.name}${genres}`, "artist", artist.id);
}

export function formatAlbumLine(album: NormalisedAlbum, idx: number): string {
  const year = album.releaseDate ? album.releaseDate.slice(0, 4) : "?";
  return withUri(`${idx + 1}. ${album.name} — ${album.artists.join(", ")} (${year})`, "album", album.id);
}

export function formatPlaylistLine(playlist: NormalisedPlaylist, idx: number): string {
  return withUri(`${idx + 1}. ${playlist.name} (${playlist.trackCount} tracks)`, "playlist", playlist.id);
}
