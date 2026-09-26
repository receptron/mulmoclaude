// Validation pass surfaced through presentCollection: a malformed record
// is silently skipped at read time, so the validator must report it back
// to the authoring LLM. Pins the unparseable-JSON detection (the
// silent-data-loss bug), the cheap schema checks, and the realpath
// containment guard (the dataDir must stay under the workspace root).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateCollectionRecords, validateRecordObject } from "@mulmoclaude/core/collection/server";
import type { LoadedCollection } from "../../../server/workspace/collections/index.js";
import type { CollectionSchema } from "../../../server/workspace/collections/types.js";

const schema = {
  title: "Lessons",
  icon: "school",
  dataPath: "data/lessons/items",
  primaryKey: "id",
  fields: {
    id: { type: "string", label: "ID", primary: true, required: true },
    title: { type: "string", label: "Title", required: true },
    status: { type: "enum", label: "Status", values: ["planned", "done"], required: true },
  },
} as unknown as CollectionSchema;

// `root` is the test "workspace"; records live in `root/items` (the dataDir),
// so the realpath containment guard is satisfied — mirrors test_io.ts.
let root: string;
let dir: string;
const collection = (dataDir = dir): LoadedCollection =>
  ({ slug: "lessons", source: "project", schema, dataDir, skillDir: dataDir }) as unknown as LoadedCollection;
