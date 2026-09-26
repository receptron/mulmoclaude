// Sorting for the collection list table. The header sort toggle (next to
// each field title) cycles a single active column through none → asc →
// desc → none; this module turns that state plus a per-field value
// extractor into an ordered copy of the rows.
//
// Two invariants the comparator guarantees:
//   1. Rows with an empty/missing value for the sorted field always sink
//      to the bottom, regardless of direction.
//   2. Ties (and the empty group) keep their original order — the sort is
//      stable via the captured source index.
//
// Field-type → comparable mapping (see `isSortableField`):
//   string/text/email → string · number/money → numeric ·
//   date/datetime → epoch-ms · enum → declared-index · boolean/toggle/flag →
//   false<true · ref → display label · derived → its display type.
// markdown/table/image/file/embed get no sort button.

import { parseIsoDate } from "./calendarGrid";
import { fieldTextOrNull } from "./fieldText";
import type { CollectionItem, CollectionFieldSpec, CollectionFieldType } from "./schema";

export type SortDirection = "asc" | "desc";

export interface SortState {
  /** Field key of the single active sort column. */
  field: string;
  direction: SortDirection;
}

/** A row's comparable value for the active field. Exactly one of `num` /
 *  `str` is set when not empty; `empty` rows always sort last. */
export interface SortValue {
  empty: boolean;
  num?: number;
  str?: string;
}

const EMPTY: SortValue = { empty: true };

/** Field types that render no value text in the table, so offer no sort. */
const NON_SORTABLE: ReadonlySet<CollectionFieldType> = new Set<CollectionFieldType>(["markdown", "table", "image", "file", "embed", "backlinks", "rollup"]);

export function isSortableField(field: CollectionFieldSpec): boolean {
  return !NON_SORTABLE.has(field.type);
}

/** Cycle one column's state: none → asc → desc → none. */
export function nextSortDirection(current: SortDirection | null): SortDirection | null {
  if (current === null) return "asc";
  if (current === "asc") return "desc";
  return null;
}

// ── SortValue constructors (one per comparable kind) ────────────────

export function numericSortValue(raw: unknown): SortValue {
  if (raw == null || raw === "") return EMPTY;
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) ? { empty: false, num } : EMPTY;
}

export function stringSortValue(raw: unknown): SortValue {
  // An array/object has no sort key — treat it as empty (sorts last) instead of
  // grouping every such record together under "[object Object]".
  const str = fieldTextOrNull(raw);
  if (str === null) return EMPTY;
  return str.trim() === "" ? EMPTY : { empty: false, str };
}

/** A bare date at LOCAL midnight — the instant `Date.parse` gives `…T00:00`.
 *  `Date.parse` alone reads a bare date as UTC, which would sort an all-day
 *  `datetime` value after that morning's timed ones east of Greenwich. */
function epochOf(text: string): number {
  const ymd = parseIsoDate(text);
  return ymd === null ? Date.parse(text) : new Date(ymd.year, ymd.month - 1, ymd.day).getTime();
}

export function dateSortValue(raw: unknown): SortValue {
  const text = fieldTextOrNull(raw);
  if (text === null || text === "") return EMPTY;
  const epoch = epochOf(text);
  // Unparseable dates fall back to a lexical compare rather than vanishing.
  return Number.isNaN(epoch) ? stringSortValue(raw) : { empty: false, num: epoch };
}

/** Enum sorts by the value's index in the declared `values` list. A value
 *  outside the list (or unset) is treated as empty → last. */
export function enumSortValue(values: readonly string[] | undefined, raw: unknown): SortValue {
  const text = fieldTextOrNull(raw);
  if (text === null || text === "") return EMPTY;
  const idx = values ? values.indexOf(text) : -1;
  return idx < 0 ? EMPTY : { empty: false, num: idx };
}

/** Boolean / toggle: false < true, never empty (unset reads as false). */
export function boolSortValue(checked: boolean): SortValue {
  return { empty: false, num: checked ? 1 : 0 };
}

// ── Comparator + driver ─────────────────────────────────────────────

export function compareSortValues(left: SortValue, right: SortValue): number {
  if (left.num !== undefined && right.num !== undefined) return left.num - right.num;
  const leftStr = left.str ?? String(left.num ?? "");
  const rightStr = right.str ?? String(right.num ?? "");
  return leftStr.localeCompare(rightStr);
}

/** Stable sort of `items` by `valueOf`. Empties always last; ties hold
 *  source order. Returns a new array (does not mutate `items`). */
export function sortItems(items: readonly CollectionItem[], direction: SortDirection, valueOf: (item: CollectionItem) => SortValue): CollectionItem[] {
  const dir = direction === "asc" ? 1 : -1;
  return items
    .map((item, index) => ({ item, index, sv: valueOf(item) }))
    .sort((left, right) => {
      if (left.sv.empty || right.sv.empty) {
        if (left.sv.empty && right.sv.empty) return left.index - right.index;
        return left.sv.empty ? 1 : -1;
      }
      const base = compareSortValues(left.sv, right.sv);
      return base !== 0 ? base * dir : left.index - right.index;
    })
    .map((decorated) => decorated.item);
}
