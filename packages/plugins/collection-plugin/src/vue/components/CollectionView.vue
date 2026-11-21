<template>
  <div class="h-full flex flex-col bg-slate-50/30">
    <CollectionHeader
      ref="collectionHeaderRef"
      :collection="collection"
      :embedded="embedded"
      :hide-header="hideHeader"
      :is-read-only="isReadOnly"
      :data-source-route="dataSourceRoute"
      :is-feed-route="isFeedRoute"
      :refreshing="refreshing"
      :pushing="pushing"
      :collection-actions="collectionActions"
      :collection-action-pending="collectionActionPending"
      :running-action-ids="runningActions"
      :can-create="canCreate"
      :calendar-active="calendarActive"
      :can-delete-collection="canDeleteCollection"
      :can-delete-feed="canDeleteFeed"
      @back="goBack"
      @refresh-feed="refreshFeed"
      @push-calendar="pushCalendar"
      @open-chat="openChat"
      @run-collection-action="runCollectionAction"
      @open-create="openCreate"
      @confirm-collection-delete="confirmCollectionDelete"
      @confirm-feed-delete="confirmFeedDelete"
    />

    <!-- Transient note for an agent-ingest Refresh: the worker runs in the
         background, so records don't update synchronously — tell the user the
         refresh started rather than leaving the click feeling like a no-op. -->
    <div
      v-if="refreshNote"
      class="mx-6 mt-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-4 py-2 text-sm text-indigo-800 flex items-center gap-2"
      data-testid="collections-refresh-note"
    >
      <span class="material-icons text-base text-indigo-600">hourglass_top</span>
      <span class="flex-1">{{ refreshNote }}</span>
    </div>

    <!-- Search Toolbar. Shown when there are items to search OR when a view
         toggle is available — the toggle must reach an empty date-bearing
         collection (empty-day create) and a collection whose only views are
         custom ones (so its buttons + the "+" stay reachable). -->
    <CollectionToolbar
      v-if="collection && ((!hideSearch && items.length > 0) || (!hideViewToggle && (hasCalendar || hasKanban || hasCustomViews || canAddCustomView)))"
      v-model:search-query="searchQuery"
      v-model:flag-filters="flagFilters"
      :collection="collection"
      :items="items"
      :hide-search="hideSearch"
      :hide-view-toggle="hideViewToggle"
      :active-view="activeView"
      :flag-chips="flagChips"
      :custom-views="customViews"
      :can-add-custom-view="canAddCustomView"
      :can-configure-views="canConfigureViews"
      :can-add-mobile-view="canAddMobileView"
      :has-calendar="hasCalendar"
      :has-kanban="hasKanban"
      :has-custom-views="hasCustomViews"
      :calendar-active="calendarActive"
      :kanban-active="kanbanActive"
      :date-fields="dateFields"
      :enum-fields="enumFields"
      :calendar-anchor-field="calendarAnchorField"
      :kanban-group-field="kanbanGroupField"
      :table-filtered-count="tableFilteredItems.length"
      :filtered-count="filteredItems.length"
      @set-view="setView"
      @set-custom-view="setCustomView"
      @add-view="addCustomView"
      @open-config="configOpen = true"
      @update:anchor-field="anchorOverride = $event"
      @update:group-field="kanbanOverride = $event"
    />

    <CollectionRepairBanner v-if="collection && dataIssues.length > 0" :count="dataIssues.length" @repair="repairCollection" />

    <div class="flex-1 overflow-auto">
      <div v-if="loading" class="flex flex-col items-center justify-center py-20 text-sm text-slate-500 gap-3">
        <div class="h-8 w-8 border-2 border-indigo-600/20 border-t-indigo-600 rounded-full animate-spin"></div>
        <span>{{ t("common.loading") }}</span>
      </div>

      <div v-else-if="loadError" class="m-6 rounded-xl border border-red-200 bg-red-50/50 p-4 text-sm text-red-800 shadow-sm flex items-center gap-3">
        <span class="material-icons text-red-600">error</span>
        <span>{{ loadError === "not-found" ? t("collectionsView.notFound") : `${t("collectionsView.loadFailed")}: ${loadError}` }}</span>
      </div>

      <div v-else-if="!collection">
        <!-- defensive: loading=false, error=null, collection=null -->
      </div>

      <!-- Calendar body: an alternative to the table for date-bearing
           collections. Shown whenever active (even when empty) so the
           empty-cell create affordance stays available. -->
      <div v-else-if="calendarActive" class="p-4">
        <CollectionCalendarView
          :schema="collection.schema"
          :items="filteredItems"
          :anchor-field="calendarAnchorField"
          :end-field="calendarEndField"
          :time-field="calendarTimeField"
          :color-field="kanbanGroupField"
          :selected="viewing ? String(viewing[collection.schema.primaryKey] ?? '') : undefined"
          @select="onCalendarSelect"
          @open-day="onOpenDay"
        />

        <!-- Day (time-allocation) popup. Selecting a record opens it on the
             right of this modal (the `#detail` slot), replacing the old panel
             that sat below the grid. -->
        <CollectionDayView
          v-if="openDay"
          :schema="collection.schema"
          :items="filteredItems"
          :day="openDay"
          :anchor-field="calendarAnchorField"
          :end-field="calendarEndField"
          :time-field="calendarTimeField"
          :color-field="kanbanGroupField"
          :selected="viewing ? String(viewing[collection.schema.primaryKey] ?? '') : undefined"
          :can-create="canCreate"
          :show-detail="Boolean(viewing || editing)"
          @select="onCalendarSelect"
          @create-on="createOnDate"
          @close="closeRecordSurfaces"
        >
          <template #detail>
            <CollectionRecordPanel
              v-model:editing="editing"
              :collection="collection"
              :viewing="viewing"
              :saving="saving"
              :save-error="saveError"
              :action-error="actionError"
              :action-pending="actionPending"
              :visible-actions="visibleActions"
              :running-action-ids="viewingRunningActionIds"
              :live-record="liveRecord"
              :live-derived="liveDerived"
              :view-title="viewTitle"
              :is-singleton="isSingleton"
              :readonly="isReadOnly"
              :render="render"
              :locale="locale"
              @submit="saveEditor"
              @cancel="cancelEditor"
              @edit="editFromView"
              @close="closeRecordSurfaces"
              @delete="viewing && confirmDelete(viewing)"
              @run-action="runAction"
              @item-chat="onItemChat"
            />
          </template>
        </CollectionDayView>

        <!-- Undated records (the "no date" tray) have no timeline slot, so
             they open in the shared record modal (rendered once at the View
             root) instead of the day view. -->
      </div>

      <!-- Kanban body: an alternative to the table for enum-bearing
           collections. The board groups records into columns by the chosen
           enum field; dragging a card between columns writes that field. -->
      <div v-else-if="kanbanActive" class="h-full flex flex-col">
        <!-- Inline-edit failure banner: a card drop (group-field write) was
             rolled back. The detail panel's `saveError` isn't shown during a
             drag, so inline edits surface their own — same as the table. -->
        <div
          v-if="inlineError"
          class="m-3 mb-0 rounded-xl border border-red-200 bg-red-50/50 p-4 text-sm text-red-800 shadow-sm flex items-center gap-3"
          data-testid="collections-inline-error"
        >
          <span class="material-icons text-red-600">error</span>
          <span class="flex-1">{{ t("collectionsView.inlineSaveFailed", { error: inlineError }) }}</span>
          <button
            type="button"
            class="h-8 w-8 flex items-center justify-center rounded text-red-600 hover:bg-red-100"
            :aria-label="t('common.close')"
            @click="inlineError = null"
          >
            <span class="material-icons text-base">close</span>
          </button>
        </div>
        <div class="flex-1 min-h-0 px-3 py-2">
          <CollectionKanbanView
            :schema="collection.schema"
            :items="filteredItems"
            :group-field="kanbanGroupField"
            :selected="viewing ? String(viewing[collection.schema.primaryKey] ?? '') : undefined"
            :notified="notifiedSeverities"
            :readonly="isReadOnly"
            @select="onCalendarSelect"
            @move="onKanbanMove"
          />
        </div>
      </div>

      <!-- Custom (LLM-authored) HTML view, rendered in a sandboxed iframe over
           the collection's records. Placed before the empty states so it shows
           even for an empty collection (e.g. a still-empty year grid). A
           mobile-target view renders in the phone-frame preview instead — the
           host-wrapped srcdoc + postMessage bridge, exactly what the phone
           remote receives. -->
      <div v-else-if="activeCustomView" class="h-full" data-testid="collection-custom-view-body">
        <CollectionRemoteViewPreview
          v-if="activeCustomView.target === 'mobile'"
          :slug="collection.slug"
          :view="activeCustomView"
          @start-chat="onCustomViewStartChat"
        />
        <CollectionCustomView
          v-else
          :slug="collection.slug"
          :view="activeCustomView"
          :search-query="searchQuery"
          @open-item="onCustomViewOpenItem"
          @start-chat="onCustomViewStartChat"
        />
      </div>

      <div v-else-if="items.length === 0 && editing?.mode !== 'create'" class="flex flex-col items-center justify-center py-20 text-sm text-slate-400 gap-2">
        <span class="material-icons text-4xl text-slate-300">folder_open</span>
        <p class="font-semibold text-slate-600">{{ t(isReadOnly ? "collectionsView.itemsEmptyReadonly" : "collectionsView.itemsEmpty") }}</p>
      </div>

      <div
        v-else-if="tableFilteredItems.length === 0 && editing?.mode !== 'create'"
        class="flex flex-col items-center justify-center py-20 text-sm text-slate-400 gap-2"
      >
        <span class="material-icons text-4xl text-slate-300">search_off</span>
        <p class="font-semibold text-slate-600">{{ t("collectionsView.noMatchingItems") }}</p>
        <!-- Clears the flag chips too — either narrowing can be the one
             that emptied the table. -->
        <button type="button" class="text-xs text-indigo-600 font-semibold hover:underline" @click="((searchQuery = ''), (flagFilters = {}))">
          {{ t("collectionsView.clearSearch") }}
        </button>
      </div>

      <div v-else class="overflow-x-auto [container-type:inline-size]">
        <!-- Inline-edit failure banner: a cell write (checkbox/dropdown)
             was rolled back; the detail panel's `saveError` isn't visible
             here so inline edits surface their own. -->
        <div
          v-if="inlineError"
          class="m-4 rounded-xl border border-red-200 bg-red-50/50 p-4 text-sm text-red-800 shadow-sm flex items-center gap-3"
          data-testid="collections-inline-error"
        >
          <span class="material-icons text-red-600">error</span>
          <span class="flex-1">{{ t("collectionsView.inlineSaveFailed", { error: inlineError }) }}</span>
          <button
            type="button"
            class="h-8 w-8 flex items-center justify-center rounded text-red-600 hover:bg-red-100"
            :aria-label="t('common.close')"
            @click="inlineError = null"
          >
            <span class="material-icons text-base">close</span>
          </button>
        </div>
        <CollectionTable
          v-model:hovered-sort-key="hoveredSortKey"
          :collection="collection"
          :list-column-fields="listColumnFields"
          :sorted-items="sortedItems"
          :render="render"
          :is-read-only="isReadOnly"
          :enum-originally-empty="enumOriginallyEmpty"
          :inline-saving-rows="inlineSavingRows"
          :sort-state="sortState"
          :open-row-id="openRowId"
          :editing-row-id="editingRowId"
          @open-view="openView"
          @cycle-sort="cycleSort"
          @commit-toggle="commitToggle"
          @commit-inline-edit="commitInlineEdit"
        />
      </div>
    </div>

    <!-- Shared record modal — the single open/edit surface for every view
         mode (table / kanban) and the calendar's undated tray.
         Calendar's DATED records keep their day-view modal (which embeds the
         same panel on its right), so this is suppressed while that's open. -->
    <CollectionRecordModal v-if="collection && (viewing || editing) && !(calendarActive && openDay)" @close="closeRecordModal">
      <CollectionRecordPanel
        v-model:editing="editing"
        :collection="collection"
        :viewing="viewing"
        :saving="saving"
        :save-error="saveError"
        :action-error="actionError"
        :action-pending="actionPending"
        :visible-actions="visibleActions"
        :running-action-ids="viewingRunningActionIds"
        :live-record="liveRecord"
        :live-derived="liveDerived"
        :view-title="viewTitle"
        :is-singleton="isSingleton"
        :readonly="isReadOnly"
        :render="render"
        :locale="locale"
        @submit="saveEditor"
        @cancel="cancelEditor"
        @edit="editFromView"
        @close="closeView"
        @delete="viewing && confirmDelete(viewing)"
        @run-action="runAction"
        @item-chat="onItemChat"
      />
    </CollectionRecordModal>

    <!-- `kind: "mutate"` params mini-form (teleported; stacks over the
         record modal its button lives in). -->
    <CollectionMutateParamsModal
      v-if="mutateModal"
      :key="`${mutateModal.action.id}-${mutateModal.itemId}`"
      :action="mutateModal.action"
      :pending="mutatePending"
      :error="mutateError"
      @close="mutateModal = null"
      @submit="submitMutateParams"
    />

    <!-- Per-collection config (gear): manage/delete custom views. -->
    <CollectionViewConfigModal
      v-if="configOpen && collection"
      :slug="collection.slug"
      :title="collection.title"
      :views="customViews"
      @changed="onViewsChanged"
      @close="configOpen = false"
    />

    <!-- `chat-modal-options` reaches the modal's footer, and ONLY on the standalone path. With
         `sendTextMessage` set we are inside a chat card and `submitChat` sends into the session
         already running (useCollectionChat's `dispatchSeed`), so a host control over "which chat
         gets started" would change nothing — an option that does not apply is worse than none. -->
    <CollectionChatModal v-if="chatOpen && collection" :collection-title="collection.title" @close="closeChat" @submit="submitChat">
      <template v-if="!sendTextMessage" #options><slot name="chat-modal-options" /></template>
    </CollectionChatModal>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useCollectionI18n } from "../lang";
