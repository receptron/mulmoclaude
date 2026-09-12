// Shared markdown pipeline for the /skills right pane. The active-skill
// body and the catalog-preview body both render markdown → sanitized
// HTML and post-process mermaid the same way; centralising the pair here
// keeps the two viewers from drifting on which sanitiser or mermaid
// wiring they use (the duplication #2301 flagged).

import { computed, ref, type ComputedRef, type Ref } from "vue";
import { renderMarkdownToSafeHtml } from "../../utils/markdown/renderMarkdown";
import { useMermaidRenderer } from "../../utils/markdown/useMermaid";
import { useCodeCopyButtons } from "../../utils/markdown/useCodeCopyButtons";

export interface SkillMarkdown {
  /** Bind to the `v-html` container so mermaid can post-process it. */
  markdownRef: Ref<HTMLElement | null>;
  /** Sanitised HTML for the `v-html` binding. */
  renderedBody: ComputedRef<string>;
}

export function useSkillMarkdown(source: () => string | null | undefined): SkillMarkdown {
  const markdownRef = ref<HTMLElement | null>(null);
  const renderedBody = computed(() => renderMarkdownToSafeHtml(source()));
  useMermaidRenderer(markdownRef, renderedBody);
  useCodeCopyButtons(markdownRef, renderedBody);
  return { markdownRef, renderedBody };
}
