import "../../../server/workspace/collections/configure.js"; // configure @mulmoclaude/core/collection host binding for tests

// Characterization tests for the schema-level cross-field rules — the long
// `.refine()` chain on the collection schema. Each rule guards a
// misconfiguration that would otherwise fail SILENTLY at runtime (a bell that
// never rings, a spawn that fans out forever, a currency that mislabels
// amounts), so the thing worth pinning is that each one still REJECTS.
//
// Written before the chain is refactored into named predicates: a rule whose
// condition gets inverted during the move would still parse valid schemas
// fine, and only stop rejecting the bad ones. That direction of breakage is
// invisible without a test per rule.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CollectionSchemaZ } from "@mulmoclaude/core/collection/server";

const baseFields = {
  id: { type: "string", label: "ID", primary: true, required: true },
  name: { type: "string", label: "Name" },
  status: { type: "enum", label: "Status", values: ["todo", "done"] },
  due: { type: "date", label: "Due" },
  startAt: { type: "datetime", label: "Start" },
  endAt: { type: "datetime", label: "End" },
  timeText: { type: "string", label: "Time" },
  count: { type: "number", label: "Count" },
  code: { type: "string", label: "Currency code" },
};

const base = {
  title: "Tasks",
  icon: "check_circle",
  dataPath: "data/collections/tasks/items",
  primaryKey: "id",
  fields: baseFields,
};

type Overrides = Record<string, unknown>;

const parse = (overrides: Overrides = {}) => CollectionSchemaZ.safeParse({ ...base, ...overrides });

function messagesOf(result: ReturnType<typeof parse>): string {
  return result.success ? "" : result.error.issues.map((issue) => issue.message).join(" || ");
}

function assertAccepts(overrides: Overrides): void {
  const result = parse(overrides);
  assert.equal(result.success, true, `expected acceptance, got: ${messagesOf(result)}`);
}

function assertRejects(overrides: Overrides, needle: string): void {
  const result = parse(overrides);
  assert.equal(result.success, false, "expected rejection, but the schema parsed");
  const messages = messagesOf(result);
  assert.ok(messages.includes(needle), `expected a message containing ${JSON.stringify(needle)}, got: ${messages}`);
}

describe("collection schema rules — the baseline fixture is valid", () => {
  it("accepts the base schema", () => {
    assertAccepts({});
  });
});

describe("collection schema rules — storage declaration", () => {
  it("rejects declaring none of dataPath / dataSource / storage", () => {
    assert.equal(CollectionSchemaZ.safeParse({ title: base.title, icon: base.icon, primaryKey: "id", fields: baseFields }).success, false);
  });

  it("rejects declaring two of them", () => {
    assertRejects({ dataSource: { type: "csv", path: "data/tasks.csv" } }, "declare exactly one of");
  });

  it("accepts dataSource alone", () => {
    assertAccepts({ dataPath: undefined, dataSource: { type: "csv", path: "data/tasks.csv" } });
  });

  it("accepts storage alone", () => {
    assertAccepts({ dataPath: undefined, storage: { type: "sqlite", path: "data/tasks.db" } });
  });
});

describe("collection schema rules — dataSource is read-only", () => {
  const readOnly = { dataPath: undefined, dataSource: { type: "csv", path: "data/tasks.csv" } };

  it("rejects singleton on a dataSource collection", () => {
    assertRejects({ ...readOnly, singleton: "the-one" }, "read-only");
  });

  it("rejects ingest on a dataSource collection", () => {
    assertRejects({ ...readOnly, ingest: { kind: "agent", schedule: "daily", role: "assistant", template: "templates/refresh.md" } }, "read-only");
  });

  // The rule is a conjunction over four write mechanisms; each needs its own
  // case, or an inverted clause stays invisible behind the ones that are
  // covered (CodeRabbit).
  it("rejects spawn on a dataSource collection", () => {
    assertRejects(
      {
        ...readOnly,
        completionField: "status",
        completionDoneValues: ["done"],
        triggerField: "due",
        spawn: { every: { unit: "week", interval: 1 }, set: { status: "todo" } },
      },
      "read-only",
    );
  });

  it("rejects googleCalendar on a dataSource collection", () => {
    assertRejects({ ...readOnly, googleCalendar: { calendarId: "primary", map: { name: "summary" } } }, "read-only");
  });

  it("rejects a mutate action on a dataSource collection", () => {
    assertRejects(
      { ...readOnly, actions: [{ id: "done", kind: "mutate", label: "Done", set: { status: "done" } }] },
      'its actions cannot use `kind: "mutate"`',
    );
  });
});