import CollectionHeader from "./CollectionHeader.vue";
import CollectionMutateParamsModal from "./CollectionMutateParamsModal.vue";
import CollectionRecordModal from "./CollectionRecordModal.vue";
import CollectionChatModal from "./CollectionChatModal.vue";
import CollectionRepairBanner from "./CollectionRepairBanner.vue";
import CollectionToolbar from "./CollectionToolbar.vue";
import CollectionCalendarView from "./CollectionCalendarView.vue";
import CollectionDayView from "./CollectionDayView.vue";
import CollectionKanbanView from "./CollectionKanbanView.vue";
import CollectionRecordPanel from "./CollectionRecordPanel.vue";
import CollectionViewConfigModal from "./CollectionViewConfigModal.vue";
import CollectionCustomView from "./CollectionCustomView.vue";
import CollectionRemoteViewPreview from "./CollectionRemoteViewPreview.vue";
import CollectionTable from "./CollectionTable.vue";
import { useCollectionRendering } from "../useCollectionRendering";
import {
  builtInViewAvailability,
  writeCollectionViewMode,
  writeCollectionSort,
  writeCollectionFlagFilters,
  type BuiltInViewAvailability,
  type CollectionViewMode,
} from "../collectionViewMode";
import type { CollectionConfirmOptions, CollectionPushResult } from "../uiContext";
import { useCollectionUi } from "../scopedUi";
import { pushKeptDeletes, pushMessage, pushProblems } from "../calendarPushResult";
import { useTableSort } from "../composables/useTableSort";
import { useCollectionActions } from "../composables/useCollectionActions";
import { useFlagFilters } from "../composables/useFlagFilters";
import { useCollectionChat } from "../composables/useCollectionChat";
import { useViewMode } from "../composables/useViewMode";
import { useLiveCollectionRefresh } from "../composables/useLiveCollectionRefresh";
import {
  dateOf,
  fieldDefaultValue,
  itemMatchesQuery,
  snapshotEmptyEnums,
  rowIdOf,
  toggleChecked,
  nextUniqueItemId,
  newItemId,
  COMPUTED_TYPES,
  buildUpdatedRecord,
  coerceInlineValue,
  draftToRecord,
  firstMissingRequiredField,
  rowFromItem,
  type Ymd,
  type SortValueDeps,
  type CollectionCustomView as CustomViewSpec,
  type CollectionDetail,
  type CollectionItem,
  type CollectionFieldSpec as FieldSpec,
  type CollectionRecordIssue,
  type CollectionNotifySeverity,
  type EditState,
  type TableRowDraft,
} from "@mulmoclaude/core/collection";

/** `slug` / `selected` are supplied only in EMBEDDED mode (the
 *  `presentCollection` chat card mounts this component and drives both
 *  from the tool result). In standalone route mode (the
 *  `/collections/:slug` page) both are undefined and the component reads
 *  `route.params.slug` / `route.query.selected` as before.
 *
 *  `sendTextMessage` is forwarded ONLY by the chat card — its presence
 *  is our "rendered inside a chat" signal. When set, chat-triggering
 *  actions send into the current session instead of spawning a new
 *  chat (see `runAction` / `submitChat`). */
const props = defineProps<{
  slug?: string | undefined;
  selected?: string | undefined;
  sendTextMessage?: ((text?: string) => void) | undefined;
  /** Embedded mode only: initial view / anchor / group restored from the
   *  card's persisted `viewState` so a switch to calendar or kanban
   *  survives a remount. (The table sort is NOT a card prop — it's a shared
   *  per-collection localStorage preference, read by both modes.) Accepts a
   *  `custom:<id>` mode too so the dashboard can open a tile directly on a
   *  custom view. */
  initialView?: CollectionViewMode | undefined;
  initialAnchorField?: string | undefined;
  initialGroupField?: string | undefined;
  /** Hide the header's view-mode toggle (table ↔ calendar ↔ kanban ↔
   *  custom + "add view"). The dashboard sets this because each tile
   *  carries its own view picker, persisting the choice to the dashboard
   *  layout rather than the card/localStorage. Search stays available. */
  hideViewToggle?: boolean;
  /** Hide the top header (icon / title / chat / add / delete). The
   *  dashboard sets this because each tile renders its own header
   *  (drag handle + icon + title + view picker), so the view's built-in
   *  header would be a redundant second title bar. */
  hideHeader?: boolean;
  /** Hide the record search input. The dashboard sets this to keep tiles
   *  compact; with the toggle also hidden the whole toolbar collapses. */
  hideSearch?: boolean;
}>();

