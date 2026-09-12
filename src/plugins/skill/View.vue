<template>
  <!-- Top-anchored layout: the skill card sits flush against the
       canvas top to match the other document-like plugins
       (markdown, presentDocument, …). The canvas may reserve more
       vertical space than the collapsed card needs; the empty pane
       below is intentional and consistent with those siblings. -->
  <div class="h-full flex flex-col overflow-y-auto p-6">
    <div class="max-w-3xl mx-auto w-full">
      <div class="rounded-lg border border-purple-200 bg-purple-50 shadow-sm">
        <!-- Collapsed header — clickable. The whole card collapses by
             default; clicking expands the skill body. The use of
             `<details>` keeps keyboard / a11y semantics correct. -->
        <details class="group">
          <summary class="cursor-pointer list-none p-4 flex items-start gap-3 hover:bg-purple-100/40 rounded-lg" :data-testid="'skill-summary-' + skillName">
            <span class="material-icons text-purple-600 text-base mt-0.5 shrink-0">extension</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-baseline gap-2 flex-wrap">
                <span class="font-medium text-purple-900">{{ skillName }}</span>
                <span v-if="skillScope !== 'unknown'" class="text-[10px] uppercase tracking-wide text-purple-500 px-1.5 py-0.5 rounded-full bg-purple-100">
                  {{ skillScope }}
                </span>
              </div>
              <div v-if="skillDescription" class="text-sm text-gray-700 mt-1">{{ skillDescription }}</div>
              <div v-else class="text-sm text-gray-500 italic mt-1">{{ t("pluginSkill.noDescription") }}</div>
            </div>
            <span class="material-icons text-gray-400 text-base shrink-0 group-open:rotate-180 transition-transform">expand_more</span>
          </summary>

          <!-- Expanded body — markdown-rendered. -->
          <div class="border-t border-purple-200 p-4 bg-white rounded-b-lg">
            <div v-if="skillPath" class="text-[11px] font-mono text-gray-400 mb-3 break-all">{{ skillPath }}</div>
            <!-- eslint-disable vue/no-v-html -- DOMPurify-sanitized markdown of the SKILL.md body Claude CLI synthesised. The body comes from the user's local skill file, surfaced verbatim here. Multi-line element so disable/enable pair (CLAUDE.md UI rule). -->
            <div
              ref="markdownContainerRef"
              class="markdown-content prose prose-slate max-w-none"
              translate="yes"
              @click="handleExternalLinkClick"
              v-html="renderedHtml"
            ></div>
            <!-- eslint-enable vue/no-v-html -->
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolResultComplete } from "gui-chat-protocol/vue";
import type { SkillData } from "./types";
import { handleExternalLinkClick } from "@mulmoclaude/markdown-utils/dom/externalLink";
import { renderMarkdownToSafeHtml } from "../../utils/markdown/renderMarkdown";
import { useMermaidRenderer } from "../../utils/markdown/useMermaid";
import { useCodeCopyButtons } from "../../utils/markdown/useCodeCopyButtons";

const { t } = useI18n();

const props = defineProps<{
  selectedResult: ToolResultComplete<SkillData>;
}>();

const skillName = computed(() => props.selectedResult.data?.skillName ?? "");
const skillScope = computed(() => props.selectedResult.data?.skillScope ?? "unknown");
const skillPath = computed(() => props.selectedResult.data?.skillPath ?? null);
const skillDescription = computed(() => props.selectedResult.data?.skillDescription ?? null);
const body = computed(() => props.selectedResult.data?.body ?? "");

const renderedHtml = computed(() => renderMarkdownToSafeHtml(body.value, { breaks: true, gfm: true }));

const markdownContainerRef = ref<HTMLElement | null>(null);
useMermaidRenderer(markdownContainerRef, renderedHtml);
useCodeCopyButtons(markdownContainerRef, renderedHtml);
</script>

<style scoped>
.markdown-content :deep(h1) {
  font-size: 1.5rem;
  font-weight: bold;
  margin-top: 1em;
  margin-bottom: 0.5em;
}
.markdown-content :deep(h2) {
  font-size: 1.25rem;
  font-weight: bold;
  margin-top: 1em;
  margin-bottom: 0.5em;
}
.markdown-content :deep(h3) {
  font-size: 1.125rem;
  font-weight: bold;
  margin-top: 0.75em;
  margin-bottom: 0.5em;
}
.markdown-content :deep(p) {
  margin-bottom: 0.75em;
}
.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin-left: 1.5em;
  margin-bottom: 0.75em;
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
  padding: 0.75em;
  border-radius: 4px;
  overflow-x: auto;
  margin-bottom: 0.75em;
}
.markdown-content :deep(pre code) {
  background-color: transparent;
  padding: 0;
}
.markdown-content :deep(blockquote) {
  border-left: 3px solid #d1d5db;
  padding-left: 1em;
  color: #4b5563;
  margin: 0.75em 0;
}
.markdown-content :deep(a) {
  color: #2563eb;
  text-decoration: underline;
}
</style>
