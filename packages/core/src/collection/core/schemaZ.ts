// The zod SINGLE SOURCE OF TRUTH for the collection schema contract.
//
// Every TypeScript type in `./schema` is derived from these definitions via
// `z.infer` (type-only imports, erased at emit) — there is no hand-written
// mirror to drift. Field specs are a DISCRIMINATED UNION on `type` (and
// `ingest` on `kind`): each variant declares exactly the keys it owns, so an
// unknown key is stripped per-variant, a new field type is a new union
// member (not another optional key + refine on a flat bag), and error
// messages name the variant that failed.
//
// This module is ISOMORPHIC — zod plus the pure predicates in `./ids` /
// `./templatePath`, no node built-ins — but it is deliberately NOT exported
// through the browser barrel (`../index`): browser code imports the derived
// TYPES from `./schema` (type-only ⇒ no zod in the bundle) and the server
// imports the validators through `../server` (discovery re-exports
// `CollectionSchemaZ`). Runtime imports here point only at `./schema`'s
// consts, so the module graph stays acyclic: schemaZ → schema.

import { isRecord, isUnknownArray } from "@mulmoclaude/common";
import { z } from "zod";
import { isSafeSlug } from "./ids";
import { ACCENT_COLORS } from "./accentColor";
import { isSafeActionTemplatePath, isSafeCustomViewI18nPath, isSafeCustomViewPath } from "./templatePath";
import { INGEST_KINDS, AGENT_INGEST_KIND, FEED_SCHEDULES } from "./schema";
import {
  actionIdsAreUnique,
  calendarEndFieldIsDateLike,
  calendarEndFieldRequiresCalendarField,
  calendarFieldIsDateLike,
  calendarTimeFieldIsDeclared,
  calendarTimeFieldIsStringBacked,
  calendarTimeFieldRequiresCalendarField,
  collectionActionIdsAreUnique,
  collectionActionsAreNotMutate,
  completionFieldIsDeclared,
  completionFlagReadsOnlyStoredFields,
  completionPairIsCoherent,
  currencyFieldRefsNameCodeFields,
  dataSourceDeclaresNoMutateAction,
  dataSourceDeclaresNoWriteMachinery,
  declaresExactlyOneStore,
  displayFieldIsDeclared,
  embedIdFieldsNameIdBearingFields,
  fieldDrivenFromFieldCarried,
  fieldDrivenFromFieldIsEnum,
  fieldDrivenMapCoversValues,
  fieldVisibilityGatesNameDeclaredFields,
  flagCompletionSpawnDeclaresWhen,
  flagConditionsNameDeclaredFields,
  googleCalendarMapNamesStoredFields,
  kanbanFieldIsAnEnum,
  mutateParamRefsAreDeclared,
  mutateSetKeysNameStoredFields,
  notifyWhenFieldIsDeclared,
  notifyWhenRequiresCompletion,
  singletonIsAValidRecordId,
  spawnCarryEntriesAreDeclared,
  spawnRequiresTriggerField,
  spawnSuccessorStartsInert,
  spawnWhenFieldIsDeclared,
  togglesProjectValidEnums,
  triggerFieldIsADateField,
  triggerFieldRequiresCompletion,
  triggerLeadDaysRequiresTriggerField,
  viewIdsAreSlugs,
  viewIdsAreUnique,
} from "./schemaRules";

// ---------------------------------------------------------------------------
// Shared predicate shapes
// ---------------------------------------------------------------------------

/** Optional visibility predicate shared by actions and fields: the target
 *  shows only when the open record's `field` (stringified) is one of `in`.
 *  Domain-free — `field` is any non-empty key, `in` a non-empty array of
 *  non-empty values; the host never interprets the meaning.
 *
 *  `trim().min(1)` rather than bare `min(1)` so a whitespace-only string
 *  ("   ") fails validation — otherwise the cell formatter / dropdown would
 *  render visual blanks that look like missing data. Applied consistently to
 *  every "non-empty string" slot in this file (CodeRabbit PR #1497). */
export const WhenZ = z.object({
  field: z.string().trim().min(1),
  in: z.array(z.string().trim().min(1)).min(1),
});

// `where` — a richer AND-of-conditions predicate than the single-field
// `WhenZ` above: typed comparison ops (`eq/ne/in/contains/gt/gte/lt/lte`)
// evaluated by `./where`'s `matchesWhere`. Consumed by `flag` fields
// (below) and `dynamicIcon` (further down). Defined here, ahead of the
// field specs, so `FlagFieldZ` can reference it.
//
// A condition's comparison value is either a literal `value` or a
// `valueFrom` reference to another record's field (e.g. a `_config`
// singleton's `defaultCity`, resolved at compute time against the source
// collection's own records — see the server's `dynamicIcon.ts`
// `recordsById`). Exactly one of the two is required: neither (nothing to
// compare against) and both (ambiguous which wins) are equally meaningless.
// `record` omitted → the SAME record being matched (field-to-field compare,
// e.g. `spent > budget`); set → another record by primaryKey (e.g. `_config`).
export const ValueRefZ = z.object({
  record: z.string().trim().min(1).optional(),
  field: z.string().trim().min(1),
});
export const WhereCondZ = z
  .object({
    field: z.string().trim().min(1),
    op: z.enum(["eq", "ne", "in", "gt", "gte", "lt", "lte", "contains"]),
    value: z.union([z.string(), z.array(z.string())]).optional(),
    valueFrom: ValueRefZ.optional(),
  })
  .refine((cond) => (cond.value !== undefined) !== (cond.valueFrom !== undefined), {
    message: "a where condition must declare exactly one of `value` (a literal) or `valueFrom` (a reference to another record's field), never both or neither",
    path: ["value"],
  })
  .refine((cond) => cond.value === undefined || (cond.op === "in") === Array.isArray(cond.value), {
    message: "`in` requires an array `value` (the allowed set); every other op requires a single string `value`",
    path: ["value"],
  });
export const WhereZ = z.array(WhereCondZ);

// ---------------------------------------------------------------------------
// Field specs — a discriminated union on `type`
// ---------------------------------------------------------------------------

// Keys every field variant carries. `when` gates visibility (list cell,
// edit form, detail view — purely presentational, a hidden field's stored
// value is never cleared; only honoured on top-level fields). `primary`
// marks the field whose value is the record's filename (exactly one per
// schema — enforced by `acceptParsedSchema`, not here). The referenced
// `when.field` is validated to be a real top-level field by a schema-level
// refine below (a field can't see its siblings here).
const fieldBase = {
  label: z.string().min(1),
  primary: z.boolean().optional(),
  required: z.boolean().optional(),
  when: WhenZ.optional(),
};

// A field that renders as money must declare where its currency comes from —
// otherwise the formatter silently falls back to USD and mislabels non-USD
// amounts. Two ways to satisfy it: a literal `currency` (an ISO 4217 code,
// fixed for every record) or a `currencyField` naming a sibling record field
// that holds the code (per-record, e.g. an invoice's `currency` enum; resolved
// against the TOP-LEVEL record even for money sub-fields inside a table). At
// least one is required. The stored value is always a plain decimal number;
// currency is presentation only.
const currencyKeys = {
  currency: z.string().trim().min(1).optional(),
  currencyField: z.string().trim().min(1).optional(),
};
const hasCurrencySource = (spec: { currency?: string | undefined; currencyField?: string | undefined }): boolean =>
  spec.currency !== undefined || spec.currencyField !== undefined;
const currencyMessage = {
  message:
    "fields that render as money (type 'money', or 'derived' with display 'money') must declare either a literal `currency` (ISO 4217 code, e.g. 'USD', 'JPY') or a `currencyField` naming the record field that holds the code",
  path: ["currency"],
};

const slugMessage = (key: string) => ({
  message: `\`${key}\` must be a valid collection slug (alphanumeric / hyphen / underscore, no path separators)`,
  path: [key],
});