const emit = defineEmits<{
  /** Embedded mode only: the open record changed (id) or closed (null).
   *  The card persists this in its tool-result `viewState` so the open
   *  item survives a re-render. */
  select: [id: string | null];
  /** Embedded mode only: the view mode / calendar anchor / kanban group
   *  changed. The card persists these alongside `selected` so the calendar,
   *  kanban and custom views stick. (The table sort is shared via localStorage
   *  instead.) */
  viewStateChange: [state: { view: CollectionViewMode; anchorField: string; groupField: string }];
}>();

const { t, locale } = useCollectionI18n();
// All host couplings (data, routing, confirm, chat, shortcuts, notifications,
// the pin toggle) come through the injected CollectionUi binding. The aliases
// keep the body's call sites unchanged where the host shape matched 1:1.
const cui = useCollectionUi();
// Called THROUGH `cui`, never copied off it: the binding a card resolves can
// change under this component (another card, another project), and a captured
// method would keep confirming / unpinning / seeding chats in the old project.
const openConfirm = (options: CollectionConfirmOptions): Promise<boolean> => cui.confirm(options);
const unpin = (kind: "collection" | "feed", slug: string): Promise<boolean> => cui.unpin(kind, slug);
const appApi = { startNewChat: (prompt: string, role: string): void => cui.startChat(prompt, role) };

/** Embedded when a `slug` prop is supplied; standalone (route-driven)
 *  otherwise. Switches the slug/selected source and the open/close
 *  navigation behaviour. */
const embedded = computed<boolean>(() => props.slug !== undefined);

/** Active collection slug: the prop in embedded mode, else the route
 *  param. */
const activeSlug = computed<string | undefined>(() => {
  if (props.slug !== undefined) return props.slug;
  const slug = cui.routeSlug();
  return slug !== undefined && slug.length > 0 ? slug : undefined;
});

/** Active open-record id: the prop in embedded mode (may be undefined),
 *  else the `?selected=` query. */
const activeSelected = computed<string | undefined>(() => {
  if (embedded.value) return props.selected;
  return cui.routeSelectedId();
});

const collection = ref<CollectionDetail | null>(null);
const items = ref<CollectionItem[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
// Record files the server flagged as malformed/invalid (silently skipped
// at read time). When non-empty the view shows a Repair banner whose
// button reports them back to the LLM. See `repairCollection`.
const dataIssues = ref<CollectionRecordIssue[]>([]);

// Primary-key → notification severity for this collection's records that
// currently have an active bell notification — passed to the Kanban board so
// it can flag those cards in the matching bell colour (urgent red / nudge amber).
const notifiedSeverities = computed<Map<string, CollectionNotifySeverity>>(() => {
  const slug = collection.value?.slug;
  return slug ? cui.notifiedSeverities(slug) : new Map<string, CollectionNotifySeverity>();
});
/** True while a feed collection's manual refresh is in flight. */
const refreshing = ref(false);
const pushing = ref(false);
/** Transient note shown after an agent-ingest Refresh dispatches a background
 *  worker (records update asynchronously, so there's nothing to show inline).
 *  Auto-clears; `refreshNoteTimer` cancels a pending clear on re-trigger. */
const refreshNote = ref<string | null>(null);
let refreshNoteTimer: ReturnType<typeof setTimeout> | undefined;
/** Slug already auto-refreshed on first open — prevents a reload loop
 *  (the auto-refresh reloads the view, which would re-trigger otherwise). */
const autoRefreshedSlug = ref<string | null>(null);
const editing = ref<EditState | null>(null);
/** The record currently shown in read-only "open" mode. Distinct
 *  from `editing`: open mode renders formatted values (no inputs)
 *  and is what a `/collections/<slug>?selected=<id>` deep link
 *  lands on. Mutually exclusive with `editing` in practice —
 *  `editFromView` hands off from one to the other. */
const viewing = ref<CollectionItem | null>(null);
/** The calendar day whose time-allocation popup is open, or null. The
 *  selected record (`viewing`) renders in that popup's right pane; a record
 *  with no resolvable day falls back to the panel below the grid. */
const openDay = ref<Ymd | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);
/** Error from an inline table-cell edit (checkbox/dropdown). Distinct
 *  from `saveError` (rendered only inside the detail panel, which is
 *  closed during inline editing) — shown as a banner above the table. */
const inlineError = ref<string | null>(null);
/** Per-load snapshot of enum cells that had NO value when fetched
 *  (keyed `<rowId>:<fieldKey>`). Only these cells offer the empty
 *  placeholder option in their inline dropdown — a cell that already
 *  has a value can't be blanked inline (use the edit form for that). */
const enumOriginallyEmpty = ref<Set<string>>(new Set());
/** Rows with an inline cell save in flight (by `rowId`). While a row is
 *  here its inline controls are disabled, so two quick edits to the same
 *  row can't race two full-record PUTs — an older PUT landing last would
 *  otherwise clobber the newer field on disk while the UI shows the
 *  newer optimistic value (Codex PR #1599 P2). */
const inlineSavingRows = ref<Set<string>>(new Set());

// Shared rendering + linked-data layer: owns the ref/embed caches and
// every value-formatting helper, reused by the extracted table / cell / record
// panel so there's one implementation. The whole object is passed down as the
// `render` prop; only the few helpers this component still calls directly
// (sort deps, dataSource route) are destructured here.
const render = useCollectionRendering(collection, locale);
const { refDisplay, evaluateDerivedAgainstItem, fileRoutePath } = render;

const searchQuery = ref("");

const filteredItems = computed<CollectionItem[]>(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return items.value;
  return items.value.filter((item) => itemMatchesQuery(item, query));
});

// ── Flag filter chips (table view only) ───────────────────────────
// One tri-state chip per predicate-shaped field (all → hide → only), ANDed with
// the text search. The reactive shell + per-collection localStorage state live
// in `useFlagFilters`; the tri-state transition / own-property read / colour
// mappings in `../flagFilterDisplay`. `tableFilteredItems` + `flagValueOf` feed
// the sort below.
// The filter-menu open/close + click-outside and the chip display/cycle helpers
// now live in CollectionToolbar (its `menuRef` must bind the wrapper the toolbar
// renders); the parent keeps only the filtering DATA — `flagFilters` (v-model to
// the toolbar + persist watch + empty-state clear), `flagChips` (toolbar prop),
// `tableFilteredItems` (table / sort / count), and `flagValueOf` (sort).
const {
  flagFilters,
  flagChips,
  tableFilteredItems,
  flagValueOf,
  resetForSlug: resetFlagFiltersForSlug,
} = useFlagFilters({ collection, filteredItems, activeSlug, deriveRecord: render.deriveRecord, t });

// ── List-table sort (single active column, header toggle) ─────────
// Row readers the pure `sortValueOf` can't get from the raw cell: toggle /
// flag projections, the derived-formula evaluator, the derived-record
// enrichment, and ref display resolution — all backed by the rendering
// composable. Stable function refs, so one object serves every row.
const sortValueDeps: SortValueDeps = {
  toggleChecked,
  flagValueOf,
  evaluateDerived: evaluateDerivedAgainstItem,
  deriveRecord: render.deriveRecord,
  resolveRefDisplay: refDisplay,
};

// Sort state + header display, extracted to a composable. Calendar / kanban keep
// their own ordering; only the table consumes `sortedItems`. The shared
// per-collection localStorage sort is read here and reset on collection switch
// (below); the write lives in the persist watch.
const {
  sortState,
  hoveredSortKey,
  sortedItems,
  cycleSort,
  resetForSlug: resetSortForSlug,
} = useTableSort({
  collection,
  tableFilteredItems,
  activeSlug,
  sortValueDeps,
});

// ────────────────────────────────────────────────────────────────
// Open / edit record panel (shared modal + calendar day view)
// ────────────────────────────────────────────────────────────────
// Detail, edit, and create all render `CollectionRecordPanel` inside the
// shared `CollectionRecordModal` (or the calendar day view for dated
// records). One panel open at a time (`viewing` / `editing` are single
// refs). The list table only highlights the open/edited row.

/** Stringified primary-key value for a row (the row's stable identity). */
function rowId(item: CollectionItem): string {
  return rowIdOf(collection.value?.schema.primaryKey, item);
}

/** This row is the one open in read-only detail. */
function isRowOpen(item: CollectionItem): boolean {
  return viewing.value !== null && rowId(viewing.value) === rowId(item);
}

/** rowId of the record open in read-only detail (drives the table's row
 *  highlight), or null when nothing is open. */
const openRowId = computed<string | null>(() => (viewing.value ? rowId(viewing.value) : null));

/** rowId of the record being edited (highlights it in the list while the edit
 *  modal is open), or null. Create mode has no backing row, so nothing matches. */
const editingRowId = computed<string | null>(() => {
  const draft = editing.value;
  if (!draft || draft.mode === "create") return null;
  return draft.originalId;
});

/** Re-run a collection's retrieval now, then reload its records: a feed's
 *  `ingest`, or a `googleCalendar` sync (#2427). Only reachable when one of
 *  the two is present (button is gated). */
