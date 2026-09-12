// Vue composable that keeps every markdown viewer's code fences
// wired up with a copy button. The viewer passes its
// `<div v-html="renderedHtml">` container ref and the reactive
// source; this hook schedules a `nextTick` → `attachCodeCopyButtons`
// on mount and whenever the source changes, mirroring
// `useMermaidRenderer` so newly-injected `<pre><code>` blocks gain a
// button without each viewer re-implementing the plumbing.

import { onMounted, watch, nextTick, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { attachCodeCopyButtons } from "@mulmoclaude/markdown-utils/markdown/codeCopyButtons";

export function useCodeCopyButtons(containerRef: Ref<HTMLElement | null | undefined>, sourceRef: Ref<unknown>): void {
  const { t } = useI18n();
  const run = async (): Promise<void> => {
    await nextTick();
    attachCodeCopyButtons(containerRef.value ?? null, {
      copyLabel: t("markdownCodeCopy.copyLabel"),
      copiedLabel: t("markdownCodeCopy.copiedLabel"),
    });
  };
  onMounted(() => {
    void run();
  });
  // `immediate: false` — `onMounted` already covers the initial
  // render. `flush: "post"` fires after Vue applies the DOM patch that
  // v-html triggers, so newly-rendered code blocks exist when we scan
  // for them.
  watch(sourceRef, () => void run(), { flush: "post" });
}
