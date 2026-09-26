<template>
  <!-- File drop is handled at the chat panel level (#1289 Step 2)
       so the user can drop anywhere over the panel + messages, not
       just over the input box. ChatInput still owns `readFile` for
       the dropped file — App.vue calls it via the exposed method
       once the panel-wide drop fires. -->
  <div class="border-t border-gray-200">
    <SuggestionsPanel
      v-model:expanded="suggestionsExpanded"
      :queries="queries"
      :trigger-ref="suggestionsBtnRef"
      @send="onSuggestionSend"
      @edit="onSuggestionEdit"
    />
    <div class="p-2 relative">
      <SlashCommandMenu
        v-if="slashMenuOpen"
        :items="slashItems"
        :highlighted-index="slashHighlightedIndex"
        @select="selectSlashSkill"
        @hover="slashMenu.setHighlight($event)"
      />
      <div v-if="fileError" class="mb-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-1.5" data-testid="file-error">
        {{ fileError }}
      </div>
      <div v-if="pastedFiles.length > 0" class="flex flex-wrap gap-1.5 mb-1" data-testid="chat-attachment-list">
        <ChatAttachmentPreview
          v-for="(file, index) in pastedFiles"
          :key="file.name + index"
          :data-url="file.dataUrl"
          :preview-data-url="file.previewDataUrl"
          :filename="file.name"
          :mime="file.mime"
          @remove="removeFileAt(index)"
        />
      </div>
      <!-- Messages sent while the agent is running queue here instead of
           going out immediately; they merge back into the input for a
           final edit + send once the run finishes (App.vue owns the
           merge). Each chip is removable so a queued line can be dropped
           before it comes back. -->
      <div v-if="bufferedMessages.length > 0" class="flex flex-col gap-1 mb-1" data-testid="buffered-message-list">
        <div
          v-for="(message, index) in bufferedMessages"
          :key="index"
          class="flex items-center gap-1.5 bg-blue-50 border border-blue-200 rounded px-2 py-1 text-xs text-gray-700"
          data-testid="buffered-message"
        >
          <span class="material-icons text-sm leading-none text-blue-400">schedule</span>
          <span class="flex-1 truncate" :title="message">{{ message }}</span>
          <button
            type="button"
            class="text-gray-400 hover:text-red-600 shrink-0 flex items-center"
            :title="t('chatInput.removeBuffered')"
            :aria-label="t('chatInput.removeBuffered')"
            data-testid="buffered-message-remove"
            @click="removeBufferedAt(index)"
          >
            <span class="material-icons text-sm leading-none">close</span>
          </button>
        </div>
      </div>
      <div class="flex gap-2" :class="{ 'mt-2': pastedFiles.length > 0 }">
        <textarea
          ref="textarea"
          :value="modelValue"
          data-testid="user-input"
          :placeholder="placeholder"
          rows="2"
          class="flex-1 bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 placeholder-gray-400 resize-none"
          @input="onInput"
          @compositionstart="imeEnter.onCompositionStart"
          @compositionend="imeEnter.onCompositionEnd"
          @keydown="onKeydown"
          @blur="onBlur"
          @paste="onPasteFile"
        />
        <div class="flex flex-col gap-1">
          <button
            ref="suggestionsBtnRef"
            data-testid="suggestions-btn"
            class="rounded w-8 h-8 flex items-center justify-center"
            :class="suggestionsExpanded ? 'text-blue-600 bg-blue-50' : 'text-gray-400 hover:text-gray-600'"
            :title="t('suggestionsPanel.tooltip')"
            :aria-label="t('suggestionsPanel.tooltip')"
            @click="suggestionsExpanded = !suggestionsExpanded"
          >
            <span class="material-icons text-base leading-none">lightbulb</span>
          </button>
          <button
            v-if="isRunning"
            data-testid="stop-btn"
            class="bg-red-600 hover:bg-red-700 text-white rounded w-8 h-8 flex items-center justify-center"
            :title="t('chatInput.stop')"
            :aria-label="t('chatInput.stop')"
            @click="emit('stop')"
          >
            <span class="material-icons text-base leading-none">stop</span>
          </button>
          <button
            v-else
            data-testid="send-btn"
            class="bg-blue-600 hover:bg-blue-700 text-white rounded w-8 h-8 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            :title="t('chatInput.send')"
            :aria-label="t('chatInput.send')"
            @click="emit('send')"
          >
            <span class="material-icons text-base leading-none">send</span>
          </button>
          <button
            data-testid="attach-file-btn"
            class="text-gray-400 hover:text-gray-600 rounded w-8 h-8 flex items-center justify-center"
            :title="t('chatInput.attachFile')"
            :aria-label="t('chatInput.attachFile')"
            @click="openFilePicker"
          >
            <span class="material-icons text-base leading-none">attach_file</span>
          </button>
          <!-- Toggle mic. Hidden unless the backend reports voice input
               ready (Mac + enabled + model downloaded). Click to arm
               voice input for the session: it listens on the user's
               turn, pauses while the agent runs, and auto-resumes each
               turn until clicked off. Each pause finalizes a segment
               that is transcribed and appended for review (never
               auto-sent). -->
          <button
            v-if="voiceAvailable"
            data-testid="mic-btn"
            class="rounded w-8 h-8 flex items-center justify-center"
            :class="micButtonClass"
            :title="micButtonLabel"
            :aria-label="micButtonLabel"
            @click="onMicClick"
          >
            <span class="material-icons text-base leading-none">{{ micButtonIcon }}</span>
          </button>
        </div>
      </div>

      <!-- Hidden file input driven by the attach button. No `accept`
           filter: a type we cannot read still attaches as a file. The
           change handler routes through the same processFiles() used by
           drop + paste, so all three paths behave identically. -->
      <input ref="fileInput" type="file" multiple class="hidden" data-testid="file-input" @change="onFilePicked" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, toRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useVoiceInput } from "../composables/useVoiceInput";