describe("collection schema rules — actions", () => {
  it("rejects duplicate action ids", () => {
    assertRejects(
      {
        actions: [
          { id: "same", kind: "mutate", label: "A", set: { status: "done" } },
          { id: "same", kind: "mutate", label: "B", set: { status: "todo" } },
        ],
      },
      "unique `id`s",
    );
  });

  it("rejects duplicate collectionAction ids", () => {
    assertRejects(
      {
        collectionActions: [
          { id: "same", kind: "chat", label: "A", role: "assistant", template: "templates/a.md" },
          { id: "same", kind: "chat", label: "B", role: "assistant", template: "templates/b.md" },
        ],
      },
      "unique `id`s",
    );
  });

  // A typo'd key would write a stray value into every record forever.
  it("rejects a mutate `set` key that names no declared field", () => {
    assertRejects({ actions: [{ id: "a", kind: "mutate", label: "A", set: { staus: "done" } }] }, "must name declared, non-computed fields");
  });

  it("rejects a mutate `set` key that names the primaryKey", () => {
    assertRejects({ actions: [{ id: "a", kind: "mutate", label: "A", set: { id: "x" } }] }, "never the primaryKey");
  });

  it("rejects an undeclared `$params.<name>` reference", () => {
    assertRejects({ actions: [{ id: "a", kind: "mutate", label: "A", set: { name: "$params.who" } }] }, "must name keys declared in its `params`");
  });

  it("accepts a `$params.<name>` reference that is declared", () => {
    assertAccepts({ actions: [{ id: "a", kind: "mutate", label: "A", set: { name: "$params.who" }, params: { who: { type: "string", label: "Who" } } }] });
  });

  // A collection-level action has no record to write.
  it("rejects a mutate collectionAction", () => {
    assertRejects({ collectionActions: [{ id: "a", kind: "mutate", label: "A", set: { status: "done" } }] }, "has no record to write");
  });
});

describe("collection schema rules — singleton", () => {
  it("rejects a singleton value that is not a valid item id", () => {
    assertRejects({ singleton: "../escape" }, "must be a valid item id");
  });

  it("accepts a well-formed singleton value", () => {
    assertAccepts({ singleton: "the-one" });
  });
});

describe("collection schema rules — currency", () => {
  it("rejects a currencyField pointing at a non-code field type", () => {
    assertRejects(
      { fields: { ...baseFields, amount: { type: "money", label: "Amount", currencyField: "count" } } },
      "must name a top-level `string`, `text`, or `enum` field",
    );
  });

  it("accepts a currencyField pointing at a string field", () => {
    assertAccepts({ fields: { ...baseFields, amount: { type: "money", label: "Amount", currencyField: "code" } } });
  });

  it("rejects a currencyField that names nothing at all", () => {
    assertRejects({ fields: { ...baseFields, amount: { type: "money", label: "Amount", currencyField: "curreny" } } }, "must name a top-level");
  });
});

describe("collection schema rules — completion pair", () => {
  it("rejects completionField without completionDoneValues", () => {
    assertRejects({ completionField: "status" }, "must be declared together");
  });

  it("rejects completionDoneValues without completionField", () => {
    assertRejects({ completionDoneValues: ["done"] }, "must be declared together");
  });

  it("accepts the pair declared together", () => {
    assertAccepts({ completionField: "status", completionDoneValues: ["done"] });
  });

  it("rejects a completionField that names no declared field", () => {
    assertRejects({ completionField: "stat", completionDoneValues: ["done"] }, "must name a top-level field");
  });

  // done ⇔ the flag's `where` matches, so a second source of truth is refused.
  it("rejects completionDoneValues alongside a flag completionField", () => {
    assertRejects(
      {
        fields: { ...baseFields, overdue: { type: "flag", label: "Overdue", where: [{ field: "status", op: "eq", value: "todo" }] } },
        completionField: "overdue",
        completionDoneValues: ["yes"],
      },
      "must be declared together",
    );
  });

  it("accepts a flag completionField with completionDoneValues omitted", () => {
    assertAccepts({
      fields: { ...baseFields, overdue: { type: "flag", label: "Overdue", where: [{ field: "status", op: "eq", value: "todo" }] } },
      completionField: "overdue",
    });
  });
});

