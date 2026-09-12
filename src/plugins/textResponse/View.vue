<template>
  <!-- Plugin-seeded first user turn (e.g. Encore): mirror the skill
       plugin's collapsed-card layout. Skips the assistant chrome
       (PDF / edit / copy) since the message wasn't authored by the
       user and editing it post-hoc has no meaning. -->
  <div v-if="isSeededUserTurn" class="h-full flex flex-col overflow-y-auto p-6" data-testid="text-response-seeded-card">
    <div class="max-w-3xl mx-auto w-full">
      <div class="rounded-lg border border-purple-200 bg-purple-50 shadow-sm">
        <details class="group">
          <summary class="cursor-pointer list-none p-4 flex items-start gap-3 hover:bg-purple-100/40 rounded-lg" data-testid="text-response-seeded-summary">
            <span class="material-icons text-purple-600 text-base mt-0.5 shrink-0">extension</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-baseline gap-2 flex-wrap">
                <span class="font-medium text-purple-900">{{ t("pluginTextResponse.seededByPlugin", { pkg: seededByPlugin }) }}</span>
              </div>
              <div class="text-sm text-gray-700 mt-1">{{ t("pluginTextResponse.seededByPluginTooltip", { pkg: seededByPlugin }) }}</div>
            </div>
            <span class="material-icons text-gray-400 text-base shrink-0 group-open:rotate-180 transition-transform">expand_more</span>
          </summary>
          <div class="border-t border-purple-200 p-4 bg-white rounded-b-lg">
            <div
              v-if="truncationInfo.wasTruncated"
              class="mb-3 p-3 rounded border border-amber-300 bg-amber-50 text-amber-900 text-sm"
              data-testid="text-response-seeded-truncation-banner"
            >
              {{
                t("pluginTextResponse.truncatedForRender", {
                  omitted: truncationInfo.omittedChars.toLocaleString(locale),
                  total: truncationInfo.originalChars.toLocaleString(locale),
                })
              }}
            </div>
            <!-- eslint-disable vue/no-v-html -- marked.parse output of the plugin-seeded prompt; trusted in-process render matching the standard textResponse path. Multi-line element so disable/enable pair (CLAUDE.md UI rule). -->
            <div
              ref="markdownContainerRef"
              class="markdown-content prose prose-slate max-w-none"
              translate="yes"
              @click="openLinksInNewTab"
              v-html="renderedHtml"
            ></div>
            <!-- eslint-enable vue/no-v-html -->
            <div v-if="messageAttachments.length > 0" class="space-y-3 mt-3" data-testid="text-response-seeded-attachments">
              <SentAttachmentChip v-for="file in messageAttachments" :key="file.path" :path="file.path" :filename="file.filename" variant="block" />
            </div>
          </div>
        </details>
      </div>
    </div>
  </div>
  <div v-else class="h-full flex flex-col">
    <div v-if="isAssistant" class="flex items-center justify-end gap-2 px-3 py-2 border-b border-gray-100 shrink-0">
      <button
        class="h-8 px-2.5 flex items-center gap-1 rounded bg-green-600 hover:bg-green-700 text-white text-sm disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        :disabled="pdfDownloading"
        data-testid="text-response-pdf-button"
        @click="downloadPdf"
      >
        <span class="material-icons text-base">{{ pdfDownloading ? "hourglass_empty" : "download" }}</span>
        {{ t("pluginTextResponse.pdf") }}
      </button>
      <button
        class="h-8 px-2.5 flex items-center gap-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 text-sm disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        :disabled="zipDownloading"
        data-testid="text-response-zip-button"
        @click="downloadZipFile"
      >
        <span class="material-icons text-base">{{ zipDownloading ? "hourglass_empty" : "folder_zip" }}</span>
        {{ t("common.downloadZip") }}
      </button>
      <span v-if="pdfError" class="text-xs text-red-500" :title="pdfError">{{ t("pluginTextResponse.pdfFailed") }}</span>
      <span v-if="zipFailed" class="text-xs text-red-500">{{ t("common.downloadFailed") }}</span>
    </div>
    <div class="flex-1 overflow-hidden relative" @click.capture="openLinksInNewTab">
      <div class="text-response-container">
        <div class="text-response-content-wrapper">
          <div class="p-6">
            <div class="max-w-3xl mx-auto space-y-4">
              <div class="rounded-lg border border-gray-300 bg-white shadow-sm p-5" :class="roleTheme">
                <div class="flex justify-between items-start mb-2 text-sm text-gray-500">
                  <span class="font-medium text-gray-700">{{ speakerLabel }}</span>
                  <span v-if="transportKind" class="italic">{{ transportKind }}</span>
                </div>
                <div
                  v-if="truncationInfo.wasTruncated"
                  class="mb-3 p-3 rounded border border-amber-300 bg-amber-50 text-amber-900 text-sm"
                  data-testid="text-response-truncation-banner"
                >
                  {{
                    t("pluginTextResponse.truncatedForRender", {
                      omitted: truncationInfo.omittedChars.toLocaleString(locale),
                      total: truncationInfo.originalChars.toLocaleString(locale),
                    })
                  }}
                </div>
                <!-- eslint-disable vue/no-v-html -- DOMPurify-sanitised marked output (renderMarkdownToSafeHtml). Multi-line element so disable/enable pair (CLAUDE.md UI rule) instead of -next-line. -->
                <div
                  ref="markdownContainerRef"
                  class="markdown-content prose prose-slate max-w-none leading-relaxed text-gray-900"
                  translate="yes"
                  :data-testid="isAssistant ? 'text-response-assistant-body' : undefined"
                  v-html="renderedHtml"
                ></div>
                <!-- eslint-enable vue/no-v-html -->
                <div v-if="messageAttachments.length > 0" class="space-y-3 mt-3" data-testid="text-response-attachments">
                  <SentAttachmentChip v-for="file in messageAttachments" :key="file.path" :path="file.path" :filename="file.filename" variant="block" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Collapsible Editor -->
        <details v-if="editable" ref="detailsEl" class="text-response-source" data-testid="text-response-edit">
          <summary data-testid="text-response-edit-summary">{{ t("pluginTextResponse.editContent") }}</summary>
          <textarea v-model="editedText" class="text-response-editor" spellcheck="false" data-testid="text-response-edit-textarea"></textarea>
          <button class="apply-btn" :disabled="!hasChanges" data-testid="text-response-apply-btn" @click="applyChanges">
            {{ t("pluginTextResponse.applyChanges") }}
          </button>
        </details>
      </div>
      <button v-show="!editing" class="copy-btn" :title="copied ? t('pluginTextResponse.copiedLabel') : t('pluginTextResponse.copyLabel')" @click="copyText">
        <span class="material-icons">{{ copied ? "check" : "content_copy" }}</span>
      </button>
      <button v-show="editing" class="cancel-btn" @click="cancelEdit">{{ t("pluginTextResponse.cancel") }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { marked } from "marked";
import type { ToolResult, ToolResultComplete } from "gui-chat-protocol/vue";
import type { TextResponseData } from "./types";
import type { AttachmentEntry } from "../../types/attachment";
import SentAttachmentChip from "../../components/SentAttachmentChip.vue";
import { handleExternalLinkClick } from "@mulmoclaude/markdown-utils/dom/externalLink";
import { classifyWorkspacePath } from "../../utils/path/workspaceLinkRouter";
import { useMermaidRenderer } from "../../utils/markdown/useMermaid";
import { useCodeCopyButtons } from "../../utils/markdown/useCodeCopyButtons";
import { useAppApi } from "../../composables/useAppApi";
import { usePdfDownload } from "../../composables/usePdfDownload";
import { useMarkdownZip } from "../../composables/useMarkdownZip";
import { useClipboardCopy } from "@mulmoclaude/core/plugin-vue";
import { buildPdfFilename } from "@mulmoclaude/markdown-utils/files/filename";
import { extractTextResponseTitle, truncateForRender } from "./utils";
import { renderMarkdownToSafeHtml } from "../../utils/markdown/renderMarkdown";
import { transformThinkBlocks, wrapJsonAsCodeFence } from "./renderPipeline";

const { t, locale } = useI18n();
const appApi = useAppApi();

const props = withDefaults(
  defineProps<{
    selectedResult: ToolResultComplete<TextResponseData>;
    editable?: boolean | undefined;
    // When set, the editor textarea edits this string instead of the
    // displayed `data.text`. FilesView uses it to feed the editor the
    // raw on-disk source (with frontmatter intact, no image-URL
    // rewriting) while the rendered pane keeps showing the cleaned-up
    // display text. Callers listen for `updateSource` to receive the
    // edited source and handle persistence themselves.
    editableSource?: string | undefined;
  }>(),
  { editable: true, editableSource: undefined },
);
const emit = defineEmits<{
  updateResult: [result: ToolResult];
  updateSource: [source: string];
}>();

// --- Data & computed from upstream View ---

const messageText = computed(() => props.selectedResult.data?.text ?? "");
// Source fed into the editor. When the parent passes `editableSource`
// it wins; otherwise we edit the displayed text, matching the
// component's original (chat-message) behaviour.
const editorSource = computed(() => (props.editableSource !== undefined ? props.editableSource : messageText.value));
const editedText = ref(editorSource.value);

watch(editorSource, (next) => {
  editedText.value = next;
});

const messageRole = computed(() => props.selectedResult.data?.role ?? "assistant");
const transportKind = computed(() => props.selectedResult.data?.transportKind ?? "");
const messageAttachments = computed<AttachmentEntry[]>(() => props.selectedResult.data?.attachments ?? []);
// Pkg name when this user turn was seeded by `runtime.chat.start()`
// (Phase 1 of the Encore plan). Drives the "from <pkg>" chip and a
// muted background variant so the user can tell the message came
// from a plugin and not themselves.
const seededByPlugin = computed<string>(() => props.selectedResult.data?.seededByPlugin ?? "");
// First-user-turn-seeded-by-plugin signal (#1218-adjacent): render
// the skill-style collapsed card path instead of the default user
// bubble. `parseSessionEntries` only stamps `seededByPlugin` on the
// very first user turn of a plugin-origin session, so this branch is
// inherently scoped to the opening message.
const isSeededUserTurn = computed(() => Boolean(seededByPlugin.value) && messageRole.value === "user");

// Truncation summary surfaced to the template — the banner renders when
// `wasTruncated` is true, telling the user the visible content is a preview
// and the raw text is available via Copy. See #1863 for the pathological
// input this defends against (Opus 4.8 degenerate repetition freezing Safari).
const truncationInfo = computed(() => truncateForRender(messageText.value ?? ""));

const MARKED_OPTIONS = { breaks: true, gfm: true } as const;

const renderInnerMarkdown = (markdown: string): string => {
  const html = marked(markdown, MARKED_OPTIONS);
  return typeof html === "string" ? html : "";
};

const renderedHtml = computed(() => {
  const { displayText, wasTruncated } = truncationInfo.value;
  if (!displayText) return "";
  // A truncated tail can't be valid JSON, so skip the wrap; a partial dump
  // is more informative rendered as markdown.
  const withJson = wasTruncated ? displayText : wrapJsonAsCodeFence(displayText);
  const processedText = transformThinkBlocks(withJson, renderInnerMarkdown);
  // Assistant text is the least-trusted markdown surface in the app —
  // route it through the shared DOMPurify path so an echoed
  // `<img onerror=…>` / `javascript:` link can't execute.
  return renderMarkdownToSafeHtml(processedText, MARKED_OPTIONS);
});

const speakerLabel = computed(() => {
  if (messageRole.value === "system") return t("pluginTextResponse.speakerSystem");
  if (messageRole.value === "user") return t("pluginTextResponse.speakerUser");
  return t("pluginTextResponse.speakerAssistant");
});

const roleTheme = computed(() => {
  switch (messageRole.value) {
    case "system":
      return "bg-blue-50 border-blue-200";
    case "user":
      return "bg-green-50 border-green-200";
    default:
      return "bg-purple-50 border-purple-200";
  }
});

const hasChanges = computed(() => editedText.value !== editorSource.value);

// `<details>` element ref. Declared together with the editing state
// just below, but hoisted up here so `applyChanges` can close the
// panel after a save without TDZ ordering trouble.
const detailsEl = ref<HTMLDetailsElement>();

// Container for the rendered markdown surface (seeded-turn card OR
// assistant response body — only one mounts at a time via v-if/v-else,
// so a single ref binds to whichever branch is live). Feeds the
// mermaid post-render pass.
const markdownContainerRef = ref<HTMLElement | null>(null);
useMermaidRenderer(markdownContainerRef, renderedHtml);
useCodeCopyButtons(markdownContainerRef, renderedHtml);

function applyChanges() {
  if (!hasChanges.value) return;

  if (props.editableSource !== undefined) {
    // Source-editing mode: hand the edited string to the parent and
    // let it decide how to persist. The component's own `data.text`
    // isn't touched — the parent will re-supply `editableSource` after
    // the save round-trip.
    emit("updateSource", editedText.value);
  } else {
    const updatedResult: ToolResult = {
      ...props.selectedResult,
      data: {
        ...props.selectedResult.data,
        text: editedText.value,
      },
    };
    emit("updateResult", updatedResult);
  }
  if (detailsEl.value) detailsEl.value.open = false;
}

// --- Local customizations: PDF, copy, edit toggle, external links ---

const isAssistant = computed(() => (props.selectedResult.data?.role ?? "assistant") === "assistant");

function openLinksInNewTab(event: MouseEvent): void {
  if (handleExternalLinkClick(event)) return;
  // Internal workspace-path links (rendered by marked from agent
  // Markdown): route to the appropriate view instead of letting them
  // navigate the SPA to a non-existent session route.
  const { target } = event;
  // Element, not HTMLElement: an inline <svg> inside a link is a real
  // click target and must still resolve to its anchor.
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  if (classifyWorkspacePath(href)) {
    event.preventDefault();
    appApi.navigateToWorkspacePath(href);
  }
}

const { pdfDownloading, pdfError, downloadPdf: rawDownloadPdf } = usePdfDownload();
const { zipDownloading, zipFailed, downloadZip: rawDownloadZip } = useMarkdownZip();

const editing = ref(false);

function onDetailsToggle(event: Event) {
  const details = event.target;
  if (details instanceof HTMLDetailsElement) editing.value = details.open;
}

onMounted(() => {
  detailsEl.value?.addEventListener("toggle", onDetailsToggle);
});

onBeforeUnmount(() => {
  detailsEl.value?.removeEventListener("toggle", onDetailsToggle);
});

function cancelEdit() {
  if (detailsEl.value) detailsEl.value.open = false;
  // Reset edited text to whatever the editor started with — in
  // source-editing mode that's the raw source, otherwise the display
  // text. Using the computed `editorSource` keeps both paths correct.
  editedText.value = editorSource.value;
}

const { copied, copy } = useClipboardCopy();

async function copyText() {
  // In Files-Explorer mode `data.text` is the DISPLAY text with image refs
  // rewritten to `/api/files/raw?...` — copying that yields broken URLs
  // outside the app. Prefer the raw editable source, then the export source,
  // falling back to display text for the chat path (where it's the full raw
  // text the truncation banner promises).
  await copy(props.editableSource ?? props.selectedResult.data?.pdfSourceText ?? props.selectedResult.data?.text ?? "");
}

// PDF and zip share the same source: display text and export source can
// diverge (Files Explorer's .md preview pre-rewrites image refs to
// `/api/files/raw?...` for the browser, which the server inliner can't
// resolve back to disk), so prefer the original source when provided.
function markdownExport(): { text: string; filename: string; baseDir?: string | undefined; stripFrontmatter?: boolean | undefined } {
  const { data } = props.selectedResult;
  const text = data?.pdfSourceText ?? data?.text ?? "";
  const filename = buildPdfFilename({
    name: extractTextResponseTitle(data?.text ?? ""),
    fallback: "chat",
    timestampMs: appApi.getResultTimestamp(props.selectedResult.uuid),
  });
  return { text, filename, baseDir: data?.pdfBaseDir, stripFrontmatter: data?.pdfStripFrontmatter };
}

async function downloadPdf() {
  const { text, filename, baseDir, stripFrontmatter } = markdownExport();
  await rawDownloadPdf(text, filename, { baseDir, stripFrontmatter });
}

async function downloadZipFile() {
  const { text, filename, baseDir, stripFrontmatter } = markdownExport();
  await rawDownloadZip(text, filename, { baseDir, stripFrontmatter });
}
</script>

<style scoped>
.markdown-content :deep(h1) {
  font-size: 2rem;
  font-weight: bold;
  margin-top: 1em;
  margin-bottom: 0.5em;
}

.markdown-content :deep(h2) {
  font-size: 1.75rem;
  font-weight: bold;
  margin-top: 1em;
  margin-bottom: 0.5em;
}

.markdown-content :deep(h3) {
  font-size: 1.5rem;
  font-weight: bold;
  margin-top: 1em;
  margin-bottom: 0.5em;
}

.markdown-content :deep(h4) {
  font-size: 1.25rem;
  font-weight: bold;
  margin-top: 1em;
  margin-bottom: 0.5em;
}

.markdown-content :deep(h5) {
  font-size: 1.125rem;
  font-weight: bold;
  margin-top: 1em;
  margin-bottom: 0.5em;
}

.markdown-content :deep(h6) {
  font-size: 1rem;
  font-weight: bold;
  margin-top: 1em;
  margin-bottom: 0.5em;
}

.markdown-content :deep(p) {
  margin-bottom: 1em;
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin-left: 1.5em;
  margin-bottom: 1em;
}

.markdown-content :deep(li) {
  margin-bottom: 0.5em;
}

.markdown-content :deep(code) {
  background-color: #f5f5f5;
  padding: 0.2em 0.4em;
  border-radius: 3px;
  font-family: Consolas, "MS Gothic", "BIZ UDGothic", monospace;
  font-size: 0.9em;
}

.markdown-content :deep(pre) {
  background-color: #f5f5f5;
  padding: 1em;
  border-radius: 4px;
  overflow-x: auto;
  margin-bottom: 1em;
}

.markdown-content :deep(pre code) {
  background-color: transparent;
  padding: 0;
}

.markdown-content :deep(blockquote) {
  border-left: 4px solid #ddd;
  padding-left: 1em;
  color: #666;
  margin: 1em 0;
}

.markdown-content :deep(a) {
  color: #2563eb;
  text-decoration: underline;
}

.markdown-content :deep(a:hover) {
  color: #1d4ed8;
}

.markdown-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 1em;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid #ddd;
  padding: 0.5em;
  text-align: left;
}

