// Per-collection view preferences (the view mode, and the table's active
// column sort) persisted to localStorage, keyed by collection slug. Lets the
// standalone `/collections/:slug` page reopen in the last-used view and sort
// instead of resetting. Embedded chat cards seed from these but persist their
// own copy in the tool-result `viewState` (they read, never write — so a
// stale card can't clobber the shared preference).

import type { SortState, CollectionSchema } from "@mulmoclaude/core/collection";

/** The host's built-in, field-derived view modes. */
export type BuiltInViewMode = "table" | "calendar" | "kanban";
/** A custom (LLM-authored) view's selector key: `custom:<viewId>`. */
export type CustomViewMode = `custom:${string}`;
export type CollectionViewMode = BuiltInViewMode | CustomViewMode;

const CUSTOM_VIEW_PREFIX = "custom:";

/** Build the `custom:<id>` selector key for a custom view. */
export function customViewKey(viewId: string): CustomViewMode {
  return `${CUSTOM_VIEW_PREFIX}${viewId}`;
}

/** Is this mode one of the LLM-authored custom views (rather than a built-in)? */
export function isCustomViewMode(view: CollectionViewMode): view is CustomViewMode {
  return view.startsWith(CUSTOM_VIEW_PREFIX);
}

export interface BuiltInViewAvailability {
  calendar: boolean;
  kanban: boolean;
}

/** Whether the schema offers each built-in view: calendar needs a
 *  `date`/`datetime` field, kanban an `enum` field, and either is withheld
 *  when `builtinViews` sets it to `false`. */
export function builtInViewAvailability(schema: CollectionSchema): BuiltInViewAvailability {
  const fields = Object.values(schema.fields);
  const hasDateField = fields.some((field) => field.type === "date" || field.type === "datetime");
  const hasEnumField = fields.some((field) => field.type === "enum");
  return {
    calendar: hasDateField && schema.builtinViews?.calendar !== false,
    kanban: hasEnumField && schema.builtinViews?.kanban !== false,
  };
}

/** Every view mode a schema can render, in selector order: `table`
 *  always, then the available built-in views, then each declared custom
 *  view. Shares `builtInViewAvailability` with `CollectionView` so callers
 *  outside that component — e.g. the dashboard's per-tile view picker —
 *  offer exactly the same choices. */
export function applicableViewModes(schema: CollectionSchema): CollectionViewMode[] {
  const modes: CollectionViewMode[] = ["table"];
  const available = builtInViewAvailability(schema);
  if (available.calendar) modes.push("calendar");
  if (available.kanban) modes.push("kanban");
  for (const view of schema.views ?? []) modes.push(customViewKey(view.id));
  return modes;
}

/** The EFFECTIVE view for a raw mode, collapsing any mode whose enabling
 *  condition is gone: `calendar`/`kanban` fall back to `table` once their
 *  date/enum field vanishes (e.g. after a collection switch), and a
 *  `custom:<id>` falls back once that id is no longer a declared view. Single
 *  source of truth for the toggle highlight and the body branches. */
export function resolveActiveViewMode(
  view: CollectionViewMode,
  hasCalendar: boolean,
  hasKanban: boolean,
  customViewIds: readonly string[],
): CollectionViewMode {
  if (view === "calendar" && hasCalendar) return "calendar";
  if (view === "kanban" && hasKanban) return "kanban";
  if (isCustomViewMode(view)) {
    const viewId = view.slice(CUSTOM_VIEW_PREFIX.length);
    if (customViewIds.includes(viewId)) return view;
  }
  return "table";
}

const STORAGE_KEY = "collection_view_modes";
const SORT_STORAGE_KEY = "collection_sorts";

const BUILT_IN_MODES: readonly BuiltInViewMode[] = ["table", "calendar", "kanban"];

/** `Object.entries` of a value already narrowed to a non-array object, with the
 *  values kept `unknown` so each store re-validates before storing. */
function readEntries(source: object): [string, unknown][] {
  return Object.entries(source);
}

/** A persisted mode is valid if it's a known built-in OR any `custom:<id>`
 *  key (the id is validated against the live schema at render time, so an
 *  unknown custom id simply collapses to the table there). Takes `unknown`
 *  and type-guards `string` first: a corrupted localStorage entry could hold a
 *  number/object, and calling `.startsWith` on that would throw. Shared with
 *  the embedded card's `viewState` reader so both restore paths accept exactly
 *  the same set of modes. */
