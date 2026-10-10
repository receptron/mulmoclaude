// The listening summaries are what the agent reads before calling `play`, so each line
// that names a playable item has to carry the URI `play` takes (#3432).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { summariseListening } from "../../../packages/plugins/spotify-plugin/src/core/responses.ts";
import { spotifyUri } from "../../../packages/plugins/spotify-plugin/src/spotifyUri.ts";
import type { NormalisedPlaylist, NormalisedTrack, RecentlyPlayedItem } from "../../../packages/plugins/spotify-plugin/src/types.ts";

const track = (trackId: string, name: string): NormalisedTrack => ({
  id: trackId,
  name,
  artists: ["Joni"],
  album: "Blue",
  durationMs: 1000,
  trackUri: `spotify:track:${trackId}`,
});
/** A podcast episode as `normaliseTrack` leaves it: it passes, but carries no track URI. */
const EPISODE: NormalisedTrack = { id: "e-1", name: "Episode 12", artists: [], album: "", durationMs: 1000 };
const TRACKS = [track("t-1", "Blue"), track("t-2", "River")];
const PLAYLISTS: NormalisedPlaylist[] = [
  { id: "p-1", name: "Focus", description: "", trackCount: 12 },
  { id: "p-2", name: "Run", description: "", trackCount: 3 },
];
const RECENT: RecentlyPlayedItem[] = TRACKS.map((item) => ({ track: item, playedAt: "2026-07-30T10:00:00.000Z" }));

/** The item lines of a list summary: everything after its "Title (n):" header. */
const itemLines = (summary: string): string[] => summary.split("\n").slice(1);

describe("summariseListening — every line ends with the item's URI", () => {
  it("liked and playlistTracks lines end with the track URI", () => {
    (["liked", "playlistTracks"] as const).forEach((kind) => {
      const lines = itemLines(summariseListening(kind, TRACKS));
      assert.deepEqual(
        lines.map((line) => line.split(" · ").pop()),
        TRACKS.map((item) => item.trackUri),
        kind,
      );
    });
  });

  it("playlists lines end with the playlist URI", () => {
    const lines = itemLines(summariseListening("playlists", PLAYLISTS));
    assert.deepEqual(
      lines.map((line) => line.split(" · ").pop()),
      PLAYLISTS.map((item) => spotifyUri("playlist", item.id)),
    );
  });

  it("recent lines end with the track URI", () => {
    const lines = itemLines(summariseListening("recent", RECENT));
    assert.deepEqual(
      lines.map((line) => line.split(" · ").pop()),
      TRACKS.map((item) => item.trackUri),
    );
  });

  it("gives an episode no URI rather than an invented spotify:track: one", () => {
    const lines = itemLines(summariseListening("playlistTracks", [TRACKS[0], EPISODE]));
    assert.deepEqual(lines, ["1. Blue — Joni · spotify:track:t-1", "2. Episode 12 — "]);
    assert.equal(summariseListening("nowPlaying", EPISODE), "Now playing: Episode 12 —  ()");
  });

  it("now playing ends with the track URI", () => {
    assert.equal(summariseListening("nowPlaying", TRACKS[0]), "Now playing: Blue — Joni (Blue) · spotify:track:t-1");
  });

  it("keeps the empty and nothing-playing messages unchanged", () => {
    assert.equal(summariseListening("liked", []), "No liked items.");
    assert.equal(summariseListening("nowPlaying", null), "Nothing is currently playing.");
  });
});

describe("spotifyUri", () => {
  it("builds the URI shape `play` takes", () => {
    assert.equal(spotifyUri("album", "abc123"), "spotify:album:abc123");
    assert.equal(spotifyUri("playlist", "p"), "spotify:playlist:p");
  });
});