describe("collection schema rules — field pointers", () => {
  it("rejects a displayField that names no declared field", () => {
    assertRejects({ displayField: "nmae" }, "schema `displayField` must name a top-level field");
  });

  it("rejects a field whose `when.field` names no declared field", () => {
    assertRejects({ fields: { ...baseFields, extra: { type: "string", label: "Extra", when: { field: "nope", in: ["x"] } } } }, "`when.field` must name");
  });

  it("rejects a flag whose `where` names no declared field", () => {
    assertRejects(
      { fields: { ...baseFields, bad: { type: "flag", label: "Bad", where: [{ field: "nope", op: "eq", value: "x" }] } } },
      "`where` conditions must name top-level fields",
    );
  });

  it("rejects an embed `idField` pointing at a non-ref/string field", () => {
    assertRejects(
      { fields: { ...baseFields, linked: { type: "embed", label: "Linked", to: "people", idField: "count" } } },
      "must name a top-level `ref` or `string` field",
    );
  });

  it("rejects a kanbanField that is not an enum", () => {
    assertRejects({ kanbanField: "name" }, "must name a top-level `enum` field");
  });

  it("accepts a kanbanField naming an enum", () => {
    assertAccepts({ kanbanField: "status" });
  });
});

describe("collection schema rules — builtinViews opt-out", () => {
  it("accepts either or both built-in views switched off or on", () => {
    assertAccepts({ builtinViews: { calendar: false } });
    assertAccepts({ builtinViews: { kanban: false } });
    assertAccepts({ builtinViews: { calendar: true, kanban: false } });
    assertAccepts({ builtinViews: {} });
  });

  it("rejects a misspelt key instead of silently keeping the toggle", () => {
    assertRejects({ builtinViews: { calender: false } }, "Unrecognized key");
  });

  it("rejects a non-boolean value", () => {
    assertRejects({ builtinViews: { kanban: "false" } }, "expected boolean");
  });
});

describe("collection schema rules — toggle projection", () => {
  const toggleOver = (spec: Record<string, unknown>) => ({ fields: { ...baseFields, done: { type: "toggle", label: "Done", ...spec } } });

  it("accepts a toggle projecting onto a real enum with member values", () => {
    assertAccepts(toggleOver({ field: "status", onValue: "done", offValue: "todo" }));
  });

  it("rejects a toggle whose target is not an enum", () => {
    assertRejects(toggleOver({ field: "name", onValue: "a", offValue: "b" }), "must name a top-level `enum` field");
  });

  it("rejects a toggle whose onValue is outside the enum's values", () => {
    assertRejects(toggleOver({ field: "status", onValue: "finished", offValue: "todo" }), "must be values of that enum");
  });
});

describe("collection schema rules — trigger", () => {
  const withCompletion = { completionField: "status", completionDoneValues: ["done"] };

  it("rejects triggerField without completion tracking", () => {
    assertRejects({ triggerField: "due" }, "requires `completionField`");
  });

  it("rejects a triggerField that is not a date field", () => {
    assertRejects({ ...withCompletion, triggerField: "name" }, "must name a top-level `date` field");
  });

  it("accepts a date triggerField alongside completion", () => {
    assertAccepts({ ...withCompletion, triggerField: "due" });
  });

  it("rejects triggerLeadDays without triggerField", () => {
    assertRejects({ ...withCompletion, triggerLeadDays: 3 }, "requires `triggerField`");
  });
});

