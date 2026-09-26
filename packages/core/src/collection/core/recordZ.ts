// Compiled per-collection zod RECORD validators (plan step ⓪ Phase B of
// plans/done/collection-ontology.md): `compileRecordZ(schema, tier)` turns a
// CollectionSchema's `fields` into a zod object validator for the stored
// record JSON, so every consumer of record validation — the putItems write
// gate, the post-hoc file scan, and (future) `mutate` action `params` forms —
// derives its checks from the same compiler instead of growing parallel
// hand-rolled loops.
//
// Two tiers, per the lint-not-lock principle:
//
// - `"enforced"` — the write-gate tier. Reproduces EXACTLY the historical
//   three checks (required fields non-empty, enum values in the closed set;
//   the primaryKey↔filename identity check stays in `validateRecordObject`,
//   which owns the id). Message strings are part of the contract: they are
//   the `problem` feedback the authoring LLM acts on, and the file scan and
//   the write gate must report enforced-tier violations IDENTICALLY.
// - `"strict"` — the report-only tier: enforced plus per-type checks
//   (number/money hold numerics, booleans are booleans, dates parse, table
//   rows conform to their sub-schema). Consumed by `validateCollectionRecords`
//   (the scan surfaced through presentCollection / the detail response) so
//   legacy records written under the loose rules get REPORTED, never
//   rejected. Promote a strict check into the enforced tier only once the
//   lint runs clean across real workspaces.
//
// Isomorphic (zod + pure logic, no node built-ins) but — like `./schemaZ` —
// deliberately NOT exported through the browser barrel; the server surface
// re-exports it via `../server/validate`.

import { isRecord } from "@mulmoclaude/common";
import { z } from "zod";
import { coerceNumeric } from "./backlinks";
import { parseIsoDate, parseIsoDateTime } from "./calendarGrid";
import { isCanonicalServerTime } from "./serverTime";
import { COMPUTED_TYPES } from "./schema";
import type { CollectionFieldSpec, CollectionItem, CollectionSchema, CollectionSubFieldSpec } from "./schema";

// COMPUTED_TYPES moved to `./schema` (zod-free, so `./draft` can share
// it); re-exported here for the existing server-surface importers.
export { COMPUTED_TYPES };

export type RecordCheckTier = "enforced" | "strict";

type AnyFieldSpec = CollectionFieldSpec | CollectionSubFieldSpec;

/** The emptiness rule shared by `required` and the "only check present
 *  values" gate. NOT a truthiness check — `0` and `false` are filled. */
const isEmptyValue = (value: unknown): boolean => value === undefined || value === null || value === "";

/** The historical write-gate checks, verbatim: required non-empty, enum
 *  membership (compared as strings, so a numeric `5` satisfies `"5"`). */
function enforcedProblem(key: string, spec: AnyFieldSpec, value: unknown): string | null {
  const empty = isEmptyValue(value);
  if (spec.required && empty) return `missing required field '${key}'`;
  if (!empty && spec.type === "enum" && !spec.values.includes(String(value))) {
    return `'${key}' = '${String(value)}' is not one of [${spec.values.join(", ")}]`;
  }
  return null;
}

// Numeric coercion for the strict `number`/`money` check — moved to
// `./backlinks` so rollup sums share the same definition of "numeric".

/** Report-only per-type checks on a PRESENT value. Date / datetime reuse the
 *  calendar's STRICT civil parsers (`parseIsoDate` / `parseIsoDateTime`), so
 *  the lint flags exactly the values the calendar / trigger / spawn code
 *  would silently drop — impossible days like `2026-02-30`, and datetimes
 *  outside the canonical `YYYY-MM-DDTHH:MM[:SS]` shape (e.g. a `Z` suffix,
 *  which the day view can't place). `string`-backed types accept anything
 *  stringifiable; `ref` existence is out of scope. */
/** Named in the lint's own message, so the shape is shown rather than
 *  described. */
const CANONICAL_SERVER_TIME_EXAMPLE = "2026-08-15T01:45:54.605987654Z";

/** The shapes a `datetime` field may hold.
 *
 *  A bare date is an all-day value: `…T00:00` is how a real midnight start is
 *  written, so it cannot also mean "all day", and a bare date is the shape the
 *  push already sends as Google's `start.date`.
 *
 *  The server-stamped instant is not a loosening of the civil shape. A SHARED
 *  collection can pin a field to the server's clock, and what is stored there is
 *  a Firestore timestamp the rules require; by the time it reaches here it is the
 *  canonical instant string (`../core/serverTime`). Only that exact form is
 *  accepted — RFC3339 in general is not, because two values with different
 *  offsets do not sort in time order, and the order is the whole reason the
 *  field exists. */
function isStoredDateTime(value: unknown): boolean {
  return parseIsoDateTime(value) !== null || parseIsoDate(value) !== null || isCanonicalServerTime(value);
}