async function refreshFeed(): Promise<void> {
  const current = collection.value;
  if (!current || refreshing.value) return;
  if (!current.schema.ingest && !current.schema.googleCalendar) return;
  refreshing.value = true;
  inlineError.value = null;
  const result = await cui.refreshCollection(current.slug);
  refreshing.value = false;
  if (!result.ok) {
    loadError.value = result.error;
    return;
  }
  await loadCollection(current.slug);
  // refreshOne reports retriever failures via `errors` even on HTTP 200, so
  // surface them — otherwise a failed refresh looks like success.
  if (result.data.errors.length > 0) {
    inlineError.value = t("collectionsView.refreshFailed", { error: result.data.errors.join("; ") });
    return;
  }
  // Agent ingest dispatched a worker — records update later. A manual refresh
  // runs a VISIBLE session: open it so the user can watch/debug the run. Fall
  // back to a transient note if the host can't navigate (router-less embed).
  if (result.data.dispatched) {
    if (result.data.chatId && cui.navigate) cui.navigate(`/chat/${result.data.chatId}`);
    else showRefreshNote(t("collectionsView.refreshDispatched"));
  }
}

/** Push locally created / edited records to the declared Google calendar
 *  (#2598) — the opposite direction from `refreshFeed`.
 *
 *  Reloads afterwards because a create gives Google the record's own id and the
 *  push stores the new baseline; the reload is what shows the user the state the
 *  next push will diff against. */
async function pushCalendar(): Promise<void> {
  const current = collection.value;
  if (!current || pushing.value || !current.schema.googleCalendar) return;
  pushing.value = true;
  inlineError.value = null;
  const result = await cui.pushCalendarCollection(current.slug);
  pushing.value = false;
  if (!result.ok) {
    loadError.value = result.error;
    return;
  }
  await loadCollection(current.slug);
  reportPush(result.data);
}

/** Say what the push did. Problems arrive as fields on an HTTP 200, so a silent
 *  success here would render a setup failure as "nothing to push".
 *
 *  A deletion Google refused is NOT a problem: it rides alongside the counts, so
 *  one refusal cannot hide what the run actually wrote (#3272). */
function reportPush(result: CollectionPushResult): void {
  const problems = pushProblems(result);
  const kept = keptDeletesNote(result);
  if (problems.length > 0) {
    // The refusal rides along even here: it is the only thing saying an event is
    // still standing in Google, and the help file promises every push reports it.
    // ` / ` rather than a space: no `pushFailed` template ends in punctuation, and
    // several locales have neither capitals nor inter-word spaces, so a space alone
    // leaves the two sentences with no boundary at all.
    inlineError.value = [t("collectionsView.pushFailed", { error: problems.join("; ") }), ...kept].join(" / ");
    return;
  }
  const { key, params } = pushMessage(result);
  showRefreshNote([t(key, params), ...kept].join(" "));
}

/** The sentence naming the deletions left standing, or nothing to add. */
function keptDeletesNote(result: CollectionPushResult): string[] {
  const kept = pushKeptDeletes(result);
  if (kept.length === 0) return [];
  return [t("collectionsView.pushKeptDeletes", { reasons: kept.join("; ") })];
}

/** Show a transient refresh note, replacing any pending auto-clear. */
function showRefreshNote(message: string): void {
  refreshNote.value = message;
  if (refreshNoteTimer !== undefined) clearTimeout(refreshNoteTimer);
  refreshNoteTimer = setTimeout(() => {
    refreshNote.value = null;
    refreshNoteTimer = undefined;
  }, 6000);
}

// ── Schema-declared actions (collection-level, per-record, mutate) ──
// The reactive shell + the `runningActions` generation guard live in
// `useCollectionActions`; the load path (`loadCollection` / `refreshItemsInPlace`)
// drives the guard through `clearRunningActions` / `beginRunningActionsReconcile`.
const {
  runningActions,
  actionPending,
  actionError,
  collectionActionPending,
  mutateModal,
  mutatePending,
  mutateError,
  collectionActions,
  visibleActions,
  viewingRunningActionIds,
  runCollectionAction,
  runAction,
  submitMutateParams,
  repairCollection,
  clearRunningActions,
  beginRunningActionsReconcile,
} = useCollectionActions({ collection, viewing, dataIssues, inlineError, cui, props, t });

// ── Chat entry points (header "chat about collection" + per-record chat box) ──
// The modal open/close + the skill/feed chat-seed builder live in
// `useCollectionChat`; the seed shape is core's `skillCommandSeed`.
const { chatOpen, openChat, closeChat, submitChat, onItemChat } = useCollectionChat({ collection, viewing, cui, props, closeRecord: closeRecordSurfaces, t });

// ── Related-collections pulldown ──────────────────────────────────────
// Its whole markup AND its `useRelatedMenu` (open-state, click-outside ref,
// lazy per-slug ontology fetch) live in CollectionHeader — the menu sits
// entirely inside the header, so the ref and the document listener belong in
// one component. The parent still drives the per-slug reset (in the activeSlug
// watcher below) through the child's exposed `resetForSlugChange`, at the same
// point it always did.
const collectionHeaderRef = ref<InstanceType<typeof CollectionHeader> | null>(null);

async function loadCollection(slug: string): Promise<void> {
  // Snapshot the shortcut kind BEFORE the await — if the user navigates
  // between /feeds/:slug and /collections/:slug while the fetch is in
  // flight, reading route.name in the 404 branch could unpin the wrong
  // (kind, slug) pair.
  const requestedKind = !embedded.value && cui.isFeedRoute() ? "feed" : "collection";
  loading.value = true;
  loadError.value = null;
  collection.value = null;
  items.value = [];
  dataIssues.value = []; // never carry a previous collection's issues over
  clearRunningActions(); // ditto for another collection's spinners
  searchQuery.value = ""; // Reset search query on collection load
  // NOTE: the active column sort is NOT reset here — it's part of the view
  // state, so it must survive a refresh / edit reload and an embedded card
  // remount. The collection-SWITCH reset lives in the `activeSlug` watch.
  render.resetLinkedCaches();
  viewing.value = null;
  openDay.value = null; // never carry a previous collection's open day over
  const reconcileRunningActions = beginRunningActionsReconcile();
  const result = await cui.fetchCollectionDetail(slug);
  loading.value = false;
  if (!result.ok) {
    loadError.value = result.status === 404 ? "not-found" : result.error;
    // Dead-click safety net: a pinned shortcut for a collection/feed
    // deleted out-of-band (e.g. via chat) lands here. Self-prune it so
    // the launcher doesn't keep a button that 404s. Standalone only
    // (embedded cards carry no shortcut), and only if we're still on the
    // slug that triggered this fetch.
    if (result.status === 404 && !embedded.value && activeSlug.value === slug) {
      void unpin(requestedKind, slug);
    }
    return;
  }
  collection.value = result.data.collection;
  items.value = result.data.items;
  dataIssues.value = result.data.issues ?? [];
  reconcileRunningActions(result.data.runningActions);
  enumOriginallyEmpty.value = snapshotEmptyEnums(result.data.collection.schema, result.data.items);
  // Fan out to fetch each unique target collection so the table can
  // render ref values as display names (not slugs) and the form
  // dropdown has options. Failures fall back gracefully — the table
  // cell shows the raw slug and the form falls back to text input.
  // Pass the slug that triggered THIS load so the helper can drop
  // its result if a faster subsequent load has already switched us
  // to a different collection (Codex P1 review on PR #1495).
  await render.loadLinkedCollections(result.data.collection.schema, slug);
  // A `?selected=<id>` deep link opens that record in read-only
  // mode once its items are available. Guard against a stale load:
  // only act if we're still on the slug that triggered this fetch.
  // Deliberately DON'T force calendar view here: the earlier
  // `maybeOpenCalendarForSelected` behaviour also wrote "calendar" to
  // localStorage, permanently overriding the user's table/kanban
  // preference for that collection. Deep-linked records open in the
  // user's saved view; if they want the calendar day popup, they can
  // switch to calendar from the header (#1675).
  if (collection.value?.slug === slug) {
    syncViewToSelected();
  }
  maybeAutoRefreshFeed(slug);
}

/** Refresh records + schema IN PLACE for a live (pub/sub-driven) update,
 *  preserving the user's browsing state — unlike `loadCollection`, which is the
 *  route-change path and resets it. Specifically: does NOT null `collection`
 *  (so the layout and an active custom-view iframe don't remount), keeps
 *  `searchQuery` / `openDay` / `sortState`, and shows no loading spinner; the
 *  open detail (`viewing`) is re-resolved against the fresh records by id, so it
 *  follows an edited record and closes only if the record was deleted. A failed
 *  fetch is a no-op (keep the current data) — a transient blip shouldn't blank a
 *  view the user is reading. */
async function refreshItemsInPlace(slug: string): Promise<void> {
  const reconcileRunningActions = beginRunningActionsReconcile();
  const result = await cui.fetchCollectionDetail(slug);
  // Bail if the fetch failed or the user switched collections mid-flight.
  if (!result.ok || activeSlug.value !== slug) return;
  collection.value = result.data.collection;
  items.value = result.data.items;
  dataIssues.value = result.data.issues ?? [];
  reconcileRunningActions(result.data.runningActions);
  enumOriginallyEmpty.value = snapshotEmptyEnums(result.data.collection.schema, result.data.items);
  await render.loadLinkedCollections(result.data.collection.schema, slug);
  if (activeSlug.value !== slug) return; // re-check after the await
  // Keep an open detail modal pointed at the fresh record object (or close it
  // if the record is now gone) — `viewing` holds a stale reference otherwise.
  if (viewing.value) {
    const openId = String(viewing.value[result.data.collection.schema.primaryKey] ?? "");
    viewing.value = findItemById(openId) ?? null;
  }
}