describe("collection schema rules — spawn", () => {
  const spawnBase = { completionField: "status", completionDoneValues: ["done"], triggerField: "due" };

  it("accepts a spawn that leaves the successor inert", () => {
    assertAccepts({ ...spawnBase, spawn: { every: { unit: "week", interval: 1 }, set: { status: "todo" } } });
  });

  it("rejects spawn without a triggerField", () => {
    assertRejects(
      { completionField: "status", completionDoneValues: ["done"], spawn: { every: { unit: "week", interval: 1 }, set: { status: "todo" } } },
      "`spawn` requires `triggerField`",
    );
  });

  it("rejects a spawn.when.field that names no declared field", () => {
    assertRejects(
      { ...spawnBase, spawn: { every: { unit: "week", interval: 1 }, when: { field: "nope", in: ["done"] }, set: { status: "todo" } } },
      "`spawn.when.field` must name",
    );
  });

  it("rejects a spawn.carry entry that names no declared field", () => {
    assertRejects(
      { ...spawnBase, spawn: { every: { unit: "week", interval: 1 }, carry: ["nope"], set: { status: "todo" } } },
      "every `spawn.carry` entry must name",
    );
  });

  // A successor born already matching its own predicate re-spawns on the first
  // reconcile and fans out into an unbounded chain of records.
  it("rejects a spawn whose `set` seeds the predicate field to a matching value", () => {
    assertRejects({ ...spawnBase, spawn: { every: { unit: "week", interval: 1 }, set: { status: "done" } } }, "non-matching state");
  });

  it("rejects a spawn that carries the predicate field (inheriting the matching value)", () => {
    assertRejects({ ...spawnBase, spawn: { every: { unit: "week", interval: 1 }, carry: ["status"] } }, "non-matching state");
  });

  it("rejects a flag-completion schema that spawns without an explicit spawn.when", () => {
    assertRejects(
      {
        fields: { ...baseFields, overdue: { type: "flag", label: "Overdue", where: [{ field: "status", op: "eq", value: "todo" }] } },
        completionField: "overdue",
        triggerField: "due",
        spawn: { every: { unit: "week", interval: 1 }, set: { status: "todo" } },
      },
      "must declare an explicit `spawn.when`",
    );
  });
});

describe("collection schema rules — field-driven spawn.every", () => {
  const drivenBase = { completionField: "status", completionDoneValues: ["done"], triggerField: "due" };
  const freq = { type: "enum", label: "Frequency", values: ["weekly", "monthly"] };
  const fieldsWithFreq = { ...baseFields, freq };

  it("accepts a field-driven every whose map covers the enum and is carried", () => {
    assertAccepts({
      ...drivenBase,
      fields: fieldsWithFreq,
      spawn: {
        every: { fromField: "freq", map: { weekly: { unit: "week", interval: 1 }, monthly: { unit: "month", interval: 1 } } },
        carry: ["freq"],
        set: { status: "todo" },
      },
    });
  });

  it("rejects a fromField that is not an enum", () => {
    assertRejects(
      { ...drivenBase, spawn: { every: { fromField: "name", map: { a: { unit: "week", interval: 1 } } }, carry: ["name"], set: { status: "todo" } } },
      "must name a top-level `enum` field",
    );
  });

  // A missing key stalls a record at that frequency; an extra key is a map
  // left stale after an enum edit.
  it("rejects a map missing one of the enum's values", () => {
    assertRejects(
      {
        ...drivenBase,
        fields: fieldsWithFreq,
        spawn: { every: { fromField: "freq", map: { weekly: { unit: "week", interval: 1 } } }, carry: ["freq"], set: { status: "todo" } },
      },
      "must exactly cover the `values`",
    );
  });

  it("rejects a map with an extra key the enum does not declare", () => {
    assertRejects(
      {
        ...drivenBase,
        fields: fieldsWithFreq,
        spawn: {
          every: {
            fromField: "freq",
            map: { weekly: { unit: "week", interval: 1 }, monthly: { unit: "month", interval: 1 }, daily: { unit: "day", interval: 1 } },
          },
          carry: ["freq"],
          set: { status: "todo" },
        },
      },
      "must exactly cover the `values`",
    );
  });

  it("rejects a fromField that reaches the successor via neither carry nor set", () => {
    assertRejects(
      {
        ...drivenBase,
        fields: fieldsWithFreq,
        spawn: {
          every: { fromField: "freq", map: { weekly: { unit: "week", interval: 1 }, monthly: { unit: "month", interval: 1 } } },
          set: { status: "todo" },
        },
      },
      "so the successor keeps a resolvable recurrence interval",
    );
  });

  it("accepts a fromField written by set to a value present in the map", () => {
    assertAccepts({
      ...drivenBase,
      fields: fieldsWithFreq,
      spawn: {
        every: { fromField: "freq", map: { weekly: { unit: "week", interval: 1 }, monthly: { unit: "month", interval: 1 } } },
        set: { status: "todo", freq: "weekly" },
      },
    });
  });

  it("rejects a fromField set to a value the map does not cover", () => {
    assertRejects(
      {
        ...drivenBase,
        fields: fieldsWithFreq,
        spawn: {
          every: { fromField: "freq", map: { weekly: { unit: "week", interval: 1 }, monthly: { unit: "month", interval: 1 } } },
          set: { status: "todo", freq: "yearly" },
        },
      },
      "so the successor keeps a resolvable recurrence interval",
    );
  });
});

