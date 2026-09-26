// Unit tests for the pure, reactivity-free transforms extracted from the
// collection rendering composable
// (packages/plugins/collection-plugin/src/vue/useCollectionRendering.helpers.ts).
// These are plain functions of their arguments — no vue / DOM / caches —
// so they pin the money/label/target/option logic the templates depend on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  CollectionDetail,
  CollectionDetailResponse,
  CollectionItem,
  CollectionSchema,
  CollectionFieldSpec as FieldSpec,
  CollectionFieldType as FieldType,
} from "@mulmoclaude/core/collection";
import {
  buildEmbedOptions,
  buildRefDisplayMap,
  buildRefRecordMap,
  currencySymbolForLocale,
  detailText,
  displayFieldFor,
  formatCell,
  formatMoney,
  hasTableRows,
  inputTypeFor,
  isExternalUrl,
  isServerStamped,
  resolveCurrency,
  sortedRefOptions,
  stepForFieldType,
  tableRows,
} from "../../../packages/plugins/collection-plugin/src/vue/useCollectionRendering.helpers";

// Fixture builder: assembles a spec dynamically (often deliberately partial),
// so it casts rather than satisfying the discriminated union per-variant.
const field = (type: FieldType, extra: Record<string, unknown> = {}): FieldSpec => ({ type, label: type, ...extra }) as FieldSpec;

const makeSchema = (fields: Record<string, FieldSpec>, primaryKey = "id"): CollectionSchema => ({
  title: "Test",
  icon: "list",
  dataPath: "collections/test",
  primaryKey,
  fields,
});

const makeDetail = (schema: CollectionSchema, items: CollectionItem[]): CollectionDetailResponse => {
  const collection: CollectionDetail = { slug: "test", title: "Test", icon: "list", source: "user", schema };
  return { collection, items };
};

describe("stepForFieldType", () => {
  it("emits a 2-decimal step for money and step=any for number", () => {
    assert.equal(stepForFieldType("money"), "0.01");
    assert.equal(stepForFieldType("number"), "any");
  });
  it("is undefined for non-numeric field types", () => {
    assert.equal(stepForFieldType("text"), undefined);
    assert.equal(stepForFieldType("date"), undefined);
  });
});

describe("inputTypeFor", () => {
  it("maps money to the number input", () => {
    assert.equal(inputTypeFor("money"), "number");
    assert.equal(inputTypeFor("number"), "number");
  });
  it("maps datetime to datetime-local and passes through email/date", () => {
    assert.equal(inputTypeFor("datetime"), "datetime-local");
    assert.equal(inputTypeFor("email"), "email");
    assert.equal(inputTypeFor("date"), "date");
  });
  it("does not offer a datetime-local for a value it cannot hold", () => {
    // A shared collection can pin a `datetime` to the server's clock, and what reaches the UI is
    // the canonical instant. `datetime-local` cannot hold that string, so the control would render
    // EMPTY — and saving the record would then write the empty value over a field the rules refuse
    // to see move, failing the whole update with a permission error that names nothing.
    const stamped = "2026-08-15T23:05:54.605987654Z";
    assert.equal(isServerStamped(stamped), true);
    assert.equal(inputTypeFor("datetime", stamped), "text");
    // A civil value an author typed is still edited as a datetime.
    assert.equal(isServerStamped("2026-08-15T10:00"), false);
    assert.equal(inputTypeFor("datetime", "2026-08-15T10:00"), "datetime-local");
    assert.equal(inputTypeFor("datetime", ""), "datetime-local");
    // And nothing else is affected by the value. The lock is read alongside the field's TYPE
    // where it is rendered, because this input is shared with string / email / ref / image / file
    // — a string field whose value happens to look canonical must stay editable.
    assert.equal(inputTypeFor("date", stamped), "date");
    assert.equal(inputTypeFor("string", stamped), "text");
  });
  it("keeps a date picker for an all-day bare date in a datetime field", () => {
    // `datetime-local` shows a bare date as blank, and saving then writes the blank back.
    assert.equal(inputTypeFor("datetime", "2026-09-28"), "date");
    assert.equal(inputTypeFor("datetime", "2026-02-30"), "datetime-local");
    assert.equal(inputTypeFor("date", "2026-09-28"), "date");
  });
  it("falls back to text for everything else", () => {
    assert.equal(inputTypeFor("markdown"), "text");
    assert.equal(inputTypeFor("ref"), "text");
  });
});

