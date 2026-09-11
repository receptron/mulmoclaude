// Movie + PDF export (#1614): each output has the same status-poll →
// long-held generate dispatch → authenticated download triple, kept as
// independent state so a movie and a PDF can be requested for the same
// script without collision. Media bytes are served behind host auth; the
// host-injected `fetchMediaBlob` keeps the auth boundary intact (a plain
// `<a href download>` can't attach the host's headers).

import { ref, type ComputedRef, type Ref } from "vue";
import { errorMessage } from "@mulmoclaude/common";
import { downloadFilename, staleSince, type StoryRef } from "../helpers";
import type { MulmoScriptTransport } from "../transport";
import type { MulmoScriptHostAdapter } from "../hostAdapter";

export interface UseMediaExportOptions {
  api: MulmoScriptTransport;
  adapter: MulmoScriptHostAdapter;
  filePath: ComputedRef<string>;
  /** Which registered root `filePath` is relative to; `undefined` = the host's default (#3014). */
  root: ComputedRef<string | undefined>;
  chatSessionId: ComputedRef<string | undefined>;
}

type MediaKind = "movie" | "pdf";

export function useMediaExport({ api, adapter, filePath, root, chatSessionId }: UseMediaExportOptions) {
  // The PAIR, not the path: `stories/deck.json` exists in every root (#3014), so a late
  // resolution must be matched against the root it was asked for as well.
  const storyRef = (): StoryRef => ({ filePath: filePath.value, root: root.value });
  const movieGenerating = ref(false);
  const movieDownloading = ref(false);
  const moviePath = ref<string | null>(null);
  // Persists the most-recent movie-generation failure so the toolbar can
  // surface it inline with a retry button (#1197). Cleared at the start of
  // every generate / regenerate attempt.
  const movieError = ref<string | null>(null);
  const pdfGenerating = ref(false);
  const pdfDownloading = ref(false);
  const pdfPath = ref<string | null>(null);

  // Long-held dispatch — resolves when the whole pipeline finishes (minutes).
  // If the user navigates to a different result meanwhile the resolution
  // describes the OLD script, so drop it; the new script's own
  // initializeScript / pubsub subscription owns the visible state.
  async function generateMovie(): Promise<void> {
    const requested = storyRef();
    movieGenerating.value = true;
    movieError.value = null;
    const response = await api.call("generateMovie", { ...requested, chatSessionId: chatSessionId.value });
    if (staleSince(storyRef(), requested)) return;
    movieGenerating.value = false;
    if (!response.ok) {
      // Surface inline (instead of `alert()` which blocks + has no retry
      // affordance). The error chip with a retry button lives in the toolbar.
      movieError.value = response.error;
      return;
    }
    moviePath.value = response.data.moviePath;
  }

  async function generatePdf(): Promise<void> {
    const requested = storyRef();
    pdfGenerating.value = true;
    const response = await api.call("generatePdf", { ...requested, chatSessionId: chatSessionId.value });
    if (staleSince(storyRef(), requested)) return;
    pdfGenerating.value = false;
    if (!response.ok) {
      alert(response.error);
      return;
    }
    pdfPath.value = response.data.pdfPath;
  }

  async function refreshMoviePath(): Promise<void> {
    const requested = storyRef();
    if (!requested.filePath) return;
    const response = await api.call("movieStatus", requested);
    if (staleSince(storyRef(), requested)) return;
    if (response.ok && response.data.moviePath) moviePath.value = response.data.moviePath;
  }

  async function refreshPdfPath(): Promise<void> {
    const requested = storyRef();
    if (!requested.filePath) return;
    const response = await api.call("pdfStatus", requested);
    if (staleSince(storyRef(), requested)) return;
    if (response.ok && response.data.pdfPath) pdfPath.value = response.data.pdfPath;
  }

  // Authenticated blob → synthetic <a download> click. The download attribute
  // carries the filename so the browser still surfaces a native save dialog.
  async function downloadMedia(kind: MediaKind, sourcePath: string | null, fallbackName: string, downloading: Ref<boolean>): Promise<void> {
    const fetchMediaBlob = adapter.fetchMediaBlob;
    if (!fetchMediaBlob || !sourcePath || downloading.value) return;
    downloading.value = true;
    let objectUrl: string | null = null;
    try {
      const blob = await fetchMediaBlob(kind === "movie" ? { moviePath: sourcePath } : { pdfPath: sourcePath });
      objectUrl = URL.createObjectURL(blob);
      clickDownloadAnchor(objectUrl, downloadFilename(sourcePath, fallbackName));
    } catch (err) {
      alert(errorMessage(err));
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      downloading.value = false;
    }
  }

  function downloadMovie(): Promise<void> {
    return downloadMedia("movie", moviePath.value, "movie.mp4", movieDownloading);
  }

  function downloadPdf(): Promise<void> {
    return downloadMedia("pdf", pdfPath.value, "deck.pdf", pdfDownloading);
  }

  // Movie/PDF spinners + paths are per-script: without a reset, switching away
  // from a generating script would leave the new script's toolbar spinning.
  function resetMedia(): void {
    moviePath.value = null;
    pdfPath.value = null;
    movieGenerating.value = false;
    pdfGenerating.value = false;
    movieError.value = null;
  }

  return {
    moviePath,
    movieGenerating,
    movieDownloading,
    movieError,
    pdfPath,
    pdfGenerating,
    pdfDownloading,
    generateMovie,
    downloadMovie,
    refreshMoviePath,
    generatePdf,
    downloadPdf,
    refreshPdfPath,
    resetMedia,
  };
}

function clickDownloadAnchor(href: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