/** The plain scalar field types. Stored and edited as primitive values; no
 *  variant-specific keys.
 *  - `image`: a workspace-relative image path (e.g. a `data/attachments/...`
 *    upload); rendered as an <img> in the detail view (not the list table —
 *    a per-row fetch is too expensive at scale). Stored as a plain string.
 *  - `file`: a workspace-relative file path as a plain string (e.g. an
 *    `artifacts/html/<name>.html` app). Rendered as a clickable link in both
 *    the list table and the detail view: HTML / SVG artifacts open their
 *    rendered form in a new tab; any other path opens in the File Explorer. */
const ScalarFieldZ = z.object({
  type: z.enum(["string", "text", "email", "number", "date", "datetime", "boolean", "markdown", "image", "file"]),
  ...fieldBase,
});

/** A link to another collection: the record stores the target item's
 *  primary-key slug and the host renders a clickable link + dropdown picker.
 *  `to` must be a real slug (not `../foo`, not `mc-clients/extra` — see
 *  Codex P2 on PR #1495); whether the target collection exists resolves
 *  fail-soft at render time, never here. */
const RefFieldZ = z
  .object({
    type: z.literal("ref"),
    ...fieldBase,
    to: z.string().min(1),
  })
  .refine((spec) => isSafeSlug(spec.to), slugMessage("to"));

/** A money amount. See `currencyKeys` for the currency-source contract. */
const MoneyFieldZ = z
  .object({
    type: z.literal("money"),
    ...fieldBase,
    ...currencyKeys,
  })
  .refine(hasCurrencySource, currencyMessage);

/** A closed set of allowed string values. The form renders a `<select>`
 *  populated from `values`; storage is a plain string.
 *
 *  `default` pre-fills a NEW record — the Add form starts on it, and a
 *  `putItems` row in `create` mode that omits the field gets it. Never applied
 *  on `merge` / `upsert`: those edit a record that already answered this.
 *
 *  Membership in `values` is NOT checked here on purpose. This schema is what
 *  discovery parses on every load, and a rejection there drops the whole
 *  collection out of the index (`discovery.ts`) — too steep a price for a
 *  cosmetic key, and the key was silently ignored before #2839, so a stale one
 *  may already sit in someone's file. `putSchema` refuses a non-member instead,
 *  where the author is present to read the reason. */
const EnumFieldZ = z.object({
  type: z.literal("enum"),
  ...fieldBase,
  values: z.array(z.string().trim().min(1)).min(1),
  default: z.string().trim().min(1).optional(),
});

// Sub-fields inside a `table.of` map: the regular field types minus `table`
// (no nested tables) and `derived` (no computed columns inside a table —
// would need the evaluator to walk the row context, defer until a real need
// surfaces). Also no `when` / `primary` — rows have neither visibility
// gating nor filenames.
const subFieldBase = {
  label: z.string().min(1),
  required: z.boolean().optional(),
};
const SubScalarFieldZ = z.object({
  type: z.enum(["string", "text", "email", "number", "date", "datetime", "boolean", "markdown"]),
  ...subFieldBase,
});
const SubRefFieldZ = z.object({ type: z.literal("ref"), ...subFieldBase, to: z.string().min(1) }).refine((spec) => isSafeSlug(spec.to), slugMessage("to"));
const SubMoneyFieldZ = z.object({ type: z.literal("money"), ...subFieldBase, ...currencyKeys }).refine(hasCurrencySource, currencyMessage);
const SubEnumFieldZ = z.object({ type: z.literal("enum"), ...subFieldBase, values: z.array(z.string().trim().min(1)).min(1) });

export const SubFieldSpecZ = z.discriminatedUnion("type", [SubScalarFieldZ, SubRefFieldZ, SubMoneyFieldZ, SubEnumFieldZ]);

/** A flat sub-table: each row is a record of `of`'s sub-schema (insertion
 *  order = column order). v0 disallows nested tables and derived columns to
 *  keep the editor + evaluator simple. */
const TableFieldZ = z
  .object({
    type: z.literal("table"),
    ...fieldBase,
    of: z.record(z.string(), SubFieldSpecZ),
  })
  .refine((spec) => Object.keys(spec.of).length > 0, {
    message: "fields with type 'table' must declare a non-empty `of` (sub-schema for each row)",
    path: ["of"],
  });

/** A computed scalar: `formula` is a tiny expression evaluated against the
 *  record — `+ - * /`, parens, identifier refs to top-level fields,
 *  `sum(tableField[].col)`, and `sum(tableField[].col * tableField[].col)`
 *  (see `./derivedFormula`). `display` picks the inner type the value renders
 *  as (default `"number"`) — restricted to the non-composite display targets,
 *  since a derived value is a scalar. Never stored; computed by `deriveAll`
 *  on both server and client. */
const DerivedFieldZ = z
  .object({
    type: z.literal("derived"),
    ...fieldBase,
    formula: z.string().trim().min(1),
    display: z.enum(["string", "number", "money", "date"]).optional(),
    ...currencyKeys,
  })
  .refine((spec) => spec.display !== "money" || hasCurrencySource(spec), currencyMessage);

/** Pulls a record from another collection into the read-only detail view.
 *  Display-only — nothing is stored on this record, so it never appears in
 *  the list table or the edit form. Must declare a valid `to` slug (same
 *  path-traversal guard as `ref`) AND exactly one of `id` (a fixed target
 *  record, e.g. `me` for the singleton profile — same for every record) or
 *  `idField` (a sibling top-level field naming the per-record target, e.g.
 *  an invoice's `issuerId` selecting which profile to embed as the bill-from
 *  block; an absent/empty value resolves fail-soft to "no record"). The
 *  `idField` target is validated to be a real `ref`/`string` field by a
 *  schema-level refine below. */
const EmbedFieldZ = z
  .object({
    type: z.literal("embed"),
    ...fieldBase,
    to: z.string().min(1),
    id: z.string().trim().min(1).optional(),
    idField: z.string().trim().min(1).optional(),
  })
  .refine((spec) => isSafeSlug(spec.to) && (spec.id !== undefined) !== (spec.idField !== undefined), {
    message:
      "fields with type 'embed' must declare a `to` (valid collection slug) and exactly one of `id` (a fixed record's primary key) or `idField` (a sibling field naming the per-record target)",
    path: ["id"],
  });

/** Display-only REVERSE refs (plan step ② of plans/done/collection-ontology.md):
 *  a read-only sub-table of the records in collection `from` whose `via`
 *  ref field stores THIS record's primary key. Stores nothing (joins
 *  `COMPUTED_TYPES`); resolution is shared server/client via
 *  `core/backlinks.ts`. `display` names the `from` columns to show;
 *  `filter` (the standard `when` shape, matched against each SOURCE
 *  record) narrows the rows. Validation is shape-only, like `embed`:
 *  `from` must be a safe slug, but whether it exists — and whether `via` /
 *  `display` name real fields there — resolves fail-soft at render
 *  (empty sub-table). Do NOT add cross-schema existence checks here. */
const BacklinksFieldZ = z
  .object({
    type: z.literal("backlinks"),
    ...fieldBase,
    from: z.string().min(1),
    via: z.string().trim().min(1),
    display: z.array(z.string().trim().min(1)).min(1),
    filter: WhenZ.optional(),
  })
  .refine((spec) => isSafeSlug(spec.from), slugMessage("from"));

/** A cross-collection AGGREGATE over a backlink relation (plan step ⑤ of
 *  plans/done/collection-ontology.md): a computed number — never stored — that
 *  sums a source column (or counts rows) over the records in `from` whose
 *  `via` ref points at this record. Same `from`/`via`/`filter` vocabulary
 *  and reverse-loading machinery as `backlinks`; resolution shared
 *  server/client via `core/backlinks.ts`'s `rollupValue`. Deliberately a
 *  STRUCTURED field, not `sumOver(...)` formula syntax — the derived
 *  evaluator's no-string-literals boundary stays untouched — and
 *  deliberately just `sum` | `count`. Rollups resolve BEFORE the formula
 *  pass, so a sibling `derived` formula may read them as identifiers
 *  (`played = homePlayed + awayPlayed`). Fail-soft: an unresolvable
 *  `from` renders em-dash; an empty match set is a real 0. */
