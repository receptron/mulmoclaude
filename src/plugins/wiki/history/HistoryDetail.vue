<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { formatSmartTime } from "../../../utils/format/date";
import { fetchHistorySnapshot, restoreHistorySnapshot, type SnapshotContent, type SnapshotSummary } from "./api";
import { DIFF_LINE_KIND, joinFrontmatterAndBody, renderUnifiedDiff, stripAutoStampKeys, type DiffHunk, type DiffLineKind } from "./diff";
import RestoreConfirm from "./RestoreConfirm.vue";

const props = defineProps<{
  slug: string;
  /** Summary of the snapshot being viewed (carries ts/editor/reason for the header). */
  summary: SnapshotSummary;
  /** Summary of the snapshot just before this one in the list (newest-first
   *  ordering = `summary` is at index N, `previousSummary` is at index N+1).
   *  null when this is the oldest entry. Used for the "compare with previous"
   *  toggle. */
  previousSummary: SnapshotSummary | null;
  /** Live page body + frontmatter, supplied by the parent so we don't
   *  re-fetch on tab switches. */
  currentBody: string;
  currentMeta: Record<string, unknown>;
}>();

const emit = defineEmits<{
  back: [];
  /** Fired after the server returns 200 on the restore POST. The
   *  parent (View.vue) handles the tab switch + success toast. */
  restored: [];
}>();

const { t } = useI18n();

const COMPARE_TARGET = {
  current: "current",
  previous: "previous",
} as const;
type CompareTarget = (typeof COMPARE_TARGET)[keyof typeof COMPARE_TARGET];

const loading = ref(true);
const fetchError = ref<string | null>(null);
const snapshot = ref<SnapshotContent | null>(null);
const previousSnapshot = ref<SnapshotContent | null>(null);
// Separate error channel for the previous-compare fetch (codex
// iter-4 #946). Folding it into `fetchError` made a failed previous
// load take over the whole detail pane even after the user
// switched back to "current" — kept blocking valid state.
const previousFetchError = ref<string | null>(null);

const compareTarget = ref<CompareTarget>(COMPARE_TARGET.current);
const restoring = ref(false);
const restoreError = ref<string | null>(null);
const confirmOpen = ref(false);

// Stale-response guards (codex iter-1 #946). A user who clicks a
// different snapshot before the previous fetch returns would
// otherwise see the slow response overwrite the new selection.
// Two separate tokens because the "current" and "previous" fetches
// are independent.
let loadToken = 0;
let previousLoadToken = 0;

onMounted(async () => {
  await loadThisSnapshot();
});

watch(
  () => props.summary.stamp,
  async (next, prev) => {
    if (next === prev) return;
    await loadThisSnapshot();
  },
);

watch(compareTarget, async (target, prevTarget) => {
  // Switching away from "previous" must invalidate any in-flight
  // previous-snapshot load — otherwise its late failure would
  // surface as `fetchError` and take over the detail pane even
  // though the user is now looking at the (valid) current
  // comparison (codex iter-3 #946).
  if (prevTarget === COMPARE_TARGET.previous && target !== COMPARE_TARGET.previous) {
    previousLoadToken += 1;
  }
  if (target === COMPARE_TARGET.previous && previousSnapshot.value === null && props.previousSummary !== null) {
    await loadPreviousSnapshot();
  }
});

async function loadThisSnapshot(): Promise<void> {
  const myToken = ++loadToken;
  // Invalidate any in-flight previous-snapshot load too — codex
  // iter-2 #946: a slow `previousSnapshot` response was otherwise
  // able to land after the user switched to a different snapshot,
  // surfacing a comparison against the wrong base. Bumping
  // `previousLoadToken` here guarantees that lingering response
  // sees its token as stale and drops on the floor.
  previousLoadToken += 1;
  loading.value = true;
  fetchError.value = null;
  previousFetchError.value = null;
  snapshot.value = null;
  previousSnapshot.value = null;
  compareTarget.value = COMPARE_TARGET.current;
  restoreError.value = null;
  const result = await fetchHistorySnapshot(props.slug, props.summary.stamp);
  if (myToken !== loadToken) return;
  loading.value = false;
  if (!result.ok) {
    fetchError.value = result.error;
    return;
  }
  snapshot.value = result.data.snapshot;
}

async function loadPreviousSnapshot(): Promise<void> {
  if (props.previousSummary === null) return;
  const myToken = ++previousLoadToken;
  previousFetchError.value = null;
  const result = await fetchHistorySnapshot(props.slug, props.previousSummary.stamp);
  if (myToken !== previousLoadToken) return;
  if (!result.ok) {
    previousFetchError.value = result.error;
    return;
  }
  previousSnapshot.value = result.data.snapshot;
}