describe("collection schema rules — calendar", () => {
  it("rejects a calendarField that is not date-like", () => {
    assertRejects({ calendarField: "name" }, "schema `calendarField` must name a top-level `date` or `datetime` field");
  });

  it("accepts a date and a datetime calendarField", () => {
    assertAccepts({ calendarField: "due" });
    assertAccepts({ calendarField: "startAt" });
  });

  it("rejects calendarEndField without calendarField", () => {
    assertRejects({ calendarEndField: "endAt" }, "requires `calendarField`");
  });

  it("rejects a calendarEndField that is not date-like", () => {
    assertRejects({ calendarField: "startAt", calendarEndField: "name" }, "schema `calendarEndField` must name a top-level `date` or `datetime` field");
  });

  it("rejects calendarTimeField without calendarField", () => {
    assertRejects({ calendarTimeField: "timeText" }, "requires `calendarField`");
  });

  it("rejects a calendarTimeField that names no declared field", () => {
    assertRejects({ calendarField: "due", calendarTimeField: "nope" }, "schema `calendarTimeField` must name a top-level field");
  });

  // The day view parses the value as a time string, so a number column can't
  // drive it.
  it("rejects a calendarTimeField that is not string-backed", () => {
    assertRejects({ calendarField: "due", calendarTimeField: "count" }, "must name a top-level `string` or `text` field");
  });

  it("accepts a string calendarTimeField alongside a calendarField", () => {
    assertAccepts({ calendarField: "due", calendarTimeField: "timeText" });
  });
});

describe("collection schema rules — notifyWhen", () => {
  it("rejects notifyWhen without completion tracking", () => {
    assertRejects({ notifyWhen: { field: "status", in: ["todo"] } }, "requires `completionField`");
  });

  it("rejects a notifyWhen.field that names no declared field", () => {
    assertRejects(
      { completionField: "status", completionDoneValues: ["done"], notifyWhen: { field: "nope", in: ["x"] } },
      "`notifyWhen.field` must name a top-level field",
    );
  });

  it("accepts notifyWhen alongside completion tracking", () => {
    assertAccepts({ completionField: "status", completionDoneValues: ["done"], notifyWhen: { field: "status", in: ["todo"] } });
  });
});

describe("collection schema rules — custom views", () => {
  it("rejects a view id that is not a valid slug", () => {
    assertRejects({ views: [{ id: "../escape", label: "Bad", file: "views/bad.html" }] }, "must be a valid slug");
  });

  it("rejects duplicate view ids", () => {
    assertRejects(
      {
        views: [
          { id: "board", label: "A", file: "views/a.html" },
          { id: "board", label: "B", file: "views/b.html" },
        ],
      },
      "unique `id`s",
    );
  });

  it("accepts distinct, slug-safe view ids", () => {
    assertAccepts({
      views: [
        { id: "board", label: "A", file: "views/a.html" },
        { id: "chart", label: "B", file: "views/b.html" },
      ],
    });
  });
});