const RollupFieldZ = z
  .object({
    type: z.literal("rollup"),
    ...fieldBase,
    from: z.string().min(1),
    via: z.string().trim().min(1),
    op: z.enum(["sum", "count"]),
    column: z.string().trim().min(1).optional(),
    filter: WhenZ.optional(),
  })
  .refine((spec) => isSafeSlug(spec.from), slugMessage("from"))
  .refine((spec) => (spec.op === "sum") === (spec.column !== undefined), {
    message: 'a rollup\'s `column` names the source column to aggregate: required for op "sum", meaningless for op "count"',
    path: ["column"],
  });

/** A checkbox that is a pure PROJECTION of an `enum` field — it stores
 *  nothing of its own. Checked when the enum named by `field` equals
 *  `onValue`; toggling writes `onValue` / `offValue` back to that enum
 *  field. Lets a "done" checkbox front a kanban `status` field with the enum
 *  as the single source of truth (no separate stored boolean to keep in
 *  sync). `field` / `onValue` / `offValue` are validated against the target
 *  enum's `values` by a schema-level refine below. */
const ToggleFieldZ = z.object({
  type: z.literal("toggle"),
  ...fieldBase,
  field: z.string().trim().min(1),
  onValue: z.string().trim().min(1),
  offValue: z.string().trim().min(1),
});

/** A computed boolean: the record matched against a `where` predicate
 *  (the same AND-of-conditions shape `dynamicIcon` uses; evaluated by
 *  `./where`'s `matchesWhere`). Generic state summaries — isDone,
 *  isPassed, isQualified — become declared fields, so every
 *  field-driven mechanism (table cells, detail view, completion via
 *  `completionField`) picks them up without special cases. Never
 *  stored; computed by `deriveAll` on both server and client in the
 *  same saturation loop as `derived`, so a flag may read derived /
 *  rollup values — and other flags (`matchesWhere` stringifies, so
 *  `eq "true"` composes). Deliberately a STRUCTURED field, not formula
 *  syntax — the derived evaluator's no-string-literals boundary stays
 *  untouched (same reasoning as `rollup`). Cross-record
 *  `valueFrom.record` is rejected here: per-record evaluation has no
 *  `recordsById`, so it could only ever silently never-match.
 *  `where` condition fields are validated to exist by a schema-level
 *  refine below (a field can't see its siblings). */
const FlagFieldZ = z
  .object({
    type: z.literal("flag"),
    ...fieldBase,
    where: WhereZ.min(1),
  })
  .refine((spec) => spec.where.every((cond) => cond.valueFrom?.record === undefined), {
    message:
      "a flag's `where` cannot use `valueFrom.record` (cross-record references are unresolvable in per-record evaluation); use a literal `value` or a same-record `valueFrom` (field-to-field)",
    path: ["where"],
  });

export const FieldSpecZ = z.discriminatedUnion("type", [
  ScalarFieldZ,
  RefFieldZ,
  MoneyFieldZ,
  EnumFieldZ,
  TableFieldZ,
  DerivedFieldZ,
  EmbedFieldZ,
  BacklinksFieldZ,
  RollupFieldZ,
  ToggleFieldZ,
  FlagFieldZ,
]);

// ---------------------------------------------------------------------------
// Actions & custom views
// ---------------------------------------------------------------------------

// Keys every action variant carries.
const actionBase = {
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  icon: z.string().trim().min(1).optional(),
};

/** The LLM-seeded action kinds — same shape, different visibility:
 *  - `"chat"` — start a new VISIBLE chat in `role` with the templated
 *    seed prompt (judgment work: drafting, planning, conversation).
 *  - `"agent"` — dispatch a HIDDEN worker (origin `system`) with the SAME
 *    seed; it edits records via manageCollection and finishes silently
 *    (mechanical enrichment: refresh a price, fetch metadata). Spinner
 *    while running, deduped failure bell on error — see
 *    server/api/routes/collectionAgentActions.ts. */
const SeededActionZ = z.object({
  kind: z.enum(["chat", "agent"]),
  ...actionBase,
  role: z.string().trim().min(1),
  template: z
    .string()
    .trim()
    .min(1)
    .refine(isSafeActionTemplatePath, "must be a safe path under `templates/` (e.g. `templates/invoice.md`; no `..`, no leading `/`, no backslash)"),
  when: WhenZ.optional(),
});

/** `kind: "mutate"` — a declarative, HOST-executed write; no LLM, no
 *  tokens (plan step ④ of plans/done/collection-ontology.md). Clicking the
 *  button (after an optional `params` mini-form) merges `set` into the
 *  record: values are literals or `$params.<name>` references. `require`
 *  is the state gate — the standard `when` shape, both the visibility
 *  rule AND the server-side authorization rule, exactly like `when` on
 *  the seeded kinds. `params` reuses the table sub-field DSL, and the
 *  form is validated by the SAME compiled record checks `putItems` uses
 *  (`recordFieldProblem`), not a third mechanism. Record-level only —
 *  a collection-level mutate has no record to write (schema refine
 *  below). Merge semantics make half-states unconstructible THROUGH
 *  THIS PATH; the raw file stays editable by design (lint, not lock). */
const MutateActionZ = z
  .object({
    kind: z.literal("mutate"),
    ...actionBase,
    require: WhenZ.optional(),
    params: z.record(z.string().trim().min(1), SubFieldSpecZ).optional(),
    set: z.record(z.string().trim().min(1), z.union([z.string(), z.number(), z.boolean()])),
  })
  .refine((spec) => Object.keys(spec.set).length > 0, {
    message: "a mutate action's `set` must name at least one field to write",
    path: ["set"],
  });

/** A schema-declared record action, rendered as a button in the read-only
 *  detail view. Domain-free: the host validates the shape; the meaning
 *  (role + template prose, or the declarative `set`) is data. A
 *  discriminated union on `kind` — each kind declares only its own keys. */
export const ActionSpecZ = z.discriminatedUnion("kind", [SeededActionZ, MutateActionZ]);

/** A custom (LLM-authored) HTML view registration. Domain-free: the host
 *  validates the shape; the view's behaviour lives in the HTML file. `file`
 *  is constrained to `views/*.html` (path-safe) so the view-file reader can
 *  never reach the data folder or the schema/template files. `id` is
 *  validated to be a real slug + unique by schema-level refines below. */
