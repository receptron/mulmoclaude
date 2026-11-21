// The list-table / calendar / kanban / custom view-mode state. Local UI state,
// never persisted to schema: the user toggles it and the standalone page restores
// the last-used mode per collection from localStorage (an embedded card seeds from
// its own `initialView` first). The calendar is offered only when the schema has a
// `date` field and the kanban only with an `enum` field (unless `builtinViews` opts
// out), so `activeView` collapses a stale mode no longer offered back to `table`.
//
// A thin reactive shell over `../collectionViewMode`: the pure mode-collapse
// (`resolveActiveViewMode`) lives there. The localStorage WRITE stays in the
// parent's combined persist watch
// (which also emits `viewStateChange` and writes sort + flag filters) — same
// pattern as `useTableSort` / `useFlagFilters`; this owns the ref + the
// read-on-init / `resetForSlug` restore.

import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { CollectionCustomView as CustomViewSpec } from "@mulmoclaude/core/collection";
import { readCollectionViewMode, resolveActiveViewMode, type CollectionViewMode } from "../collectionViewMode";

interface UseViewModeParams {
  activeSlug: Readonly<Ref<string | undefined>>;
  /** Embedded cards restore their own persisted mode first (`initialView`); it
   *  wins over the slug's stored preference so a stale card can't clobber it. */
  props: { initialView?: CollectionViewMode | undefined };
  /** Whether the schema has a date / enum field (from the parent's field lists) —
   *  gates whether a stored `calendar` / `kanban` survives `activeView`. */
  hasCalendar: Readonly<Ref<boolean>>;
  hasKanban: Readonly<Ref<boolean>>;
  /** The declared custom views (host-filtered) — an unknown `custom:<id>`
   *  collapses to `table`. */
  customViews: Readonly<Ref<CustomViewSpec[]>>;
}

export interface UseViewMode {
  activeView: ComputedRef<CollectionViewMode>;
  activeCustomView: ComputedRef<CustomViewSpec | null>;
  calendarActive: ComputedRef<boolean>;
  kanbanActive: ComputedRef<boolean>;
  setView: (next: CollectionViewMode) => void;
  setCustomView: (viewId: string) => void;
  /** Restore the given collection's stored mode (else `table`) — the
   *  switch-collection reset; a mode belongs to a schema, never carried across. */
  resetForSlug: (slug: string | undefined) => void;
}

/** The stored mode for a slug (else `table`): a card's `initialView` wins, then
 *  the slug's persisted preference. */
function storedViewModeFor(slug: string | undefined, initialView: CollectionViewMode | undefined): CollectionViewMode {
  if (initialView) return initialView;
  return (slug && readCollectionViewMode(slug)) || "table";
}

export function useViewMode({ activeSlug, props, hasCalendar, hasKanban, customViews }: UseViewModeParams): UseViewMode {
  const view = ref<CollectionViewMode>(storedViewModeFor(activeSlug.value, props.initialView));

  const activeView = computed<CollectionViewMode>(() =>
    resolveActiveViewMode(
      view.value,
      hasCalendar.value,
      hasKanban.value,
      customViews.value.map((entry) => entry.id),
    ),
  );

  /** The selected custom view's spec, or null when a built-in view is active. */
  const activeCustomView = computed<CustomViewSpec | null>(() => {
    const mode = activeView.value;
    if (!mode.startsWith("custom:")) return null;
    const viewId = mode.slice("custom:".length);
    return customViews.value.find((entry) => entry.id === viewId) ?? null;
  });

  const calendarActive = computed<boolean>(() => activeView.value === "calendar");
  const kanbanActive = computed<boolean>(() => activeView.value === "kanban");

  function setView(next: CollectionViewMode): void {
    view.value = next;
  }

  /** Select a custom view by id (builds the `custom:<id>` mode key). */
  function setCustomView(viewId: string): void {
    view.value = `custom:${viewId}`;
  }

  /** Restore the new collection's stored mode; the axis fields reset separately. */
  function resetForSlug(slug: string | undefined): void {
    view.value = storedViewModeFor(slug, undefined);
  }

  return {
    activeView,
    activeCustomView,
    calendarActive,
    kanbanActive,
    setView,
    setCustomView,
    resetForSlug,
  };
}
