// Unit tests for the pure collection list-table sort helpers
// (src/utils/collections/sortItems.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isSortableField,
  nextSortDirection,
  sortItems,
  numericSortValue,
  stringSortValue,
  dateSortValue,
  enumSortValue,
  boolSortValue,
  type SortValue,
} from "@mulmoclaude/core/collection";
import type { FieldSpec, CollectionItem } from "../../../src/components/collectionTypes.js";

describe("isSortableField", () => {
  it("offers sorting for value-bearing field types", () => {
    for (const type of ["string", "text", "email", "number", "money", "date", "datetime", "enum", "boolean", "toggle", "ref", "derived"] as const) {
      assert.equal(isSortableField({ type, label: type } as FieldSpec), true, type);
    }
  });

  it("offers no sorting for non-textual field types", () => {
    for (const type of ["markdown", "table", "image", "file", "embed"] as const) {
      assert.equal(isSortableField({ type, label: type } as FieldSpec), false, type);
    }
  });
});

describe("nextSortDirection", () => {
  it("cycles none → asc → desc → none", () => {
    assert.equal(nextSortDirection(null), "asc");
    assert.equal(nextSortDirection("asc"), "desc");
    assert.equal(nextSortDirection("desc"), null);
  });
});

describe("SortValue constructors", () => {
  it("numericSortValue parses numbers and flags empties", () => {
    assert.deepEqual(numericSortValue(3), { empty: false, num: 3 });
    assert.deepEqual(numericSortValue("4.5"), { empty: false, num: 4.5 });
    assert.equal(numericSortValue(null).empty, true);
    assert.equal(numericSortValue("").empty, true);
    assert.equal(numericSortValue("abc").empty, true);
  });

  it("stringSortValue treats blank as empty", () => {
    assert.deepEqual(stringSortValue("hi"), { empty: false, str: "hi" });
    assert.equal(stringSortValue("   ").empty, true);
    assert.equal(stringSortValue(null).empty, true);
  });

  it("dateSortValue compares by epoch ms", () => {
    const jan = dateSortValue("2024-01-01");
    const jun = dateSortValue("2024-06-01");
    assert.equal(jan.empty, false);
    assert.equal(jun.empty, false);
    assert.ok((jan.num as number) < (jun.num as number));
    assert.equal(dateSortValue("").empty, true);
  });

  it("dateSortValue puts a bare date at local midnight, like …T00:00", () => {
    // `Date.parse` reads a bare date as UTC, which sorted an all-day `datetime`
    // after that morning's timed records east of Greenwich.
    assert.equal(dateSortValue("2026-09-28").num, dateSortValue("2026-09-28T00:00").num);
    assert.ok((dateSortValue("2026-09-28").num as number) < (dateSortValue("2026-09-28T08:00").num as number));
    assert.ok((dateSortValue("2026-09-27T23:59").num as number) < (dateSortValue("2026-09-28").num as number));
  });

  it("dateSortValue keeps an impossible bare date on the lexical fallback", () => {
    assert.equal(dateSortValue("2026-02-30").str, undefined);
    assert.equal(dateSortValue("not a date").str, "not a date");
  });

  it("enumSortValue keys off the declared index, not the label", () => {
    const values = ["low", "high", "critical"]; // deliberately non-alphabetical
    assert.deepEqual(enumSortValue(values, "low"), { empty: false, num: 0 });
    assert.deepEqual(enumSortValue(values, "critical"), { empty: false, num: 2 });
    assert.equal(enumSortValue(values, "unknown").empty, true);
    assert.equal(enumSortValue(values, "").empty, true);
  });

  it("boolSortValue orders false < true and is never empty", () => {
    assert.deepEqual(boolSortValue(false), { empty: false, num: 0 });
    assert.deepEqual(boolSortValue(true), { empty: false, num: 1 });
  });
});

describe("sortItems", () => {
  const rows: CollectionItem[] = [
    { id: "a", n: 2 },
    { id: "b", n: 1 },
    { id: "c", n: 3 },
  ];
  const byN = (item: CollectionItem): SortValue => numericSortValue(item.n);

  it("sorts ascending and descending without mutating the input", () => {
    const asc = sortItems(rows, "asc", byN).map((row) => row.id);
    assert.deepEqual(asc, ["b", "a", "c"]);
    const desc = sortItems(rows, "desc", byN).map((row) => row.id);
    assert.deepEqual(desc, ["c", "a", "b"]);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["a", "b", "c"],
      "input untouched",
    );
  });

  it("sinks empty values to the bottom in both directions", () => {
    const mixed: CollectionItem[] = [{ id: "a", n: 2 }, { id: "x" }, { id: "b", n: 1 }];
    assert.deepEqual(
      sortItems(mixed, "asc", byN).map((row) => row.id),
      ["b", "a", "x"],
    );
    assert.deepEqual(
      sortItems(mixed, "desc", byN).map((row) => row.id),
      ["a", "b", "x"],
    );
  });

  it("keeps ties and the empty group in original order (stable)", () => {
    const dup: CollectionItem[] = [{ id: "a", n: 1 }, { id: "b", n: 1 }, { id: "y" }, { id: "z" }];
    assert.deepEqual(
      sortItems(dup, "asc", byN).map((row) => row.id),
      ["a", "b", "y", "z"],
    );
    assert.deepEqual(
      sortItems(dup, "desc", byN).map((row) => row.id),
      ["a", "b", "y", "z"],
    );
  });
});