const editorBadge = computed(() => editorBadgeFor(props.summary.editor));

function markerFor(kind: DiffLineKind): string {
  if (kind === DIFF_LINE_KIND.add) return "+";
  if (kind === DIFF_LINE_KIND.del) return "-";
  return " "; // non-breaking space — keeps the column aligned
}

function editorBadgeFor(editor: SnapshotSummary["editor"]): { label: string; className: string } {
  if (editor === "llm") {
    return { label: t("pluginWiki.history.editorBadgeLLM"), className: "bg-purple-50 text-purple-700" };
  }
  if (editor === "system") {
    return { label: t("pluginWiki.history.editorBadgeSystem"), className: "bg-gray-100 text-gray-700" };
  }
  return { label: t("pluginWiki.history.editorBadgeUser"), className: "bg-blue-50 text-blue-700" };
}

const hunks = computed<DiffHunk[]>(() => {
  if (snapshot.value === null) return [];
  // Right side = the snapshot we're viewing, with auto-stamps stripped.
  const rightMeta = stripAutoStampKeys(stripSnapshotMetaPatchKeys(snapshot.value.meta));
  const right = joinFrontmatterAndBody(rightMeta, snapshot.value.body);

  if (compareTarget.value === COMPARE_TARGET.current) {
    const leftMeta = stripAutoStampKeys(props.currentMeta);
    const left = joinFrontmatterAndBody(leftMeta, props.currentBody);
    return renderUnifiedDiff(left, right, 3);
  }
  // compare with previous
  if (previousSnapshot.value === null) return [];
  const leftMeta = stripAutoStampKeys(stripSnapshotMetaPatchKeys(previousSnapshot.value.meta));
  const left = joinFrontmatterAndBody(leftMeta, previousSnapshot.value.body);
  return renderUnifiedDiff(left, right, 3);
});

const showNoPreviousMessage = computed(() => compareTarget.value === COMPARE_TARGET.previous && props.previousSummary === null);
const showPreviousFetchError = computed(() => compareTarget.value === COMPARE_TARGET.previous && previousFetchError.value !== null);
const showNoChangesMessage = computed(() => {
  if (loading.value) return false;
  if (snapshot.value === null) return false;
  if (compareTarget.value === COMPARE_TARGET.previous && (props.previousSummary === null || previousSnapshot.value === null)) return false;
  return hunks.value.length === 0;
});

/** The snapshot's frontmatter still carries `_snapshot_*` keys
 *  (snapshot pipeline metadata). These are NOT user data — strip
 *  them before any diff so they don't show up as changes against
 *  the live page (which never carries them). */
function stripSnapshotMetaPatchKeys(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key.startsWith("_snapshot_")) continue;
    out[key] = value;
  }
  return out;
}

function openConfirm(): void {
  restoreError.value = null;
  confirmOpen.value = true;
}

function cancelConfirm(): void {
  if (restoring.value) return;
  confirmOpen.value = false;
}