import ChatAttachmentPreview from "./ChatAttachmentPreview.vue";
import SlashCommandMenu from "./SlashCommandMenu.vue";
import SuggestionsPanel from "./SuggestionsPanel.vue";
import { useImeAwareEnter } from "../composables/useImeAwareEnter";
import { useSkillsList, type SkillSummary } from "../composables/useSkillsList";
import { useSlashCommandMenu, handleSlashMenuKeydown } from "../composables/useSlashCommandMenu";
import type { PastedFile } from "../types/pastedFile";
import { buildHeicPreviewDataUrl, needsBrowserPreviewConversion } from "../utils/attachment/heicPreview";

export type { PastedFile };

const { t, locale } = useI18n();

const props = withDefaults(
  defineProps<{
    modelValue: string;
    pastedFiles: PastedFile[];
    isRunning: boolean;
    /** Messages queued while the agent runs. Rendered as removable chips
     *  above the input; App.vue merges them back into `modelValue` when
     *  the run finishes. */
    bufferedMessages?: string[];
    queries?: string[];
    /** Currently displayed session id. Voice "armed" state is reset
     *  whenever this changes so leaving a session and coming back
     *  starts with the mic off (the state is in-memory only — never
     *  persisted). */
    sessionId?: string;
  }>(),
  { bufferedMessages: () => [], queries: () => [], sessionId: "" },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:pastedFiles": [files: PastedFile[]];
  "update:bufferedMessages": [messages: string[]];
  send: [];
  stop: [];
  "suggestion-send": [query: string];
}>();

const placeholder = computed(() => (props.isRunning ? t("chatInput.runningPlaceholder") : t("chatInput.placeholder")));

function removeBufferedAt(index: number): void {
  emit(
    "update:bufferedMessages",
    props.bufferedMessages.filter((_, i) => i !== index),
  );
}

// Local voice input (Mac-only). The mic button is hidden unless the
// backend reports voice input ready; transcripts are appended to the
// input for review, never auto-sent. See plans/done/feat-voice-input.md.
function insertTranscript(text: string): void {
  const current = props.modelValue;
  const next = current.trim().length > 0 ? `${current.trimEnd()} ${text}` : text;
  emit("update:modelValue", next);
}

const {
  available: voiceAvailable,
  listening: voiceListening,
  transcribing: voiceTranscribing,
  start: startVoice,
  stop: stopVoice,
  refreshAvailability: refreshVoiceAvailability,
} = useVoiceInput({
  locale: () => locale.value,
  onTranscript: insertTranscript,
});

// Sticky per-session voice intent. Once the user turns the mic on it
// stays "armed" for the session: capture pauses while the agent is
// running (isRunning) and auto-resumes when it's the user's turn again.
// The button toggles this intent; turning it off stops auto-resume.
const voiceSessionOn = ref(false);

