<template>
  <div class="px-6 py-3 bg-white border-b border-slate-100 flex items-center justify-between gap-4">
    <div v-if="!hideSearch && items.length > 0" class="relative flex-1 max-w-md">
      <span class="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 pointer-events-none">
        <span class="material-icons text-lg">search</span>
      </span>
      <input
        v-model="searchQuery"
        type="text"
        :placeholder="t('collectionsView.searchPlaceholder')"
        :aria-label="t('collectionsView.searchPlaceholder')"
        class="w-full bg-slate-50 border border-slate-200/80 rounded-xl pl-9 pr-8 py-1.5 text-xs placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:bg-white transition-all font-medium"
      />
      <button
        v-if="searchQuery"
        type="button"
        :aria-label="t('collectionsView.clearSearch')"
        class="absolute inset-y-0 right-0 flex items-center pr-2.5 text-slate-400 hover:text-slate-600"
        @click="searchQuery = ''"
      >
        <span class="material-icons text-sm">close</span>
      </button>
    </div>
    <div class="flex items-center gap-2">
      <!-- Filter menu (table view only): one tri-state entry (all → hide
           → only) per predicate-shaped field — `flag`, `boolean`,
           `toggle` — plus a synthesized "done" entry for legacy
           completion-pair schemas. Collapsed behind a single trigger so
           a chip-heavy schema can't flood the chrome row, and styled as
           a dashed pill (soft-tinted when active) so it never reads as
           another view-toggle button. State is a shared per-collection
           localStorage preference, like the table sort. -->
      <div v-if="activeView === 'table' && flagChips.length > 0 && items.length > 0" ref="filterMenuRef" class="relative">
        <button
          type="button"
          class="h-8 px-2.5 flex items-center gap-1 rounded-full text-xs font-medium transition-colors"
          :class="
            activeFlagFilterCount > 0
              ? 'bg-indigo-50 text-indigo-700 border border-indigo-300'
              : 'bg-transparent text-slate-500 border border-dashed border-slate-300 hover:bg-slate-50'
          "
          :aria-label="t('collectionsView.flagFilterButton')"
          :aria-expanded="filterMenuOpen"
          data-testid="collections-filter-menu"
          @click="filterMenuOpen = !filterMenuOpen"
        >
          <span class="material-icons text-sm" aria-hidden="true">filter_alt</span>
          <span>{{ t("collectionsView.flagFilterButton") }}</span>
          <span
            v-if="activeFlagFilterCount > 0"
            class="min-w-4 h-4 px-1 flex items-center justify-center rounded-full bg-indigo-600 text-white text-[10px] font-bold"
            >{{ activeFlagFilterCount }}</span
          >
        </button>
        <div
          v-if="filterMenuOpen"
          class="absolute left-0 top-full mt-1 z-20 min-w-max rounded border border-slate-200 bg-white shadow-lg py-1"
          role="group"
          :aria-label="t('collectionsView.flagFilterButton')"
          data-testid="collections-filter-menu-panel"
        >
          <button
            v-for="chip in flagChips"
            :key="chip.key"
            type="button"
            class="w-full h-8 px-3 flex items-center gap-2 text-xs font-medium transition-colors hover:bg-slate-50"
            :class="flagChipClass(chip.key)"
            :title="flagChipTitle(chip)"
            :aria-label="flagChipTitle(chip)"
            :aria-pressed="flagFilterMode(chip.key) !== undefined"
            :data-testid="`collections-flag-chip-${chip.key}`"
            @click="cycleFlagFilter(chip.key)"
          >
            <span class="material-icons text-sm" :class="flagChipIconClass(chip.key)" aria-hidden="true">{{ flagChipIcon(chip.key) }}</span>
            <span class="flex-1 text-left">{{ chip.label }}</span>
          </button>
        </div>
      </div>
      <!-- View toggle: table ↔ calendar ↔ kanban. Calendar shows only when
           the schema has a `date` field, kanban only with an `enum` field
           (either withheld by `builtinViews`);
           local UI state, never persisted. -->
      <div
        v-if="!hideViewToggle && (hasCalendar || hasKanban || hasCustomViews || canAddCustomView)"
        class="flex gap-0.5"
        role="group"
        :aria-label="t('collectionsView.viewToggle')"
      >
        <button
          type="button"
          class="h-8 px-2.5 flex items-center gap-1 rounded text-xs font-bold transition-colors"
          :class="activeView === 'table' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'"
          :aria-pressed="activeView === 'table'"
          data-testid="collection-view-toggle-table"
          @click="emit('setView', 'table')"
        >
          <span class="material-icons text-sm">table_rows</span>
          <span>{{ t("collectionsView.viewTable") }}</span>
        </button>
        <button
          v-if="hasCalendar"
          type="button"
          class="h-8 px-2.5 flex items-center gap-1 rounded text-xs font-bold transition-colors"
          :class="activeView === 'calendar' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'"
          :aria-pressed="activeView === 'calendar'"
          data-testid="collection-view-toggle-calendar"
          @click="emit('setView', 'calendar')"
        >
          <span class="material-icons text-sm">calendar_month</span>
          <span>{{ t("collectionsView.viewCalendar") }}</span>
        </button>
        <button
          v-if="hasKanban"
          type="button"
          class="h-8 px-2.5 flex items-center gap-1 rounded text-xs font-bold transition-colors"
          :class="activeView === 'kanban' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'"
          :aria-pressed="activeView === 'kanban'"
          data-testid="collection-view-toggle-kanban"
          @click="emit('setView', 'kanban')"
        >
          <span class="material-icons text-sm">view_kanban</span>
          <span>{{ t("collectionsView.viewKanban") }}</span>
        </button>
        <!-- Custom (LLM-authored) views declared on the schema. -->
        <button
          v-for="cv in customViews"
          :key="cv.id"
          type="button"
          class="h-8 px-2.5 flex items-center gap-1 rounded text-xs font-bold transition-colors"
          :class="activeView === customViewKey(cv.id) ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'"
          :aria-pressed="activeView === customViewKey(cv.id)"
          :data-testid="`collection-view-custom-${cv.id}`"
          @click="emit('setCustomView', cv.id)"
        >
          <IconGlyph :icon="cv.icon" :fallback="cv.target === 'mobile' ? 'smartphone' : 'dashboard_customize'" size-class="text-sm" />
          <span>{{ cv.label }}</span>
        </button>
        <!-- "+" — ask Claude to author a new custom view for this collection.
             Opens a chooser (desktop vs phone target) when the host supports
             remote views; otherwise seeds the desktop prompt directly. -->
        <div v-if="canAddCustomView" ref="addMenuRef" class="relative">
          <button
            type="button"
            class="h-8 w-8 flex items-center justify-center rounded bg-white text-slate-500 border border-slate-200 hover:bg-slate-50"
            :title="t('collectionsView.addView')"
            :aria-label="t('collectionsView.addView')"
            :aria-expanded="addMenuOpen"
            data-testid="collection-view-add"
            @click="onAddViewClick"
          >
            <span class="material-icons text-sm">add</span>
          </button>
          <div
            v-if="addMenuOpen"
            class="absolute left-0 top-full mt-1 z-20 min-w-max rounded border border-slate-200 bg-white shadow-lg py-1"
            data-testid="collection-view-add-menu"
          >
            <button
              type="button"
              class="w-full h-8 px-3 flex items-center gap-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
              data-testid="collection-view-add-desktop"
              @click="addCustomView('desktop')"
            >
              <span class="material-icons text-sm">dashboard_customize</span>
              <span>{{ t("collectionsView.addViewDesktop") }}</span>
            </button>
            <button
              type="button"
              class="w-full h-8 px-3 flex items-center gap-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
              data-testid="collection-view-add-mobile"
              @click="addCustomView('mobile')"
            >
              <span class="material-icons text-sm">smartphone</span>
              <span>{{ t("collectionsView.addViewMobile") }}</span>
            </button>
          </div>
        </div>
        <!-- Gear — per-collection config (currently: manage/delete custom
             views). Standalone only, and only when there's a view to manage. -->
        <button
          v-if="canConfigureViews"
          type="button"
          class="h-8 w-8 flex items-center justify-center rounded bg-white text-slate-500 border border-slate-200 hover:bg-slate-50"
          :title="t('collectionsView.config.open')"
          :aria-label="t('collectionsView.config.open')"
          data-testid="collection-config-open"
          @click="emit('openConfig')"
        >
          <span class="material-icons text-sm">settings</span>
        </button>
      </div>
      <!-- Which date field anchors the grid (only when >1 date field). -->
      <select
        v-if="calendarActive && dateFields.length > 1"
        :value="calendarAnchorField"
        class="h-8 px-2 rounded border border-slate-200 bg-white text-xs font-semibold text-slate-600 focus:outline-none focus:border-indigo-500 cursor-pointer"
        :aria-label="t('collectionsView.calendarFieldLabel')"
        data-testid="collection-calendar-field"
        @change="onAnchorFieldChange"
      >
        <option v-for="key in dateFields" :key="key" :value="key">{{ collection?.schema.fields[key]?.label ?? key }}</option>
      </select>
      <!-- Which enum field groups the board (only when >1 enum field). -->
      <select
        v-if="kanbanActive && enumFields.length > 1"
        :value="kanbanGroupField"
        class="h-8 px-2 rounded border border-slate-200 bg-white text-xs font-semibold text-slate-600 focus:outline-none focus:border-indigo-500 cursor-pointer"
        :aria-label="t('collectionsView.kanbanFieldLabel')"
        data-testid="collection-kanban-field"
        @change="onGroupFieldChange"
      >
        <option v-for="key in enumFields" :key="key" :value="key">{{ collection?.schema.fields[key]?.label ?? key }}</option>
      </select>
      <!-- Hidden for a custom view: the count is the HOST's match tally
           (scalar fields only, `itemMatchesQuery`), while the iframe fetches
           its own records and may match more — nested rows, keyword arrays,
           long text. Now that the box drives both (#2959) a disagreeing
           "3 / 120" beside a view showing 5 hits reads as a bug. -->
      <div v-if="items.length > 0 && !customViewActive" class="text-[10px] text-slate-400 font-bold uppercase tracking-wider select-none">
        {{ t("collectionsView.searchSummary", { shown: activeView === "table" ? tableFilteredCount : filteredCount, total: items.length }) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import { IconGlyph } from "@mulmoclaude/core/plugin-vue";
import { useCollectionI18n } from "../lang";
import { useClickOutside } from "../composables/useClickOutside";
import { customViewKey, isCustomViewMode, type CollectionViewMode, type FlagFilterMode, type FlagFilterState } from "../collectionViewMode";
import { cycleFlagFilterState, flagChipClassForMode, flagChipIconClassForMode, flagChipIconForMode, flagFilterModeOf } from "../flagFilterDisplay";
import type { CollectionDetail, CollectionItem, CollectionCustomView as CustomViewSpec, FlagChip } from "@mulmoclaude/core/collection";

const props = defineProps<{
  collection: CollectionDetail | null;
  items: CollectionItem[];
  hideSearch?: boolean;
  hideViewToggle?: boolean;
  activeView: CollectionViewMode;
  flagChips: FlagChip[];
  customViews: CustomViewSpec[];
  canAddCustomView: boolean;
  canConfigureViews: boolean;
  /** Whether the host can render a phone (remote) view — drives whether "+"
   *  opens the desktop/phone chooser or seeds the desktop prompt directly. */
  canAddMobileView: boolean;
  hasCalendar: boolean;
  hasKanban: boolean;
  hasCustomViews: boolean;
  calendarActive: boolean;
  kanbanActive: boolean;
  dateFields: string[];
  enumFields: string[];
  calendarAnchorField: string;
  kanbanGroupField: string;
  /** Row counts for the "showing N of M" summary — the table view's
   *  flag-filtered count and the other views' search-only count. */
  tableFilteredCount: number;
  filteredCount: number;
}>();

const emit = defineEmits<{
  setView: [mode: CollectionViewMode];
  setCustomView: [viewId: string];
  addView: [target: "desktop" | "mobile"];
  openConfig: [];
  "update:anchorField": [value: string];
  "update:groupField": [value: string];
}>();

/** Search query and flag-filter state are owned by the parent (they feed its
 *  `filteredItems` / `tableFilteredItems`); the toolbar drives them via
 *  v-model. */
const searchQuery = defineModel<string>("searchQuery", { required: true });
const flagFilters = defineModel<FlagFilterState>("flagFilters", { required: true });

const { t } = useCollectionI18n();

// The two click-outside menus live here so their `menuRef` binds the wrapper
// `<div>` this component renders — a ref bound in the parent could not see
// these elements. `useClickOutside` registers a document listener only while
// open and tears it down on close / unmount.
const { open: filterMenuOpen, menuRef: filterMenuRef } = useClickOutside();
const { open: addMenuOpen, menuRef: addMenuRef } = useClickOutside();

// Close both menus when the active collection changes — a menu left open while
// switching collections would otherwise linger (the parent used to reset these
// on its slug watch; with the refs living here, the reset does too).
watch(
  () => props.collection?.slug,
  () => {
    addMenuOpen.value = false;
    filterMenuOpen.value = false;
  },
);

// The chip tri-state / own-property read / icon + colour mappings are the pure
// helpers in `../flagFilterDisplay` (shared with `useFlagFilters`); the toolbar
// only wraps them against the live `flagFilters` v-model.
function flagFilterMode(key: string): FlagFilterMode | undefined {
  return flagFilterModeOf(flagFilters.value, key);
}

/** Cycle a chip all → hide → only → all. */
function cycleFlagFilter(key: string): void {
  flagFilters.value = cycleFlagFilterState(flagFilters.value, key);
}

const flagChipIcon = (key: string): string => flagChipIconForMode(flagFilterMode(key));
const flagChipIconClass = (key: string): string => flagChipIconClassForMode(flagFilterMode(key));
const flagChipClass = (key: string): string => flagChipClassForMode(flagFilterMode(key));

/** A custom view is showing — the host's own match count doesn't describe it. */
const customViewActive = computed<boolean>(() => isCustomViewMode(props.activeView));

/** How many chips currently filter (badge on the menu trigger). */
const activeFlagFilterCount = computed<number>(() => props.flagChips.filter((chip) => flagFilterMode(chip.key) !== undefined).length);

function flagChipTitle(chip: FlagChip): string {
  const mode = flagFilterMode(chip.key);
  if (mode === "hide") return t("collectionsView.flagFilterHide", { label: chip.label });
  if (mode === "only") return t("collectionsView.flagFilterOnly", { label: chip.label });
  return t("collectionsView.flagFilterAll", { label: chip.label });
}

function onAnchorFieldChange(event: Event): void {
  const { target } = event;
  if (target instanceof HTMLSelectElement) emit("update:anchorField", target.value);
}

function onGroupFieldChange(event: Event): void {
  const { target } = event;
  if (target instanceof HTMLSelectElement) emit("update:groupField", target.value);
}

/** "+" click: open the target chooser, or skip the one-item menu and seed
 *  the desktop prompt directly when mobile views aren't available. */
function onAddViewClick(): void {
  if (!props.canAddMobileView) {
    addCustomView("desktop");
    return;
  }
  addMenuOpen.value = !addMenuOpen.value;
}

/** Close the chooser and ask the parent to seed the authoring chat. */
function addCustomView(target: "desktop" | "mobile"): void {
  addMenuOpen.value = false;
  emit("addView", target);
}
</script>
