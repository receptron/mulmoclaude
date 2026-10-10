// The agent passes these straight to `play` (`trackUris` / `contextUri`), so every
// summary line that names a playable item ends with its URI.

export type SpotifyContextType = "album" | "artist" | "playlist";

export const spotifyUri = (type: SpotifyContextType, id: string): string => `spotify:${type}:${id}`;

export const withUri = (line: string, type: SpotifyContextType, id: string): string => `${line} · ${spotifyUri(type, id)}`;

/** A track line carries the URI Spotify returned, never one rebuilt from the id: an
 *  episode normalised as a track has no `trackUri` and its line stays bare. */
export const withTrackUri = (line: string, track: { trackUri?: string }): string => (track.trackUri ? `${line} · ${track.trackUri}` : line);