// First-open auto-refresh: when a feed view opens with no records yet
// (e.g. a just-registered feed that hasn't hit the scheduler), fetch once
// so data appears without a manual Refresh. Guarded per slug so the reload
// `refreshFeed` triggers can't loop; the view re-mounts per slug, so each
// open retries at most once.
//
// Restricted to ACTUAL feeds (`source === "feed"`): a declarative feed
// populates synchronously here, but a skill-backed `ingest.kind: "agent"`
// collection would dispatch a VISIBLE worker and navigate the user to its
// chat just by opening an empty collection — those refresh on schedule or an
// explicit Refresh click only.
function maybeAutoRefreshFeed(slug: string): void {
  if (embedded.value) return;
  const current = collection.value;
  if (current?.slug !== slug || current.source !== "feed") return;
  if (items.value.length > 0 || autoRefreshedSlug.value === slug) return;
  autoRefreshedSlug.value = slug;
  void refreshFeed();
}

/** Schema fields excluding display-only `embed` fields — used by the
 *  list table only (a whole embedded record doesn't fit a table cell,
 *  and it'd be identical in every row). The detail modal and the edit
 *  form iterate the full `schema.fields` so embeds render there too. */
// Fields shown as columns in the list table. Excludes `embed`
// (display-only fixed record, no per-record value), `backlinks` (a
// whole reverse-ref sub-table can't live in a cell — detail view only),
// `image` — a per-row <img> fetches one file each, too expensive for a
// collection with many records, and the image is shown in the detail
// view anyway — and the primary key (an id is plumbing, not data: it
// identifies the row via data-testid / ref links but doesn't earn a
// column).
const listColumnFields = computed<[string, FieldSpec][]>(() =>
  collection.value
    ? Object.entries(collection.value.schema.fields).filter(
        ([key, field]) => field.type !== "embed" && field.type !== "backlinks" && field.type !== "image" && key !== collection.value?.schema.primaryKey,
      )
    : [],
);

/** True when the current collection declares `schema.singleton` —
 *  exactly one record, its primary key fixed to the declared value. */
const isSingleton = computed<boolean>(() => Boolean(collection.value?.schema.singleton));

/** True when the collection is backed by an external `dataSource` (CSV) —
 *  read-only in every write surface here; the server enforces the same
 *  rule with 405s, this just keeps dead controls off the screen. */
const isReadOnly = computed<boolean>(() => collection.value?.schema.dataSource !== undefined);

/** File-explorer route for the dataSource file (the one editable thing
 *  about a read-only collection), or null on a router-less host. */
const dataSourceRoute = computed<string | null>(() => {
  const sourcePath = collection.value?.schema.dataSource?.path;
  return sourcePath ? fileRoutePath(sourcePath) : null;
});

/** Whether the Add button should show. Always for a normal collection;
 *  for a singleton only until its one record exists; never for a
 *  read-only (dataSource) collection. */
const canCreate = computed<boolean>(() => {
  if (!collection.value) return false;
  if (isReadOnly.value) return false;
  return !(isSingleton.value && items.value.length > 0);
});

// A collection is deletable only when it's project-scope AND not a
// preset (`mc-*`) — mirrors the server-side rule in
// `deleteCollection`. User-scope skills are read-only from MulmoClaude;
// presets re-seed on restart so deleting them is futile.
const canDeleteCollection = computed<boolean>(() => {
  const current = collection.value;
  if (!current) return false;
  return current.source === "project" && !current.slug.startsWith("mc-");
});

// True only for an actual Feed (discovered from `feeds/<slug>/`, source
// `feed`) — NOT merely any collection carrying an `ingest` block. A
// skill-backed collection can now declare `ingest.kind: "agent"` (scheduled
// agent refresh) yet still be a project-scope collection, deleted the normal
// way; keying off `schema.ingest` here used to surface a SECOND delete button
// on those. Feeds are deleted via DELETE /api/feeds/:slug.
const isFeed = computed<boolean>(() => collection.value?.source === "feed");
const canDeleteFeed = computed<boolean>(() => isFeed.value && !embedded.value);

// Which list to return to from the back arrow: feeds opened via /feeds
// go back to the feed list; everything else to the collections index.
const isFeedRoute = computed<boolean>(() => !embedded.value && cui.isFeedRoute());

// ── View mode (table | calendar | kanban) ─────────────────────────
// Local UI state only — NEVER persisted to schema. The user toggles it;
// the host never flips it programmatically. The calendar is offered only
// when the schema has a `date` field and the kanban only when it has an
// `enum` field (and neither is set to `false` in `builtinViews`), so plain
// collections and the initial load are unchanged (default "table").
//
// Standalone route mode persists the last-used mode per collection in
// localStorage so reopening `/collections/:slug` restores the prior view
// instead of always starting on the table. Embedded chat cards restore from
// the card's own `initialView` first; lacking that (a freshly-rendered
// presentCollection card), they fall back to the same per-collection store
// the standalone page uses, so a card also opens in the last-used view.
// `CollectionViewMode` ("table" | "calendar" | "kanban" | `custom:<id>`) is
// imported from the view-mode util.

// The raw `view` ref + its init/restore live in `useViewMode` (created below,
// once the field lists it gates on — hasCalendar / hasKanban / customViews —
// exist).

/** `date` / `datetime` fields in declaration order — the calendar can anchor
 *  on any (a `datetime` anchor also carries the clock for the day view). */
const dateFields = computed<string[]>(() =>
  collection.value
    ? Object.entries(collection.value.schema.fields)
        .filter(([, field]) => field.type === "date" || field.type === "datetime")
        .map(([key]) => key)
    : [],
);

/** Which built-in views the schema offers (field-derived, minus `builtinViews` opt-outs). */
const builtInViews = computed<BuiltInViewAvailability>(() =>
  collection.value ? builtInViewAvailability(collection.value.schema) : { calendar: false, kanban: false },
);

/** Whether the table ↔ calendar toggle is offered. */
const hasCalendar = computed<boolean>(() => builtInViews.value.calendar);

/** `enum` fields in declaration order — the kanban can group on any. */
const enumFields = computed<string[]>(() =>
  collection.value
    ? Object.entries(collection.value.schema.fields)
        .filter(([, field]) => field.type === "enum")
        .map(([key]) => key)
    : [],
);

/** Whether the kanban toggle is offered (needs an `enum` field to group on). */
const hasKanban = computed<boolean>(() => builtInViews.value.kanban);

/** Custom (LLM-authored) HTML views declared on the schema. Mobile-target
 *  views need the host's `fetchRemoteView` binding (the phone-frame preview's
 *  data source) — on a host without it they're hidden from the selector. */
const customViews = computed<CustomViewSpec[]>(() => {
  const views = collection.value?.schema.views ?? [];
  return cui.fetchRemoteView ? views : views.filter((entry) => entry.target !== "mobile");
});
const hasCustomViews = computed<boolean>(() => customViews.value.length > 0);

// View-mode state (raw `view` ref + `activeView` collapse + set/reset). The
// localStorage WRITE stays in the parent's combined persist watch below (with
// sort + flag filters + the embedded `viewStateChange` emit), same pattern as the
// sort / flag composables — this owns the ref + read-on-init + `resetForSlug`.
const {
  activeView,
  activeCustomView,
  calendarActive,
  kanbanActive,
  setView,
  setCustomView,
  resetForSlug: resetViewModeForSlug,
} = useViewMode({ activeSlug, props, hasCalendar, hasKanban, customViews });

/** Whether to offer the "+" (author a new custom view) button. Standalone
 *  page only (the seed starts a chat). Feeds qualify too — their views are
 *  authored under feeds/<slug>/ and the seed prompt points there. */
const canAddCustomView = computed<boolean>(() => Boolean(collection.value) && !embedded.value);

/** Whether authoring a phone (remote app) view is worth offering — mirrors
 *  the selector filter: without the host's `fetchRemoteView` binding a mobile
 *  view could be authored but never shown. Passed to the toolbar, which owns
 *  the "+" chooser (open/close + click-outside) and only signals the target. */
const canAddMobileView = computed<boolean>(() => Boolean(cui.fetchRemoteView));

/** Seed a chat asking Claude to author a new custom view for this collection.
 *  Reuses the same chat-seed path as collection actions — the host injects a
 *  templated prompt; Claude asks, authors the HTML, and registers it. The
 *  authoring base is source-aware: a feed lives under `feeds/<slug>/`, every
 *  other collection under the `data/skills/<slug>/` staging dir. The prompt
 *  is target-aware: phone views follow the custom-view-remote contract and
 *  register with `target: "mobile"`. */
function addCustomView(target: "desktop" | "mobile"): void {
  const current = collection.value;
  if (!current) return;
  const base = current.source === "feed" ? `feeds/${current.slug}` : `data/skills/${current.slug}`;
  const key = target === "mobile" ? "collectionsView.addMobileViewPrompt" : "collectionsView.addViewPrompt";
  const prompt = t(key, { title: current.title, base });
  if (props.sendTextMessage) {
    props.sendTextMessage(prompt);
    return;
  }
  appApi.startNewChat(prompt, cui.generalRoleId);
}