function strictTypeProblem(key: string, spec: AnyFieldSpec, value: unknown): string | null {
  switch (spec.type) {
    case "number":
    case "money":
      return Number.isFinite(coerceNumeric(value)) ? null : `'${key}' = '${String(value)}' is not numeric (a '${spec.type}' field stores a plain number)`;
    case "boolean":
      return value === true || value === false ? null : `'${key}' = '${String(value)}' is not a boolean (store true or false, unquoted)`;
    case "date":
      return parseIsoDate(value) !== null ? null : `'${key}' = '${String(value)}' is not a real YYYY-MM-DD date`;
    case "datetime":
      return isStoredDateTime(value)
        ? null
        : `'${key}' = '${String(value)}' is not a YYYY-MM-DDTHH:MM datetime (seconds optional, no timezone suffix — the shape the calendar parses), ` +
            `nor a YYYY-MM-DD all-day date, nor a server-stamped instant (${CANONICAL_SERVER_TIME_EXAMPLE})`;
    default:
      return null;
  }
}

/** Strict check for a PRESENT `table` value: an array of row objects, each
 *  row conforming to the sub-schema (required / enum / typed sub-values).
 *  First row problem wins, prefixed with the row number so the fix is
 *  locatable. */
function strictTableProblem(key: string, spec: Extract<CollectionFieldSpec, { type: "table" }>, value: unknown): string | null {
  if (!Array.isArray(value)) return `'${key}' = '${String(value)}' is not an array of rows (a 'table' field stores an array of row objects)`;
  for (let index = 0; index < value.length; index++) {
    const row: unknown = value[index];
    if (!isRecord(row)) return `'${key}' row ${index + 1} is not an object`;
    for (const [subKey, subSpec] of Object.entries(spec.of)) {
      const subValue = row[subKey];
      // Typed checks apply to PRESENT sub-values only — an empty optional
      // cell is fine, mirroring the top-level gate in `recordFieldProblem`.
      const problem = enforcedProblem(subKey, subSpec, subValue) ?? (isEmptyValue(subValue) ? null : strictTypeProblem(subKey, subSpec, subValue));
      if (problem) return `'${key}' row ${index + 1}: ${problem}`;
    }
  }
  return null;
}

/** First problem for one field's stored value under `tier`, or null.
 *  Enforced checks always run (and their messages never vary by tier — the
 *  scan and the write gate must agree on them); strict adds the per-type
 *  layer on present values only. */
export function recordFieldProblem(key: string, spec: AnyFieldSpec, value: unknown, tier: RecordCheckTier): string | null {
  const enforced = enforcedProblem(key, spec, value);
  if (enforced || tier === "enforced") return enforced;
  if (isEmptyValue(value)) return null;
  if (spec.type === "table") return strictTableProblem(key, spec, value);
  return strictTypeProblem(key, spec, value);
}

// Compiled validators cached per schema OBJECT (a putItems batch validates
// many rows against the same LoadedCollection.schema instance; a re-loaded
// collection gets a fresh schema object and naturally re-compiles).
const compiled = new WeakMap<CollectionSchema, Partial<Record<RecordCheckTier, z.ZodType>>>();

/** Compile `schema.fields` into a zod validator for a stored record.
 *  Loose object: unknown keys are allowed and any declared key may be
 *  absent (records are user files, not parse-and-rewrite targets —
 *  callers validate, they never persist the parse output). The checks run
 *  as ONE object-level refine iterating fields in declaration order —
 *  per-key shape schemas can't express "key may be absent BUT its absence
 *  must still reach the required check", and the single loop keeps the
 *  first reported issue identical to the historical first-problem-wins
 *  contract. */
export function compileRecordZ(schema: CollectionSchema, tier: RecordCheckTier): z.ZodType {
  const cached = compiled.get(schema)?.[tier];
  if (cached) return cached;
  const stored = Object.entries(schema.fields).filter(([, spec]) => !COMPUTED_TYPES.has(spec.type));
  const validator = z.looseObject({}).superRefine((record, ctx) => {
    for (const [key, spec] of stored) {
      const problem = recordFieldProblem(key, spec, record[key], tier);
      if (problem) ctx.addIssue({ code: "custom", message: problem, path: [key] });
    }
  });
  const entry = compiled.get(schema) ?? {};
  entry[tier] = validator;
  compiled.set(schema, entry);
  return validator;
}

/** First schema problem on an in-memory record under `tier`, or null. One
 *  issue per record keeps the report short and the fix obvious (the
 *  historical contract of `validateRecordObject`). */
export function firstRecordProblem(record: CollectionItem, schema: CollectionSchema, tier: RecordCheckTier): string | null {
  const result = compileRecordZ(schema, tier).safeParse(record);
  if (result.success) return null;
  return result.error.issues[0]?.message ?? "record failed schema validation";
}