describe("isExternalUrl", () => {
  it("accepts http and https, case-insensitively", () => {
    assert.equal(isExternalUrl("http://example.com"), true);
    assert.equal(isExternalUrl("https://example.com"), true);
    assert.equal(isExternalUrl("HTTPS://EXAMPLE.COM"), true);
  });
  it("rejects non-http schemes, relative paths, and non-strings", () => {
    assert.equal(isExternalUrl("ftp://example.com"), false);
    assert.equal(isExternalUrl("/local/path"), false);
    assert.equal(isExternalUrl(""), false);
    assert.equal(isExternalUrl(42), false);
    assert.equal(isExternalUrl(null), false);
  });
});

describe("detailText", () => {
  it("renders an em-dash for empty-ish values", () => {
    assert.equal(detailText(undefined), "—");
    assert.equal(detailText(null), "—");
    assert.equal(detailText(""), "—");
  });
  it("stringifies real values, including falsy-but-present ones", () => {
    assert.equal(detailText("hello"), "hello");
    assert.equal(detailText(0), "0");
    assert.equal(detailText(false), "false");
  });
});

describe("formatCell", () => {
  it("renders an em-dash for empty-ish values", () => {
    assert.equal(formatCell(undefined, "text"), "—");
    assert.equal(formatCell(null, "text"), "—");
    assert.equal(formatCell("", "text"), "—");
  });
  it("passes markdown through untouched at or below the preview length", () => {
    const exactly80 = "a".repeat(80);
    assert.equal(formatCell(exactly80, "markdown"), exactly80);
    assert.equal(formatCell("short", "markdown"), "short");
  });
  it("truncates markdown longer than 80 chars with an ellipsis", () => {
    const long = "a".repeat(81);
    const out = formatCell(long, "markdown");
    assert.equal(out, `${"a".repeat(80)}…`);
    assert.equal(out.length, 81); // 80 chars + the single ellipsis glyph
  });
  it("stringifies primitives and JSON-encodes objects", () => {
    assert.equal(formatCell(7, "number"), "7");
    assert.equal(formatCell("x", "text"), "x");
    assert.equal(formatCell({ a: 1 }, "text"), '{"a":1}');
  });
});

describe("resolveCurrency", () => {
  it("prefers a per-record currencyField over the literal currency", () => {
    const spec = field("money", { currency: "USD", currencyField: "cur" });
    assert.equal(resolveCurrency(spec, { cur: "JPY" }), "JPY");
  });
  it("falls back to the literal currency when the field is blank or absent", () => {
    const spec = field("money", { currency: "USD", currencyField: "cur" });
    assert.equal(resolveCurrency(spec, { cur: "   " }), "USD");
    assert.equal(resolveCurrency(spec, {}), "USD");
    assert.equal(resolveCurrency(spec, null), "USD");
  });
  it("returns the literal currency when no currencyField is declared", () => {
    assert.equal(resolveCurrency(field("money", { currency: "EUR" }), { cur: "JPY" }), "EUR");
  });
});

describe("formatMoney", () => {
  it("renders an em-dash for empty-ish input", () => {
    assert.equal(formatMoney(undefined, "USD", "en-US"), "—");
    assert.equal(formatMoney("", "USD", "en-US"), "—");
  });
  it("formats numeric and numeric-string amounts", () => {
    assert.ok(formatMoney(1234.5, "USD", "en-US").includes("1,234.50"));
    assert.ok(formatMoney("12.5", "USD", "en-US").includes("12.50"));
  });
  it("defaults a missing currency to USD", () => {
    assert.ok(formatMoney(1, undefined, "en-US").includes("$"));
  });
  it("returns the raw string for non-finite amounts", () => {
    assert.equal(formatMoney("abc", "USD", "en-US"), "abc");
  });
  it("degrades to the plain number when the currency code is invalid", () => {
    assert.equal(formatMoney(5, "NOTACODE", "en-US"), "5");
  });
});

describe("currencySymbolForLocale", () => {
  it("returns the localized symbol for known codes", () => {
    assert.equal(currencySymbolForLocale("USD", "en-US"), "$");
    assert.equal(currencySymbolForLocale("JPY", "en-US"), "¥");
    assert.equal(currencySymbolForLocale("EUR", "en-US"), "€");
  });
  it("defaults a blank currency to USD", () => {
    assert.equal(currencySymbolForLocale(undefined, "en-US"), "$");
    assert.equal(currencySymbolForLocale("", "en-US"), "$");
  });
  it("returns the code itself when it is not a valid currency", () => {
    assert.equal(currencySymbolForLocale("NOTACODE", "en-US"), "NOTACODE");
  });
});