// ── Per-collection config (gear → manage custom views) ──────────────
const configOpen = ref<boolean>(false);

/** Whether to offer the config gear. Standalone page only, and only when
 *  there's a deletable custom view to manage — i.e. the collection is one
 *  whose views the server will delete (project non-preset, or a feed; never a
 *  read-only user-scope skill). Mirrors the server's refusal rules. */
const canConfigureViews = computed<boolean>(() => !embedded.value && hasCustomViews.value && (canDeleteCollection.value || isFeed.value));

/** Reload the collection after the config modal deletes a view so the toggle
 *  row + the modal's own list reflect the removal. */
async function onViewsChanged(): Promise<void> {
  const current = collection.value;
  if (current) await loadCollection(current.slug);
}

// In-view override for which enum field groups the board; null ⇒ the schema
// hint, else the first enum field.
const kanbanOverride = ref<string | null>(props.initialGroupField ?? null);
const kanbanGroupField = computed<string>(() => {
  if (kanbanOverride.value && enumFields.value.includes(kanbanOverride.value)) return kanbanOverride.value;
  const hint = collection.value?.schema.kanbanField;
  if (hint && enumFields.value.includes(hint)) return hint;
  return enumFields.value[0] ?? "";
});

// In-view override for which date field anchors the grid; null ⇒ the
// schema hint, else the first date field.
const anchorOverride = ref<string | null>(props.initialAnchorField ?? null);
const calendarAnchorField = computed<string>(() => {
  if (anchorOverride.value && dateFields.value.includes(anchorOverride.value)) return anchorOverride.value;
  const hint = collection.value?.schema.calendarField;
  if (hint && dateFields.value.includes(hint)) return hint;
  return dateFields.value[0] ?? "";
});
// The end field pairs with `schema.calendarField`. If the user switches the
// in-view anchor to a different date field, the span no longer applies —
// drop it so chips don't render from the new start to the original end.
const calendarEndField = computed<string | undefined>(() => {
  const schema = collection.value?.schema;
  if (!schema?.calendarEndField) return undefined;
  return calendarAnchorField.value === schema.calendarField ? schema.calendarEndField : undefined;
});
// The time-string field (e.g. ENGAGEMENTS' "time") that places records on the
// day view. Like the end field, it pairs with the schema's `calendarField` —
// dropped when the in-view anchor is switched to a different date field.
const calendarTimeField = computed<string | undefined>(() => {
  const schema = collection.value?.schema;
  if (!schema?.calendarTimeField) return undefined;
  return calendarAnchorField.value === schema.calendarField ? schema.calendarTimeField : undefined;
});

/** A slug-safe id not already used by a loaded record. A UUID never
 *  collides in practice, and the loaded set is only the rows this view
 *  holds anyway — the re-roll is kept because the server's overwrite
 *  guard is the real backstop and this costs nothing. */
function generateUniqueItemId(primaryKey: string): string {
  return nextUniqueItemId(items.value, primaryKey, newItemId);
}

/** The draft slots for one kind of field, built through `Object.fromEntries`
 *  rather than by assigning into an accumulator: a field may be named
 *  `__proto__` (JSON.parse hands that over as an own key), and `draft[key] = v`
 *  would run the prototype setter for that one name — the field would silently
 *  have no slot. `fromEntries` defines an own property whatever the name is
 *  (Codex review on #2910). */
function draftSlots<T>(fields: [string, FieldSpec][], keep: (field: FieldSpec) => boolean, valueOf: (key: string, field: FieldSpec) => T): Record<string, T> {
  return Object.fromEntries(fields.filter(([, field]) => keep(field)).map(([key, field]): [string, T] => [key, valueOf(key, field)]));
}

/** A stored `table` value as editable row drafts: anything that isn't a list of
 *  plain objects has no rows to edit. */
function tableRowsFromItem(raw: unknown, field: FieldSpec): TableRowDraft[] {
  const sub = field.type === "table" ? field.of : undefined;
  if (!sub || !Array.isArray(raw)) return [];
  return raw
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .map((row) => rowFromItem(row, sub));
}

const isBoolField = (field: FieldSpec): boolean => field.type === "boolean";
const isTableField = (field: FieldSpec): boolean => field.type === "table";
/** Everything else that gets a text slot — the computed/projected kinds
 *  (COMPUTED_TYPES: derived, embed, backlinks, rollup, toggle) have none. */
const isTextField = (field: FieldSpec): boolean => !isBoolField(field) && !isTableField(field) && !COMPUTED_TYPES.has(field.type);

function openCreate(): void {
  if (!collection.value) return;
  const fields = Object.entries(collection.value.schema.fields);
  const text = draftSlots(fields, isTextField, (_key, field) => fieldDefaultValue(field) ?? "");
  const bool = draftSlots(fields, isBoolField, () => false);
  // New record — no boolean was originally present.
  const boolOriginallyPresent = draftSlots(fields, isBoolField, () => false);
  const boolTouched = draftSlots(fields, isBoolField, () => false);
  const table = draftSlots(fields, isTableField, (): TableRowDraft[] => []);
  // Singleton collections fix the primary key to the schema-declared
  // value (e.g. "me") so the first Add can't pick an arbitrary id.
  // Otherwise pre-fill a unique, editable id so the user doesn't have to
  // invent one — the primary-key input stays enabled in create mode, so
  // they can still override it before saving. Same generator the server
  // uses for a blank-id POST (`generateItemId` delegates to `newItemId`).
  const { singleton, primaryKey } = collection.value.schema;
  if (singleton) {
    text[primaryKey] = singleton;
  } else if (Object.hasOwn(text, primaryKey) && !text[primaryKey]) {
    // Only when nothing filled it: an `enum` is a legal primary key, and a
    // generated UUID is not one of its `values` — the form would open blank on
    // a field that cannot be saved. `hasOwn` rather than `in`, so a primary key
    // named after something on Object.prototype reads its own slot rather than
    // an inherited one (Codex review on #2910).
    text[primaryKey] = generateUniqueItemId(primaryKey);
  }
  viewing.value = null; // one panel open at a time
  editing.value = { mode: "create", text, bool, boolOriginallyPresent, boolTouched, table, originalId: null };
  saveError.value = null;
}

function openEdit(item: CollectionItem): void {
  if (!collection.value) return;
  // Same `draftSlots` construction as the create path, and for the same
  // reason: a field may be named `__proto__`, which an assignment would send
  // to the prototype setter instead of a draft slot (Codex/CodeRabbit on
  // #2910). Without a slot the field cannot be edited at all.
  const fields = Object.entries(collection.value.schema.fields);
  const text = draftSlots(fields, isTextField, (key) => (item[key] === undefined || item[key] === null ? "" : String(item[key])));
  const bool = draftSlots(fields, isBoolField, (key) => item[key] === true);
  // Whether the key was present in the source record, so an untouched field
  // stays omitted through a save. `typeof === "boolean"` is more defensive than
  // `key in item`: a wrong-typed value (`billable: "yes"`) is not a real state.
  const boolOriginallyPresent = draftSlots(fields, isBoolField, (key) => typeof item[key] === "boolean");
  const boolTouched = draftSlots(fields, isBoolField, () => false);
  const table = draftSlots(fields, isTableField, (key, field): TableRowDraft[] => tableRowsFromItem(item[key], field));
  const primaryRaw = item[collection.value.schema.primaryKey];
  const originalId = typeof primaryRaw === "string" ? primaryRaw : String(primaryRaw ?? "");
  viewing.value = null; // one panel open at a time
  editing.value = { mode: "edit", text, bool, boolOriginallyPresent, boolTouched, table, originalId };
  saveError.value = null;
}

function closeEditor(): void {
  editing.value = null;
  saving.value = false;
  saveError.value = null;
}

/** Cancel the editor. Edit → reopen the record's read-only detail (don't
 *  collapse the panel); create → just close (no prior detail to show). */
function cancelEditor(): void {
  const draft = editing.value;
  const returnTo = draft && draft.mode === "edit" ? draft.originalId : null;
  closeEditor();
  if (returnTo) {
    const item = findItemById(returnTo);
    if (item) showDetail(item);
  }
}

/** Open mode (read-only detail). Toggles: clicking the already-open row
 *  collapses it. Opening a row cancels any in-progress edit (one panel
 *  open at a time). In embedded mode, report the open id so the host
 *  card can persist it in `viewState`. */
function openView(item: CollectionItem): void {
  if (isRowOpen(item) && !editing.value) {
    closeView();
    return;
  }
  if (editing.value) closeEditor();
  showDetail(item);
}

/** Open the read-only detail for a record WITHOUT the click-toggle. Used
 *  when reopening detail programmatically (after save / cancel), where
 *  `openView`'s "click the open row to collapse" guard would otherwise
 *  immediately close a row the embedded `viewState` sync just reopened. */
function showDetail(item: CollectionItem): void {
  viewing.value = item;
  actionError.value = null;
  if (embedded.value && collection.value) {
    emit("select", String(item[collection.value.schema.primaryKey] ?? ""));
  }
}

/** Close open mode. Embedded mode reports the close via `select(null)`
 *  (the card clears its `viewState`); standalone mode drops the
 *  `?selected=` query param so a refresh / back-button doesn't reopen
 *  the record and the URL reflects the closed state. */