export const CustomViewZ = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  icon: z.string().trim().min(1).optional(),
  // Where the view runs. Absent ⇒ "desktop" (the sandboxed iframe over the
  // token/dataUrl contract), so every pre-existing view keeps its behavior.
  // "mobile" ⇒ served to the phone remote via getRemoteView (postMessage
  // contract, @mulmoclaude/core/remote-view) and phone-frame-previewed on
  // desktop. See plans/done/feat-remote-custom-view.md.
  target: z.enum(["desktop", "mobile"]).optional(),
  file: z
    .string()
    .trim()
    .min(1)
    .refine(isSafeCustomViewPath, "must be a safe path under `views/` ending in `.html` (e.g. `views/year.html`; no `..`, no leading `/`, no backslash)"),
  // A JSON translation dictionary co-located with the view (shape mirrors
  // vue-i18n locale messages; the host injects only the active locale's flat
  // string map into the iframe — see `CollectionCustomView.i18n`'s docs in
  // ./schema's source history / docs/developer.md).
  i18n: z
    .string()
    .trim()
    .min(1)
    .refine(
      isSafeCustomViewI18nPath,
      "must be a safe path under `views/` ending in `.i18n.json` (e.g. `views/year.i18n.json`; no `..`, no leading `/`, no backslash)",
    )
    .optional(),
  // What the view may do with the data endpoint. Defaults to ["read"] (least
  // privilege); the mint endpoint clamps any requested caps to this. There is
  // deliberately no "delete" — a view can never do more than the agent's own
  // manageCollection tool.
  capabilities: z.array(z.enum(["read", "write"])).optional(),
  // Whether this view's `__MC_VIEW.startChat` SENDS instead of drafting (#3062).
  // Default-deny (absent ⇒ draft): the prompt lands in the composer for the user
  // to read / edit / send. Declaring it here rather than letting the view's own
  // code ask is what keeps the decision reviewable — the schema is short and
  // human-read, the view HTML is not — and it is why an already-shipped view
  // cannot start auto-running turns just because the host was upgraded. The
  // host reads THIS, never a flag the iframe posts up. It governs the phone
  // (`target: "mobile"`) as well as the desktop: the phone runtime once always
  // sent, on the grounds that it has no Enter key to press
  // (receptron/mulmoterminal#1253), but that silently overrode default-deny on a
  // device the view's author never tested (receptron/mulmoserver#273).
  allowSendChat: z.boolean().optional(),
  // Mobile-only write policy (plans/done/feat-remote-writable-view.md). Default-deny:
  // a `target: "mobile"` view may patch ONLY these fields via
  // `__MC_VIEW.updateItem`, and may delete only when `allowDelete` is true. The
  // host re-derives + enforces both on every mutate — never trusting the client.
  // Ignored for desktop views (they use the token-scoped `capabilities` above).
  editableFields: z.array(z.string().trim().min(1)).optional(),
  allowDelete: z.boolean().optional(),
  // Mobile-only image inlining (plans/done/feat-remote-view-images.md). A
  // `target: "mobile"` view can't reach the host's localhost, so an `image`-type
  // field's workspace path is unrenderable on the phone; listing it here makes
  // the host inline it as a downscaled `data:` URL thumbnail in getItems pages.
  // Opt-in (absent ⇒ none), projection- and budget-bounded host-side. Ignored
  // for desktop views (they resolve via /api/files/raw).
  imageFields: z.array(z.string().trim().min(1)).optional(),
  imageMaxEdge: z.number().int().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Spawn (host-driven recurrence)
// ---------------------------------------------------------------------------

/** Recurrence advance for `spawn.every`. `interval` is a positive integer
 *  count of `unit`s (`interval: 3` + `unit: "month"` = quarterly);
 *  `dayOfMonth` (month/year only) is the CANONICAL day-of-month anchor
 *  (1-31, read from the rule and clamped per-month at compute time so "31st
 *  of every month" never drifts) or the `"last"` sentinel for end-of-month.
 *  `.strict()` so the union below cleanly rejects an object carrying BOTH
 *  `unit` and `fromField` (it fails this arm on the unknown `fromField`). */
export const EveryLiteralZ = z
  .object({
    unit: z.enum(["day", "week", "month", "year"]),
    interval: z.number().int().min(1),
    dayOfMonth: z.union([z.number().int().min(1).max(31), z.literal("last")]).optional(),
  })
  .strict();

/** Field-driven recurrence: pick the interval per-record by an `enum`
 *  field's value — one collection can mix daily / weekly / monthly
 *  obligations in a single list. `map` keys are validated to exactly cover
 *  that field's `values` by a `CollectionSchemaZ` refine (which can see the
 *  sibling `fields`); here each map value just has to be a well-formed
 *  literal `every`. `.strict()` mirrors the literal arm so a both-keys
 *  object fails this arm too. */
export const EveryFieldDrivenZ = z
  .object({
    fromField: z.string().trim().min(1),
    map: z.record(z.string(), EveryLiteralZ),
  })
  .strict();

/** Either a single literal interval (applied to every record) or the
 *  field-driven map. Two `.strict()` arms mean "both keys" and "neither
 *  key" both fail validation, with no extra refine. */
export const EveryZ = z.union([EveryLiteralZ, EveryFieldDrivenZ]);

/** Host-driven recurrence: when a record satisfies `when` (default:
 *  "`completionField` value ∈ `completionDoneValues`"), the host creates the
 *  next record with a forward-advanced `triggerField` date. `carry` copies
 *  record fields verbatim onto the successor; `set` forces fixed values
 *  (typically resetting the status field to its pending value). The
 *  successor's id and contents are a pure function of (source record, this
 *  rule); creation is create-if-absent, so the mechanism stays convergent. */