const validate = (dataDir = dir) => validateCollectionRecords(collection(dataDir), { workspaceRoot: root });
const write = (name: string, body: string) => writeFileSync(path.join(dir, name), body);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "validate-"));
  dir = path.join(root, "items");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("validateCollectionRecords", () => {
  it("returns no issues when every record is valid", async () => {
    write("a.json", JSON.stringify({ id: "a", title: "A", status: "planned" }));
    write("b.json", JSON.stringify({ id: "b", title: "B", status: "done" }));
    assert.deepEqual(await validate(), []);
  });

  it("returns [] when the data dir doesn't exist yet", async () => {
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(await validate(), []);
  });

  it("flags an unparseable record (the unescaped-quote bug)", async () => {
    write("bad.json", '{ "id": "bad", "title": "がんは"細胞のバグ"", "status": "planned" }');
    const issues = await validate();
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.file, "bad.json");
    assert.match(issues[0]?.problem ?? "", /invalid JSON/);
  });

  it("flags a record whose JSON is not an object", async () => {
    write("arr.json", JSON.stringify([1, 2]));
    write("num.json", "42");
    const byFile = Object.fromEntries((await validate()).map((i) => [i.file, i.problem]));
    assert.match(byFile["arr.json"] ?? "", /not a JSON object/);
    assert.match(byFile["num.json"] ?? "", /not a JSON object/);
  });

  it("flags a non-regular .json entry (a directory)", async () => {
    mkdirSync(path.join(dir, "weird.json"));
    const [issue] = await validate();
    assert.equal(issue?.file, "weird.json");
    assert.match(issue?.problem ?? "", /not a regular file/);
  });

  it("flags id not matching the filename", async () => {
    write("x.json", JSON.stringify({ id: "wrong", title: "T", status: "planned" }));
    const [issue] = await validate();
    assert.match(issue?.problem ?? "", /must equal the filename/);
  });

  it("flags a missing required field and an invalid enum value", async () => {
    write("m.json", JSON.stringify({ id: "m", status: "planned" })); // missing title
    write("e.json", JSON.stringify({ id: "e", title: "T", status: "nope" })); // bad enum
    const byFile = Object.fromEntries((await validate()).map((i) => [i.file, i.problem]));
    assert.match(byFile["m.json"] ?? "", /missing required field 'title'/);
    assert.match(byFile["e.json"] ?? "", /not one of/);
  });

  it("ignores dotfiles and non-json entries", async () => {
    write(".DS_Store", "junk");
    write("notes.txt", "not a record");
    write("ok.json", JSON.stringify({ id: "ok", title: "T", status: "done" }));
    assert.deepEqual(await validate(), []);
  });

  it("refuses a dataDir that escapes the workspace root", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
    // Malformed on purpose: if the guard ever READ this dir it would report a
    // "not a JSON object" issue, so [] proves it short-circuited before reading.
    writeFileSync(path.join(outside, "secret.json"), "42");
    assert.deepEqual(await validate(outside), []);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("validateRecordObject — the write-gate variant", () => {
  const check = (record: Record<string, unknown>, itemId: string) => validateRecordObject(record, itemId, schema);

  it("accepts a record matching the schema", () => {
    assert.equal(check({ id: "a", title: "A", status: "planned" }, "a"), null);
  });

  it("reports the same problems the file scan reports (parity)", async () => {
    write("m.json", JSON.stringify({ id: "m", status: "planned" }));
    const [scanIssue] = await validate();
    assert.equal(check({ id: "m", status: "planned" }, "m"), scanIssue?.problem);
  });

  it("flags primaryKey ≠ itemId, missing required, bad enum", () => {
    assert.match(check({ id: "other", title: "T", status: "done" }, "a") ?? "", /must equal the filename/);
    assert.match(check({ id: "a", status: "done" }, "a") ?? "", /missing required field 'title'/);
    assert.match(check({ id: "a", title: "T", status: "nope" }, "a") ?? "", /not one of/);
  });

  it("skips computed field types entirely (derived, embed, toggle)", () => {
    // All three COMPUTED_TYPES marked required: a record carrying none
    // of them must still validate — they're host-computed, never stored.
    const withComputed = {
      ...schema,
      fields: {
        ...schema.fields,
        total: { type: "derived", label: "Total", formula: "1 + 1", required: true },
        owner: { type: "embed", label: "Owner", to: "profile", id: "me", required: true },
        done: { type: "toggle", label: "Done", field: "status", onValue: "done", offValue: "planned", required: true },
      },
    } as unknown as CollectionSchema;
    assert.equal(validateRecordObject({ id: "a", title: "T", status: "done" }, "a", withComputed), null);
  });
});

// Phase B (plans/done/collection-ontology.md step ⓪): the file scan lints
// per-type rules ("strict" tier) that the write gate deliberately does NOT
// enforce yet — legacy records get reported, never rejected on write.
describe("strict tier — typed checks reported by the scan, not enforced on write", () => {
  const typedSchema = {
    title: "Typed",
    icon: "category",
    dataPath: "data/typed/items",
    primaryKey: "id",
    fields: {
      id: { type: "string", label: "ID", primary: true, required: true },
      hours: { type: "number", label: "Hours" },
      rate: { type: "money", label: "Rate", currency: "USD" },
      active: { type: "boolean", label: "Active" },
      due: { type: "date", label: "Due" },
      seen: { type: "datetime", label: "Seen" },
      lines: {
        type: "table",
        label: "Lines",
        of: {
          what: { type: "string", label: "What", required: true },
          qty: { type: "number", label: "Qty" },
          unit: { type: "enum", label: "Unit", values: ["hour", "day"] },
        },
      },
    },
  } as unknown as CollectionSchema;
  const typedCollection = (dataDir = dir): LoadedCollection =>
    ({ slug: "typed", source: "project", schema: typedSchema, dataDir, skillDir: dataDir }) as unknown as LoadedCollection;
  const scan = () => validateCollectionRecords(typedCollection(), { workspaceRoot: root });
  const gate = (record: Record<string, unknown>, itemId: string) => validateRecordObject(record, itemId, typedSchema);

  it("passes well-typed values, including empty optionals", async () => {
    write("ok.json", JSON.stringify({ id: "ok", hours: 3.5, rate: 120, active: false, due: "2026-07-15", seen: "2026-07-15T09:00:00" }));
    write("sparse.json", JSON.stringify({ id: "sparse" })); // every optional absent
    assert.deepEqual(await scan(), []);
  });

  it("accepts a bare date in a datetime field as an all-day value", async () => {
    write("allday.json", JSON.stringify({ id: "allday", seen: "2026-09-28" }));
    write("feb30dt.json", JSON.stringify({ id: "feb30dt", seen: "2026-02-30" })); // shape-valid, calendar-impossible
    const byFile = Object.fromEntries((await scan()).map((i) => [i.file, i.problem]));
    assert.equal(byFile["allday.json"], undefined);
    assert.match(byFile["feb30dt.json"] ?? "", /'seen' = '2026-02-30' is not a YYYY-MM-DDTHH:MM datetime .*nor a YYYY-MM-DD all-day date/);
  });

  it("tolerates numeric strings in number/money fields (renderers coerce them)", async () => {
    write("n.json", JSON.stringify({ id: "n", hours: "42", rate: "99.5" }));
    assert.deepEqual(await scan(), []);
  });

  it("reports non-numeric, non-boolean, and unparseable date/datetime values", async () => {
    write("num.json", JSON.stringify({ id: "num", hours: "three" }));
    write("arr.json", JSON.stringify({ id: "arr", hours: [42] })); // [42] stringifies to "42" — must still be flagged
    write("bool.json", JSON.stringify({ id: "bool", active: "true" }));
    write("date.json", JSON.stringify({ id: "date", due: "July 15" }));
    write("feb30.json", JSON.stringify({ id: "feb30", due: "2026-02-30" })); // shape-valid, calendar-impossible
    write("dt.json", JSON.stringify({ id: "dt", seen: "yesterday" }));
    write("dtz.json", JSON.stringify({ id: "dtz", seen: "2026-07-15T09:00:00Z" })); // Z suffix — the day view can't place it
    const byFile = Object.fromEntries((await scan()).map((i) => [i.file, i.problem]));
    assert.match(byFile["num.json"] ?? "", /'hours' = 'three' is not numeric/);
    assert.match(byFile["arr.json"] ?? "", /'hours' = '42' is not numeric/);
    assert.match(byFile["bool.json"] ?? "", /'active' = 'true' is not a boolean/);
    assert.match(byFile["date.json"] ?? "", /'due' = 'July 15' is not a real YYYY-MM-DD date/);
    assert.match(byFile["feb30.json"] ?? "", /'due' = '2026-02-30' is not a real YYYY-MM-DD date/);
    assert.match(byFile["dt.json"] ?? "", /'seen' = 'yesterday' is not a YYYY-MM-DDTHH:MM datetime/);
    assert.match(byFile["dtz.json"] ?? "", /'seen' = '2026-07-15T09:00:00Z' is not a YYYY-MM-DDTHH:MM datetime/);
  });

  it("reports malformed table values and row-level sub-field problems", async () => {
    write("notarr.json", JSON.stringify({ id: "notarr", lines: "oops" }));
    write(
      "row.json",
      JSON.stringify({
        id: "row",
        lines: [
          { what: "design", qty: 2 },
          { qty: "many", what: "dev" },
        ],
      }),
    );
    write("miss.json", JSON.stringify({ id: "miss", lines: [{ qty: 1 }] }));
    write("enum.json", JSON.stringify({ id: "enum", lines: [{ what: "qa", unit: "week" }] }));
    const byFile = Object.fromEntries((await scan()).map((i) => [i.file, i.problem]));
    assert.match(byFile["notarr.json"] ?? "", /'lines' = 'oops' is not an array of rows/);
    assert.match(byFile["row.json"] ?? "", /'lines' row 2: 'qty' = 'many' is not numeric/);
    assert.match(byFile["miss.json"] ?? "", /'lines' row 1: missing required field 'what'/);
    assert.match(byFile["enum.json"] ?? "", /'lines' row 1: 'unit' = 'week' is not one of \[hour, day\]/);
  });

  it("the write gate does NOT reject strict-tier violations (lint, not lock)", () => {
    assert.equal(gate({ id: "a", hours: "three", active: "true", due: "July 15", lines: "oops" }, "a"), null);
  });

  it("the write gate rejects strict-tier violations when explicitly asked for the strict tier", () => {
    assert.match(validateRecordObject({ id: "a", hours: "three" }, "a", typedSchema, "strict") ?? "", /'hours' = 'three' is not numeric/);
  });

  it("table sub-field problems are strict-only: the scan reports them, the gate passes them", async () => {
    const record = { id: "badenum", hours: 1, lines: [{ what: "x", unit: "week" }] };
    write("badenum.json", JSON.stringify(record));
    assert.equal(gate(record, "badenum"), null);
    const [issue] = await scan();
    assert.match(issue?.problem ?? "", /'lines' row 1: 'unit' = 'week' is not one of \[hour, day\]/);
  });
});
