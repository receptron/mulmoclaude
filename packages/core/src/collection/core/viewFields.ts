// Field metadata a custom view receives as `window.__MC_VIEW.fields` (#2169),
// so a view's enum dropdown follows `schema.json` instead of a hard-coded list.
// The sandboxed iframe cannot read the schema itself (its token only reaches
// `view-data`), so the host derives this at mint time and injects it.

import { isRecord, isUnknownArray } from "@mulmoclaude/common";
import type { CollectionSchema } from "./schema";

export interface CustomViewEnumField {
  type: "enum";
  values: string[];
}

/** Keyed by top-level field name. Only `enum` fields today. */
export type CustomViewFields = Record<string, CustomViewEnumField>;

/** Enum metadata for every top-level `enum` field of `schema`; other field
 *  types (and `table` sub-fields) are left out. Values are copied, so a caller
 *  mutating the result cannot reach back into the loaded schema. */
export function buildCustomViewFields(schema: Pick<CollectionSchema, "fields">): CustomViewFields {
  const entries = Object.entries(schema.fields).flatMap(([key, spec]): [string, CustomViewEnumField][] =>
    spec.type === "enum" ? [[key, { type: "enum", values: [...spec.values] }]] : [],
  );
  return Object.fromEntries(entries);
}

export function isCustomViewEnumField(value: unknown): value is CustomViewEnumField {
  if (!isRecord(value) || value.type !== "enum") return false;
  return isUnknownArray(value.values) && value.values.every((entry) => typeof entry === "string");
}

/** Narrow an untrusted mint response's `fields` to the valid entries. Anything
 *  that is not an object yields `{}`; a malformed or unknown-type entry is
 *  dropped on its own so one bad field cannot hide the rest. */
export function customViewFieldsFrom(raw: unknown): CustomViewFields {
  if (!isRecord(raw)) return {};
  const entries = Object.entries(raw).flatMap(([key, field]): [string, CustomViewEnumField][] =>
    isCustomViewEnumField(field) ? [[key, { type: "enum", values: [...field.values] }]] : [],
  );
  return Object.fromEntries(entries);
}