function closeView(): void {
  viewing.value = null;
  actionError.value = null;
  if (embedded.value) {
    emit("select", null);
    return;
  }
  if (cui.routeSelectedId() !== undefined) {
    cui.setSelectedId(null);
  }
}

/** Backdrop click / Escape on the shared record modal. While editing this
 *  cancels the draft (reopening the detail, matching the in-panel Cancel
 *  button — so a stray click never silently discards edits); while viewing
 *  it closes the detail. */
function closeRecordModal(): void {
  if (editing.value) {
    cancelEditor();
    return;
  }
  closeView();
}

/** Hand off from open mode to the editor for the same record. */
function editFromView(): void {
  const item = viewing.value;
  if (!item) return;
  viewing.value = null;
  openEdit(item);
}

function findItemById(itemId: string): CollectionItem | undefined {
  if (!collection.value) return undefined;
  const { primaryKey } = collection.value.schema;
  return items.value.find((item) => String(item[primaryKey] ?? "") === itemId);
}

/** Reconcile the open-mode view with the `?selected=<id>` query —
 *  the single source of truth for which record is open. Opens the
 *  matching record, or closes the modal when the param is absent /
 *  empty / points at an id that isn't loaded (deleted record, stale
 *  link). Keeping `viewing` in lockstep with the URL means browser
 *  back / forward and a removed param both close the modal instead
 *  of leaving stale UI on screen (Codex P2 + CodeRabbit on #1502). */
function syncViewToSelected(): void {
  const selected = activeSelected.value;
  if (typeof selected !== "string" || selected.length === 0) {
    viewing.value = null;
    return;
  }
  const match = findItemById(selected) ?? null;
  viewing.value = match;
  // A deep link / notification opens the record in the shared modal, which
  // is centred regardless of where the row sits in a long list — no scroll
  // needed (the inline-expansion era required one).
}

/** Title for the open-mode header: the record's primary-key value
 *  (e.g. `INV-2026-0001`), falling back to the collection title.
 *  Non-string primary keys (numeric ids) are stringified rather
 *  than discarded (CodeRabbit on #1502). */
const viewTitle = computed<string>(() => {
  if (!viewing.value || !collection.value) return "";
  const pkValue = viewing.value[collection.value.schema.primaryKey];
  if (pkValue === undefined || pkValue === null || pkValue === "") return collection.value.title ?? "";
  return String(pkValue);
});

/** Live computed record from the current draft. Drives derived
 *  field displays in the form so subtotal/tax/total update as
 *  the user edits line items. */
const liveRecord = computed<CollectionItem | null>(() => {
  if (!collection.value || !editing.value) return null;
  return draftToRecord(editing.value, collection.value.schema);
});

/** Live record with derived fields resolved (drives the form's
 *  read-only derived inputs). Derivation lives in the shared
 *  rendering composable; this binds it to the current draft. */
const liveDerived = computed<CollectionItem | null>(() => {
  if (!collection.value || !liveRecord.value) return null;
  return render.deriveRecord(liveRecord.value);
});

async function saveEditor(): Promise<void> {
  if (!collection.value || !editing.value) return;
  // Snapshot mutable refs before any await — route changes during
  // the save (e.g. user navigates away) can null `collection.value`
  // and would throw on the post-await `loadCollection(...)`.
  const { slug, schema } = collection.value;
  const draft = editing.value;
  saveError.value = null;

  const missing = firstMissingRequiredField(draft, schema);
  if (missing) {
    saveError.value = `${missing}: ${t("collectionsView.requiredField")}`;
    return;
  }

  saving.value = true;
  const record = draftToRecord(draft, schema);
  const isCreate = draft.mode === "create";
  const result = isCreate ? await cui.createItem(slug, record) : await cui.updateItem(slug, draft.originalId ?? "", record);
  saving.value = false;
  if (!result.ok) {
    saveError.value = result.error;
    return;
  }
  const savedId = result.data.itemId;
  closeEditor();
  await loadCollection(slug);
  // Return to the saved record's read-only detail (for create, this is the
  // newly added row) in the shared modal.
  const saved = findItemById(savedId);
  if (saved) showDetail(saved);
}

/** Write a single cell's value directly onto the live `items` entry.
 *  Reactive in Vue 3 (proxy), so the bound checkbox/select re-renders.
 *  `undefined` (enum cleared to the placeholder) renders as the empty
 *  option; the PUT body omits the key via `buildUpdatedRecord`. */
function applyInlineValue(item: CollectionItem, key: string, value: unknown): void {
  item[key] = value;
}

/** Inline table-cell edit (boolean checkbox / enum dropdown): optimistic
 *  update, then PUT the full record. Gated per row so a second edit can't
 *  race the in-flight one. On failure, roll the cell back and surface the
 *  error. Bypasses the detail/edit panel entirely. */
async function commitInlineEdit(item: CollectionItem, key: string, field: FieldSpec, raw: boolean | string): Promise<void> {
  if (!collection.value || isReadOnly.value) return;
  const { slug } = collection.value;
  const itemId = rowId(item);
  if (!itemId || inlineSavingRows.value.has(itemId)) return;
  const previous = item[key];
  const coerced = coerceInlineValue(field, raw);
  applyInlineValue(item, key, coerced);
  inlineError.value = null;
  inlineSavingRows.value.add(itemId);
  const result = await cui.updateItem(slug, itemId, buildUpdatedRecord(item, key, coerced));
  inlineSavingRows.value.delete(itemId);
  if (!result.ok) {
    applyInlineValue(item, key, previous);
    inlineError.value = result.error;
  }
}

/** Flip a `toggle`: write the projected enum field to `offValue` when
 *  currently checked, else `onValue`. Reuses the inline-edit PUT path
 *  (optimistic + rollback) — the toggle has no value of its own. */
function commitToggle(item: CollectionItem, field: FieldSpec): void {
  if (field.type !== "toggle" || !collection.value) return;
  const targetKey = field.field;
  const enumField = collection.value.schema.fields[targetKey];
  if (!enumField) return;
  const next = toggleChecked(item, field) ? field.offValue : field.onValue;
  void commitInlineEdit(item, targetKey, enumField, next);
}

async function confirmDelete(item: CollectionItem): Promise<void> {
  if (!collection.value) return;
  // Snapshot before any await (see saveEditor) — confirm dialog
  // awaits user input, plenty of time for the route to change.
  const { slug } = collection.value;
  const { primaryKey } = collection.value.schema;
  const idRaw = item[primaryKey];
  const itemId = typeof idRaw === "string" ? idRaw : String(idRaw ?? "");
  if (!itemId) return;
  const ok = await openConfirm({
    message: t("collectionsView.confirmDelete"),
    confirmText: t("common.remove"),
    cancelText: t("common.cancel"),
    variant: "danger",
  });
  if (!ok) return;
  const result = await cui.deleteItem(slug, itemId);
  if (!result.ok) {
    loadError.value = result.error;
    return;
  }
  await loadCollection(slug);
}

// Delete the whole collection (skill + records), not just one item.
// The server archives a restorable copy first; on success we leave the
// now-gone collection's route for the index.
async function confirmCollectionDelete(): Promise<void> {
  const current = collection.value;
  if (!current) return;
  // Snapshot before the await — the confirm dialog yields control and
  // the route could change underneath us (see confirmDelete).
  const { slug, title } = current;
  const ok = await openConfirm({
    message: t("collectionsView.confirmDeleteCollection", { title }),
    confirmText: t("common.remove"),
    cancelText: t("common.cancel"),
    variant: "danger",
  });
  if (!ok) return;
  const result = await cui.deleteCollection(slug);
  if (!result.ok) {
    loadError.value = result.error;
    return;
  }
  cui.gotoIndex("collection");
}

function goBack(): void {
  cui.gotoIndex(isFeedRoute.value ? "feed" : "collection");
}

// Delete a feed: remove its feeds/<slug>/ registry entry (records on disk
// are retained), then return to the feed list. Distinct from
// `confirmCollectionDelete`, which archives + deletes a skill-backed
// collection through the project-scope collection-delete route.
async function confirmFeedDelete(): Promise<void> {
  const current = collection.value;
  if (!current) return;
  const { slug, title } = current;
  const ok = await openConfirm({
    message: t("collectionsView.confirmDeleteFeed", { title }),
    confirmText: t("common.remove"),
    cancelText: t("common.cancel"),
    variant: "danger",
  });
  if (!ok) return;
  const result = await cui.deleteFeed(slug);
  if (!result.ok) {
    loadError.value = result.error;
    return;
  }
  cui.gotoIndex("feed");
}

// Load on slug change, immediate so the initial value (route param or
// prop) triggers the first fetch — replaces the old `onMounted` +
// separate slug watch. Works identically for route mode (reads
// `route.params.slug`) and embedded mode (reads the `slug` prop).
/** Open the create form with the clicked calendar day prefilled into the
 *  anchor field. The calendar day view's + affordance; the create flow itself
 *  is the same one the Add button uses. A `datetime` anchor renders as a
 *  `datetime-local` input, which rejects a bare `YYYY-MM-DD` — seed midnight
 *  so the chosen day actually survives the prefill. */
