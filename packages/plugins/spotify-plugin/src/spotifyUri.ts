// The agent passes these straight to `play` (`trackUris` / `contextUri`), so every
// summary line that names a playable item ends with its URI.

export type SpotifyEntityType = "track" | "album" | "artist" | "playlist";

export const spotifyUri = (type: SpotifyEntityType, id: string): string => `spotify:${type}:${id}`;

export const withUri = (line: string, type: SpotifyEntityType, id: string): string => `${line} · ${spotifyUri(type, id)}`;