.markdown-content :deep(th) {
  background-color: #f5f5f5;
  font-weight: bold;
}

.markdown-content :deep(hr) {
  border: none;
  border-top: 1px solid #ddd;
  margin: 1.5em 0;
}

.markdown-content :deep(.think-block) {
  color: #6b7280;
  background-color: #f9fafb;
  border-left: 3px solid #d1d5db;
  padding: 0.75em 1em;
  margin: 1em 0;
  border-radius: 4px;
  font-style: italic;
}

.markdown-content :deep(.think-block p) {
  color: #6b7280;
}

.markdown-content :deep(.think-block code) {
  background-color: #e5e7eb;
  color: #4b5563;
}

/* Container styles */
.text-response-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.text-response-content-wrapper {
  flex: 1;
  overflow-y: auto;
}

/* Editor panel styles */
.text-response-source {
  padding: 0.5rem;
  background: #f5f5f5;
  border-top: 1px solid #e0e0e0;
  font-family: Consolas, "MS Gothic", "BIZ UDGothic", monospace;
  font-size: 0.85rem;
  flex-shrink: 0;
}

.text-response-source summary {
  cursor: pointer;
  user-select: none;
  padding: 0.5rem;
  background: #e8e8e8;
  border-radius: 4px;
  font-weight: 500;
  color: #333;
}

.text-response-source[open] summary {
  margin-bottom: 0.5rem;
}

.text-response-source summary:hover {
  background: #d8d8d8;
}

.text-response-editor {
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

.text-response-editor:focus {
  outline: none;
  border-color: #4caf50;
  box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.1);
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

.apply-btn:active {
  background: #3d8b40;
}

.apply-btn:disabled {
  background: #cccccc;
  color: #666666;
  cursor: not-allowed;
  opacity: 0.6;
}

.apply-btn:disabled:hover {
  background: #cccccc;
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

.cancel-btn {
  position: absolute;
  bottom: 0.5rem;
  right: 0.65rem;
  padding: 0.5rem 1rem;
  background: #e0e0e0;
  color: #333;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  z-index: 1;
}

.cancel-btn:hover {
  background: #d0d0d0;
}
</style>