async function performRestore(): Promise<void> {
  restoring.value = true;
  restoreError.value = null;
  const result = await restoreHistorySnapshot(props.slug, props.summary.stamp);
  restoring.value = false;
  if (!result.ok) {
    restoreError.value = result.error;
    confirmOpen.value = false;
    return;
  }
  confirmOpen.value = false;
  emit("restored");
}
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0" data-testid="wiki-history-detail">
    <!-- Top bar: back + restore -->
    <div class="shrink-0 flex items-center justify-between px-4 py-2 border-b border-gray-100">
      <button
        type="button"
        class="h-8 px-2.5 flex items-center gap-1 rounded text-sm text-gray-600 hover:bg-gray-100 transition-colors"
        data-testid="wiki-history-back-button"
        @click="emit('back')"
      >
        <span class="material-icons text-base">arrow_back</span>
        {{ t("pluginWiki.history.backToList") }}
      </button>
      <button
        type="button"
        class="h-8 px-2.5 flex items-center gap-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        :disabled="loading || snapshot === null || restoring"
        data-testid="wiki-history-restore-button"
        @click="openConfirm"
      >
        <span class="material-icons text-base">restore</span>
        {{ t("pluginWiki.history.restoreButton") }}
      </button>
    </div>

    <!-- Header: snapshot metadata + diff target toggle -->
    <div class="shrink-0 px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-2 text-sm text-gray-700 min-w-0">
        <span :class="['inline-flex items-center px-2 h-5 rounded text-xs font-medium', editorBadge.className]" data-testid="wiki-history-detail-editor-badge">
          {{ editorBadge.label }}
        </span>
        <span class="text-gray-500" data-testid="wiki-history-detail-ts">
          {{ formatSmartTime(props.summary.ts) }}
        </span>
        <span v-if="props.summary.reason" class="text-gray-700 truncate" data-testid="wiki-history-detail-reason">{{ ` — ${props.summary.reason}` }}</span>
      </div>
      <div class="flex border border-gray-300 rounded overflow-hidden text-sm">
        <button
          :class="[
            'h-8 px-2.5 transition-colors',
            compareTarget === COMPARE_TARGET.current ? 'bg-blue-50 text-blue-600 font-medium' : 'bg-white text-gray-600 hover:bg-gray-50',
          ]"
          data-testid="wiki-history-compare-current"
          @click="compareTarget = COMPARE_TARGET.current"
        >
          {{ t("pluginWiki.history.compareCurrent") }}
        </button>
        <button
          :class="[
            'h-8 px-2.5 border-l border-gray-200 transition-colors',
            compareTarget === COMPARE_TARGET.previous ? 'bg-blue-50 text-blue-600 font-medium' : 'bg-white text-gray-600 hover:bg-gray-50',
          ]"
          data-testid="wiki-history-compare-previous"
          @click="compareTarget = COMPARE_TARGET.previous"
        >
          {{ t("pluginWiki.history.comparePrevious") }}
        </button>
      </div>
    </div>

    <!-- Inline restore-failure banner (Q10=B) -->
    <div
      v-if="restoreError"
      class="shrink-0 mx-4 mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
      data-testid="wiki-history-restore-error"
    >
      {{ t("pluginWiki.history.restoreFailureBanner", { error: restoreError }) }}
    </div>

    <!-- Body: loading / fetch error / no-previous / no-changes / diff -->
    <div class="flex-1 overflow-y-auto px-4 py-3 font-mono text-xs">
      <div v-if="loading" class="flex items-center justify-center py-8 text-gray-400">
        <span class="material-symbols-outlined animate-spin text-base mr-2">progress_activity</span>
        {{ t("pluginWiki.history.loading") }}
      </div>
      <div v-else-if="fetchError" class="text-red-600">{{ fetchError }}</div>
      <div v-else-if="showNoPreviousMessage" class="text-gray-500">{{ t("pluginWiki.history.diffNoPrevious") }}</div>
      <div v-else-if="showPreviousFetchError" class="text-red-600">{{ previousFetchError }}</div>
      <div v-else-if="showNoChangesMessage" class="text-gray-500">{{ t("pluginWiki.history.diffNoChanges") }}</div>
      <div v-else>
        <template v-for="(hunk, hunkIdx) in hunks" :key="hunkIdx">
          <div v-if="hunk.hiddenBefore > 0" class="text-gray-400 italic px-2 py-1 border-y border-gray-100 bg-gray-50">
            {{ t("pluginWiki.history.hiddenLines", { count: hunk.hiddenBefore }) }}
          </div>
          <div
            v-for="(line, lineIdx) in hunk.lines"
            :key="`${hunkIdx}-${lineIdx}`"
            :class="[
              'whitespace-pre-wrap px-2 py-0.5 leading-snug',
              line.kind === DIFF_LINE_KIND.add && 'bg-green-50 text-green-800',
              line.kind === DIFF_LINE_KIND.del && 'bg-red-50 text-red-800',
              line.kind === DIFF_LINE_KIND.context && 'text-gray-700',
            ]"
            :data-testid="`wiki-history-diff-line-${line.kind}`"
          >
            <span
              :class="[
                'mr-1',
                line.kind === DIFF_LINE_KIND.add && 'text-green-600',
                line.kind === DIFF_LINE_KIND.del && 'text-red-600',
                line.kind === DIFF_LINE_KIND.context && 'text-gray-300',
              ]"
              >{{ markerFor(line.kind) }}</span>{{ line.text }}
          </div>
          <div v-if="hunkIdx === hunks.length - 1 && hunk.hiddenAfter > 0" class="text-gray-400 italic px-2 py-1 border-y border-gray-100 bg-gray-50">
            {{ t("pluginWiki.history.hiddenLines", { count: hunk.hiddenAfter }) }}
          </div>
        </template>
      </div>
    </div>

    <!-- Confirm modal -->
    <RestoreConfirm v-if="confirmOpen" :snapshot="props.summary" :restoring="restoring" @cancel="cancelConfirm" @confirm="performRestore" />
  </div>
</template>
