// Pure, reactivity-free data transforms extracted from
// useCollectionRendering.ts so they can be unit-tested in isolation. NO
// vue / DOM / I/O / reactive state here — every function is a plain
// function of its arguments. The composable imports these and calls them
// from inside its computed/watch closures; behaviour is identical.

import { deriveAll, fieldText, isCanonicalServerTime, parseIsoDate } from "@mulmoclaude/core/collection";
import type {
  CollectionDetailResponse,
  CollectionItem,
  CollectionSchema,
  CollectionFieldSpec as FieldSpec,
  CollectionFieldType as FieldType,
  RefDisplayMap,
  RefOption,
  RefRecordMap,
} from "@mulmoclaude/core/collection";

const EM_DASH = "—";
const DEFAULT_CURRENCY = "USD";
// Markdown cells are single-line list previews; longer text is elided so
// the table row stays one line.
const MARKDOWN_CELL_PREVIEW_MAX = 80;

// `<input type="number">` defaults to step="1", which makes the browser
// reject any decimal value (e.g. 0.1) as invalid. Emit step="any" for
// numeric fields so fractional values can be entered and saved.
export function stepForFieldType(type: FieldType): string | undefined {
  if (type === "money") return "0.01";
  if (type === "number") return "any";
  return undefined;
}

/** A value the SERVER stamped and the rules froze.
 *
 *  A shared collection can pin a `datetime` to the server's clock, and what
 *  reaches the UI is the canonical instant string. It must not be offered for
 *  editing, and the reason is not tidiness: `datetime-local` cannot hold that
 *  string, so the control renders EMPTY, and saving the record then writes the
 *  empty (or a re-typed civil) value over a field the rules refuse to see move.
 *  The whole update fails, with a permission error that names nothing.
 *
 *  Recognised by the value rather than by the schema because the declaration
 *  that pins it lives in the app's `app.json`, which no UI reads. */
export function isServerStamped(value: unknown): boolean {
  return isCanonicalServerTime(value);
}

/** `datetime-local` shows nothing for a value it cannot hold, and saving then
 *  writes the blank back. A server-stamped instant is shown as text (and is
 *  disabled where it is rendered); an all-day bare date keeps a date picker. */
function dateTimeInputType(value: unknown): string {
  if (isServerStamped(value)) return "text";
  return parseIsoDate(value) === null ? "datetime-local" : "date";
}

export function inputTypeFor(type: FieldType, value?: unknown): string {
  if (type === "email") return "email";
  if (type === "number") return "number";
  if (type === "money") return "number";
  if (type === "date") return "date";
  if (type === "datetime") return dateTimeInputType(value);
  return "text";
}

export function isExternalUrl(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

export function detailText(value: unknown): string {
  const text = fieldText(value, EM_DASH);
  return text === "" ? EM_DASH : text;
}

export function formatCell(value: unknown, type: FieldType): string {
  if (value === undefined || value === null || value === "") return EM_DASH;
  if (type === "markdown" && typeof value === "string") {
    return value.length > MARKDOWN_CELL_PREVIEW_MAX ? `${value.slice(0, MARKDOWN_CELL_PREVIEW_MAX)}…` : value;
  }
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** Resolve the ISO 4217 code for a money field: a per-record
 *  `currencyField` (when present and non-blank) wins over the field's
 *  literal `currency`. Only `money` / `derived` variants carry currency
 *  keys; any other field resolves to undefined (the formatter's USD
 *  fallback), as before. */
export function resolveCurrency(field: FieldSpec, record: CollectionItem | null | undefined): string | undefined {
  if (field.type !== "money" && field.type !== "derived") return undefined;
  if (field.currencyField && record) {
    const code = record[field.currencyField];
    if (typeof code === "string" && code.trim().length > 0) return code;
  }
  return field.currency;
}

export function formatMoney(value: unknown, currency: string | undefined, displayLocale: string): string {
  if (value === undefined || value === "") return EM_DASH;
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return fieldText(value, EM_DASH);
  const currencyCode = currency && currency.length > 0 ? currency : DEFAULT_CURRENCY;
  try {
    return new Intl.NumberFormat(displayLocale, { style: "currency", currency: currencyCode }).format(amount);
  } catch {
    return String(amount);
  }
}

export function currencySymbolForLocale(currency: string | undefined, locale: string): string {
  const code = currency && currency.length > 0 ? currency : DEFAULT_CURRENCY;
  try {
    const parts = new Intl.NumberFormat(locale, { style: "currency", currency: code }).formatToParts(0);
    return parts.find((entry) => entry.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

export function tableRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
}

export function hasTableRows(value: unknown): boolean {
  return tableRows(value).length > 0;
}

/** Pick the field used to label a referenced/embedded record: prefer a
 *  `name` field, then `title`, else fall back to the primary key. */
export function displayFieldFor(fields: Record<string, FieldSpec>, primaryKey: string): string {
  if ("name" in fields) return "name";
  if ("title" in fields) return "title";
  return primaryKey;
}

export function buildRefDisplayMap(detail: CollectionDetailResponse): RefDisplayMap {
  const { fields, primaryKey } = detail.collection.schema;
  const displayField = displayFieldFor(fields, primaryKey);
  const map: RefDisplayMap = {};
  for (const item of detail.items) {
    const slugRaw = item[primaryKey];
    if (typeof slugRaw !== "string" || slugRaw.length === 0) continue;
    const displayRaw = item[displayField];
    map[slugRaw] = typeof displayRaw === "string" && displayRaw.length > 0 ? displayRaw : slugRaw;
  }
  return map;
}

/** Index DERIVED records by primary key — the client mirror of the
 *  server's `loadTarget` indexing: string non-empty ids only, one record
 *  per id (a duplicate keeps the LAST record in its FIRST position —
 *  plain-object key semantics). Shared by the ref-record cache and the
 *  backlinks view so every client consumer agrees with server enrichment
 *  on which source records exist. */
export function derivedRecordsById(schema: CollectionSchema, items: CollectionItem[]): RefRecordMap {
  const map: RefRecordMap = {};
  for (const item of items) {
    const slugRaw = item[schema.primaryKey];
    if (typeof slugRaw === "string" && slugRaw.length > 0) map[slugRaw] = deriveAll(schema, item, {});
  }
  return map;
}

export function buildRefRecordMap(detail: CollectionDetailResponse): RefRecordMap {
  return derivedRecordsById(detail.collection.schema, detail.items);
}

export function sortedRefOptions(map: RefDisplayMap): RefOption[] {
  return Object.entries(map)
    .map(([slug, display]) => ({ slug, display }))
    .sort((left, right) => left.display.localeCompare(right.display));
}

/** Dropdown options for an `embed` field's per-record picker: every
 *  record in the target collection, labelled by its name/title (or
 *  primary key), skipping records without a slug and sorted by label. */
export function buildEmbedOptions(schema: CollectionSchema, items: CollectionItem[]): RefOption[] {
  const { fields, primaryKey } = schema;
  const displayField = displayFieldFor(fields, primaryKey);
  return items
    .map((item) => {
      const slug = fieldText(item[primaryKey]);
      const labelRaw = item[displayField];
      const display = typeof labelRaw === "string" && labelRaw.length > 0 ? labelRaw : slug;
      return { slug, display };
    })
    .filter((opt) => opt.slug.length > 0)
    .sort((left, right) => left.display.localeCompare(right.display));
}