function onMicClick(): void {
  voiceSessionOn.value = !voiceSessionOn.value;
}

const micButtonClass = computed(() => {
  if (voiceSessionOn.value) return voiceListening.value ? "bg-red-600 text-white animate-pulse" : "bg-red-600 text-white";
  return voiceTranscribing.value ? "text-blue-500" : "text-gray-400 hover:text-gray-600";
});
const micButtonIcon = computed(() => (!voiceSessionOn.value && voiceTranscribing.value ? "hourglass_top" : "mic"));
const micButtonLabel = computed(() => (voiceSessionOn.value ? t("chatInput.voice.stop") : t("chatInput.voice.start")));

// Disarm when the displayed session changes — voice intent is per
// session and never persisted, so leaving and returning starts off.
watch(
  () => props.sessionId,
  () => {
    voiceSessionOn.value = false;
  },
);

// Drive listening from (intent ∧ available ∧ not the agent's turn).
// Auto-starts when armed and it becomes the user's turn; pauses when
// the agent starts running; drops the intent if the mic can't start
// (permission denied) so it doesn't retry every turn.
function wantsToListen(): boolean {
  return voiceSessionOn.value && voiceAvailable.value && !props.isRunning;
}

watch([voiceSessionOn, () => props.isRunning, voiceAvailable], () => {
  if (wantsToListen() && !voiceListening.value) {
    startVoice()
      .then((ok) => {
        if (!ok) {
          voiceSessionOn.value = false;
          return;
        }
        // `startVoice()` awaits mic permission; the state may have flipped
        // (session switch / toggled off / agent started) while we waited.
        // The watcher won't re-fire for that, so re-check here and stop a
        // start that's now stale rather than record in the wrong state.
        if (!wantsToListen()) stopVoice();
      })
      .catch(() => undefined);
  } else if (!wantsToListen() && voiceListening.value) {
    stopVoice();
  }
});

onMounted(() => {
  void refreshVoiceAvailability();
});

const textarea = ref<HTMLTextAreaElement | null>(null);
const fileError = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const suggestionsExpanded = ref(false);
const suggestionsBtnRef = ref<HTMLButtonElement | null>(null);

const MAX_ATTACH_BYTES = 30 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

function validateFile(file: File): string | null {
  if (file.size > MAX_ATTACH_BYTES) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    return t("chatInput.fileTooLarge", { sizeMB });
  }
  return null;
}

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function clampToSlots(files: File[]): File[] {
  const remainingSlots = MAX_ATTACHMENTS - props.pastedFiles.length;
  if (files.length > remainingSlots) {
    fileError.value = t("chatInput.tooManyFiles", { max: MAX_ATTACHMENTS });
  }
  return remainingSlots <= 0 ? [] : files.slice(0, remainingSlots);
}

function findFirstValidationError(files: File[]): string | null {
  return files.reduce<string | null>((err, file) => err ?? validateFile(file), null);
}

function emitClampedFiles(valid: PastedFile[]): void {
  const slotsNow = MAX_ATTACHMENTS - props.pastedFiles.length;
  const clamped = slotsNow < valid.length ? valid.slice(0, Math.max(0, slotsNow)) : valid;
  if (clamped.length > 0) {
    emit("update:pastedFiles", [...props.pastedFiles, ...clamped]);
  }
  if (clamped.length < valid.length) {
    fileError.value = t("chatInput.tooManyFiles", { max: MAX_ATTACHMENTS });
  }
}

let fileQueue = Promise.resolve();

async function processFiles(files: File[]): Promise<void> {
  fileError.value = null;
  const accepted = clampToSlots(files);
  if (accepted.length === 0) return;

  const firstError = findFirstValidationError(accepted);
  if (firstError) {
    fileError.value = firstError;
    return;
  }

  const pending = accepted.map(async (file): Promise<PastedFile | null> => {
    const dataUrl = await readFileAsDataUrl(file);
    if (!dataUrl) return null;
    // Browser-side HEIC/HEIF conversion only affects the preview
    // chip's <img src>. The original `dataUrl` still travels to the
    // upload endpoint unchanged — server-side heic-convert produces
    // the JPEG the LLM reads. Failed conversion → previewDataUrl
    // stays absent and the chip falls back to a file icon.
    const preview = needsBrowserPreviewConversion(file.type) ? await buildHeicPreviewDataUrl(file) : null;
    return {
      dataUrl,
      name: file.name,
      mime: file.type,
      ...(preview ? { previewDataUrl: preview } : {}),
    };
  });

  try {
    const results = await Promise.all(pending);
    const valid = results.filter((result): result is PastedFile => result !== null);
    if (valid.length > 0) emitClampedFiles(valid);
  } catch {
    fileError.value = t("chatInput.readFileFailed");
  }

  await nextTick();
}