describe("tableRows / hasTableRows", () => {
  it("keeps only plain-object rows", () => {
    const rows = tableRows([{ a: 1 }, null, [1, 2], "x", 5, { b: 2 }]);
    assert.deepEqual(rows, [{ a: 1 }, { b: 2 }]);
  });
  it("returns an empty array for non-arrays and empty input", () => {
    assert.deepEqual(tableRows(undefined), []);
    assert.deepEqual(tableRows("nope"), []);
    assert.deepEqual(tableRows([]), []);
  });
  it("hasTableRows reflects whether any valid row survives", () => {
    assert.equal(hasTableRows([{ a: 1 }]), true);
    assert.equal(hasTableRows([null, [1], "x"]), false);
    assert.equal(hasTableRows([]), false);
    assert.equal(hasTableRows(undefined), false);
  });
});

describe("displayFieldFor", () => {
  it("prefers name, then title, else the primary key", () => {
    assert.equal(displayFieldFor({ name: field("text"), title: field("text") }, "id"), "name");
    assert.equal(displayFieldFor({ title: field("text") }, "id"), "title");
    assert.equal(displayFieldFor({ other: field("text") }, "id"), "id");
  });
});

// uniqueRefTargets / uniqueEmbedTargets / uniqueBacklinkSources moved to
// @mulmoclaude/core (`collection/core/linkTargets.ts`) — the single
// implementation shared with server enrichment. Their tests live in
// packages/core/test/collection/test_linkTargets.ts.

describe("buildRefDisplayMap", () => {
  it("maps primary-key slug to the name field, falling back to slug", () => {
    const schema = makeSchema({ id: field("text"), name: field("text") });
    const detail = makeDetail(schema, [{ id: "a", name: "Alice" }, { id: "b" }]);
    assert.deepEqual(buildRefDisplayMap(detail), { a: "Alice", b: "b" });
  });
  it("uses title when there is no name field", () => {
    const schema = makeSchema({ id: field("text"), title: field("text") });
    const detail = makeDetail(schema, [{ id: "a", title: "Hello" }]);
    assert.deepEqual(buildRefDisplayMap(detail), { a: "Hello" });
  });
  it("skips items whose primary key is missing or not a string", () => {
    const schema = makeSchema({ id: field("text"), name: field("text") });
    const detail = makeDetail(schema, [{ id: "", name: "X" }, { name: "Y" }, { id: 3, name: "Z" }]);
    assert.deepEqual(buildRefDisplayMap(detail), {});
  });
});

describe("buildRefRecordMap", () => {
  it("keys full records by slug and runs the derive loop", () => {
    const schema = makeSchema({
      id: field("text"),
      qty: field("number"),
      price: field("number"),
      total: field("derived", { formula: "qty * price" }),
    });
    const detail = makeDetail(schema, [{ id: "a", qty: 2, price: 10 }]);
    const map = buildRefRecordMap(detail);
    assert.deepEqual(Object.keys(map), ["a"]);
    const recordA = map.a;
    assert.ok(recordA);
    assert.equal(recordA.total, 20);
    assert.equal(recordA.qty, 2);
  });
  it("skips items without a valid string primary key", () => {
    const schema = makeSchema({ id: field("text") });
    const detail = makeDetail(schema, [{ id: "" }, { id: 5 }]);
    assert.deepEqual(buildRefRecordMap(detail), {});
  });
});

describe("sortedRefOptions", () => {
  it("turns a display map into options sorted by label", () => {
    assert.deepEqual(sortedRefOptions({ b: "Beta", a: "Alpha", c: "Gamma" }), [
      { slug: "a", display: "Alpha" },
      { slug: "b", display: "Beta" },
      { slug: "c", display: "Gamma" },
    ]);
  });
  it("returns an empty array for an empty map", () => {
    assert.deepEqual(sortedRefOptions({}), []);
  });
});

describe("buildEmbedOptions", () => {
  it("labels each record, drops slug-less rows, and sorts by label", () => {
    const schema = makeSchema({ id: field("text"), name: field("text") });
    const items: CollectionItem[] = [{ id: "z", name: "Zed" }, { id: "a", name: "Amy" }, { name: "no-slug" }];
    assert.deepEqual(buildEmbedOptions(schema, items), [
      { slug: "a", display: "Amy" },
      { slug: "z", display: "Zed" },
    ]);
  });
  it("falls back to the slug when the label field is empty", () => {
    const schema = makeSchema({ id: field("text"), name: field("text") });
    assert.deepEqual(buildEmbedOptions(schema, [{ id: "solo" }]), [{ slug: "solo", display: "solo" }]);
  });
  it("returns an empty array for no items", () => {
    assert.deepEqual(buildEmbedOptions(makeSchema({ id: field("text") }), []), []);
  });
});
