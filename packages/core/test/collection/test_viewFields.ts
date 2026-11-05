// `__MC_VIEW.fields` (#2169): the host derives enum metadata from the schema at
// view-token mint time, and the client narrows the mint response before
// injecting it into the sandboxed iframe.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCustomViewFields, customViewFieldsFrom, isCustomViewEnumField } from "../../src/collection/core/viewFields.ts";
import type { CollectionSchema } from "../../src/collection/core/schema.ts";

type Fields = CollectionSchema["fields"];

test("buildCustomViewFields: emits every top-level enum with its values in order", () => {
  const fields: Fields = {
    status: { type: "enum", label: "Status", values: ["open", "done"] },
    category: { type: "enum", label: "Category", values: ["質問", "要望", "バグ"], default: "質問" },
  };
  assert.deepEqual(buildCustomViewFields({ fields }), {
    status: { type: "enum", values: ["open", "done"] },
    category: { type: "enum", values: ["質問", "要望", "バグ"] },
  });
});

test("buildCustomViewFields: ignores non-enum fields (ref, scalars, table sub-enums)", () => {
  const fields: Fields = {
    title: { type: "string", label: "Title" },
    clientId: { type: "ref", label: "Client", to: "clients" },
    lines: { type: "table", label: "Lines", of: { kind: { type: "enum", label: "Kind", values: ["a", "b"] } } },
    priority: { type: "enum", label: "Priority", values: ["high"] },
  };
  assert.deepEqual(buildCustomViewFields({ fields }), { priority: { type: "enum", values: ["high"] } });
});

test("buildCustomViewFields: no enum fields / no fields at all → {}", () => {
  assert.deepEqual(buildCustomViewFields({ fields: { title: { type: "string", label: "Title" } } }), {});
  assert.deepEqual(buildCustomViewFields({ fields: {} }), {});
});

test("buildCustomViewFields: copies values so the schema cannot be mutated through the result", () => {
  const values = ["a", "b"];
  const result = buildCustomViewFields({ fields: { status: { type: "enum", label: "S", values } } });
  result.status?.values.push("c");
  assert.deepEqual(result.status?.values, ["a", "b", "c"]);
  assert.deepEqual(values, ["a", "b"]);
});

test("buildCustomViewFields: a proto-named key (CollectionSchemaZ rejects it upstream) still stays an own data property", () => {
  const fields: Fields = JSON.parse('{"__proto__":{"type":"enum","label":"P","values":["x"]}}');
  const result = buildCustomViewFields({ fields });
  assert.ok(Object.hasOwn(result, "__proto__"));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(JSON.stringify(result), '{"__proto__":{"type":"enum","values":["x"]}}');
});

test("isCustomViewEnumField: accepts a well-formed entry, including empty values", () => {
  assert.equal(isCustomViewEnumField({ type: "enum", values: ["a"] }), true);
  assert.equal(isCustomViewEnumField({ type: "enum", values: [] }), true);
});

test("isCustomViewEnumField: rejects malformed entries", () => {
  const bad: unknown[] = [
    null,
    undefined,
    "enum",
    42,
    [],
    {},
    { type: "ref", values: ["a"] },
    { type: "enum" },
    { type: "enum", values: "a,b" },
    { type: "enum", values: ["a", 1] },
    { type: "enum", values: [null] },
  ];
  bad.forEach((value) => assert.equal(isCustomViewEnumField(value), false, JSON.stringify(value)));
});

test("customViewFieldsFrom: non-object input (absent / older host) → {}", () => {
  [undefined, null, "x", 1, true, [], [{ type: "enum", values: [] }]].forEach((raw) => assert.deepEqual(customViewFieldsFrom(raw), {}));
});

test("customViewFieldsFrom: keeps valid entries and drops each malformed one on its own", () => {
  const raw: unknown = {
    status: { type: "enum", values: ["open", "done"] },
    broken: { type: "enum", values: [1] },
    clientId: { type: "ref", to: "clients", options: [] },
    empty: { type: "enum", values: [] },
  };
  assert.deepEqual(customViewFieldsFrom(raw), {
    status: { type: "enum", values: ["open", "done"] },
    empty: { type: "enum", values: [] },
  });
});

test("customViewFieldsFrom: strips extra keys from an entry", () => {
  const raw: unknown = { status: { type: "enum", values: ["a"], secret: "x" } };
  assert.deepEqual(customViewFieldsFrom(raw), { status: { type: "enum", values: ["a"] } });
});

test("round trip: build → JSON → customViewFieldsFrom is identity", () => {
  const fields: Fields = { status: { type: "enum", label: "S", values: ["a", "b"] }, title: { type: "string", label: "T" } };
  const built = buildCustomViewFields({ fields });
  assert.deepEqual(customViewFieldsFrom(JSON.parse(JSON.stringify(built))), built);
});