function addFiles(files: File[]): void {
  fileQueue = fileQueue.then(() => processFiles(files));
}

function removeFileAt(index: number): void {
  const updated = props.pastedFiles.filter((_, i) => i !== index);
  emit("update:pastedFiles", updated);
}

function onPasteFile(event: ClipboardEvent): void {
  const items = event.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    event.preventDefault();
    addFiles(files);
  }
}

function openFilePicker(): void {
  fileInput.value?.click();
}

function onFilePicked(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const files = input.files ? Array.from(input.files) : [];
  if (files.length > 0) addFiles(files);
  input.value = "";
}

watch(
  () => props.pastedFiles.length,
  (len) => {
    if (len === 0) fileError.value = null;
  },
);

const imeEnter = useImeAwareEnter(() => emit("send"));

// Inline "/" command palette. Shares the lightbulb Skills tab's data store;
// owns only open/filter/highlight state here, with the keyboard interception
// below running ahead of `imeEnter` so Enter selects instead of sending.
const { skills, refresh: refreshSkills } = useSkillsList();
const slashMenu = useSlashCommandMenu(toRef(props, "modelValue"), () => skills.value);
const slashMenuOpen = slashMenu.isOpen;
const slashItems = slashMenu.items;
const slashHighlightedIndex = slashMenu.highlightedIndex;

// Refresh the skill list each time the menu first opens (cheap, dedup'd) so a
// skill added since boot shows up; collapse the lightbulb panel so the two
// menus are never open at once.
watch(
  () => slashMenu.query.value,
  (query, prev) => {
    if (query !== null && prev === null) void refreshSkills();
  },
);
watch(slashMenuOpen, (open) => {
  if (open) suggestionsExpanded.value = false;
});

function onInput(event: Event): void {
  const { target } = event;
  if (target instanceof HTMLTextAreaElement) emit("update:modelValue", target.value);
}

function onKeydown(event: KeyboardEvent): void {
  // Ctrl/Cmd+Enter inserts a newline instead of sending. Checked before the
  // slash menu so the chord still works while a skill is highlighted (the
  // menu's Enter handler would otherwise select it). A textarea does not
  // insert on this chord natively, so we splice it in at the caret.
  if (isNewlineChord(event)) {
    event.preventDefault();
    insertNewlineAtCursor();
    return;
  }
  if (slashMenuOpen.value && handleSlashMenuKeydown(slashMenu, event, { isImeConfirmation: imeEnter.isImeConfirmation, onSelect: selectSlashSkill })) {
    return;
  }
  imeEnter.onKeydown(event);
}

function isNewlineChord(event: KeyboardEvent): boolean {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey) && !imeEnter.isImeConfirmation(event);
}

function insertNewlineAtCursor(): void {
  const field = textarea.value;
  const value = props.modelValue;
  const start = field?.selectionStart ?? value.length;
  const end = field?.selectionEnd ?? start;
  emit("update:modelValue", `${value.slice(0, start)}\n${value.slice(end)}`);
  nextTick(() => {
    const caret = start + 1;
    field?.focus();
    field?.setSelectionRange(caret, caret);
  });
}

// Selection populates `/<name> ` (trailing space dismisses the menu via the
// no-bare-token rule and lets the user type arguments) — it never sends.
function selectSlashSkill(skill: SkillSummary): void {
  emit("update:modelValue", `/${skill.name} `);
  nextTick(() => {
    const field = textarea.value;
    field?.focus();
    if (field) field.setSelectionRange(field.value.length, field.value.length);
  });
}

function onBlur(): void {
  imeEnter.onBlur();
  slashMenu.dismiss();
}

function onSuggestionSend(query: string): void {
  emit("suggestion-send", query);
}

function onSuggestionEdit(query: string): void {
  emit("update:modelValue", query);
  nextTick(() => textarea.value?.focus());
}

function focus(): void {
  textarea.value?.focus();
}

function collapseSuggestions(): void {
  suggestionsExpanded.value = false;
}

defineExpose({ focus, collapseSuggestions, addFiles, refreshVoiceAvailability });
</script>
