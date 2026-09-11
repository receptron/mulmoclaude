// Per-beat generated video clip state (moviePrompt / animated beats). The wire
// `stories/…` path comes from the beat-movie probe; the blob object URL is
// fetched lazily on first play through the host adapter's authenticated
// `fetchMediaBlob` — a plain <video src> can't attach the host's auth headers.

import { reactive, type ComputedRef } from "vue";
import { errorMessage } from "@mulmoclaude/common";
import { clearReactiveRecords, staleSince as staleSinceOf, type StoryRef } from "../helpers";
import type { MulmoScriptTransport } from "../transport";
import type { MulmoScriptHostAdapter } from "../hostAdapter";

export interface UseBeatMovieOptions {
  api: MulmoScriptTransport;
  adapter: MulmoScriptHostAdapter;
  filePath: ComputedRef<string>;
  /** Which registered root `filePath` is relative to; `undefined` = the host's default (#3014). */
  root: ComputedRef<string | undefined>;
}

export function useBeatMovie({ api, adapter, filePath, root }: UseBeatMovieOptions) {
  const beatMovies = reactive<Record<number, string>>({});
  const beatMovieUrls = reactive<Record<number, string>>({});
  const beatMovieOpen = reactive<Record<number, boolean>>({});
  const beatMovieLoading = reactive<Record<number, boolean>>({});

  // The PAIR, not the path: `stories/deck.json` exists in every root (#3014).
  const storyRef = (): StoryRef => ({ filePath: filePath.value, root: root.value });
  const staleSince = (requested: StoryRef): boolean => staleSinceOf(storyRef(), requested);

  async function loadExistingBeatMovie(index: number): Promise<void> {
    const requested = storyRef();
    const response = await api.call("beatMovie", { ...requested, beatIndex: index });
    if (staleSince(requested)) return;
    // silently ignore errors — the clip simply hasn't been generated yet
    if (response.ok && response.data.moviePath) {
      beatMovies[index] = response.data.moviePath;
    }
  }

  async function playBeatMovie(index: number): Promise<void> {
    const fetchMediaBlob = adapter.fetchMediaBlob;
    if (!fetchMediaBlob || !beatMovies[index] || beatMovieLoading[index]) return;
    if (beatMovieUrls[index]) {
      beatMovieOpen[index] = true;
      return;
    }
    beatMovieLoading[index] = true;
    try {
      // Re-type the .mov blob as video/mp4 — same ISO-BMFF family, and
      // <video> support for "video/mp4" is broader than "video/quicktime".
      const blob = new Blob([await fetchMediaBlob({ moviePath: beatMovies[index], root: root.value })], { type: "video/mp4" });
      beatMovieUrls[index] = URL.createObjectURL(blob);
      beatMovieOpen[index] = true;
    } catch (err) {
      alert(errorMessage(err));
    } finally {
      Reflect.deleteProperty(beatMovieLoading, index);
    }
  }

  function closeBeatMovie(index: number): void {
    Reflect.deleteProperty(beatMovieOpen, index);
  }

  // Drop one beat's cached clip (regenerate is about to replace it on
  // disk). Revoking the object URL frees the blob immediately.
  function invalidateBeatMovie(index: number): void {
    if (beatMovieUrls[index]) URL.revokeObjectURL(beatMovieUrls[index]);
    [beatMovies, beatMovieUrls, beatMovieOpen].forEach((map) => Reflect.deleteProperty(map, index));
  }

  function resetBeatMovies(): void {
    Object.values(beatMovieUrls).forEach((url) => URL.revokeObjectURL(url));
    clearReactiveRecords(beatMovies, beatMovieUrls, beatMovieOpen, beatMovieLoading);
  }

  return {
    beatMovies,
    beatMovieUrls,
    beatMovieOpen,
    beatMovieLoading,
    loadExistingBeatMovie,
    playBeatMovie,
    closeBeatMovie,
    invalidateBeatMovie,
    resetBeatMovies,
  };
}