function createOnDate(iso: string): void {
  if (!canCreate.value) return;
  openCreate();
  const anchor = calendarAnchorField.value;
  if (!editing.value || !anchor) return;
  const anchorType = collection.value?.schema.fields[anchor]?.type;
  editing.value.text[anchor] = anchorType === "datetime" ? `${iso}T00:00` : iso;
}

/** The civil day a record sits on, from its calendar anchor field (handles
 *  both `date` and `datetime`). Null for undated records. */
function dayOfItem(item: CollectionItem): Ymd | null {
  return dateOf(item[calendarAnchorField.value]);
}

/** Mirror the open record into the `?selected=<id>` query (standalone mode)
 *  so the calendar's day-view + selection is a copy-pasteable link. In-app
 *  selection didn't previously touch the URL; the calendar now does. */
function writeSelectedToUrl(itemId: string): void {
  if (embedded.value || cui.routeSelectedId() === itemId) return;
  cui.setSelectedId(itemId);
}

/** Calendar chip / kanban card click → open that record's detail. In the
 *  calendar it opens the day (time-allocation) popup on the record's day with
 *  the detail in the right pane; an undated record falls back to the panel
 *  below the grid. Unlike `openView`, this never toggles — a second click on
 *  the same record keeps it open. */
function onCalendarSelect(itemId: string | null): void {
  if (!itemId) {
    closeView();
    return;
  }
  const item = findItemById(itemId);
  if (!item) return;
  if (editing.value) closeEditor();
  // Anchor the popup on the record's day; null for an undated record, which
  // closes the popup so its detail falls back to the panel below the grid.
  if (calendarActive.value) openDay.value = dayOfItem(item);
  showDetail(item);
  writeSelectedToUrl(itemId);
}

/** A custom (sandboxed) view asked to open a record in the shared modal.
 *  `view` → read-only detail, `edit` → straight into the editor. Ungated: the
 *  capability token governs the view's *code*, not user actions through the
 *  host's own trusted modal (no write happens without an explicit Save). */
function onCustomViewOpenItem(payload: { id: string; mode: "view" | "edit" }): void {
  const item = findItemById(payload.id);
  if (!item) return;
  if (editing.value) closeEditor();
  if (payload.mode === "edit") {
    openEdit(item);
    return;
  }
  showDetail(item);
  writeSelectedToUrl(payload.id);
}

/** The custom view called `__MC_VIEW.startChat(prompt, role)` — open a new chat
 *  seeded with the prompt. `role` is optional; the host honours it only when it
 *  names a role it allows — known, and not a debug role — and opens in General
 *  otherwise, the same way a schema action's role does.
 *
 *  Draft by default: the view's code only PROPOSES text, and the user approves /
 *  edits / sends it, so no capability is required. A view whose `views[]` entry
 *  declares `allowSendChat: true` sends instead — one press runs the turn (#3062).
 *  That flag is read off the SCHEMA by the view components, never taken from the
 *  iframe's message, so the sandbox cannot grant itself the send. */
function onCustomViewStartChat(payload: { prompt: string; role?: string | undefined; send: boolean }): void {
  const prompt = payload.prompt.trim();
  if (!prompt) return;
  // `startChat` needs a concrete role where the draft path takes an optional one,
  // so an omitted role becomes General here rather than host-side.
  if (payload.send) cui.startChat(prompt, payload.role ?? cui.generalRoleId);
  else cui.startNewChatDraft(prompt, payload.role);
}

/** A calendar day cell was activated → open its popup on a clean slate
 *  (clear any prior selection so the popup opens timeline-only). */
function onOpenDay(day: Ymd): void {
  if (editing.value) closeEditor();
  closeView();
  openDay.value = day;
}

/** Take down every full-screen surface the open record can sit in — the day
 *  popup, any in-progress draft, and the detail itself. Clearing `editing`
 *  matters because the shared record modal shows whenever `editing` is set and
 *  no day is open — so without this, an edit/create started inside the day
 *  popup would re-appear in the centred modal the instant the popup closed
 *  (Codex P2 on #1656). */
function closeRecordSurfaces(): void {
  openDay.value = null;
  if (editing.value) closeEditor();
  closeView();
}

/** Kanban card dropped in a column → set the record's group field to the
 *  column value (the empty string clears it for the Uncategorized column).
 *  Reuses the inline-edit path (optimistic write + PUT + rollback). */
function onKanbanMove(itemId: string, value: string): void {
  const item = findItemById(itemId);
  const key = kanbanGroupField.value;
  const field = collection.value?.schema.fields[key];
  if (!item || !field) return;
  void commitInlineEdit(item, key, field, value);
}

watch(
  activeSlug,
  (slug, prevSlug) => {
    // Reset view state when switching BETWEEN collections — but not on the
    // initial run (prevSlug undefined), so an embedded card's restored
    // `initialView` / `initialAnchorField` survive the first load. Both modes
    // restore the new collection's stored mode (else "table"); the axis
    // fields always reset to their schema defaults.
    if (prevSlug !== undefined && slug !== prevSlug) {
      resetViewModeForSlug(slug);
      anchorOverride.value = null;
      kanbanOverride.value = null;
      // The toolbar closes its own filter / add-view menus on this slug change
      // (it owns their open state now).
      // Drop the previous collection's cached neighbors so the next open
      // re-derives them for the new slug (also clears any in-flight spinner).
      collectionHeaderRef.value?.resetForSlugChange();
      // A sort belongs to a collection's own schema, so don't carry it across —
      // restore the new collection's stored (shared) sort instead. Same for
      // the flag filter chips.
      resetSortForSlug(slug);
      resetFlagFiltersForSlug(slug);
    }
    if (slug) {
      loadCollection(slug);
    } else {
      collection.value = null;
      items.value = [];
      enumOriginallyEmpty.value = new Set();
      inlineSavingRows.value = new Set();
      searchQuery.value = ""; // Reset search query
      loading.value = false;
    }
  },
  { immediate: true },
);

// ── Live updates ──
// Refetch when the server reports a record change for the active collection —
// agent writes (the common case: a record added/updated mid-chat), UI writes
// from another tab/window, feed refreshes, and host-driven `spawn` successors
// all ride the host's collection-change channel. `subscribeChanges` is an
// OPTIONAL host capability: a host without a pub/sub transport omits it and the
// view simply keeps its existing manual-refresh behaviour.
//
// Debounced so a bulk write (N rows) collapses to one refetch, and DEFERRED
// (not dropped) while an inline/create edit is unsaved so a live refetch never
// clobbers the user's draft. A change that lands mid-edit sets a pending flag
// that the `editing` watch below flushes once the edit ends — whether it ends
// by save or cancel — so a cancelled edit doesn't leave the view stale.
useLiveCollectionRefresh({ activeSlug, editing, cui, refreshItemsInPlace });

onUnmounted(() => {
  if (refreshNoteTimer !== undefined) clearTimeout(refreshNoteTimer);
});

// Embedded mode: report view/anchor changes so the chat card persists them
// in `viewState` (alongside `selected`). Standalone mode: persist the view
// mode per slug in localStorage so reopening restores it.
// `loading` is a dependency so the write re-runs when the collection finishes
// loading: that's the point where a stored mode unsupported by this schema
// (its date/enum field gone) has collapsed to "table" and must be normalized
// back into storage — otherwise no other dependency changes and it lingers.
watch([activeView, calendarAnchorField, kanbanGroupField, sortState, flagFilters, loading], () => {
  // Persist the EFFECTIVE view (activeView), not the raw `view` ref — a
  // stale "calendar"/"kanban" that has fallen back to "table" (its enabling
  // field gone) must not be saved as an impossible mode.
  if (embedded.value) {
    emit("viewStateChange", { view: activeView.value, anchorField: calendarAnchorField.value, groupField: kanbanGroupField.value });
  }
  // Don't write during the load window: until the collection resolves,
  // `hasCalendar`/`hasKanban` are false so `activeView` reads "table",
  // which would clobber a stored "calendar"/"kanban" before it can apply.
  if (activeSlug.value && !loading.value && collection.value) {
    // View mode stays standalone-authored — embedded reads but never writes it,
    // so a stale card can't clobber the shared mode. The table SORT, by
    // contrast, IS shared both ways: a card always re-reads it on mount, so
    // there's no per-card value to go stale and clobber the store.
    if (!embedded.value) writeCollectionViewMode(activeSlug.value, activeView.value);
    writeCollectionSort(activeSlug.value, sortState.value);
    // Flag chips share the sort's both-ways model: a card re-reads them on
    // mount, so there's no per-card value to go stale and clobber the store.
    writeCollectionFlagFilters(activeSlug.value, flagFilters.value);
  }
});

// React to the active selection changing while already on this
// collection: follow it to open the new record, OR close the modal when
// it's cleared (browser back / card close) or points at a missing id.
// The initial / cross-collection case is handled by `loadCollection`;
// here we only act once items are loaded.
watch(activeSelected, () => {
  if (loading.value || !collection.value) return;
  syncViewToSelected();
  // Keep the calendar-owned openDay in step with the selection — re-anchor it on
  // the selected record's day, or clear it when the selection is gone. Do this
  // even when the calendar isn't the active view: openDay is calendar state, so
  // a selection cleared in the table must not survive into a later calendar
  // visit. Never force a view switch here — that's loadCollection's deep-link job.
  openDay.value = viewing.value ? dayOfItem(viewing.value) : null;
});
</script>