export function isCollectionViewMode(value: unknown): value is CollectionViewMode {
  return typeof value === "string" && (BUILT_IN_MODES.some((mode) => mode === value) || value.startsWith(CUSTOM_VIEW_PREFIX));
}

type ViewModeMap = Record<string, CollectionViewMode>;

function readAll(): ViewModeMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Plain object only — an array would pass `typeof === "object"` and then
    // let writeCollectionViewMode write string keys onto it.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Same policy as the sort / flag-filter stores below: drop entries whose
    // stored value no longer validates rather than handing them back.
    const out: ViewModeMap = {};
    for (const [slug, value] of readEntries(parsed)) {
      if (isCollectionViewMode(value)) out[slug] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function readCollectionViewMode(slug: string): CollectionViewMode | null {
  const stored: unknown = readAll()[slug];
  return isCollectionViewMode(stored) ? stored : null;
}

export function writeCollectionViewMode(slug: string, view: CollectionViewMode): void {
  try {
    const all = readAll();
    all[slug] = view;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage unavailable / quota exceeded — the preference is
    // best-effort, so silently skip rather than break the view.
  }
}

// ── Active column sort (table view) ──────────────────────────────────

type SortMap = Record<string, SortState>;

function isSortState(value: unknown): value is SortState {
  if (!value || typeof value !== "object") return false;
  if (!("field" in value) || typeof value.field !== "string") return false;
  return "direction" in value && (value.direction === "asc" || value.direction === "desc");
}

function readAllSorts(): SortMap {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Drop any entry whose stored shape no longer validates (e.g. a schema
    // whose field was renamed away leaves a stale value) so callers only ever
    // see a well-formed SortState.
    const out: SortMap = {};
    for (const [slug, value] of readEntries(parsed)) {
      if (isSortState(value)) out[slug] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function readCollectionSort(slug: string): SortState | null {
  return readAllSorts()[slug] ?? null;
}

/** Persist (or, when `sort` is null, clear) the slug's active column sort. */
export function writeCollectionSort(slug: string, sort: SortState | null): void {
  try {
    // Rebuild without the slug rather than `delete all[slug]` (dynamic-delete),
    // then re-add it when a sort is set — clearing leaves no stale key behind.
    const all = Object.fromEntries(Object.entries(readAllSorts()).filter(([key]) => key !== slug));
    if (sort) all[slug] = sort;
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Best-effort, same as the view-mode store.
  }
}

// ── Flag filter chips (table view) ───────────────────────────────────

/** One chip's active filter mode: `hide` drops matching rows, `only`
 *  keeps just them. A chip with no entry shows all rows. */
export type FlagFilterMode = "hide" | "only";
/** Chip key (flag field name, or the synthesized completion key) → mode. */
export type FlagFilterState = Record<string, FlagFilterMode>;

const FLAG_FILTER_STORAGE_KEY = "collection_flag_filters";

function isFlagFilterState(value: unknown): value is FlagFilterState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((mode) => mode === "hide" || mode === "only");
}

function readAllFlagFilters(): Record<string, FlagFilterState> {
  try {
    const raw = localStorage.getItem(FLAG_FILTER_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, FlagFilterState> = {};
    for (const [slug, value] of readEntries(parsed)) {
      if (isFlagFilterState(value)) out[slug] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** The slug's persisted chip states ({} when none). A key whose flag no
 *  longer exists in the schema is harmless — the chip list is derived
 *  from the live schema, so a stale entry just never renders/filters. */
export function readCollectionFlagFilters(slug: string): FlagFilterState {
  return readAllFlagFilters()[slug] ?? {};
}

/** Persist the slug's chip states; an empty state clears the entry. */
export function writeCollectionFlagFilters(slug: string, filters: FlagFilterState): void {
  try {
    const all = Object.fromEntries(Object.entries(readAllFlagFilters()).filter(([key]) => key !== slug));
    if (Object.keys(filters).length > 0) all[slug] = filters;
    localStorage.setItem(FLAG_FILTER_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Best-effort, same as the view-mode store.
  }
}