describe("collection schema rules — googleCalendar map", () => {
  const sync = (map: Record<string, string>) => ({ googleCalendar: { calendarId: "primary", map } });

  it("accepts a map naming declared, non-computed, non-primary fields", () => {
    assertAccepts(sync({ name: "summary", startAt: "start", endAt: "end" }));
  });

  it("rejects a map key that names no declared field", () => {
    assertRejects(sync({ nope: "summary" }), "must name a declared, non-computed field");
  });

  // The primary field always holds the Google event id, which is what keeps
  // re-syncs idempotent.
  it("rejects a map key that names the primaryKey", () => {
    assertRejects(sync({ id: "summary" }), "never the primaryKey");
  });
});

// Regression for #2318: a field pointer is an LLM-authored key. A bare
// `schema.fields[name]` reaches inherited Object.prototype members
// (`constructor`, `__proto__`, `toString`), so a pointer like
// `completionField: "constructor"` resolves to a function and PASSES the
// "names a declared field" check — then misfires silently at runtime. Each of
// these currently-passing schemas must be REJECTED once the lookup is gated on
// own-key membership.
describe("collection schema rules — prototype keys are not declared fields (#2318)", () => {
  const spawnBase = { completionField: "status", completionDoneValues: ["done"], triggerField: "due" };

  it("rejects a mutate `set` key that is a prototype name", () => {
    assertRejects({ actions: [{ id: "a", kind: "mutate", label: "A", set: { constructor: "done" } }] }, "must name declared, non-computed fields");
  });

  it("rejects a googleCalendar map key that is a prototype name", () => {
    assertRejects({ googleCalendar: { calendarId: "primary", map: { toString: "summary" } } }, "must name a declared, non-computed field");
  });

  it("rejects a completionField that is a prototype name", () => {
    assertRejects({ completionField: "constructor", completionDoneValues: ["done"] }, "schema `completionField` must name a top-level field");
  });

  it("rejects a displayField that is a prototype name", () => {
    assertRejects({ displayField: "__proto__" }, "schema `displayField` must name a top-level field");
  });

  it("rejects a field whose `when.field` is a prototype name", () => {
    assertRejects(
      { fields: { ...baseFields, extra: { type: "string", label: "Extra", when: { field: "constructor", in: ["x"] } } } },
      "`when.field` must name",
    );
  });

  it("rejects a flag whose `where` field is a prototype name", () => {
    assertRejects(
      { fields: { ...baseFields, bad: { type: "flag", label: "Bad", where: [{ field: "toString", op: "eq", value: "x" }] } } },
      "`where` conditions must name top-level fields",
    );
  });

  it("rejects a flag whose `where` valueFrom.field is a prototype name", () => {
    assertRejects(
      { fields: { ...baseFields, bad: { type: "flag", label: "Bad", where: [{ field: "status", op: "eq", valueFrom: { field: "constructor" } }] } } },
      "`where` conditions must name top-level fields",
    );
  });

  it("rejects a spawn.when.field that is a prototype name", () => {
    assertRejects(
      { ...spawnBase, spawn: { every: { unit: "week", interval: 1 }, when: { field: "constructor", in: ["done"] }, set: { status: "todo" } } },
      "`spawn.when.field` must name",
    );
  });

  it("rejects a spawn.carry entry that is a prototype name", () => {
    assertRejects(
      { ...spawnBase, spawn: { every: { unit: "week", interval: 1 }, carry: ["constructor"], set: { status: "todo" } } },
      "every `spawn.carry` entry must name",
    );
  });

  it("rejects a notifyWhen.field that is a prototype name", () => {
    assertRejects(
      { completionField: "status", completionDoneValues: ["done"], notifyWhen: { field: "constructor", in: ["x"] } },
      "schema `notifyWhen.field` must name a top-level field",
    );
  });

  // BOUNDARY: a field literally named after a prototype member IS a real OWN
  // key, so a pointer to it must still be accepted — the guard rejects
  // INHERITED members, not same-named declared fields.
  it("accepts a displayField naming an OWN field literally called `toString`", () => {
    assertAccepts({ fields: { ...baseFields, toString: { type: "string", label: "TS" } }, displayField: "toString" });
  });
});
