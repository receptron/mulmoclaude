<template>
  <div class="h-full bg-white flex flex-col overflow-hidden">
    <!-- Header -->
    <div class="flex items-start justify-between px-6 py-4 border-b border-gray-100 shrink-0">
      <div class="min-w-0 flex-1">
        <h2 class="text-lg font-semibold text-gray-800 truncate" data-testid="mulmo-script-title">
          {{ script.title || "Untitled Script" }}
        </h2>
        <p v-if="script.description" class="text-sm text-gray-500 mt-0.5 truncate" data-testid="mulmo-script-description">
          {{ script.description }}
        </p>
        <div class="flex items-center gap-3 mt-1 text-xs text-gray-400">
          <span>{{ m.beatCount(beats.length) }}</span>
          <span v-if="script.lang">{{ script.lang }}</span>
          <span v-if="filePath" class="truncate">{{ filePath }}</span>
        </div>
      </div>
      <MulmoScriptToolbar
        :movie-path="moviePath"
        :movie-generating="movieGenerating"
        :movie-downloading="movieDownloading"
        :is-play-ready="isPlayReady"
        :can-fetch-media="canFetchMedia"
        :pdf-path="pdfPath"
        :pdf-generating="pdfGenerating"
        :pdf-downloading="pdfDownloading"
        @play="playPresentation"
        @generate-movie="generateMovie"
        @download-movie="downloadMovie"
        @generate-pdf="generatePdf"
        @download-pdf="downloadPdf"
      />
    </div>

    <!--
      Inline error chip for movie-generation failures (#1197).
      Previously the catch arm of `generateMovie` raised an `alert()` —
      blocking, no retry path, and many users just dismissed the modal
      and saw a stalled spinner with no explanation. The chip stays
      visible until the next generate attempt clears it.
    -->
    <div
      v-if="movieError"
      data-testid="mulmo-script-movie-error-chip"
      class="bg-red-50 border border-red-200 text-red-800 text-xs px-3 py-2 mx-4 mt-3 mb-1 rounded flex items-start gap-2"
    >
      <span class="material-icons text-base shrink-0 mt-px">error_outline</span>
      <div class="flex-1 min-w-0">
        <div class="font-medium">{{ m.movieGenerationFailed }}</div>
        <div class="break-words whitespace-pre-wrap mt-0.5">{{ movieError }}</div>
      </div>
      <button
        class="shrink-0 h-7 px-2 text-xs rounded border border-red-300 text-red-700 hover:bg-red-100 disabled:opacity-50"
        :disabled="movieGenerating"
        data-testid="mulmo-script-movie-retry-button"
        @click="generateMovie"
      >
        {{ m.retry }}
      </button>
    </div>

    <!-- Characters section -->
    <CharacterStrip
      v-if="characterKeys.length > 0"
      :character-keys="characterKeys"
      :images="script.imageParams?.images"
      :thumbnails="charImages"
      :render-state="charRenderState"
      :errors="charErrors"
      :drag-over="charDragOver"
      :movie-generating="movieGenerating"
      :any-beat-rendering="anyBeatRendering"
      @generate-all="generateAllCharacters"
      @char-drag-over="onCharDragOver"
      @char-drag-leave="onCharDragLeave"
      @char-drop="onCharDrop"
      @open-lightbox="openCharacterLightbox"
      @render-character="renderCharacter"
    />

    <!-- Deck editor (#1575, #2945): every beat is a slide → mount the interactive
         editor from @mulmocast/beat-editor. Lazy-loaded via defineAsyncComponent, so
         users whose scripts aren't decks never pay the bundle cost.

         It takes and emits a beat ARRAY, so the script goes through beatsOf / withBeats
         on the way in and out. Writing `{ ...script, beats }` by hand instead drops
         presentationStyle and slideParams, and nothing tells you it happened.

         No `layout` prop: the editor lays itself out from its own width, so the pane
         moves below the list on a narrow host (this card) rather than beside it. -->
    <!-- Two ways to look at the same script, not two kinds of script. The editor edits every
         beat type; the list is where the media lives (generate audio, render an image, open a
         clip), which the editor has no equivalent for — so neither replaces the other. -->
    <div v-if="canEditBeats" class="flex shrink-0 gap-1 px-2 pt-1 text-[11px]">
      <button type="button" :class="beatPaneTabClass(beatPane === 'edit')" data-testid="mulmo-script-tab-edit" @click="beatPane = 'edit'">
        {{ m.editTab }}
      </button>
      <button type="button" :class="beatPaneTabClass(beatPane === 'media')" data-testid="mulmo-script-tab-media" @click="beatPane = 'media'">
        {{ m.mediaTab }}
      </button>
    </div>

    <!-- A deck save that failed, in the server's own words (#3070). The editor keeps showing the
         edit either way, so without this the only difference between a save and a silent failure
         is what comes back on the next reload. Shown in both panes: switching tabs does not make
         an unsaved edit saved. -->
    <div
      v-if="deckSaveError"
      class="shrink-0 mx-2 mt-1 px-2 py-1 rounded bg-red-50 border border-red-200 text-xs text-red-700 break-words"
      role="alert"
      data-testid="mulmo-script-deck-save-error"
    >
      {{ m.saveErrorSaveFailed(deckSaveError) }}
    </div>

    <div v-if="showBeatEditor" class="flex-1 overflow-hidden" data-testid="mulmo-script-deck-editor" @focusout="onDeckFocusOut">
      <BeatListEditor :beats="deckBeats" @update:beats="onDeckBeatsUpdate" />
    </div>

    <!-- Per-beat media list: thumbnails, narration, audio / image / movie generation. -->
    <div v-else ref="beatListEl" class="flex-1 overflow-y-auto p-2 space-y-1.5">
      <div v-for="(beat, index) in beats" :key="index" class="rounded-lg border border-gray-200 overflow-hidden">
        <!-- Beat body: thumbnail + narration side by side -->
        <div class="flex gap-3 items-stretch">
          <!-- Thumbnail -->
          <div
            class="relative shrink-0 w-[45%] overflow-hidden bg-gray-50 transition-colors"
            :class="beatDragOver[index] ? 'bg-blue-50' : ''"
            @dragover="onBeatDragOver($event, index)"
            @dragleave="onBeatDragLeave(index)"
            @drop="onBeatDrop($event, index)"
          >
            <!-- Beat number badge (1-based). Sits above the drop-hint
                 overlay and the inline video player so the index stays
                 readable in every beat state. -->
            <div
              class="absolute top-1.5 left-1.5 z-10 px-1.5 py-0.5 rounded bg-black/55 text-white text-xs font-medium leading-none pointer-events-none"
              :data-testid="`mulmo-script-beat-number-${index}`"
            >
              {{ index + 1 }}
            </div>
            <!-- Inline player for the beat's generated video clip.
                 Replaces the thumbnail while open; the close button
                 returns to the still image. -->
            <template v-if="beatMovieOpen[index] && beatMovieUrls[index]">
              <video :src="beatMovieUrls[index]" class="w-full object-contain" controls autoplay :data-testid="`mulmo-script-beat-movie-player-${index}`" />
              <button
                class="absolute top-1.5 right-1.5 flex items-center justify-center w-6 h-6 rounded border border-gray-400 text-gray-600 bg-white hover:bg-gray-50"
                :title="m.close"
                :aria-label="m.close"
                :data-testid="`mulmo-script-beat-movie-close-${index}`"
                @click.stop="closeBeatMovie(index)"
              >
                <span class="material-icons text-sm">close</span>
              </button>
            </template>
            <template v-else>
              <img
                v-if="renderedImages[index]"
                :src="renderedImages[index]"
                class="w-full object-contain cursor-zoom-in"
                :alt="`Beat ${index + 1}`"
                @click="openLightbox(index)"
              />
              <!-- Play overlay: shown when the beat-movie probe found a
                   generated clip for this beat. Blob is fetched lazily
                   on first click (host-authenticated), hence the spinner. -->
              <button
                v-if="renderedImages[index] && beatMovies[index] && canFetchMedia"
                class="absolute inset-0 m-auto w-12 h-12 flex items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"
                :title="m.play"
                :aria-label="m.play"
                :data-testid="`mulmo-script-beat-movie-play-${index}`"
                @click.stop="playBeatMovie(index)"
              >
                <svg v-if="beatMovieLoading[index]" class="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                <span v-else class="material-icons text-3xl">play_arrow</span>
              </button>
              <button
                v-if="renderedImages[index] && renderState[index] !== 'rendering'"
                class="absolute top-1.5 right-1.5 flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-gray-400 text-gray-600 bg-white hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed"
                :disabled="movieGenerating"
                @click.stop="regenerateBeat(index)"
              >
                ↺
              </button>
              <div v-else-if="!renderedImages[index]" class="w-full aspect-video flex flex-col items-center justify-center gap-1 p-2">
                <template v-if="renderState[index] === 'rendering' || (movieGenerating && !renderedImages[index] && effectiveBeat(index).imagePrompt)">
                  <svg class="animate-spin w-4 h-4 text-green-400" viewBox="0 0 24 24" fill="none">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  <span class="text-xs text-green-500">{{ m.rendering }}</span>
                </template>
                <template v-else-if="renderState[index] === 'error'">
                  <span class="text-xs text-red-400 text-center">{{ renderErrors[index] }}</span>
                </template>
                <template v-else>
                  <span v-if="effectiveBeat(index).imagePrompt" class="text-xs text-gray-400 text-center italic leading-relaxed px-1">{{
                    effectiveBeat(index).imagePrompt
                  }}</span>
                  <span v-else class="text-xs text-gray-300">{{ beat.image?.type ?? "—" }}</span>
                </template>
              </div>
            </template>
            <!-- Beat drop hint / overlay -->
            <div v-if="beatDragOver[index]" class="absolute inset-0 flex items-center justify-center bg-blue-50/80 pointer-events-none">
              <span class="text-xs text-blue-500 font-medium">{{ m.drop }}</span>
            </div>
            <div
              v-else-if="!renderedImages[index] && renderState[index] !== 'rendering'"
              class="absolute bottom-0 inset-x-0 text-center text-xs text-gray-400 bg-white/70 py-0.5 pointer-events-none"
            >
              {{ m.orDropImage }}
            </div>
            <!-- Generate button for any beat without a rendered image.
                 renderBeat works for every beat type: imagePrompt /
                 typed image beats render directly, moviePrompt beats
                 get a frame extracted from the generated clip, and
                 text-only beats fall back to a prompt derived from
                 the narration text (mulmocast prompt.js). -->
            <button
              v-if="!renderedImages[index] && renderState[index] !== 'rendering' && !movieGenerating && !isBeatImageReference(effectiveBeat(index))"
              class="absolute top-1.5 right-1.5 flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-blue-400 text-blue-600 bg-white hover:bg-blue-50"
              @click="renderBeat(index)"
            >
              {{ m.generate }}
            </button>
          </div>

          <!-- Narration text -->
          <div class="flex flex-col flex-1 min-w-0 px-2 py-1.5">
            <span class="text-sm text-gray-800 leading-relaxed">{{ effectiveBeat(index).text }}</span>
            <div class="flex justify-between mt-auto pt-1">
              <!-- Audio controls -->
              <div class="flex items-center gap-1">
                <template v-if="audioState[index] === 'generating' || (movieGenerating && !beatAudios[index] && effectiveBeat(index).text)">
                  <svg class="animate-spin w-3 h-3 text-green-400" viewBox="0 0 24 24" fill="none">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                </template>
                <button
                  v-else-if="beatAudios[index]"
                  class="text-xs px-2 py-0.5 rounded border"
                  :class="playingAudio?.index === index ? 'border-red-400 text-red-600 hover:bg-red-50' : 'border-green-400 text-green-600 hover:bg-green-50'"
                  @click="playAudio(index)"
                >
                  {{ playingAudio?.index === index ? m.stop : m.play }}
                </button>
                <template v-else-if="audioErrors[index]">
                  <span class="text-xs text-red-400 truncate min-w-0 max-w-[20rem]" :title="audioErrors[index]">
                    {{ m.errPrefix }} {{ audioErrors[index] }}
                  </span>
                  <button
                    v-if="effectiveBeat(index).text"
                    class="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                    :disabled="movieGenerating"
                    @click="generateAudio(index)"
                  >
                    ↺
                  </button>
                </template>
                <button
                  v-else-if="effectiveBeat(index).text"
                  class="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-50"
                  @click="generateAudio(index)"
                >
                  {{ m.generateAudio }}
                </button>
              </div>
              <button
                class="text-gray-400 hover:text-gray-600"
                :title="sourceOpen[index] ? 'Hide source' : 'Show source'"
                :data-testid="`mulmo-script-beat-source-toggle-${index}`"
                @click="toggleSource(index)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="w-3.5 h-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Source editor -->
        <div v-if="sourceOpen[index]" class="border-t border-gray-100">
          <textarea
            v-model="sourceText[index]"
            class="w-full text-xs text-gray-600 bg-gray-50 p-2 font-mono resize-none"
            :class="isValidBeat(index) ? 'outline-none' : 'outline outline-2 outline-red-400'"
            rows="8"
            spellcheck="false"
            :data-testid="`mulmo-script-beat-source-textarea-${index}`"
          />
          <div class="flex items-center justify-end gap-2 px-2 pb-2">
            <span v-if="beatSaveErrors[index]" class="text-xs text-red-600" role="alert">{{
              beatSaveErrors[index].kind === "invalidJson"
                ? m.saveErrorInvalidJson(beatSaveErrors[index].error)
                : m.saveErrorSaveFailed(beatSaveErrors[index].error)
            }}</span>
            <button
              class="px-2 py-1 text-xs rounded border"
              :class="
                isValidBeat(index) && !beatSaving[index]
                  ? 'border-blue-400 text-blue-600 hover:bg-blue-50 cursor-pointer'
                  : 'border-gray-200 text-gray-300 cursor-not-allowed'
              "
              :disabled="!isValidBeat(index) || !!beatSaving[index]"
              :data-testid="`mulmo-script-beat-update-button-${index}`"
              @click="updateBeat(index)"
            >
              {{ beatSaving[index] ? m.saving : m.update }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="beats.length === 0" class="flex items-center justify-center h-32 text-gray-400 text-sm">{{ m.noBeats }}</div>
    </div>

    <!-- Bottom bar: Edit Script Source + Copy -->
    <div class="bottom-bar-wrapper">
      <details ref="sourceDetails" class="script-source" @toggle="onSourceToggle(($event.target as HTMLDetailsElement).open)">
        <summary>{{ m.editSource }}</summary>
        <textarea
          v-model="editableSource"
          class="script-editor"
          :class="{ 'script-editor-invalid': sourceChanged && !sourceValid }"
          spellcheck="false"
        ></textarea>
        <div class="editor-actions">
          <button class="apply-btn" :disabled="!sourceChanged || !sourceValid" @click="applySource">{{ m.applyChanges }}</button>
          <button class="cancel-btn" @click="cancelSourceEdit">{{ m.cancel }}</button>
        </div>
      </details>
      <button v-show="!editing" class="copy-btn" :title="copied ? 'Copied!' : 'Copy'" @click="copyText">
        <span class="material-icons">{{ copied ? "check" : "content_copy" }}</span>
      </button>
    </div>

    <!-- Lightbox -->
    <BeatLightbox
      v-if="lightbox"
      :lightbox="lightbox"
      :beat-count="beats.length"
      :beat-texts="beatTexts"
      :has-prev="hasPrev"
      :has-next="hasNext"
      :playing-audio-index="playingAudio?.index ?? null"
      :audio-progress="audioProgress"
      :has-current-audio="Boolean(beatAudios[lightbox.index])"
      @close="closeLightbox"
      @move="lightboxMove"
      @jump="jumpToBeat"
      @play-audio="playAudio"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { ToolResultComplete } from "gui-chat-protocol/vue";
import { mulmoBeatSchema, mulmoScriptSchema } from "@mulmocast/types";
import type { MulmoScriptData } from "../core/types";
import type { MulmoScriptGenerationEvent } from "../core/contract";
import {
  isSameScript,
  beatMayHaveMovie,
  shouldAutoRenderBeat,
  effectiveBeat as effectiveBeatOf,
  isBeatImageReference,
  isValidBeat as isValidBeatOf,
  staleSince as staleSinceOf,
  scriptSourceText as toScriptSourceText,
  resolveSilentAdvanceSeconds,
  clearReactiveRecords,
  focusLeftContainer,
  type Beat,
} from "./helpers";
import { beatsOf, withBeats, type EditableBeat } from "@mulmocast/beat-editor";
import { errorMessage } from "@mulmoclaude/common";
import { readFileAsDataUrl, useClipboardCopy } from "./support";
import { useMulmoScriptTransport } from "./transport";
import { useHostAdapter } from "./hostAdapter";
import { useMediaExport } from "./composables/useMediaExport";
import { useBeatMovie } from "./composables/useBeatMovie";
import { useCharacterImages } from "./composables/useCharacterImages";
import { useDeckEditor } from "./composables/useDeckEditor";
import type { LightboxState, MulmoScript } from "./viewTypes";
import BeatLightbox from "./components/BeatLightbox.vue";
import CharacterStrip from "./components/CharacterStrip.vue";
import MulmoScriptToolbar from "./components/MulmoScriptToolbar.vue";
import { useT } from "../lang/index";

// Lazy-loaded so the editor's Vue / tailwind chunk stays out of the initial
// bundle for users whose scripts aren't decks
// (movies, html_tailwind animations, mixed beats). `defineAsyncComponent`
// triggers the dynamic import only when `isDeck` first flips true.
const BeatListEditor = defineAsyncComponent(() => import("@mulmocast/beat-editor").then((mod) => mod.BeatListEditor));

const api = useMulmoScriptTransport();
const adapter = useHostAdapter();
// Media bytes (movie / PDF / beat clips) are served behind host auth; hosts
// opt in by injecting `fetchMediaBlob`. Without it the download / clip-play
// affordances are hidden (the probes still run — state stays warm for a
// host that injects later at remount).
const canFetchMedia = computed(() => Boolean(adapter.fetchMediaBlob));

const m = useT();

const props = defineProps<{
  selectedResult: ToolResultComplete<MulmoScriptData>;
}>();
const emit = defineEmits<{ updateResult: [result: ToolResultComplete] }>();

const data = computed(() => props.selectedResult.data);
const script = computed<MulmoScript>(() => data.value?.script ?? {});
const filePath = computed(() => data.value?.filePath ?? "");
const beats = computed<Beat[]>(() => script.value.beats ?? []);

// Per-beat render state
type RenderState = "idle" | "rendering" | "done" | "error";
const renderState = reactive<Record<number, RenderState>>({});
const renderedImages = reactive<Record<number, string>>({});
const renderErrors = reactive<Record<number, string>>({});
const sourceOpen = reactive<Record<number, boolean>>({});
const sourceText = reactive<Record<number, string>>({});
// Surface update-beat failures inline next to the Update button.
// Cleared on next successful save or editor close. Store raw error +
// kind tag so the template picks a localized message, instead of
// pre-composing an English-prefixed string here.
interface BeatSaveError {
  kind: "invalidJson" | "saveFailed";
  error: string;
}
const beatSaveErrors = reactive<Record<number, BeatSaveError>>({});
const beatSaving = reactive<Record<number, boolean>>({});
const localOverrides = reactive<Record<number, Beat>>({});
const beatAudios = reactive<Record<number, string>>({});
const audioState = reactive<Record<number, "generating" | "done" | "error">>({});
const audioErrors = reactive<Record<number, string>>({});
const playingAudio = ref<{ index: number; audio: HTMLAudioElement } | null>(null);
// Tracks the auto-advance timer running on a silent beat
// (`beat.text === ""`). Beats without text generate no audio, so the
// Play loop falls back to a `setTimeout(beat.duration)` for cues —
// without this, Play would stall on the first silent beat (#1073).
const silentPlaybackTimer = ref<{ index: number; timer: ReturnType<typeof setTimeout> } | null>(null);
const audioProgress = ref(0);

// Default duration (seconds) for a silent beat whose script doesn't
// set `duration` either. Picked to roughly match the time it takes a
// reader to scan a `textSlide` — long enough to read, short enough
// not to feel stuck. The script's own `duration` always wins.
const SILENT_BEAT_DEFAULT_SEC = 3;
const MS_PER_SECOND = 1000;
const beatListEl = ref<HTMLElement | null>(null);
const lightbox = ref<LightboxState | null>(null);
const beatDragOver = reactive<Record<number, boolean>>({});

const anyBeatRendering = computed(() => Object.values(renderState).some((state) => state === "rendering"));

// Session tagging is host transport: MulmoClaude injects the active chat
// session id so generations light its per-session sidebar indicator;
// hosts without sessions leave the adapter empty and the field is simply
// omitted from generation dispatches.
const chatSessionId = computed(() => adapter.chatSessionId?.value);

const {
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
} = useMediaExport({ api, adapter, filePath, chatSessionId });

const {
  beatMovies,
  beatMovieUrls,
  beatMovieOpen,
  beatMovieLoading,
  loadExistingBeatMovie,
  playBeatMovie,
  closeBeatMovie,
  invalidateBeatMovie,
  resetBeatMovies,
} = useBeatMovie({ api, adapter, filePath });

const {
  charRenderState,
  charImages,
  charErrors,
  charDragOver,
  characterKeys,
  onCharDragOver,
  onCharDragLeave,
  onCharDrop,
  loadExistingCharacterImage,
  refreshMissingCharacterImages,
  renderCharacter,
  generateAllCharacters,
  resetCharacters,
} = useCharacterImages({ api, filePath, chatSessionId, getImages: () => script.value.imageParams?.images });

function stopPlayingAudio() {
  // Single helper that clears both the audio path and the silent
  // auto-advance timer — callers (lightbox open / arrow nav / Stop
  // button) get consistent behaviour without remembering which
  // playback mode the current beat was using (#1073).
  stopAllPlayback();
}

function openLightbox(index: number) {
  stopPlayingAudio();
  lightbox.value = {
    src: renderedImages[index] ?? "",
    text: effectiveBeat(index).text,
    index,
  };
}

// Backdrop click handler. Stops any in-flight narration so the audio
// doesn't keep playing after the lightbox is dismissed — without this,
// the HTMLAudioElement created by playAudio() outlives the modal and
// the user hears disembodied narration with no UI to stop it.
function closeLightbox() {
  stopPlayingAudio();
  lightbox.value = null;
}

// "Play presentation" toolbar action. Opens the lightbox at beat 0 and
// kicks off its narration audio; the existing on-ended hook then chains
// through the rest of the deck (lightboxMove(1) → playAudio if the next
// beat has audio), so one click runs the whole presentation. Only wired
// to the toolbar button when moviePath is set, which is our proxy for
// "every beat has both image and audio on disk".
//
// `moviePath` arrives synchronously from movieStatus, but the per-beat
// image and audio data URIs are populated asynchronously by
// loadExistingBeatImage / loadExistingBeatAudio in initializeScript().
// The Play button can therefore become visible before beat 0's assets
// hydrate — `isPlayReady` gates the click so the lightbox never opens
// with an undefined src or silent narration on a beat that does have
// text.
const isPlayReady = computed<boolean>(() => {
  if (beats.value.length === 0) return false;
  if (!renderedImages[0]) return false;
  // Audio is only required when the beat has text (the source of TTS).
  // Beats without text are valid; they just play silently.
  if (effectiveBeat(0).text && !beatAudios[0]) return false;
  return true;
});

function playPresentation() {
  if (!isPlayReady.value) return;
  openLightbox(0);
  playBeat(0);
}

// Stop whichever playback handle is active. Idempotent. Called by
// openLightbox, manual stop / pause buttons, and by `playBeat`
// before kicking off a new beat so we never double-schedule. (#1073)
function stopAllPlayback(): void {
  if (playingAudio.value) {
    playingAudio.value.audio.pause();
    playingAudio.value = null;
    audioProgress.value = 0;
  }
  if (silentPlaybackTimer.value) {
    clearTimeout(silentPlaybackTimer.value.timer);
    silentPlaybackTimer.value = null;
  }
}

// Single entry point for "start playback at beat <index>". Routes
// on what the script DECLARED, not on what's currently hydrated:
//
//   - `text` empty  → silent path (`scheduleSilentAdvance`). The
//     schema says no audio is generated for empty-text beats, so
//     `duration` drives auto-advance.
//   - `text` present + audio loaded → audio path. `audio.ended`
//     chains via `advanceFromBeat`.
//   - `text` present + audio NOT loaded → stop. The Play button's
//     `isPlayReady` gate prevented this for beat 0, but mid-stream
//     a transient fetch miss must not silently skip the narration
//     by falling through to the silent timer (Codex review on
//     #1073 — gating on `beatAudios[index]` would do exactly that).
//
// Either path chains to the next beat via `advanceFromBeat`, so a
// run of silent beats — or audio / silent / audio sequences —
// plays through without manual interaction.
function playBeat(index: number): void {
  stopAllPlayback();
  const hasText = Boolean(effectiveBeat(index).text);
  if (!hasText) {
    scheduleSilentAdvance(index);
    return;
  }
  if (beatAudios[index]) {
    playAudio(index);
  }
  // Text beat with no audio yet → stop. The user can re-click Play
  // once the audio finishes hydrating.
}

function scheduleSilentAdvance(index: number): void {
  // Defensively narrow the script-supplied duration (zero / negative / NaN /
  // non-number → default) — a bad value would otherwise collapse to an
  // immediate timeout and the Play loop would race through every silent beat
  // in a single tick (Codex review iter-5 on #1365).
  const seconds = resolveSilentAdvanceSeconds(effectiveBeat(index).duration, SILENT_BEAT_DEFAULT_SEC);
  const timer = setTimeout(() => {
    if (silentPlaybackTimer.value?.index !== index) return;
    silentPlaybackTimer.value = null;
    if (lightbox.value?.index === index) advanceFromBeat(index);
  }, seconds * MS_PER_SECOND);
  silentPlaybackTimer.value = { index, timer };
}

function advanceFromBeat(fromIndex: number): void {
  lightboxMove(1);
  const nextIndex = lightbox.value?.index;
  if (nextIndex === undefined || nextIndex === fromIndex) return;
  playBeat(nextIndex);
}

const hasPrev = computed(() => {
  if (!lightbox.value) return false;
  for (let i = lightbox.value.index - 1; i >= 0; i--) {
    if (renderedImages[i]) return true;
  }
  return false;
});

const hasNext = computed(() => {
  if (!lightbox.value) return false;
  for (let i = lightbox.value.index + 1; i < beats.value.length; i++) {
    if (renderedImages[i]) return true;
  }
  return false;
});

// Narration text per beat, for the lightbox beat-strip hover tooltips. Reads
// through `effectiveBeat` so an unsaved in-place edit shows its new text.
const beatTexts = computed(() => beats.value.map((_, index) => effectiveBeat(index).text));

function jumpToBeat(index: number) {
  if (!lightbox.value) return;
  if (index === lightbox.value.index) return;
  if (!renderedImages[index]) return;
  // Carry the playback mode forward (audio OR silent timer) so a
  // user clicking the beat-strip thumbnail mid-playback keeps the
  // presentation rolling (#1073).
  const wasPlaying = playingAudio.value !== null || silentPlaybackTimer.value !== null;
  openLightbox(index);
  if (wasPlaying) playBeat(index);
}

function lightboxMove(delta: number) {
  if (!lightbox.value) return;
  const total = beats.value.length;
  // If a playback was in progress when the user clicked the arrow,
  // carry it forward to whichever beat we land on — `playBeat`
  // picks audio vs silent automatically. `openLightbox` stops the
  // current playback, so capture the flag BEFORE that and chain
  // AFTER. The on-ended / silent-advance paths already null their
  // own state before calling `lightboxMove`, so this branch won't
  // double-fire there.
  const wasPlaying = playingAudio.value !== null || silentPlaybackTimer.value !== null;
  let i = lightbox.value.index + delta;
  while (i >= 0 && i < total) {
    if (renderedImages[i]) {
      openLightbox(i);
      if (wasPlaying) playBeat(i);
      return;
    }
    i += delta;
  }
}
const sourceDetails = ref<HTMLDetailsElement>();
const editing = ref(false);
const editableSource = ref("");
const { copied, copy } = useClipboardCopy();

// Beats may be edited in-place via `updateBeat()` and rendered through
// `effectiveBeat()`, so the Copy / source-view text must read the merged
// shape — otherwise the clipboard returns the original prop snapshot
// until the full result is reloaded.
const effectiveScript = computed<MulmoScript>(() => ({
  ...script.value,
  beats: beats.value.map((beat, i) => localOverrides[i] ?? beat),
}));
const scriptSourceText = computed(() => toScriptSourceText(effectiveScript.value));

// Persist a saved script back into the parent's toolResult so the in-memory
// script and reactive beats[] stay in sync without a remount. The parent's
// handleUpdateResult uses Object.assign (in-place), so the prop watcher won't
// fire — callers that need a re-read drive initializeScript themselves.
function commitScript(next: MulmoScript): void {
  emit("updateResult", {
    ...props.selectedResult,
    data: { ...props.selectedResult.data, script: next },
  });
}

// #1575 — when every beat is a `slide`, swap the per-beat list UI for the
// interactive deck editor (@mulmocast/beat-editor). Mixed scripts (any non-slide
// beat) fall back to the existing list. The debounce + flush-on-unmount live
// in the composable.
const { canEditBeats, deckScriptInput, deckSaveError, onDeckUpdate, flushPendingDeckSave, watchForeignWrites } = useDeckEditor({
  api,
  filePath,
  effectiveScript,
  commitScript,
});

/**
 * Which pane the beats are shown in.
 *
 * `edit` is the beat editor — every beat type, edited in place. `media` is the per-beat list,
 * which is the only place audio / image / movie generation lives. A script with nothing to edit
 * has only the list, so the switch is hidden and this is ignored.
 *
 * `media` is the default because opening the script is what triggers rendering each beat's
 * image: the auto-render on mount lives in that list, so defaulting to `edit` silently stopped
 * thumbnails from being produced at all. Someone who wants to edit clicks once; nobody has to
 * click to get the previews they always got.
 */
const beatPane = ref<"edit" | "media">("media");
const showBeatEditor = computed(() => canEditBeats.value && beatPane.value === "edit");

const BEAT_TAB_BASE = "rounded px-2 py-0.5 font-sans";
const beatPaneTabClass = (active: boolean) => [BEAT_TAB_BASE, active ? "bg-gray-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"];

// An agent (or another window) wrote this script — pull it back off disk so the preview shows
// what is actually there. Registered here rather than in the composable because reloading is
// the View's job; the composable only knows that someone else wrote.
const unsubscribeForeignWrites = watchForeignWrites(() => {
  void refreshScriptFromDisk();
});

// The editor takes and emits a beat array; the composable, the transport and the
// toolResult all speak whole scripts. `beatsOf` / `withBeats` are the conversion, and
// `withBeats` is what keeps presentationStyle / slideParams from being dropped on the
// way back — `{ ...script, beats }` loses them silently.
const deckBeats = computed<EditableBeat[]>(() => beatsOf(deckScriptInput.value));

function onDeckBeatsUpdate(beats: EditableBeat[]): void {
  onDeckUpdate(withBeats(deckScriptInput.value, beats));
}

/**
 * Leaving the editor writes whatever is still in the debounce.
 *
 * Asking the agent to change the script means moving focus out of here first, so this lands
 * ahead of every request without the host having to announce one — MulmoTerminal's agent is a
 * terminal, and there is no "sent" event to hook. The debounce is short enough that it has
 * usually fired already; this closes the case where it has not, which would otherwise have the
 * agent read a file missing the last thing the user typed.
 */
function onDeckFocusOut(event: FocusEvent): void {
  const container = event.currentTarget instanceof Node ? event.currentTarget : null;
  if (focusLeftContainer(container, event.relatedTarget)) flushPendingDeckSave();
}

onBeforeUnmount(() => {
  flushPendingDeckSave();
  // Release beat-clip blob object URLs — they outlive the component
  // otherwise (document-scoped, not GC'd with it).
  resetBeatMovies();
  unsubscribeGenerationEvents();
  unsubscribeForeignWrites();
});
const loadedSource = ref("");
const sourceChanged = computed(() => editableSource.value !== loadedSource.value);
const sourceValid = computed(() => {
  try {
    const parsed = JSON.parse(editableSource.value);
    return mulmoScriptSchema.safeParse(parsed).success;
  } catch {
    return false;
  }
});

async function onSourceToggle(open: boolean) {
  editing.value = open;
  if (open) {
    let text = scriptSourceText.value;
    // Re-read the current file from disk so beat-level edits made
    // since mount (other tabs, MCP, manual edits) surface in the
    // editor. Uses the reopen dispatch for the same reason
    // refreshScriptFromDisk does — `filePath.value` is the wire form
    // `stories/<rel>` and only the mulmoScript save/reopen op knows
    // how to map it to the on-disk path under `artifacts/stories/...`.
    if (filePath.value) {
      const response = await api.call("save", { filePath: filePath.value });
      const diskScript = response.ok ? (response.data.script as MulmoScript | undefined) : undefined;
      if (diskScript) text = toScriptSourceText(diskScript);
      // fall through to in-memory script on failure
    }
    editableSource.value = text;
    loadedSource.value = text;
  }
}

function cancelSourceEdit() {
  if (sourceDetails.value) sourceDetails.value.open = false;
}

async function applySource() {
  let parsed: MulmoScript;
  try {
    parsed = JSON.parse(editableSource.value);
  } catch (err) {
    alert(errorMessage(err));
    return;
  }
  const response = await api.call("updateScript", {
    filePath: filePath.value,
    script: parsed,
  });
  if (!response.ok) {
    alert(response.error || "Update failed");
    return;
  }

  // Update the UI with the new script. commitScript emits first so the parent
  // data is updated (its handleUpdateResult uses in-place Object.assign, so
  // the prop watcher won't fire), then we manually re-initialize the view.
  commitScript(parsed);

  if (sourceDetails.value) sourceDetails.value.open = false;
  await initializeScript();
}

async function copyText() {
  await copy(scriptSourceText.value);
}

function effectiveBeat(index: number): Beat {
  return effectiveBeatOf(localOverrides, beats.value, index);
}

function toggleSource(index: number) {
  if (!sourceOpen[index]) {
    sourceText[index] = toScriptSourceText(effectiveBeat(index));
    Reflect.deleteProperty(beatSaveErrors, index);
  }
  sourceOpen[index] = !sourceOpen[index];
}

function isValidBeat(index: number): boolean {
  return isValidBeatOf(sourceText[index], mulmoBeatSchema);
}

async function updateBeat(index: number) {
  let beat: Beat;
  try {
    // An absent slot parses as invalid JSON, landing on the same
    // `invalidJson` branch a genuinely malformed edit would.
    beat = JSON.parse(sourceText[index] ?? "");
  } catch (err) {
    beatSaveErrors[index] = { kind: "invalidJson", error: errorMessage(err) };
    return;
  }
  const prevImage = JSON.stringify(effectiveBeat(index).image);
  const prevText = effectiveBeat(index).text;

  const requestedFilePath = filePath.value;
  Reflect.deleteProperty(beatSaveErrors, index);
  beatSaving[index] = true;
  const response = await api.call("updateBeat", {
    filePath: requestedFilePath,
    beatIndex: index,
    beat,
  });
  if (staleSince(requestedFilePath)) return;
  Reflect.deleteProperty(beatSaving, index);
  if (!response.ok) {
    beatSaveErrors[index] = { kind: "saveFailed", error: response.error };
    return;
  }

  localOverrides[index] = beat;
  sourceOpen[index] = false;

  if (JSON.stringify(beat.image) !== prevImage) {
    Reflect.deleteProperty(renderedImages, index);
    renderBeat(index);
  }

  // Audio files are content-addressed by the beat's text
  // (getBeatAudioPathOrUrl hashes text + voice), so after a text edit
  // the cached data URI belongs to the OLD narration. Drop it so the
  // "Generate Audio" button reappears, then re-probe — if the new text
  // matches previously generated audio (e.g. the edit was a revert),
  // the probe restores Play without a paid TTS call.
  if (beat.text !== prevText) {
    // If this beat's old narration is mid-playback, stop it first —
    // the deletes below remove the Play/Stop control from the row,
    // which would otherwise leave the stale audio playing with no
    // way to stop it (Codex review on #2143).
    if (playingAudio.value?.index === index) stopAllPlayback();
    Reflect.deleteProperty(beatAudios, index);
    Reflect.deleteProperty(audioState, index);
    Reflect.deleteProperty(audioErrors, index);
    if (beat.text) void loadExistingBeatAudio(index);
  }
}

async function renderBeat(index: number) {
  const requestedFilePath = filePath.value;
  renderState[index] = "rendering";
  const response = await api.call("renderBeat", {
    filePath: requestedFilePath,
    beatIndex: index,
    chatSessionId: chatSessionId.value,
  });
  if (staleSince(requestedFilePath)) return;
  if (!response.ok) {
    renderErrors[index] = response.error || "Render failed";
    renderState[index] = "error";
    return;
  }
  renderedImages[index] = response.data.image ?? "";
  renderState[index] = "done";
  refreshMissingCharacterImages();
  if (beatMayHaveMovie(effectiveBeat(index))) void loadExistingBeatMovie(index);
}

async function regenerateBeat(index: number) {
  const requestedFilePath = filePath.value;
  Reflect.deleteProperty(renderedImages, index);
  invalidateBeatMovie(index);
  renderState[index] = "rendering";
  const response = await api.call("renderBeat", {
    filePath: requestedFilePath,
    beatIndex: index,
    force: true,
    chatSessionId: chatSessionId.value,
  });
  if (staleSince(requestedFilePath)) return;
  if (!response.ok) {
    renderErrors[index] = response.error || "Render failed";
    renderState[index] = "error";
    return;
  }
  renderedImages[index] = response.data.image ?? "";
  renderState[index] = "done";
  if (beatMayHaveMovie(effectiveBeat(index))) void loadExistingBeatMovie(index);
}

// Stale-response guard shared by every per-beat/character loader and
// mutator below: capture the wire path at call time and discard the
// response when the user has navigated to a different result meanwhile —
// otherwise late responses from script A's bulk mount-time probes would
// write into the per-beat maps that now belong to script B.
function staleSince(requestedFilePath: string): boolean {
  return staleSinceOf(filePath.value, requestedFilePath);
}

async function loadExistingBeatImage(index: number) {
  const requestedFilePath = filePath.value;
  const response = await api.call("beatImage", { filePath: requestedFilePath, beatIndex: index });
  if (staleSince(requestedFilePath)) return;
  // silently ignore errors — image simply hasn't been generated yet
  if (response.ok && response.data.image) {
    renderedImages[index] = response.data.image;
    renderState[index] = "done";
  }
}

async function loadExistingBeatAudio(index: number) {
  const requestedFilePath = filePath.value;
  const response = await api.call("beatAudio", { filePath: requestedFilePath, beatIndex: index });
  if (staleSince(requestedFilePath)) return;
  // silently ignore errors
  if (response.ok && response.data.audio) {
    beatAudios[index] = response.data.audio;
    audioState[index] = "done";
  }
}

async function generateAudio(index: number) {
  const requestedFilePath = filePath.value;
  audioState[index] = "generating";
  Reflect.deleteProperty(audioErrors, index);
  const response = await api.call("generateBeatAudio", {
    filePath: requestedFilePath,
    beatIndex: index,
    chatSessionId: chatSessionId.value,
  });
  if (staleSince(requestedFilePath)) return;
  if (!response.ok) {
    audioErrors[index] = response.error || "Audio generation failed";
    audioState[index] = "error";
    return;
  }
  beatAudios[index] = response.data.audio ?? "";
  audioState[index] = "done";
}

function playAudio(index: number) {
  if (playingAudio.value) {
    playingAudio.value.audio.pause();
    const wasIndex = playingAudio.value.index;
    playingAudio.value = null;
    if (wasIndex === index) return;
  }
  const src = beatAudios[index];
  if (!src) return;
  const audio = new Audio(src);
  playingAudio.value = { index, audio };
  audioProgress.value = 0;
  audio.addEventListener("timeupdate", () => {
    if (playingAudio.value?.index !== index) return;
    if (audio.duration > 0) audioProgress.value = audio.currentTime / audio.duration;
  });
  audio.addEventListener("ended", () => {
    if (playingAudio.value?.index !== index) return;
    playingAudio.value = null;
    audioProgress.value = 0;
    if (lightbox.value?.index === index) advanceFromBeat(index);
  });
  audio.play();
}

function onBeatDragOver(event: DragEvent, index: number) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  beatDragOver[index] = true;
}

function onBeatDragLeave(index: number) {
  beatDragOver[index] = false;
}

async function onBeatDrop(event: DragEvent, index: number) {
  event.preventDefault();
  beatDragOver[index] = false;
  const file = event.dataTransfer?.files[0];
  if (!file || !file.type.startsWith("image/")) return;

  renderState[index] = "rendering";
  Reflect.deleteProperty(renderErrors, index);
  let imageData: string;
  try {
    imageData = await readFileAsDataUrl(file);
  } catch (err) {
    renderErrors[index] = errorMessage(err);
    renderState[index] = "error";
    return;
  }
  const requestedFilePath = filePath.value;
  const response = await api.call("uploadBeatImage", {
    filePath: requestedFilePath,
    beatIndex: index,
    imageData,
  });
  if (staleSince(requestedFilePath)) return;
  if (!response.ok) {
    renderErrors[index] = response.error || "Upload failed";
    renderState[index] = "error";
    return;
  }
  renderedImages[index] = response.data.image ?? "";
  renderState[index] = "done";
}

function openCharacterLightbox(key: string) {
  // Stop both audio and silent timer — character lightbox is
  // outside the play loop (#1073).
  stopAllPlayback();
  lightbox.value = {
    src: charImages[key] ?? "",
    text: key,
    index: -1,
    isCharacter: true,
  };
}

// Probe the server for an existing beat PNG before triggering any
// generation. Only auto-renders when the disk is empty AND the beat
// is a deterministic type — imagePrompt beats are left empty so the
// user clicks Generate explicitly (avoids surprise paid text2image
// calls on every page refresh).
async function hydrateBeatImage(beat: Beat, index: number, hasCharacters: boolean, autoRenderTypes: readonly string[]): Promise<void> {
  await loadExistingBeatImage(index);
  if (renderedImages[index]) return;
  if (shouldAutoRenderBeat(beat, hasCharacters, autoRenderTypes)) {
    await renderBeat(index);
  }
}

/**
 * #1074 — keep the in-memory toolResult in sync with the on-disk
 * script file. `updateBeat` / `updateScript` persist edits to
 * disk, but the session entry that backs
 * `props.selectedResult.data.script` is never rewritten, so a
 * page reload + session-restore would otherwise surface stale
 * pre-edit content.
 *
 * Why the reopen dispatch, not a generic file read: `filePath`
 * is the wire form `stories/<rel>` which only the mulmoScript save
 * op knows how to translate back to the real on-disk path under
 * `artifacts/stories/...`. The reopen op is read-only when `script`
 * is omitted; it does NOT trigger movie generation.
 *
 * The flow silently bails on every failure mode so a missing /
 * malformed / deleted script file never blocks the rest of
 * `initializeScript`.
 *
 * Stale-response guard: capture `uuid` + `filePath` before the
 * `await`. If either has changed by the time the response lands
 * (the user navigated to a different result while the request
 * was in flight, or `props.selectedResult` was swapped under us
 * by a parent watcher), drop the response on the floor — the new
 * `initializeScript` invocation triggered by that change will
 * issue its own refresh against the correct file.
 */
async function refreshScriptFromDisk(): Promise<void> {
  const requestedFilePath = filePath.value;
  if (!requestedFilePath) return;
  const requestedUuid = props.selectedResult.uuid;
  const response = await api.call("save", { filePath: requestedFilePath });
  if (props.selectedResult.uuid !== requestedUuid || filePath.value !== requestedFilePath) return;
  if (!response.ok) return;
  const diskScript = response.data.script as MulmoScript | undefined;
  // The server-side reopen op already validated against
  // `mulmoScriptSchema`, so a non-null `script` is trusted here —
  // we only need a presence check.
  if (!diskScript) return;
  if (isSameScript(diskScript, script.value)) return;
  commitScript(diskScript);
}

async function initializeScript() {
  // Stop any in-flight playback BEFORE we tear down per-script state
  // — a pending `silentPlaybackTimer` or running audio from the
  // previous script would otherwise fire `advanceFromBeat()` against
  // the new script's lightbox / beat list and either crash or
  // silently jump the new presentation forward. Also close any open
  // lightbox so the user lands on the clean View for the new result
  // (Codex review iter-4 on #1365).
  stopAllPlayback();
  lightbox.value = null;
  // Reset scroll position so new results start at the top
  if (beatListEl.value) beatListEl.value.scrollTop = 0;
  // Reset per-script state. resetMedia clears the movie/PDF spinners too —
  // per-script, so switching away from a generating script doesn't leave the
  // new script's toolbar spinning; the pendingGenerations snapshot below
  // re-lights them when the NEW script really does have work in flight.
  clearReactiveRecords(
    renderState,
    renderedImages,
    renderErrors,
    sourceOpen,
    sourceText,
    beatSaveErrors,
    beatSaving,
    localOverrides,
    beatAudios,
    audioState,
    audioErrors,
    beatDragOver,
  );
  resetCharacters();
  resetBeatMovies();
  resetMedia();
  if (sourceDetails.value) sourceDetails.value.open = false;

  // #1074 — re-read the script file from disk before per-beat
  // hydration. When the user switches between tool results inside
  // the same SPA mount and switches back, the in-memory toolResult
  // still carries whatever script was captured earlier, and
  // `localOverrides` (the only thing showing the user's edit since
  // the last save) is reset by initializeScript on remount.
  // Re-fetching from disk via the reopen op covers that gap.
  await refreshScriptFromDisk();

  // Mount-time policy: prefer the existing PNG on the server. Every
  // beat — deterministic AND imagePrompt — first probes beatImage,
  // and we only fall through to renderBeat() when the disk has nothing
  // yet AND the type is safe to auto-render (deterministic content,
  // no characters waiting). Without this probe a refresh would re-fire
  // generateBeatImage for every beat, and for imagePrompt beats that
  // means a paid text2image call against an image we already have.
  //
  // Stale-after-edit: if the user edits the script source the on-disk
  // PNG is no longer in sync with the new content, but we don't try to
  // detect that here — the per-beat ↺ button is one click away and a
  // page refresh re-runs this same probe, so the user can opt back into
  // a fresh render whenever they need to.
  const AUTO_RENDER_TYPES = ["textSlide", "markdown", "chart", "mermaid", "html_tailwind", "slide"] as const;
  const hasCharacters = characterKeys.value.length > 0;
  beats.value.forEach((beat, index) => {
    void hydrateBeatImage(beat, index, hasCharacters, AUTO_RENDER_TYPES);
    if (beat.text) loadExistingBeatAudio(index);
    if (beatMayHaveMovie(beat)) void loadExistingBeatMovie(index);
  });

  characterKeys.value.forEach((key) => loadExistingCharacterImage(key));

  if (filePath.value) {
    // Stale-response guard: if the user navigates to a different result
    // while these calls are in flight, their answers describe the OLD
    // script — drop them instead of stamping them onto the new one.
    const requestedFilePath = filePath.value;
    const isStale = () => filePath.value !== requestedFilePath;

    const response = await api.call("movieStatus", { filePath: requestedFilePath });
    if (isStale()) return;
    if (response.ok && response.data.moviePath) {
      moviePath.value = response.data.moviePath;
    }
    // ignore errors
    // Also check whether a PDF was previously generated and is still
    // newer than the source; status returns null otherwise so the UI
    // re-offers the Generate button.
    const pdfResponse = await api.call("pdfStatus", { filePath: requestedFilePath });
    if (isStale()) return;
    if (pdfResponse.ok && pdfResponse.data.pdfPath) {
      pdfPath.value = pdfResponse.data.pdfPath;
    }

    // Reflect any generations that were already in flight when we
    // mounted (user switched away mid-generation and came back).
    // Snapshot via dispatch; live updates arrive on the pubsub
    // subscription below.
    const pending = await api.call("pendingGenerations", { filePath: requestedFilePath });
    if (isStale()) return;
    if (pending.ok) {
      for (const entry of pending.data.pending) {
        reflectGenerationStart(entry);
      }
    }
  }
}

onMounted(initializeScript);
watch(() => props.selectedResult, initializeScript);

// Keep the view in sync with generations running anywhere — this View's
// own long-held dispatches, a parallel tab, the agent's background
// autoGenerateMovie. The host publishes `generation` events on the
// plugin pubsub channel (started + finished, per beat and per artifact);
// on start we mirror the local "rendering" state so spinners show even
// after a remount, on finish we reload the relevant asset off disk.
const unsubscribeGenerationEvents = api.onGenerationEvent({
  filePath: () => filePath.value,
  // The View is opened from the host's default root today; step 2 gives it a
  // root of its own. Written out rather than left to a default so the pair
  // filter is visible at the call site (#3014).
  root: () => undefined,
  handler: (event) => {
    if (!event.done) {
      reflectGenerationStart(event);
      return;
    }
    // Fire-and-forget: swallow + log so a failed reload doesn't
    // surface as an unhandled rejection.
    reflectGenerationFinish(event).catch((err) => {
      console.error("[presentMulmoScript] reload on finish failed:", err);
    });
  },
});

function reflectGenerationStart(entry: MulmoScriptGenerationEvent): void {
  if (entry.kind === "beatImage") {
    const idx = Number(entry.key);
    if (!renderedImages[idx]) renderState[idx] = "rendering";
  } else if (entry.kind === "beatAudio") {
    const idx = Number(entry.key);
    if (!beatAudios[idx]) audioState[idx] = "generating";
  } else if (entry.kind === "characterImage") {
    if (!charImages[entry.key]) charRenderState[entry.key] = "rendering";
  } else if (entry.kind === "movie") {
    movieGenerating.value = true;
  } else if (entry.kind === "pdf") {
    pdfGenerating.value = true;
  }
}

async function reflectGenerationFinish(entry: MulmoScriptGenerationEvent): Promise<void> {
  if (entry.kind === "beatImage") {
    const idx = Number(entry.key);
    await loadExistingBeatImage(idx);
    if (beatMayHaveMovie(effectiveBeat(idx))) await loadExistingBeatMovie(idx);
    if (renderState[idx] === "rendering") Reflect.deleteProperty(renderState, idx);
    refreshMissingCharacterImages();
  } else if (entry.kind === "beatAudio") {
    const idx = Number(entry.key);
    await loadExistingBeatAudio(idx);
    if (audioState[idx] === "generating") Reflect.deleteProperty(audioState, idx);
  } else if (entry.kind === "characterImage") {
    await loadExistingCharacterImage(entry.key);
    if (charRenderState[entry.key] === "rendering") {
      Reflect.deleteProperty(charRenderState, entry.key);
    }
  } else if (entry.kind === "movie") {
    movieGenerating.value = false;
    await refreshMoviePath();
  } else if (entry.kind === "pdf") {
    pdfGenerating.value = false;
    await refreshPdfPath();
  }
}
</script>

<style scoped>
.bottom-bar-wrapper {
  position: relative;
  flex-shrink: 0;
}

.script-source {
  padding: 0.5rem;
  background: #f5f5f5;
  border-top: 1px solid #e0e0e0;
  font-family: Consolas, "MS Gothic", "BIZ UDGothic", monospace;
  font-size: 0.85rem;
}

.script-source summary {
  cursor: pointer;
  user-select: none;
  padding: 0.5rem;
  background: #e8e8e8;
  border-radius: 4px;
  font-weight: 500;
  color: #333;
}

.script-source[open] summary {
  margin-bottom: 0.5rem;
}

.script-source summary:hover {
  background: #d8d8d8;
}

.script-editor {
  width: 100%;
  height: 40vh;
  padding: 1rem;
  background: #ffffff;
  border: 1px solid #ccc;
  border-radius: 4px;
  color: #333;
  font-family: "Courier New", "MS Gothic", "BIZ UDGothic", monospace;
  font-size: 0.9rem;
  resize: vertical;
  margin-bottom: 0.5rem;
  line-height: 1.5;
}

.script-editor:focus {
  outline: none;
  border-color: #4caf50;
  box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.1);
}

.script-editor-invalid {
  border-color: #ef4444;
}

.script-editor-invalid:focus {
  border-color: #ef4444;
  box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.1);
}

.editor-actions {
  display: flex;
  justify-content: space-between;
}

.apply-btn {
  padding: 0.5rem 1rem;
  background: #4caf50;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: background 0.2s;
  font-weight: 500;
}

.apply-btn:hover {
  background: #45a049;
}

.apply-btn:disabled {
  background: #cccccc;
  color: #666666;
  cursor: not-allowed;
  opacity: 0.6;
}

.cancel-btn {
  padding: 0.5rem 1rem;
  background: #e0e0e0;
  color: #333;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: background 0.2s;
  font-weight: 500;
}

.cancel-btn:hover {
  background: #d0d0d0;
}

.copy-btn {
  position: absolute;
  bottom: 0.3rem;
  right: 0.65rem;
  padding: 0.4rem;
  background: none;
  border: none;
  color: #333;
  cursor: pointer;
  z-index: 1;
}

.copy-btn:hover {
  color: #000;
}

.copy-btn .material-icons {
  font-size: 1.15rem;
}
</style>