export const SpawnZ = z.object({
  when: WhenZ.optional(),
  every: EveryZ,
  carry: z.array(z.string().trim().min(1)).optional(),
  set: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Ingest (scheduled retrieval)
// ---------------------------------------------------------------------------

/** Declarative retrieval config for a Feed (a collection that refills itself
 *  from the internet). `http-json` needs `itemsAt` (a path to the items
 *  array) only when the response body isn't itself the array; rss/atom yield
 *  items natively and ignore it — so no kind-specific requirement here. */
export const DeclarativeIngestZ = z.object({
  kind: z.enum(INGEST_KINDS),
  url: z.url(),
  schedule: z.enum(FEED_SCHEDULES),
  // Optional UTC hour (0–23) to anchor a `daily` schedule; ignored otherwise.
  atHour: z.number().int().min(0).max(23).optional(),
  itemsAt: z.string().trim().min(1).optional(),
  map: z.record(z.string().trim().min(1), z.string().trim().min(1)),
  idFrom: z.string().trim().min(1).optional(),
  maxItems: z.number().int().min(0).optional(),
});

/** Agent-performed retrieval. Valid on any collection (the primary consumer
 *  is skill-backed collections — feeds keep their declarative kinds). No
 *  `url`/`map`: the worker owns retrieval and record shape, seeded by
 *  `template` + a summary of every record, run in `role`. `template` is
 *  validated the SAME way an action's template is (safe path under
 *  `templates/`), so the skill-bridge mirrors it identically. */
export const AgentIngestZ = z.object({
  kind: z.literal(AGENT_INGEST_KIND),
  schedule: z.enum(FEED_SCHEDULES),
  // Optional UTC hour (0–23) to anchor a `daily` schedule; ignored otherwise.
  atHour: z.number().int().min(0).max(23).optional(),
  role: z.string().trim().min(1),
  template: z
    .string()
    .trim()
    .min(1)
    .refine(isSafeActionTemplatePath, "must be a safe path under `templates/` (e.g. `templates/refresh.md`; no `..`, no leading `/`, no backslash)"),
});

/** The Google event fields a collection may pull from. `id` is absent on
 *  purpose — it always lands in the primary field, since upsert-by-event-id
 *  is what makes the sync idempotent.
 *
 *  A superset of `PUSHABLE_SOURCE_FIELDS` (`google/pushPlan.ts`), listed with
 *  the pushable ones first. Mapping one of the rest gives a PULL-ONLY column
 *  that the push filters out — a choice of this sync, not only a Google
 *  limitation: `transparency` is writable and `eventType` is writable at
 *  creation, yet neither is sent. That is also why
 *  widening this enum needs no `.push-state.json` migration: the push baseline
 *  (`ShadowEvent`) is keyed off the pushable list, not off this one.
 *
 *  The last two are not Google field names but DERIVED scalars
 *  (`google/eventDerived.ts`): the structures they come from are arrays, and a
 *  collection field holds one value. */
export const GOOGLE_CALENDAR_SOURCE_FIELDS = [
  "summary",
  "start",
  "end",
  "description",
  "location",
  "colorId",
  "htmlLink",
  "status",
  "recurringEventId",
  "originalStartTime",
  "updated",
  "transparency",
  "eventType",
  "hangoutLink",
  "selfResponseStatus",
  "conferenceVideoUri",
] as const;

/** Marks a collection as the destination of the LLM-free Google Calendar
 *  sync (#2095). `map` is collectionField → Google event field, so the user's
 *  collection keeps whatever field names it already uses. */
export const GoogleCalendarSyncZ = z.object({
  /** Calendar to pull from; defaults to the user's primary. */
  calendarId: z.string().trim().min(1).optional(),
  // An empty map is silently useless rather than harmless: the sync would run
  // and write a record per event carrying ONLY the event id, so the user gets
  // rows with no content. Fail at load instead.
  map: z.record(z.string().trim().min(1), z.enum(GOOGLE_CALENDAR_SOURCE_FIELDS)).refine((map) => Object.keys(map).length > 0, {
    message: "map at least one field — a `googleCalendar` sync with an empty map writes records that carry only the event id",
  }),
  /** Run the push on the sync schedule too, immediately before each pull, so
   *  local edits reach Google without anyone pressing a button (#2620).
   *
   *  Opt-in and absent by default: a push writes to a calendar other people may
   *  read, so turning it on is the user's decision, not a default. */
  autoPush: z.boolean().optional(),
  /** Delete the Google event when its record is deleted in the collection
   *  (#3234). Absent by default, and absent means what it has always meant:
   *  the deletion is reported and Google is left alone.
   *
   *  Separate from `autoPush` rather than folded into it, because the two are
   *  different sizes of decision — `autoPush` changes WHEN a write happens,
   *  this one makes a write irreversible. Even on, the push refuses an event
   *  with attendees (`google/deletePlan.ts`). */
  propagateDeletes: z.boolean().optional(),
});

/** `ingest` is a discriminated union on `kind`: the three declarative
 *  retrievers fetch-and-map; `agent` dispatches a hidden worker. Optional on
 *  every schema — skill-backed collections usually omit it; only feeds
 *  discovered from `<workspace>/feeds/` are REQUIRED to carry it (gated by
 *  `acceptParsedSchema`). */
export const IngestZ = z.discriminatedUnion("kind", [DeclarativeIngestZ, AgentIngestZ]);

// ---------------------------------------------------------------------------
// dynamicIcon (data-driven launcher icon) and its `where` predicate
// ---------------------------------------------------------------------------

// Data-driven launcher-icon override (see `CollectionSchema.dynamicIcon`).
// `source.collection` may name ANY collection (self or cross-collection),
// so — unlike `ref`/`embed`/`when.field` elsewhere in this file — its
// shape is validated here without a cross-field refine against a specific
// target schema (that collection may not even be loaded yet); a bad
// `source.collection`/`orderBy`/condition `field` fails soft at compute
// time instead (`computeCollectionIcon`), matching this feature's locked
// design (see plans/done/feat-dynamic-collection-icons.md "Open questions").
//
// `where` is the AND-of-conditions predicate defined at the top of this
// file (`WhereZ`, shared with `flag` fields) — see `./where` for the
// evaluator.
export const DynamicIconSourceZ = z.object({
  collection: z.string().trim().min(1),
  from: z.enum(["latest", "first", "when"]).optional(),
  orderBy: z.string().trim().min(1).optional(),
  where: WhereZ.optional(),
});
export const DynamicIconRuleZ = z.object({
  where: WhereZ,
  icon: z.string().trim().min(1),
});
export const DynamicIconSpecZ = z.object({
  source: DynamicIconSourceZ,
  rules: z.array(DynamicIconRuleZ),
  fallback: z.string().trim().min(1).optional(),
});

// ---------------------------------------------------------------------------
// dataSource (external read-only data file)
// ---------------------------------------------------------------------------

/** External-data collection: the records ARE the rows of a user-supplied
 *  data file (v1: CSV), queried through DuckDB — never copied into
 *  `<dataDir>/<id>.json` files. Declaring `dataSource` makes the collection
 *  **read-only** in every UI/tool write path; updates happen by replacing /
 *  editing the file itself (file-watch republishes the views). `path` is
 *  workspace-relative and containment-checked exactly like `dataPath`. The
 *  row-id column is the schema's existing `primaryKey` — there is
 *  deliberately no second key concept here.
 *  See plans/done/feat-collection-csv-duckdb-source.md. */
export const DataSourceZ = z.object({
  type: z.literal("csv"),
  path: z.string().min(1),
});

// ---------------------------------------------------------------------------
// storage (alternative writable record backend)
// ---------------------------------------------------------------------------

/** Alternative WRITABLE storage backend for a collection's records —
 *  unlike `dataSource` (external read-only file), a `storage` collection
 *  behaves like a normal writable collection; only where the rows live
 *  changes. The store factory registry (`server/store.ts`) picks the
 *  implementation by `type` (plans/done/refactor-storage-virtualization.md).
 *
 *  A discriminated union rather than one shape with optional keys, because
 *  only the sqlite variant is a workspace FILE: its `path` is
 *  workspace-relative and containment-checked exactly like `dataPath`, while
 *  the firestore variant has no path to check — its records are not on this
 *  machine at all. Optional keys would let each arm accept the other's, and
 *  the compiler would stop being the thing that tells you which. */
export const StorageZ = z.discriminatedUnion("type", [
  /** Records in a single SQLite database file (`node:sqlite`, one JSON
   *  record per row keyed by the primaryKey). */
  z.object({
    type: z.literal("sqlite"),
    path: z.string().min(1),
  }),
  /** Records as Firestore documents of a SHARED collection, at
   *  `apps/{aid}/collections/{cid}/items/{id}`.
   *
   *  This variant declares NO location, and that is the whole shape of it:
   *  `aid` comes from the repository's `app.json` (it is one per app, not one
   *  per collection — four collections share one member roster), and `cid` is
   *  always this collection's slug. There is nothing left for a schema to say.
   *
   *  `.strict()` (the same reason the `spawn` arms use it): stripping an
   *  unknown key silently would confirm a wrong mental model — an author who
   *  writes `path` believes their records land there, and an author who writes
   *  `cid` believes the collection can be named something other than its slug.
   *  Only this new arm is strict; the sqlite arm stays permissive so an
   *  existing schema carrying a stray key doesn't start failing. */
  z
    .object({
      type: z.literal("firestore"),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// The whole schema
// ---------------------------------------------------------------------------

/** The schema's SHAPE, before any cross-field rule runs. Named so the rules in
 *  `./schemaRules` can type their argument against it — they receive whatever
 *  this parses to, and nothing narrower. */
const CollectionObjectZ = z.object({
  title: z.string().min(1),
  // Optional accent colour, drawn as a pale chip behind the launcher glyph so
  // collections sharing a generic icon stay distinguishable (#2987).
  //
  // `.catch(undefined)` is load-bearing, not defensive dressing: discovery
  // treats a schema that fails validation as NO COLLECTION AT ALL
  // (`safeParse` fails -> `return null`, the row vanishes from every index).
  // A bare `z.enum(...).optional()` would therefore make one mistyped colour
  // cost the user their whole collection — a catastrophic price for a
  // cosmetic field. Catching normalises the unknown value away instead: the
  // key is dropped, the collection loads, and the launcher draws it unstyled.
  color: z.enum(ACCENT_COLORS).optional().catch(undefined),
  // A Material Symbols ligature name, or a single emoji. Deliberately not
  // pattern-constrained: every renderer goes through `resolveIconGlyph`
  // (core/iconGlyph.ts), which decides which of the two a value is and cuts
  // anything else down to one grapheme — so a bad value degrades to a plain
  // character instead of being rejected at write time.
  icon: z.string().min(1),
  // Exactly one of `dataPath` (native JSON-file records), `dataSource`
  // (external read-only data file), or `storage` (alternative writable
  // backend) — enforced by a refine below.
  dataPath: z.string().min(1).optional(),
  dataSource: DataSourceZ.optional(),
  storage: StorageZ.optional(),
  primaryKey: z.string().min(1),
  // When set, the collection holds at most one record whose primary
  // key is this exact value (e.g. `me` for the business profile).
  // The host fixes the create form's primary key to it and hides the
  // Add button once the record exists.
  singleton: z.string().trim().min(1).optional(),
  fields: z.record(z.string(), FieldSpecZ),
  actions: z.array(ActionSpecZ).optional(),
  // Collection-level actions (header buttons). Same shape as `actions`;
  // the `when` predicate is ignored (no record context). The seed
  // prompt injects a progress summary of all records instead.
  collectionActions: z.array(ActionSpecZ).optional(),
  // Completion-tracking pair: when both are set, item-create fires a
  // notification that clears once `completionField` transitions into
  // `completionDoneValues`. The two are bound together — declaring
  // one without the other is a misconfiguration the cross-field
  // refine below rejects.
  completionField: z.string().trim().min(1).optional(),
  completionDoneValues: z.array(z.string().trim().min(1)).min(1).optional(),
  // Optional human-readable label for the completion notification's
  // title — names the field whose value reads better than the opaque
  // primaryKey (e.g. a `name` field). Falls back to the primaryKey
  // value at render time when unset or empty.
  displayField: z.string().trim().min(1).optional(),
  // Time gate: names a `date` field that delays the completion bell
  // until the clock reaches it. Requires the completion pair (the bell
  // still clears via the done value). Validated to name a real `date`
  // field by refines below.
  triggerField: z.string().trim().min(1).optional(),
  // Lead time in whole days — fire the bell this many days before
  // `triggerField`. Non-negative; requires `triggerField` (refine below).
  triggerLeadDays: z.number().int().min(0).optional(),
  // Host-driven recurrence; requires `triggerField`. See SpawnZ.
  spawn: SpawnZ.optional(),
  // Calendar view anchor: names a `date` field whose value places each
  // record on a month grid. Validated to name a real `date` field by a
  // refine below. Optional — the toggle auto-derives from any `date`
  // field when this is unset.
  calendarField: z.string().trim().min(1).optional(),
  // Multi-day span end: a second `date` field the calendar record spans
  // to. Requires `calendarField`; validated to name a real `date` field.
  calendarEndField: z.string().trim().min(1).optional(),
  // Day (time-allocation) view time source: names a string field holding a
  // free-form time or time-range (e.g. "14:00-17:00", "17:00-", "16:30").
  // Consulted only when the date fields are date-only. Requires
  // `calendarField`; validated to name a real field by a refine below.
  calendarTimeField: z.string().trim().min(1).optional(),
  // Kanban board group: names an `enum` field whose value buckets each
  // record into a column. Validated to name a real `enum` field by a
  // refine below. Optional — the toggle auto-derives from any `enum`
  // field when this is unset.
  kanbanField: z.string().trim().min(1).optional(),
  // Opt out of a built-in view toggle (`false` hides it) for collections read
  // through custom views. `.strict()` so a misspelt key fails instead of
  // silently leaving the toggle on.
  builtinViews: z.object({ calendar: z.boolean().optional(), kanban: z.boolean().optional() }).strict().optional(),
  // Custom (LLM-authored) HTML views. Each renders in a sandboxed iframe
  // over the records. Optional, so every existing schema validates
  // unchanged. Ids validated to be valid + unique slugs by refines below.
  views: z.array(CustomViewZ).optional(),
  // Completion-bell gate: only notify for records matching this predicate
  // (e.g. high-priority todos). Reuses the `when` shape; requires
  // `completionField`; field validated to exist by refines below.
  notifyWhen: WhenZ.optional(),
  // Declarative retrieval config. Present only on Feeds (collections in
  // the `<workspace>/feeds/` registry). Optional, so every existing
  // skill schema validates unchanged.
  ingest: IngestZ.optional(),
  // Declares this collection as the destination of the LLM-free Google
  // Calendar sync. Optional, so every existing schema validates unchanged.
  googleCalendar: GoogleCalendarSyncZ.optional(),
  // Data-driven launcher-icon override. Optional, so every existing
  // schema validates unchanged; `source` is required within it.
  dynamicIcon: DynamicIconSpecZ.optional(),
});

export type CollectionSchemaInput = z.infer<typeof CollectionObjectZ>;

const BareCollectionSchemaZ = CollectionObjectZ
  // Exactly one storage declaration: native records need `dataPath`, an
  // external data file needs `dataSource`, an alternative backend needs
  // `storage`. Zero (nowhere to read) and several (ambiguous which wins)
  // are equally meaningless — fail loudly at load instead of picking
  // silently.
  .refine(declaresExactlyOneStore, {
    message:
      "declare exactly one of `dataPath` (native JSON records), `dataSource` (external read-only data file), or `storage` (alternative writable backend)",
    path: ["dataPath"],
  })
  // NOTE: `storage` collections support the full write machinery
  // (`spawn` / `completionField` / `triggerField` / `singleton` / `ingest`
  // / mutate actions) — spawn and the watcher reconcilers go through the
  // CollectionStore seam. What DRIVES that reconciliation differs by
  // backend: `sqlite` has a db-file watcher, while `firestore` has no file
  // to watch and is reconciled on the clock tick instead
  // (`tickUnwatchedCollections`) until the snapshot listener lands. Either
  // way the declared behaviour runs — that equivalence is what lets this
  // refine stay backend-agnostic.
  // A `dataSource` collection is read-only by definition, so schema-level
  // write machinery can never fire: `singleton` pins CREATES, `ingest`
  // REFILLS records, `spawn` WRITES successor records. Rejecting them at
  // validation kills whole classes of writes before any runtime guard.
  .refine(dataSourceDeclaresNoWriteMachinery, {
    message: "a `dataSource` collection is read-only — it cannot declare `singleton`, `ingest`, `spawn`, or `googleCalendar` (all of them write records)",
    path: ["dataSource"],
  })
  // The sync writes each mapped value into a declared field, and puts the
  // Google event id in the primary field — so a map key that names no field
  // (or names the primary) would silently drop data or fight the id.
  .refine(googleCalendarMapNamesStoredFields, {
    message: "a `googleCalendar` map key must name a declared, non-computed field, and never the primaryKey (that always holds the Google event id)",
    path: ["googleCalendar"],
  })
  // Same rule for declarative host writes: a mutate action writes the
  // record it's invoked on.
  .refine(dataSourceDeclaresNoMutateAction, {
    message: 'a `dataSource` collection is read-only — its actions cannot use `kind: "mutate"` (a host write); use `chat`/`agent` actions instead',
    path: ["dataSource"],
  })
  // The singleton value becomes a record id (and thus a `<id>.json`
  // filename), so it must satisfy the SAME record-id rule the write path
  // enforces — otherwise the create form would lock the primary key to a
  // value the POST route then rejects as an invalid item id, making the
  // collection impossible to initialize (Codex P1).
  .refine(singletonIsAValidRecordId, {
    message: "schema `singleton` must be a valid item id (alphanumeric / hyphen / underscore / interior dot, no `..` or path separators)",
    path: ["singleton"],
  })
  // Action ids must be unique so the dispatch route resolves
  // unambiguously.
  .refine(actionIdsAreUnique, {
    message: "schema `actions` must have unique `id`s",
    path: ["actions"],
  })
  // Collection-level action ids must likewise be unique.
  .refine(collectionActionIdsAreUnique, {
    message: "schema `collectionActions` must have unique `id`s",
    path: ["collectionActions"],
  })
  // A mutate action's `set` writes real STORED fields: a typo'd key
  // would write a stray value forever, a computed/projected field is
  // never persisted, and the primaryKey is the filename (renaming is
  // not a mutation).
  .refine(mutateSetKeysNameStoredFields, {
    message: "a mutate action's `set` keys must name declared, non-computed fields (and never the primaryKey)",
    path: ["actions"],
  })
  // Every `$params.<name>` reference in `set` must name a declared
  // param — an undeclared one would silently no-op the assignment.
  .refine(mutateParamRefsAreDeclared, {
    message: "a mutate action's `$params.<name>` references must name keys declared in its `params`",
    path: ["actions"],
  })
  // A collection-level action has no record to write.
  .refine(collectionActionsAreNotMutate, {
    message: '`collectionActions` cannot contain `kind: "mutate"` — a collection-level action has no record to write',
    path: ["collectionActions"],
  })
  // A `currencyField` pointer must name a real top-level field that
  // holds a code string — a typo (`curreny`) would otherwise pass the
  // per-field check, then silently fall back to the literal / USD at
  // render and mislabel amounts. Checked at the schema level because a
  // field can't see its siblings.
  .refine(currencyFieldRefsNameCodeFields, {
    message: "a money field's `currencyField` must name a top-level `string`, `text`, or `enum` field that holds the currency code",
    path: ["fields"],
  })
  // Completion-tracking pair must be declared together: declaring
  // `completionField` without `completionDoneValues` (or vice-versa)
  // is meaningless — the host would either never fire (no done values
  // to compare against) or never clear (no field to read). Bound
  // together so the misconfiguration fails loudly at load time.
  // EXCEPTION: when `completionField` names a `flag` field, done ⇔ the
  // flag's `where` matches, so `completionDoneValues` carries no
  // information and MUST be omitted (declaring it would invite a
  // contradictory second source of truth).
  .refine(completionPairIsCoherent, {
    message:
      "schema `completionField` and `completionDoneValues` must be declared together (both set, or both omitted) — unless `completionField` names a `flag` field, in which case `completionDoneValues` must be omitted (done ⇔ the flag matches)",
    path: ["completionField"],
  })
  // `completionField` must name a real top-level field — a typo would
  // silently disable the notification mechanism otherwise.
  .refine(completionFieldIsDeclared, {
    message: "schema `completionField` must name a top-level field declared in `fields`",
    path: ["completionField"],
  })
  // `displayField`, like `completionField`, must name a real top-level
  // field — a typo would silently fall back to the primaryKey forever.
  .refine(displayFieldIsDeclared, {
    message: "schema `displayField` must name a top-level field declared in `fields`",
    path: ["displayField"],
  })
  // A field's `when.field` gates its visibility against a sibling's
  // value, so it must name a real top-level field — a typo would
  // silently keep the field hidden forever (the gate never matches).
  // Checked at the schema level because a field can't see its siblings.
  .refine(fieldVisibilityGatesNameDeclaredFields, {
    message: "a field's `when.field` must name a top-level field declared in `fields`",
    path: ["fields"],
  })
  // A flag's `where` reads sibling fields (both `cond.field` and a
  // same-record `valueFrom.field`), so each must name a real top-level
  // field — a typo would silently pin the flag false forever (`ne`:
  // true forever). Checked at the schema level because a field can't
  // see its siblings.
  .refine(flagConditionsNameDeclaredFields, {
    message: "a flag field's `where` conditions must name top-level fields declared in `fields` (both `field` and a same-record `valueFrom.field`)",
    path: ["fields"],
  })
  // A flag named by `completionField` is evaluated against the RAW
  // record — the reconciler (and spawn's fallback) read items straight
  // off disk, BEFORE any `deriveAll` enrichment — so its `where` may
  // only reference STORED fields. A condition over a computed sibling
  // (derived/rollup/toggle/flag/embed/backlinks) would see an absent
  // key: `ne` matches vacuously, every other op reads false, and the
  // bell would clear wrongly / never. General (non-completion) flags
  // keep the full vocabulary — the UI evaluates them post-enrichment.
  .refine(completionFlagReadsOnlyStoredFields, {
    message:
      "a `flag` named by `completionField` may only reference STORED fields in its `where` — completion is evaluated against the raw record (before deriveAll), where computed values (derived/rollup/toggle/flag/embed/backlinks) are absent",
    path: ["completionField"],
  })
  // The spawn-inert guard (`spawnSuccessorStartsInert`) statically
  // checks that a successor is not born already matching the spawn
  // predicate; it cannot see through a flag's `where` (the predicate
  // would need full record evaluation against `set`/`carry`). So a
  // schema whose completion is flag-form may only spawn with an
  // explicit `spawn.when` — which the guard CAN check.
  .refine(flagCompletionSpawnDeclaresWhen, {
    message:
      "a schema whose `completionField` names a `flag` field must declare an explicit `spawn.when` (the spawn-inert check cannot statically evaluate a flag's `where`)",
    path: ["spawn"],
  })
  // An `embed`'s `idField` resolves the target record id from a sibling's
  // value, so it must name a real top-level field — and one whose stored
  // value is a plain id string. Only `ref` / `string` qualify: the editor
  // writes the picked id into that field, so a non-persisted or composite
  // type (`embed` / `derived` / `toggle` / `table` / `number` / …) would
  // either not round-trip on save or hold no usable id. Restricting it
  // makes the misconfiguration fail at schema load, not silently at
  // render. `idField` is ignored on non-`embed` fields, so only check
  // there. Schema-level because a field can't see its siblings.
  .refine(embedIdFieldsNameIdBearingFields, {
    message: "an embed field's `idField` must name a top-level `ref` or `string` field declared in `fields`",
    path: ["fields"],
  })
  // `triggerField` requires the completion pair: the time gate only
  // suppresses the *completion* bell until the date, and the bell still
  // clears via `completionDoneValues`. Without completion there is no
  // bell to gate (or clear), so the declaration is meaningless.
  .refine(triggerFieldRequiresCompletion, {
    message: "schema `triggerField` requires `completionField` / `completionDoneValues` (the gated bell still clears via the done value)",
    path: ["triggerField"],
  })
  // `triggerField` must name a real `date` field — the gate parses its
  // value as `YYYY-MM-DD`; any other type can't be compared to the clock.
  .refine(triggerFieldIsADateField, {
    message: "schema `triggerField` must name a top-level `date` field declared in `fields`",
    path: ["triggerField"],
  })
  // `triggerLeadDays` only means something relative to a trigger date.
  .refine(triggerLeadDaysRequiresTriggerField, {
    message: "schema `triggerLeadDays` requires `triggerField` (it shifts when that field's bell fires)",
    path: ["triggerLeadDays"],
  })
  // `spawn` advances `triggerField` to compute the successor's trigger
  // date, so the schema must declare one.
  .refine(spawnRequiresTriggerField, {
    message: "schema `spawn` requires `triggerField` (the successor's trigger date is `triggerField` advanced by `spawn.every`)",
    path: ["spawn"],
  })
  // `spawn.when.field` and every `spawn.carry` entry must name real
  // top-level fields — a typo would silently never match / never copy.
  .refine(spawnWhenFieldIsDeclared, {
    message: "schema `spawn.when.field` must name a top-level field declared in `fields`",
    path: ["spawn"],
  })
  .refine(spawnCarryEntriesAreDeclared, {
    message: "every `spawn.carry` entry must name a top-level field declared in `fields`",
    path: ["spawn"],
  })
  // A successor must NOT be born already matching its own spawn predicate
  // — it would re-spawn on its first reconcile, fanning out into an
  // unbounded chain of records. The predicate field/values are `spawn.when`
  // when given, else the completion-done pair (the default predicate). The
  // successor's value for that field is `set[field]` if set, else the
  // carried source value (which matched, by definition, when the spawn
  // fired) if carried, else absent (safe). Reject the first two when they
  // land on a matching value.
  .refine(spawnSuccessorStartsInert, {
    message:
      "`spawn` must leave the successor in a non-matching state (e.g. `set` the status to a pending value); seeding the predicate field to a matching value via `set`/`carry` would respawn forever",
    path: ["spawn"],
  })
  // Field-driven `spawn.every` (§4.1): `fromField` must name a top-level
  // `enum` — the only field type with a closed, finite value set to drive
  // the `map` and the form `<select>`.
  .refine(fieldDrivenFromFieldIsEnum, {
    message: "`spawn.every.fromField` must name a top-level `enum` field declared in `fields`",
    path: ["spawn"],
  })
  // Field-driven `spawn.every` (§4.2): the `map` keys must exactly cover the
  // enum's `values` — a missing key would stall a record at that frequency;
  // an extra key signals a map left stale after an enum edit.
  .refine(fieldDrivenMapCoversValues, {
    message: "`spawn.every.map` keys must exactly cover the `values` of the `enum` named by `fromField` (no missing or extra keys)",
    path: ["spawn"],
  })
  // Field-driven `spawn.every` (§4.5): `fromField` must be carried (or `set`)
  // onto the successor, or the next spawn in the chain can't resolve an
  // interval and the recurrence silently halts.
  .refine(fieldDrivenFromFieldCarried, {
    message:
      "`spawn.every.fromField` must appear in `spawn.carry`, or be written by `spawn.set` to a value present in `spawn.every.map`, so the successor keeps a resolvable recurrence interval",
    path: ["spawn"],
  })
  // `calendarField` must name a real `date`/`datetime` field — the calendar
  // view parses its value to place records on the month grid (a `datetime`
  // anchor also carries the clock for the day view); any other type can't be
  // put on a calendar.
  .refine(calendarFieldIsDateLike, {
    message: "schema `calendarField` must name a top-level `date` or `datetime` field declared in `fields`",
    path: ["calendarField"],
  })
  // `calendarEndField` marks the end of a multi-day span, so it only means
  // something alongside a start anchor.
  .refine(calendarEndFieldRequiresCalendarField, {
    message: "schema `calendarEndField` requires `calendarField` (it marks the end of the span that starts at `calendarField`)",
    path: ["calendarEndField"],
  })
  // `calendarEndField` must also name a real `date`/`datetime` field — same parse.
  .refine(calendarEndFieldIsDateLike, {
    message: "schema `calendarEndField` must name a top-level `date` or `datetime` field declared in `fields`",
    path: ["calendarEndField"],
  })
  // `calendarTimeField` places records on the day view, so it only means
  // something alongside a start anchor.
  .refine(calendarTimeFieldRequiresCalendarField, {
    message: "schema `calendarTimeField` requires `calendarField` (it supplies the time-of-day for the calendar's day view)",
    path: ["calendarTimeField"],
  })
  // `calendarTimeField` must name a real top-level field (a free-form time
  // string the day view parses).
  .refine(calendarTimeFieldIsDeclared, {
    message: "schema `calendarTimeField` must name a top-level field declared in `fields`",
    path: ["calendarTimeField"],
  })
  // …and that field must be string-backed — the day view parses its value as a
  // time string, so a number/enum/date column can't drive it.
  .refine(calendarTimeFieldIsStringBacked, {
    message: "schema `calendarTimeField` must name a top-level `string` or `text` field declared in `fields`",
    path: ["calendarTimeField"],
  })
  // `kanbanField` must name a real `enum` field — the board groups records
  // into one column per declared enum value; any other type has no closed
  // set of columns to group by.
  .refine(kanbanFieldIsAnEnum, {
    message: "schema `kanbanField` must name a top-level `enum` field declared in `fields`",
    path: ["kanbanField"],
  })
  // A `toggle` field projects an `enum` field: its `field` must name a real
  // top-level enum, and `onValue` / `offValue` must be members of that
  // enum's `values` — otherwise toggling would write a value outside the
  // closed set (and never appear "checked").
  .refine(togglesProjectValidEnums, {
    message: "a `toggle` field's `field` must name a top-level `enum` field, and its `onValue`/`offValue` must be values of that enum",
    path: ["fields"],
  })
  // `notifyWhen` narrows the completion bell, so it only means something with
  // completion tracking, and its `field` must name a real top-level field.
  .refine(notifyWhenRequiresCompletion, {
    message: "schema `notifyWhen` requires `completionField` (it narrows that bell)",
    path: ["notifyWhen"],
  })
  .refine(notifyWhenFieldIsDeclared, {
    message: "schema `notifyWhen.field` must name a top-level field declared in `fields`",
    path: ["notifyWhen"],
  })
  // Every custom view `id` must be a valid slug — it doubles as the
  // view-mode selector key (`custom:<id>`) and the capability-token clamp
  // key, both of which expect a path-safe token.
  .refine(viewIdsAreSlugs, {
    message: "every `views[].id` must be a valid slug (alphanumeric / hyphen / underscore, no path separators)",
    path: ["views"],
  })
  // Custom view ids must be unique so the selector + token clamp resolve
  // unambiguously.
  .refine(viewIdsAreUnique, {
    message: "schema `views` must have unique `id`s",
    path: ["views"],
  });

// ---------------------------------------------------------------------------
// Prototype-sensitive field names — checked on the RAW input
// ---------------------------------------------------------------------------

// A field name becomes a plain-object key THROUGHOUT the engine — record
// JSON, edit drafts, enrichment output, view filter state — where a
// prototype-sensitive name would read (or write) inherited prototype data
// instead of field data (Codex review on PR #2176: a flag named
// `__proto__` jams its filter chip). This check must run BEFORE zod
// parses: zod's record builder silently SKIPS an own `__proto__` input
// key (pollution safety), so a post-parse refine would never see it and
// the author's field would just vanish. Hence the `z.preprocess` wrapper
// below rather than another `.refine`.
const PROTOTYPE_KEYS = ["__proto__", "constructor", "prototype"] as const;

/** The first own prototype-sensitive key of `value`, or null. */
function ownPrototypeKey(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  for (const key of PROTOTYPE_KEYS) {
    if (Object.hasOwn(value, key)) return key;
  }
  return null;
}

/** Own enumerable entries of an object (arrays keyed by index), none for
 *  anything else — the raw input is unvalidated, so `fields` may be junk. */
function ownEntries(value: unknown): [string, unknown][] {
  if (isUnknownArray(value)) return value.map((entry, index): [string, unknown] => [String(index), entry]);
  return isRecord(value) ? Object.entries(value) : [];
}

/** The name-defining sub-record a raw field spec (`of`) or action (`params`)
 *  carries, or undefined when the holder isn't an object at all. */
function nameDefiningSubRecord(holder: unknown, key: "of" | "params"): unknown {
  return isRecord(holder) ? holder[key] : undefined;
}

/** Dotted path of the first prototype-sensitive `params` name across both
 *  action lists, or null. */
function prototypeActionParamPath(input: Record<string, unknown>): string | null {
  for (const [listName, list] of [
    ["actions", input.actions],
    ["collectionActions", input.collectionActions],
  ] as const) {
    for (const action of isUnknownArray(list) ? list : []) {
      const badParam = ownPrototypeKey(nameDefiningSubRecord(action, "params"));
      if (badParam !== null) return `${listName}.params.${badParam}`;
    }
  }
  return null;
}

/** Dotted path of the first prototype-sensitive field name in the raw
 *  schema input — top-level `fields`, each table field's `of`, and each
 *  action's `params` (the three records that DEFINE names) — or null. */
function prototypeFieldKeyPath(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const bad = ownPrototypeKey(input.fields);
  if (bad !== null) return `fields.${bad}`;
  for (const [key, spec] of ownEntries(input.fields)) {
    const badSub = ownPrototypeKey(nameDefiningSubRecord(spec, "of"));
    if (badSub !== null) return `fields.${key}.of.${badSub}`;
  }
  return prototypeActionParamPath(input);
}

export const CollectionSchemaZ = z.preprocess((input, ctx) => {
  const bad = prototypeFieldKeyPath(input);
  if (bad !== null) {
    ctx.addIssue({ code: "custom", message: `'${bad}': field names must not be prototype-sensitive keys (\`__proto__\`, \`constructor\`, \`prototype\`)` });
    return z.NEVER;
  }
  return input;
}, BareCollectionSchemaZ);
