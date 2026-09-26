# Collection skills — build a data app from a schema

A **collection skill** is a skill directory that ships a `schema.json` next to
its `SKILL.md`. The schema declares an entire data-driven app — its data model,
cross-record relations, rendered UI, computed fields, and per-record action
buttons — in one small JSON file. You author the schema, you write the records
(one JSON file each), and you are the runtime for any behaviour the schema
can't express declaratively. The host contains **zero** knowledge of any
specific collection: it just reads the DSL and renders a table / calendar /
form / detail view, and serves a REST surface. No database, no migration tool, no ORM — a
`schema.json` plus a folder of `<id>.json` records **is** the app.

This is the project philosophy made concrete: _the workspace is the database;
files are the source of truth; you are the intelligent interface._

## Anatomy of a collection skill

<!-- authoring:staged -->
You **author** the skill under `data/skills/<slug>/` (a plain, writable data
dir). A host-side hook then **mirrors** the files into `.claude/skills/<slug>/`,
which is where the host actually discovers and renders the collection from:

```text
data/skills/<slug>/            ← YOU write here (Write / Edit)
  SKILL.md          ← instructions you read later (how to CRUD the records)
  schema.json       ← the DSL: data model + relations + UI + actions
  templates/*.md    ← natural-language bodies for actions (only if it has actions)
        │
        │  host's skill-bridge hook mirrors these three file kinds
        ▼
.claude/skills/<slug>/         ← host reads here (do NOT write here directly)
  SKILL.md  ·  schema.json  ·  templates/*.md

data/<name>/items/             ← the records (separate from the skill dir)
  <id>.json         ← one record per file (write via manageCollection putItems)
```
<!-- /authoring:staged -->
<!-- authoring:direct -->
You **author** the skill directly under `.claude/skills/<slug>/`. This root has
no `data/skills/` staging tree and no mirroring hook, so the skill dir is both
where you write and where the host discovers and renders the collection from:

```text
.claude/skills/<slug>/         ← YOU write here (Write / Edit), host reads here
  SKILL.md          ← instructions you read later (how to CRUD the records)
  schema.json       ← the DSL: data model + relations + UI + actions
  templates/*.md    ← natural-language bodies for actions (only if it has actions)
  views/*.html      ← custom views (only if the schema declares any)

data/<name>/items/             ← the records (separate from the skill dir)
  <id>.json         ← one record per file (write via manageCollection putItems)
```
<!-- /authoring:direct -->

<!-- authoring:staged -->
- **Author under `data/skills/<slug>/`, NEVER `.claude/skills/<slug>/`
  directly.** Claude Code gates writes into `.claude/` (it's the agent's own
  config surface) and the host GUI can't answer that prompt, so a direct write
  hangs/fails. Writing under `data/skills/` has no such gate; the bridge hook
  copies `SKILL.md`, `schema.json`, and `templates/*.md` across for you and
  triggers a re-scan, so the collection appears at `/collections/<slug>`
  without a restart. (Other files you drop in `data/skills/<slug>/` — a README,
  scratch notes — stay put and are NOT mirrored.)
<!-- /authoring:staged -->
<!-- authoring:direct -->
- **Author under `.claude/skills/<slug>/`, NEVER `data/skills/<slug>/`.** There
  is no staging tree here and nothing mirrors one: discovery scans
  `.claude/skills` only, so files written under `data/skills/` are never found
  and the collection simply never appears — with no error anywhere. Worse, the
  stray `data/skills/<slug>/` tree left behind can shadow the real skill's files
  on later reads. Write `SKILL.md`, `schema.json`, `templates/*.md` and any
  `views/*.html` straight into `.claude/skills/<slug>/`.
<!-- /authoring:direct -->
- **To CHANGE an existing collection's schema, use `manageCollection` — not raw
  file edits.** Call `schemaDocs` for this very reference (sectioned: pass a
  heading as `topic`, e.g. `topic: "field types"`), `getSchema` to read
  the current `schema.json` (you don't need to know its path), then `putSchema`
  to write it back. `putSchema` validates the whole schema against the same rules
  discovery enforces and reports the exact problem, where a hand-edit can
  silently fail validation and make the collection vanish from the UI. It writes
<!-- authoring:staged -->
  the canonical `data/skills/<slug>/schema.json` and mirrors it for you — same
  destination as authoring, just validated. (Creating a _new_ collection still
  means writing `SKILL.md` + `schema.json` under `data/skills/<slug>/`, since
  there's nothing to `getSchema` yet.)
<!-- /authoring:staged -->
<!-- authoring:direct -->
  the collection's `.claude/skills/<slug>/schema.json` in place — same
  destination as authoring, just validated. (Creating a _new_ collection still
  means writing `SKILL.md` + `schema.json` under `.claude/skills/<slug>/`, since
  there's nothing to `getSchema` yet.)
<!-- /authoring:direct -->
- **Do NOT use the `mc-` prefix** for skills you create. `mc-*` is reserved for
  the bundled presets (`mc-cooking-coach`, `mc-library`, `mc-wiki-*`,
  `mc-manage-*`); the server overwrites those on every boot, so your edits would
  be lost. (The billing collections — `clients`, `worklog`, `invoice`, `profile`
  — are now recipe-authored under these plain slugs, NOT `mc-` presets; see the
  worked reference below.)
- **`<slug>` rules**: lowercase letters, digits, hyphens; no leading / trailing
  hyphen; 1–64 chars (e.g. `recipes`, `book-club`, `gym-log`). It doubles as the
  URL (`/collections/<slug>`) and the directory name.
- The user opens the collection at **`/collections/<slug>`**. Link a specific
  record with `?selected=<id>` (e.g. `/collections/recipes?selected=carbonara`).

## SKILL.md

Standard skill front-matter plus prose teaching _future-you_ how to maintain the
records. Keep it short and operational:

```markdown
---
name: recipes
description: A personal recipe box. Use whenever the user asks to add, list,
  edit, or remove a recipe. Records live at `data/recipes/items/<id>.json`
  (one JSON per recipe); the user views them at `/collections/recipes`,
  rendered from `schema.json` by the host. Record I/O via the
  `manageCollection` tool (raw Read / Write / Edit on the JSON files is the
  escape hatch); schema/structure edits via `manageCollection`
  `schemaDocs` / `getSchema` / `putSchema`.
---

# Recipes (schema-driven collection)

## Record shape

- `id` — kebab-case slug, primary key (the filename, no extension)
- `title` — string, required
- ... (one bullet per field; note which are host-computed and must NOT be written)

## What to do

**Add / Update** — `manageCollection` putItems: each row is validated against
the schema BEFORE the write; fix any `rejected` row from its `problem` text
and retry just those. Use `mode: "create"` when adding so an id collision is
rejected instead of silently overwritten, and `mode: "merge"` with a partial
row (`{ id, <changed fields> }`) when updating — the default upsert replaces
the WHOLE record and would erase every optional field the row omits.
**List / Read** — `manageCollection` getItems: the only way to see
host-computed `derived` / `toggle` / `embed` values (the stored JSON never
contains them); pass `ids` / `fields` on large collections.
**Delete** — remove the record file.
**Change the schema** (add / rename / remove a field, view, or action) —
`manageCollection` `schemaDocs` for the field DSL, `getSchema` to read the
current schema, then `putSchema` to validate-and-write it. Do NOT hand-edit
`schema.json` with Read / Write / Edit — `putSchema` validates the whole schema
first and tells you exactly what's wrong, where a raw edit can silently fail
discovery's validation and make the collection vanish.
Don't recite the whole table in chat. After adding or updating a record,
call `presentCollection` (with the collection slug and the record's id) to
show it inline; for a plain "show/list" request, call `presentCollection`
with just the slug.
```

Write the `description` so it tells _you_ (in a future session) exactly when to
reach for this skill and where the records live — that text is what gets matched
when the user makes a request.

## schema.json — the DSL

Top-level shape (validated on discovery; a malformed schema is logged and
skipped, never crashes the host):

| Key                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                | Human name shown in the sidebar / header. Required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `icon`                 | A **Material Symbols** name (`receipt_long`, `people`, `schedule`, `menu_book`). Required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `dataPath`             | Records folder, relative to the collection's own root (the workspace or project folder it lives in) — e.g. `data/recipes/items`. Must stay under that root. **Required**, unless `dataSource` or `storage` is set instead: declare exactly ONE of the three. (There is no default — `data/<slug>/items` is a naming CONVENTION, not a fallback.)                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dataSource`           | Optional. `{ "type": "csv", "path": "data/students.csv" }` — the records ARE the rows of an external data file (relative to the collection's own root, containment-checked like `dataPath`). Makes the collection **read-only** in every UI/tool write path; see "External data (CSV) collections" below. Mutually exclusive with `dataPath`, `singleton`, `ingest`, `spawn`, and `mutate` actions.                                                                                                                                                                                                     |
| `storage`              | Optional. `{ "type": "sqlite", "path": "data/<name>.db" }` — records live in a single SQLite database file instead of per-record JSON files — or `{ "type": "firestore" }`, a SHARED collection whose records live in the app's Firestore (only when the user asks for sharing). Either way the collection stays **writable** and behaves identically everywhere else. Declare exactly ONE of `dataPath` / `dataSource` / `storage`. See "Alternative storage (sqlite)" and "Shared storage (firestore)" below.                                                                                                                                                            |
| `primaryKey`           | The field name whose value is the filename. That field MUST set `primary: true`. The value must be a valid record id (see the **Records** section's id-charset rule). Required.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `singleton`            | Optional. When set, at most one record exists, pinned to this exact id (e.g. `me`). Host pre-fills + locks the create form and hides Add once it exists.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fields`               | Ordered map of field-name → field spec. **Insertion order = column order** in the table. Required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `actions`              | Optional array of per-record buttons (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `completionField`      | Optional. Name of the field whose value marks an item as "done" — when set, item-create fires a bell notification that clears once the item reads as done. Must name a real field in `fields`. Two forms: paired with `completionDoneValues` (done ⇔ the field's value is in that array), or naming a **`flag` field** (done ⇔ the flag's `where` matches — `completionDoneValues` must then be omitted).                                                                                                                                                                            |
| `completionDoneValues` | Optional. Non-empty array of values that count as "done" for `completionField` (e.g. `["Done"]`, `["paid", "void"]`). Compared as strings. Omit when `completionField` names a `flag` field.                                                                                                                                                                                                                                                                                                                                                                                       |
| `notifyWhen`           | Optional. A `when` predicate (`{ "field": "...", "in": [...] }`) that **gates** the completion bell: fire it only for records matching the predicate (e.g. `{ "field": "priority", "in": ["high", "urgent"] }`). Requires `completionField`; `field` must name a real field. Absent ⇒ notify for every open record.                                                                                                                                                                                                                                                                |
| `displayField`         | Optional. Name of a field whose value is shown as the human-readable label in the completion notification's title (e.g. `Contacts: Jane Doe` instead of the opaque primaryKey). Must name a real field in `fields`. Falls back to the primaryKey value when unset or when the record's value is empty.                                                                                                                                                                                                                                                                             |
| `triggerField`         | Optional. Name of a `date` field that **delays** the completion bell until that date arrives (instead of firing on create). Requires `completionField` / `completionDoneValues` (the bell still clears via the done value). Must name a real `date` field. See "Time-gated bells" below.                                                                                                                                                                                                                                                                                           |
| `triggerLeadDays`      | Optional. Non-negative integer: fire the bell this many days **before** `triggerField` (e.g. `10` = "remind me 10 days early"). Requires `triggerField`. Default `0` (fire on the trigger date).                                                                                                                                                                                                                                                                                                                                                                                   |
| `spawn`                | Optional. Host-driven **recurrence**: when a record reaches a configured value (e.g. `status: paid`), the host auto-creates the next record with a forward-advanced `triggerField` date. Requires `triggerField`. See "Recurring obligations" below.                                                                                                                                                                                                                                                                                                                               |
| `calendarField`        | Optional. Name of a `date` (or `datetime`) field that anchors the **calendar view** (a month grid; each record lands on its date cell). When unset, the table↔calendar toggle still appears if the schema has any `date`/`datetime` field — the first one is used, switchable in-view. Set this to pin a specific anchor. Must name a real `date`/`datetime` field. See "Calendar view" below.                                                                                                                                                                                     |
| `calendarEndField`     | Optional. A second `date`/`datetime` field marking the END of a multi-day span on the calendar (the record renders across `calendarField` → this date). Requires `calendarField`. Must name a real `date`/`datetime` field.                                                                                                                                                                                                                                                                                                                                                        |
| `calendarTimeField`    | Optional. Name of a string field holding a free-form time or time-range (`"14:00-17:00"`, `"17:00-"`, `"16:30"`) used to place records on the calendar's **day (time-allocation) view**. Consulted only when the date fields are date-only — a `datetime` anchor/end pair carries its own clock and takes precedence. Requires `calendarField`. See "Calendar view" below.                                                                                                                                                                                                         |
| `kanbanField`          | Optional. Name of an `enum` field that groups records into columns on the **Kanban board** (one column per declared value). When unset, the Kanban toggle still appears if the schema has any `enum` field — the first one is used, switchable in-view. Set this to pin a specific group field. Must name a real `enum` field. See "Kanban view" below.                                                                                                                                                                                                                            |
| `views`                | Optional. Custom (LLM-authored) HTML views: `[{ id, label, icon?, file, capabilities?, target?, allowSendChat? }]`. Each renders an HTML file under `views/*.html` in a sandboxed iframe over the records, for layouts the built-ins don't cover (year/quarter overview, Gantt, report). `capabilities` is `["read"]` (default) or `["read","write"]`. `allowSendChat: true` makes the view's `startChat` buttons RUN the prompt instead of leaving it as an editable draft. `target: "mobile"` makes it a **remote view** for the phone app (different runtime contract — **`config/helps/custom-view-remote.md`**). See "Custom views" below and **`config/helps/custom-view.md`** for the desktop authoring contract. |
| `googleCalendar`       | Optional. `{ "calendarId": "primary", "map": { "<field>": "summary" } }` — the host mirrors one of the user's **Google calendars** into this collection on a schedule, **LLM-free**: no tool call, no tokens per sync. Reach for it whenever the user asks for a collection that syncs with Google Calendar — never an `ingest.kind: "agent"` worker or the `google` MCP tools, which spend an LLM turn per refresh doing what the host does for free. Needs `dataPath`. See "Google Calendar sync" below and **`config/helps/google-calendar-collection.md`**.                    |

### Field types

`string` · `text` (multi-line) · `email` · `number` · `date` (`YYYY-MM-DD`) ·
`datetime` (`YYYY-MM-DDTHH:MM`, or `YYYY-MM-DD` for all day) · `boolean` · `markdown` · `money` · `enum` ·
`ref` · `embed` · `backlinks` · `rollup` · `table` · `derived` · `image` · `file` · `toggle` · `flag`

Every field spec needs a `type` and a `label`. Extra keys by type:

- **`datetime`** — no extra keys. Stored as a `YYYY-MM-DDTHH:MM` string (seconds
  optional) and edited with a native date+time picker, or as a bare `YYYY-MM-DD`
  for an all-day value (see below). It is a **local wall
  clock, not an instant**: no `Z`, no `+09:00` offset. `08:00` means eight in the
  morning wherever the records are read, which is what a schedule means and what
  the calendar can place. So a generated value must be FORMATTED, never
  converted — `new Date(...).toISOString()` is wrong twice over: it appends the
  `Z` (`putItems` writes the row but reports it in `lint`, a full `getItems`
  listing warns about it, and a shared app's publish refuses it outright), and
  it shifts the hours by the generating machine's offset, so a Tokyo 08:00 written on a US laptop reads back as the afternoon.
  Build the string from the parts you already have (`${date}T${hh}:${mm}`). The
  one `Z`-suffixed datetime that is legal is a shared app's server-stamped
  field — nine fractional digits, written by the SERVER, never by you. Anything
  else ending in `Z` (including `toISOString()`'s three digits) is linted.
  A bare `YYYY-MM-DD` is also legal and means ALL DAY — the calendar shows it
  without a clock and a Google Calendar push sends it as an all-day event;
  `…T00:00` means a real midnight start.
  Use it (as `calendarField` / `calendarEndField`) when an event has a real
  start/end clock — the calendar's day view then draws each record as a
  proportional time block. For the common "date column + separate time column"
  shape, keep `date` and point `calendarTimeField` at the time string instead.
- **`enum`** — `values: ["draft", "sent", "paid"]` (non-empty strings). Renders
  a `<select>`; stored as a plain string. Optional `default: "draft"` pre-fills
  a NEW record — the Add form opens on it, and a `putItems` row in `create` mode
  that omits the field gets it. The value must be one of `values` (`putSchema`
  refuses otherwise). `default` pairs with `required: true`: the requirement is
  already satisfied, so the user just saves. It is NOT re-applied by `upsert` or
  `merge` — those edit a record that already carries an answer.
- **`money`** — `currency: "USD"` (ISO 4217, defaults to USD). Stored as a plain
  decimal; currency is display-only.
- **`ref`** — `to: "<target-slug>"`. Stores the target record's primary-key
  slug; host renders a clickable link + a dropdown picker populated from the
  target collection. Example: `{ "type": "ref", "to": "clients", "label": "Client" }`.
  A `derived` field on the same record can also **dereference** a `ref` to read
  a numeric column off the record it points at — see the cross-collection
  formula syntax below.
- **`embed`** — `to: "<target-slug>"`, plus **exactly one** of `id` (a _fixed_
  record id, same for every row) or `idField` (a _per-record_ target). Pulls a
  record from another collection into the read-only detail view (display-only,
  **nothing is stored** on this record). Fixed — every row embeds the same
  singleton record (e.g. a one-record `settings` collection):
  `{ "type": "embed", "to": "settings", "id": "app" }`.
  Per-record — `idField` names a sibling field (typically a `ref`) holding the
  target id, so each row embeds a different record; the host renders that
  sibling as a dropdown picker in the editor and hides its own cell (the embed
  owns it). E.g. a multi-issuer invoice: a `ref` field `issuerId → profile`
  plus `{ "type": "embed", "to": "profile", "idField": "issuerId" }`.
- **`backlinks`** — `from: "<source-slug>"`, `via: "<ref-field-in-source>"`,
  `display: ["<source-col>", ...]`, optional `filter: { "field": ..., "in": [...] }`.
  The **reverse** side of a `ref`: a read-only sub-table (detail view only) of
  the records in `from` whose `via` ref points at this record — each row links
  to that record. **Nothing is stored** on this record (like `derived`/`embed`);
  you never write it, and the rows update whenever the source records change.
  `display` names the source columns to show — a derived source column works
  when its formula is self-contained (e.g. an invoice `total` summing its own
  line items), but one that derefs yet another collection renders em-dash;
  `filter` narrows rows by a source field's value, same shape as `when`. E.g. a
  client's open invoices:
  `{ "type": "backlinks", "label": "Invoices", "from": "invoice", "via": "clientId", "display": ["issueDate", "total", "status"], "filter": { "field": "status", "in": ["draft", "sent"] } }`.
  `via` may name a top-level `ref` column, or a `ref` nested one level inside a
  `table` field as `"<tableField>.<refColumn>"` (split on the first `.`) — the
  source record matches when **any row** of that table points at this record,
  and a record referencing it in several rows still appears once. E.g. a
  chapter whose `characters` table has a `character` ref column backlinks to
  each character via `"via": "characters.character"`. Only one level of nesting
  is supported; `display`/`filter` still read the **source record**, not the row.
  An exact top-level field name wins over the dotted interpretation, so a field
  literally named `"a.b"` still resolves as a flat ref column.
  Resolution is fail-soft: an unknown `from` / `via` / `display` column, or a
  dotted `via` whose table field is absent, just renders an empty sub-table —
  no error, so author the `ref` side first.
- **`rollup`** — `from: "<source-slug>"`, `via: "<ref-field-in-source>"`,
  `op: "sum" | "count"`, `column: "<source-col>"` (required for `sum`, omitted
  for `count`), optional `filter` (same shape as `when`, against the source).
  `via` accepts the same top-level or `"<tableField>.<refColumn>"` nested form
  as `backlinks` (any matching row counts the source record once).
  A **cross-collection aggregate**: a computed number — never stored — summed
  (or counted) over the records in `from` whose `via` ref points at this
  record. Backlinks show the rows; rollup collapses them to a scalar that
  renders everywhere a number does (list column included). E.g. a client's
  unbilled hours:
  `{ "type": "rollup", "label": "Unbilled hours", "from": "worklog", "via": "clientId", "op": "sum", "column": "hours", "filter": { "field": "billed", "in": ["false"] } }`.
  Fail-soft: an unresolvable `from` renders em-dash; an empty match set is a
  real 0. Summing a source `derived` column works when its formula is
  self-contained; non-numeric values are skipped. A `derived` formula ON THE
  SAME schema may reference rollup fields as plain identifiers — rollups
  resolve before the formula pass — e.g. two one-sided counts combined:
  `"played": { "type": "derived", "formula": "homePlayed + awayPlayed" }`.
  (Caveat: that works on the collection's own rows; a `<refField>.<col>`
  deref FROM another collection reads the target without its rollups, so a
  rollup-fed derived column is em-dash when viewed through a ref.)
- **`table`** — `of: { <col>: <sub-field-spec>, ... }`. An array of rows. Each
  sub-field is a flat spec; sub-fields **cannot** be `table`, `derived`,
  `backlinks`, or `rollup` (no nested tables, no computed columns).
- **`derived`** — `formula: "<expr>"`, optional `display` (`number` default, or
  `money` / `string` / `date`) and `currency`. **Read-only, host-computed** —
  you NEVER write derived values into the JSON; the host recomputes them on
  every render and the form refuses to persist them.
- **`image`** — stores an **image path relative to the collection's own root** as a plain string
  (e.g. `data/attachments/2026/05/<id>.jpg` — the exact path from an
  `[Attached file: ...]` marker when the user attaches a photo). The host
  renders it as an `<img>` in the **detail view** (it is intentionally not a
  list-table column — a per-row image fetch is too expensive for a large
  collection). No extra keys. Great for photos like a business card: read the
  details off the attached image and write its path into the image field.
  Write the bare root-relative path — never an `/api/files/raw?...` URL.
  A **custom view** renders these via `GET <dataUrl>/image` (see
  `config/helps/custom-view.md` "Displaying images"; remote views declare
  `imageFields` instead) — never by base64-embedding them into the view HTML.
- **`file`** — stores a **file path relative to the collection's own root** as a plain string (e.g.
  `artifacts/html/the-solar-system-1777158558023.html`). Rendered as a
  **clickable link** in both the list table and the detail view (unlike `image`,
  which is detail-only — a link is cheap per-row). Clicking an HTML or SVG
  artifact opens its **rendered** form in a new browser tab (the live app /
  drawing); any other path opens in the **File Explorer**. No extra keys. Ideal
  for a "my apps" collection where each record points at a generated HTML app —
  the user launches it straight from the row. Write the bare root-relative
  path — never an `/artifacts/...` or `/api/files/raw?...` URL.
- **`toggle`** — `field: "<enum-field>"`, `onValue`, `offValue`. A checkbox that
  is a pure **projection** of an `enum` field — it **stores nothing** of its own
  (like `derived`/`embed`). Checked when the projected enum equals `onValue`;
  toggling writes `onValue` / `offValue` back to that enum. `onValue`/`offValue`
  must be members of the enum's `values`. Use it to front a kanban `status` with
  a "done" checkbox while keeping the enum as the single source of truth — e.g.
  `{ "type": "toggle", "label": "Done", "field": "status", "onValue": "Done", "offValue": "Todo" }`.
  Renders an interactive checkbox in the list table and on the kanban card (when
  it projects the board's group field); read-only in the detail view.
  **A todo / task list should almost always include one** — it's the row/card
  "done" checkbox. Without it, `status` only shows as a dropdown and a kanban
  column, with no checkbox to tick. `offValue` is the status to return to on
  uncheck (the default open column, e.g. `"Todo"`).
- **`flag`** — `where: [<conditions>]`. A **computed boolean**: true when the
  record matches every condition (AND). **Never stored** (like `derived`); the
  host recomputes it on every read, so you NEVER write flag values into the
  JSON. Each condition is `{ "field": "<field>", "op": "<op>", "value": "..." }`
  with ops `eq` / `ne` / `in` (array value) / `contains` / `gt` / `gte` / `lt` /
  `lte`, or `{ ..., "valueFrom": { "field": "<sibling>" } }` to compare two
  fields of the same record (`spent > budget`). Condition fields must name
  declared fields; cross-record `valueFrom.record` is not allowed. A flag may
  read `derived` / `rollup` values, and other flags via their stringified
  boolean (`{ "field": "isDone", "op": "eq", "value": "true" }`). Use it for
  generic state summaries — done-ness, pass/fail, qualification:
  `{ "type": "flag", "label": "Passed", "where": [{ "field": "score", "op": "gte", "value": "60" }] }`.
  A flag can also drive completion tracking (stored-field conditions only) —
  see `completionField` above and the "Completion tracking" section below.

### Conditional field visibility (`when`)

Any field may carry an optional `when: { field, in: [...] }` predicate to hide
itself until another field on the same record matches — the same shape used to
gate `actions`. The field shows only when `String(record[when.field])` is one of
`in`; absent ⇒ always shown. `when.field` MUST name another top-level field
(validated on discovery).

```json
"visited":    { "type": "boolean", "label": "Visited" },
"rating":     { "type": "number",  "label": "Rating", "when": { "field": "visited", "in": ["true"] } }
```

Here `rating` stays hidden until `visited` is checked (booleans stringify, so
match `"true"` / `"false"`). The gate applies everywhere the field renders: the
list cell goes **blank**, the edit-form input hides/shows **live** as the gating
field changes, and the detail view omits it. It is **purely presentational** —
a hidden field's stored value is never cleared, so re-matching the gate restores
it. Use it for fields that only make sense in a given state (a rating before
you've visited, a shipped-date before an order ships). Only honoured on
top-level fields, not inside a `table`'s `of`.

### Derived-formula syntax

A tiny expression evaluated against the record (pure evaluator, no `eval`;
returns `null` on any failure). Supported:

- arithmetic `+ - * /` and parentheses
- identifier references to **top-level** fields (`subtotal * taxRate`)
- `sum(tableField[].col)` — sum a column across table rows
- `sum(tableField[].col * tableField[].col)` — sum a per-row product
- `<refField>.<col>` — **dereference a `ref` field** and read a numeric column
  off the record it points at (a live cross-collection lookup)

Example: `subtotal` = `sum(lineItems[].quantity * lineItems[].rate)`,
`tax` = `subtotal * taxRate`, `total` = `subtotal + tax`.

#### Cross-collection lookups (`<refField>.<col>`)

When a field is a `ref` to another collection, a `derived` formula can reach
into the referenced record and pull a numeric column out of it. This lets one
collection compute against data **owned by another** without copying that data.

Canonical use — a portfolio that values holdings against a separate price list:

```jsonc
// my-portfolio/schema.json  (one record per holding)
"fields": {
  "ticker": { "type": "ref", "to": "stock-quotes", "label": "Stock" },  // stores e.g. "AAPL"
  "shares": { "type": "number", "label": "Shares" },
  "value":  { "type": "derived", "formula": "shares * ticker.price",     // ← reads price from the quotes row
              "display": "money", "currency": "USD", "label": "Value" }
}
```

Here `ticker.price` resolves the `ticker` ref to its `stock-quotes` record and
reads that record's `price`. `price` lives **only** in `stock-quotes`; the
portfolio never stores a copy, so a quote refresh in `stock-quotes` is the
single source of truth for every holding's value.

Rules and limits:

- The left side must be a `ref` field **on this same record**; the right side is
  a single column name. Only the `<field>.<col>` shape — no `a.b.c` chains, no
  dereferencing inside `sum(...)`.
- The referenced column must hold a number (or a numeric string). A missing
  column, a non-numeric value, or a **dangling ref** (the slug points at a row
  that doesn't exist) makes the whole formula fail soft to an em-dash (`—`),
  same as any other formula error.
- The referenced column may itself be a **`derived`** field in the target
  collection (the host computes the target's own derived fields before the
  lookup) — _as long as_ that target formula is target-local. A target derived
  field that in turn derefs a **third** collection won't resolve (only one hop
  is loaded) and reads as `—`.
- The target collection is loaded **when the page opens**. If a value changes in
  the target while the viewing collection is already open (e.g. you refresh a
  price in `stock-quotes` in another tab), the derived value updates on the next
  reload — not instantly across tabs.
- It's still per-record: each holding computes `shares * ticker.price` from its
  own `ticker`/`shares`. To total the portfolio, add a one-record summary
  collection or read the values off the list view — there is no cross-row sum
  over a joined column.

### Actions (per-record buttons)

Each entry in `actions` renders a button in the read-only detail view. Three
kinds:

- **`"chat"`** — clicking it starts a **new visible chat in a role**, seeded
  with a template + the record data — the role then does the work with its
  tools. Pick it when the output IS the conversation or the user may need to
  steer: PDF generation, bookkeeping journals, drafting an email.
- **`"agent"`** — clicking it dispatches a **hidden background worker** with
  the SAME seed; the worker edits the record via `manageCollection` and
  finishes silently — no chat window, the record just updates. Pick it for
  mechanical enrichment where a transcript would be noise: refresh a price,
  fetch metadata, look something up and write it back. The button shows a
  spinner while the worker runs; a failed run raises one bell notification
  (cleared by the next success). **End an agent template with**: "edit the
  record via manageCollection and stop — do not present anything."
- **`"mutate"`** — **no LLM at all**: the host applies a declarative write the
  moment the button is clicked (after an optional mini-form). Pick it when the
  write needs zero judgment — "Mark paid", "Assign", any fixed state
  transition. Instant and token-free. Shape (no `role`/`template`):

  ```json
  {
    "id": "assign", "label": "Assign", "icon": "person_add",
    "kind": "mutate",
    "require": { "field": "status", "in": ["open"] },
    "params": { "assignee": { "type": "string", "label": "Assignee", "required": true } },
    "set": { "assignee": "$params.assignee", "status": "assigned" }
  }
  ```

  `set` merges into the record (only the named fields change) — values are
  literals or `$params.<name>` references. `require` replaces `when` (same
  shape, same visibility-is-authorization rule, re-checked server-side).
  `params` declares an optional mini-form using the table sub-field DSL; the
  submitted values are validated like record fields, and the write itself runs
  through the same gate as `putItems` (a rejected write shows the `problem`).
  Constraints (schema-validated): `set` keys must name declared, non-computed
  fields (never the primaryKey); every `$params` reference must name a
  declared param; mutate is **record-level only** (not in `collectionActions`).
  Group several fields in one `set` so "paid" can mean `status` + `paidDate`
  written together. `toggle` stays the right tool for a single checkbox.

This is how hard logic that the schema can't express gets delegated to natural
language (and, for `"mutate"`, how the schema-expressible part stays free).

```json
{
  "id": "pdf", // unique within the schema
  "label": "Generate PDF", // button text (English)
  "icon": "picture_as_pdf", // Material Symbols name
  "kind": "chat",
  "role": "accounting", // which role the new chat runs in
  "template": "templates/invoice.md", // skill-relative; no `..`, no leading `/`
  "when": { "field": "status", "in": ["paid"] } // optional: show only when record.status ∈ {paid}
}
```

- `template` is a path **inside the skill dir** (host reads it path-safely).
  Write the action's instructions there in plain English; the host prepends the
  record JSON as sanitized, passive data and hands the whole thing to the role.
- `when` is both the visibility rule **and** the authorization rule — the host
  re-checks it server-side, so a button gated on `status: paid` can't be invoked
  for a draft. Omit `when` ⇒ always shown.
- You do **not** trigger actions yourself; point the user at the button.

### Collection-level actions (header buttons)

`collectionActions` is a second array, same entry shape as `actions`, but the
buttons render in the **collection header** instead of a record's detail view.
Use one when the work spans the whole collection rather than a single record —
e.g. a course-level "Learn / continue" button on a lessons collection that picks
the next lesson, or "Monthly close" on an invoice ledger.

The difference is what the seed prompt carries: a per-record action injects that
one record's JSON; a collection-level action injects a **compact progress
summary of every record** — each record projected down to the schema's
`primaryKey`, `displayField`, `completionField`, and `kanbanField` values (long
text / markdown / html / file fields are left out, so the prompt stays small).

```json
"collectionActions": [
  { "id": "continue", "label": "Continue", "icon": "play_arrow",
    "kind": "chat", "role": "tutor", "template": "templates/continue.md" }
]
```

- Same `id` uniqueness rule (within `collectionActions`); same path-safe
  `template`; same `role` + kind behavior (`"chat"` seeds a visible chat,
  `"agent"` dispatches a silent worker over the whole collection — e.g. a
  "Sync" button that pushes records to an external system via MCP; the
  known-good sync recipe, including the snapshot-diff state file and the
  `externalId` write-back, is **`config/helps/egress-sync.md`**).
- `when` is **ignored** here — there is no record to gate on. Always shown.

### Completion tracking (bell notifications)

Declare `completionField` + `completionDoneValues` at the top level of the
schema to wire a record's lifecycle into the bell:

```json
{
  "title": "Todos",
  "icon": "check_circle",
  "dataPath": "data/todos/items",
  "primaryKey": "id",
  "fields": {
    "id": { "type": "string", "label": "ID", "primary": true, "required": true },
    "title": { "type": "string", "label": "Title", "required": true },
    "status": { "type": "enum", "values": ["Todo", "Doing", "Done"], "label": "Status", "required": true }
  },
  "completionField": "status",
  "completionDoneValues": ["Done"],
  "displayField": "title"
}
```

Behaviour:

- **On create** the host fires a bell notification (titled
  `<schema.title>: <label>`, where `<label>` is the record's `displayField`
  value when declared — falling back to the primaryKey `<id>` otherwise;
  click-navigates to `/collections/<slug>?selected=<id>` so the item's detail
  opens) — unless the new record is **born done** (its `completionField` value
  is already in `completionDoneValues`), in which case nothing fires. The entry
  is published with `lifecycle: "action"` so it persists prominently in the
  bell until the obligation resolves.
- **On update** the host clears the notification when `completionField`
  transitions **into** a done value. Un-completing (Done → Todo) does NOT
  re-fire; firing is bound to create, by design.
- **On delete** the host clears any matching notification so a removed record
  can't leak a stale entry.

The pair is bundled — declaring one without the other fails schema validation.
`completionField` must name a real field; a typo is rejected at load. Works
with any field type whose stringified value is comparable (`enum`, `string`,
`boolean`, …) — e.g. `completionField: "status"` + `completionDoneValues:
["paid", "void"]` on an invoice, or `completionField: "shipped"` +
`completionDoneValues: ["true"]` on an order.

**Flag-form alternative**: `completionField` may instead name a **`flag`
field** — then done ⇔ the flag's `where` matches, and `completionDoneValues`
must be **omitted** (declaring it fails validation). Use it when done-ness is
richer than one field's membership (e.g. `"isDone": { "type": "flag", "where":
[{ "field": "score", "op": "gte", "value": "60" }] }` + `"completionField":
"isDone"`). Two extra rules apply only to a completion flag: its `where` may
reference **stored fields only** (no derived/rollup/toggle/flag/embed/backlinks
— completion is checked against the raw record), and combining it with `spawn`
requires an explicit `spawn.when`.

Set `displayField` to make the bell title readable: with `displayField:
"title"` the notification reads `Todos: Buy milk` instead of `Todos: t-0042`.
It must name a real field; an empty value on a given record falls back to the
primaryKey for that record.

> **Building a todo / task list?** When your `completionField` is a status enum,
> also add a `toggle` field (the row/card "done" checkbox) and `notifyWhen`
> (fire the bell only for high-priority items, not every record). See the full
> recipe in **"Worked example: a Todo list"** below — that's the canonical
> template; don't reinvent it from these fragments.

### Time-gated bells (`triggerField`)

By default the completion bell fires **on create**. Add `triggerField` — the
name of a `date` field — to instead **hold the bell until that date arrives**.
The item is still tracked, but its bell stays silent while the trigger date is
in the future and appears once the clock reaches it (compared at day
granularity in the server's local timezone). It clears the same way as any
completion bell — when `completionField` reaches a `completionDoneValues` value.

```json
{
  "title": "Reminders",
  "icon": "event",
  "dataPath": "data/reminders/items",
  "primaryKey": "id",
  "fields": {
    "id": { "type": "string", "label": "ID", "primary": true, "required": true },
    "what": { "type": "string", "label": "What", "required": true },
    "dueOn": { "type": "date", "label": "Remind on", "required": true },
    "status": { "type": "enum", "values": ["pending", "done"], "label": "Status", "required": true }
  },
  "completionField": "status",
  "completionDoneValues": ["done"],
  "displayField": "what",
  "triggerField": "dueOn"
}
```

This is the "nudge me about this on date X, until I mark it done" pattern. Notes:

- `triggerField` **requires** the completion pair (validation rejects it
  otherwise — there'd be no bell to gate or clear).
- The named field must be type `date`; its value is parsed as `YYYY-MM-DD`.
- Firing is **derived from the clock, not stored** — so if the server was down
  when the date passed, the bell simply appears at the next boot/check. Pushing
  the date back into the future retracts a bell that already fired.
- Granularity is whole days (no time-of-day).

#### Lead time — fire it early (`triggerLeadDays`)

Keep `triggerField` as the **real** due date and add `triggerLeadDays` to fire
the bell some days ahead of it. "Remind me 10 days before rent is due":

```json
"triggerField": "dueOn",
"triggerLeadDays": 10
```

The bell now appears once the clock reaches `dueOn − 10 days`, and still clears
when the item is marked done. The lead is applied at fire time (not stored), so
it **composes with `spawn`**: every recurred month fires 10 days before its own
`dueOn`, with no extra bookkeeping. It's a non-negative whole number of days and
requires `triggerField`. This is a single earlier bell — not an escalating
multi-stage reminder (info → warning → urgent), which is intentionally out of
scope for collections.

### Recurring obligations (`spawn`)

Add a `spawn` block to make a collection **recur**: when a record satisfies a
predicate (by default, when it becomes "done"), the host automatically creates
the **next** record with its `triggerField` advanced. Combined with
`triggerField`, this expresses periodic obligations — rent, subscriptions,
renewals, recurring payments — with no work from you per cycle: mark this
month's rent `paid`, and next month's pending record appears on its own.

```json
"triggerField": "dueOn",
"spawn": {
  "when":  { "field": "status", "in": ["paid"] },
  "every": { "unit": "month", "interval": 1, "dayOfMonth": 10 },
  "carry": ["amount", "payee"],
  "set":   { "status": "pending" }
}
```

- **`when`** — a `{ field, in: [...] }` predicate (same shape as field/action
  `when`) that fires the spawn. Omit it to default to "the completion-done
  condition" (i.e. spawn when this record is done).
- **`every`** — how to advance `triggerField` from this record to the next:
  - `unit`: `day` · `week` · `month` · `year`; `interval`: a positive integer
    (so `unit: "month", interval: 3` = quarterly, `unit: "year", interval: 1`
    = annual).
  - `dayOfMonth` (month/year only): the **canonical** day-of-month anchor
    (1–31, or `"last"` for the month's last day). Use it for day ≥ 29 so
    short months don't cause drift — "31st of every month" yields
    31 → 28/29 → 31 → 30 … correctly. Omit it for days ≤ 28 and the source
    date's day is preserved.
  - **Field-driven interval** (one list, mixed cadences): instead of a single
    `{ unit, interval }`, `every` may select the interval **per record** from
    an `enum` field. Use `{ "fromField": "<enum field>", "map": { <value>:
{ unit, interval, … } } }` — the host reads the record's value and
    advances by the matching entry. This lets one collection carry daily,
    weekly, and monthly obligations together:

    ```json
    "every": {
      "fromField": "frequency",
      "map": {
        "daily":   { "unit": "day",   "interval": 1 },
        "weekly":  { "unit": "week",  "interval": 1 },
        "monthly": { "unit": "month", "interval": 1, "dayOfMonth": 1 }
      }
    }
    ```

    Rules (all enforced at write time): `fromField` must name a top-level
    `enum` field; the `map` keys must **exactly cover** that enum's `values`
    (no missing or extra keys); and `fromField` must be in `carry` (or written
    by `set`) so the successor keeps its frequency and the chain keeps
    recurring. Each `map` value is a literal `every` (same `unit` / `interval`
    / `dayOfMonth` rules as above).

- **`carry`** — record fields copied verbatim onto the successor (must name
  real fields). Fields not in `carry` / `set` / the trigger+primary keys start
  blank.
- **`set`** — fields forced to fixed values on the successor (typically
  resetting the status to its pending value).

How it behaves (worth understanding so it doesn't surprise you):

- The successor's id is **deterministic**: `<stem>-<YYYYMMDD>` (the source id
  with any trailing `-YYYYMMDD` replaced). So `rent` → `rent-20260610` →
  `rent-20260710`. Creation is **create-if-absent** — it never overwrites, so
  re-running is harmless and any edits you make to a successor are preserved.
- **Forward-only**: un-doing the source (e.g. `paid` → `pending`) does NOT
  delete an already-created successor. And because spawning is convergent,
  deleting the successor while the source still matches `when` will **re-create
  it**. To genuinely **stop a recurrence**, move the source to a status that is
  _not_ in `spawn.when` (e.g. an `archived` value) — that's the supported "end
  it" gesture.
- `spawn` **requires** `triggerField` (the successor's date is `triggerField`
  advanced by `every`).

This covers _periodic_ obligations. It does **not** do escalating, multi-stage
reminders over a long prep window (info → warning → urgent) — that is
intentionally out of scope for collections.

### Scheduled agent refresh (`ingest.kind: "agent"`)

When a collection's records need to be **refreshed on a schedule by judgment**
— fetch today's stock quotes for every ticker, re-check each watched URL, pull
fresh figures that a static feed URL can't express — add an `ingest` block with
`kind: "agent"`. On schedule (and on the **Refresh** button, which appears on
any collection with an `ingest` block), the host launches a **hidden background
worker** in `role`, seeded with your `template` plus the same compact
all-records summary a collection-level action gets. The worker edits the records
itself via its collection tools, then finishes silently — nothing shows in the
chat list. Host stays generic: all the domain logic lives in the template prose.

```json
"ingest": {
  "kind": "agent",
  "schedule": "daily",
  "atHour": 22,
  "role": "investor",
  "template": "templates/refresh.md"
}
```

- **`schedule`**: `hourly` | `daily` | `weekly` | `on-demand`. `on-demand` never
  auto-runs (Refresh button only). Cadence is elapsed-based ("≥24 h since the
  last run, checked hourly") unless you anchor it (below).
- **`atHour`** (optional, `daily` only): the hour (0–23) to run around. The host
  ticks hourly, so the run lands within that hour.
  **⚠ `atHour` is UTC — NOT the user's local time.** A bare `"atHour": 9` fires
  at 09:00 UTC (= 18:00 JST, = 04:00 ET), which is almost never what "9am" means
  to the user. So when the user says a local time, **always convert to UTC
  first**: 07:00 JST → `"atHour": 22`; 9am ET ≈ `"atHour": 13`; 9am PT ≈
  `"atHour": 17`. (UTC is used for an unambiguous, DST-free comparison, matching
  the rest of the scheduler.)
- **`role`**: the role the worker runs in — it must own the tools the refresh
  needs (e.g. `investor` for the Yahoo Finance endpoints).
- **`template`**: a path-safe `templates/…md` file (same rule as action
  templates) whose prose tells the worker exactly what to do. End it with "edit
  the records and stop — do not present anything" (no one is watching its
  canvas).
- No `url`/`map` — the agent owns retrieval and record shape; its writes are
  still schema-validated. A failed run raises a single bell ("Collection refresh
  failed: `<slug>`") that clears on the next success.

Reach for `ingest.kind: "agent"` (not a `manageAutomations` task) whenever the
schedule belongs to one collection: it travels with the schema, dies with the
collection, and needs no separate setup.

### Google Calendar sync (`googleCalendar`)

A collection opts into **Google Calendar sync** the same way a feed opts into
retrieval — by declaring a block. Add `googleCalendar` and the host pulls the
user's changed events on a schedule and writes them as records **without calling
you**: no tool call, no tokens per sync.

```json
"googleCalendar": {
  "calendarId": "primary",
  "map": { "title": "summary", "on": "start", "until": "end" }
}
```

This is the answer whenever the user asks for a collection that syncs with
Google Calendar — **not** an `ingest.kind: "agent"` worker and **not** the
`google` MCP calendar tools, both of which spend an LLM turn on every refresh to
produce what the host produces for free. `map` reads _your_ field name → the
Google event field — `summary`, `start`, `end`, `description`, `location` and
`colorId` sync BOTH ways; `htmlLink`, `status`, `updated`, `transparency`,
`eventType`, `hangoutLink`, `recurringEventId` and `originalStartTime` are
pull-only, so the pull fills them and the push leaves them alone. At least one
entry is required. Never map the `primaryKey` — it always holds the
Google event id, which is what makes a re-sync update a record instead of
duplicating it.

The rest of the contract — finding a non-primary `calendarId`, how deletions
propagate, and the first-run caveat — is
**`config/helps/google-calendar-collection.md`**. Read it before authoring one.

### Calendar view

Any collection that has at least one `date` (or `datetime`) field gains a
**table ↔ calendar** toggle in its header — **zero config**. The calendar is a
month grid where each record lands on the day cell matching its date. Clicking a
record **chip** opens the same detail/edit panel the table uses; clicking
anywhere else in a day cell opens the **day (time-allocation) view** — a popup
vertical timeline of that day (see below), whose **+** button starts a new record
prefilled to that day.

```json
{
  "title": "Events",
  "icon": "event",
  "dataPath": "data/events/items",
  "primaryKey": "id",
  "fields": {
    "id": { "type": "string", "label": "ID", "primary": true, "required": true },
    "name": { "type": "string", "label": "Name", "required": true },
    "on": { "type": "date", "label": "Date", "required": true },
    "until": { "type": "date", "label": "End" }
  },
  "displayField": "name",
  "calendarField": "on",
  "calendarEndField": "until"
}
```

Notes:

- **No schema change is needed to get the toggle** — it appears whenever a `date`
  field exists. The two keys only _tune_ it: `calendarField` pins which date
  anchors the grid (otherwise the first `date` field is used, and the user can
  switch in-view when there are several); `calendarEndField` makes a record span
  multiple days (`calendarField` → `calendarEndField`, inclusive).
- `displayField` sets the chip label (falls back to the primary key).
- Records whose anchor date is missing or unparseable are listed in a small
  "No date" tray under the grid — never silently dropped.
- The calendar is purely a **rendering** of the records: it adds no storage and
  fires nothing. It composes with `triggerField` / `spawn` (which drive bells and
  recurrence) but is independent of them.
- This is the collection-native calendar — the way to give the user a
  calendar of dated records. (The old standalone Calendar view +
  `manageCalendar` tool were removed; `calendarField` is its replacement.)

#### Day view (time allocation)

Clicking a day's number badge opens a popup vertical timeline (a 24-hour grid)
showing how that day's records are allocated across the clock. Records need a
**time of day** to draw as time blocks; supply it one of two ways:

- A `datetime` `calendarField` (and optionally `calendarEndField`) — the clock
  comes from the field value itself (`2026-06-11T14:00`).
- A `date` `calendarField` **plus** `calendarTimeField` naming a string field
  with a free-form time or range. Recognised shapes:

| Time value                           | Day-view rendering                                |
| ------------------------------------ | ------------------------------------------------- |
| `"14:00-17:00"` (a range)            | a proportional **time block** from 14:00 to 17:00 |
| `"17:00-"` or `"16:30"` (start only) | a **single line** at that time (no known end)     |
| `"終日"`, blank, or unparseable      | a chip in the **all-day strip** at the bottom     |

Separators `-`, `–`, `—`, `~`, `〜`, `～` are all accepted. Overlapping blocks
split into side-by-side lanes; a multi-day `datetime` span is clamped to each
day with ▲/▼ arrows marking where it continues. Example (`date` + `time`
column):

```json
{
  "title": "Engagements",
  "icon": "event",
  "dataPath": "data/engagements/items",
  "primaryKey": "id",
  "fields": {
    "id": { "type": "string", "label": "ID", "primary": true, "required": true },
    "title": { "type": "string", "label": "Title", "required": true },
    "date": { "type": "date", "label": "Date", "required": true },
    "time": { "type": "string", "label": "Time" }
  },
  "displayField": "title",
  "calendarField": "date",
  "calendarTimeField": "time"
}
```

### Kanban view

Any collection that has at least one `enum` field gains a **Kanban board** toggle
in its header — **zero config**. The board renders one column per declared enum
value (in `values` order), plus a trailing **Uncategorized** column for
empty/unknown values (omitted when the group enum is `required`). Dragging a card
between columns writes that enum field; clicking a card opens the same
detail/edit panel.

```json
{
  "title": "Tasks",
  "icon": "checklist",
  "dataPath": "data/tasks/items",
  "primaryKey": "id",
  "fields": {
    "id": { "type": "string", "label": "ID", "primary": true, "required": true },
    "title": { "type": "string", "label": "Title", "required": true },
    "status": { "type": "enum", "label": "Status", "values": ["Backlog", "Todo", "In Progress", "Done"] },
    "done": { "type": "toggle", "label": "Done", "field": "status", "onValue": "Done", "offValue": "Todo" }
  },
  "displayField": "title",
  "kanbanField": "status"
}
```

Notes:

- **No schema change is needed to get the toggle** — it appears whenever an
  `enum` field exists. `kanbanField` only _tunes_ which enum groups the board
  (otherwise the first `enum` field is used, switchable in-view).
- **The enum is the single source of truth.** For a todo-style "done" checkbox,
  use a `toggle` field projecting the status enum (above) — do NOT add a separate
  stored boolean. Checking the box sets `status` to the done value (and moves the
  card to that column); dragging the card to the Done column checks the box. They
  are the same write.
- Columns are not draggable (order comes from the enum's `values`) and there is
  no manual ordering within a column — a drop only changes the enum value.
- Like the calendar, the board is purely a **rendering** of the records: it adds
  no storage. `completionField` / `completionDoneValues` (bells) are independent
  but pair naturally with the Done column.
- **Building a todo / task list?** Read `config/helps/todo-collection.md` — the
  complete, copy-pasteable recipe (status enum + `done` toggle + priority bells +
  calendar) plus the legacy-`todo-plugin` migration steps.

### Custom views

When the built-in views (table / calendar / kanban / dashboard) don't fit what
the user wants to _see_ — a year/quarter overview, a Gantt bar, a printable
report — author a **custom view**: an HTML file the host renders in a sandboxed
iframe over the records. Register it in `views[]` (above); it becomes a button
in the collection's view-mode selector.

- The view reads (and, with `["read","write"]`, writes) records through a
  scoped token injected as `window.__MC_VIEW` — it never touches files directly.
- It is sandboxed: inline scripts + a CDN allowlist only, and `fetch` is
  limited to the collection's own data endpoint (no third-party calls).
- Least privilege: declare `["read"]` unless the view edits records.
- It can stay **live**: call `window.__MC_VIEW.onChange(reload)` and the view
  re-fetches whenever the records change — the assistant editing them in chat,
  another tab, a feed refresh, or an auto-spawned record (like the built-in
  views). One line; no polling.

The host holds **zero** view-specific code — the view is data, like the rest of
the collection. Full authoring contract (the `window.__MC_VIEW` shape, the
read/write API, the sandbox rules, and two complete sample views):
**`config/helps/custom-view.md`**. Read it before authoring a view. For a view
that runs on the **phone remote app** (`target: "mobile"` in the `views[]`
entry) the contract is different and incompatible — read
**`config/helps/custom-view-remote.md`** instead.

### Worked example: a Todo list

The full todo recipe — complete `schema.json`, `SKILL.md`, a sample record, and
the legacy-`todo-plugin` migration steps — has its own file:
**`config/helps/todo-collection.md`**. Read it whenever you create or migrate a
todo / task list; it's the canonical template, so copy it rather than assembling
one from the fragments above. The one rule to remember: the `status` enum is the
single source of truth and the "done" checkbox is a `toggle` field projecting it
— **omit the toggle and the list has no checkbox.**

## Records — one JSON object per file

Each record is a plain file at `<dataPath>/<id>.json` (the `id` field's value is
the filename, no extension) — that is the storage model. But you read and write
records through **`manageCollection`**, not raw file I/O:

- **Create / update — `putItems`.** Every row is validated against the schema
  BEFORE the write (required fields, enum membership, primaryKey = record id)
  and the result reports `{ written, rejected }` — fix each rejected row from
  its `problem` text and retry just those rows. Use `mode: "create"` when
  adding, so an id collision is rejected instead of silently overwritten, and
  `mode: "merge"` with a partial row (`{ id, <changed fields> }`) when
  updating — the default upsert replaces the WHOLE record and would erase
  every optional field the row omits.
- **Rows a script generated — `putItems` with `itemsFile`.** When the rows
  already exist as data rather than in your head (a generated schedule, an
  imported set — anything past a few dozen records), have the script write
  them to a JSON file **under the workspace** and pass its **absolute** path as
  `itemsFile` instead of `items`. The host reads the file, so the rows never
  pass through your context: a 540-row batch is one short tool call, not 80 KB
  you transcribe. The rules:
  - `items` and `itemsFile` are mutually exclusive — passing both is refused,
    not merged.
  - The path must be **absolute** (the tool runs in the host's server process,
    whose working directory is not yours) and **inside the workspace** — write
    the generated file there rather than to a system temp dir. It must be a real
    file, not a symlink.
  - The file must hold a **non-empty JSON array of objects**, at most 8 MiB.
  - One call writes at most **1000 rows** — over that it is refused whole,
    with nothing written, so split the file and call again.

  Everything else is identical: same per-row validation, same `mode`, same
  `{ written, rejected }` result.
- **Read / list — `getItems`.** The only way to see host-computed `derived` /
  `toggle` / `embed` values (the stored JSON never contains them). Pass `ids`
  / `fields` on large collections to keep the result small — e.g.
  `fields: ["id"]` to check for an id collision before an add.
- **Delete — `deleteItems`.** Pass `ids`; the result is `{ deleted, rejected }`.
  An id that doesn't exist lands in `rejected` rather than being counted as
  deleted, so a typo'd id can't be reported back to the user as done.
- **Aggregate — `queryItems`.** Counts, sums, averages, group-bys on ANY
  collection via a structured query (`groupBy` / `aggregates` / `where` /
  `orderBy` / `limit` — full shape in the "External data (CSV) collections"
  section below). On file-backed collections it aggregates the ENRICHED
  records, so computed fields (`derived` / `rollup` / `toggle`) are
  queryable columns — "sum of invoice totals" works even when `total` is a
  formula. Prefer it over doing arithmetic on `getItems` output.
- **Cross-collection questions — `getOntology`.** Returns every collection in
  the workspace with its `primaryKey`, effective `displayField`, record count,
  and its `ref` / `embed` / `backlinks` / `rollup` relations (field → related slug, including refs
  inside `table` columns as `lines.clientId`). When a question spans
  collections ("which clients have unpaid invoices AND unlogged hours?"),
  call it first to see which collections exist and how they join, then
  `getItems` only the ones involved — instead of reading every schema.json.
- **Id charset** (enforced by `safeRecordId` in
  `packages/core/src/collection/server/paths.ts` — the single source of
  truth; `manageCollection` rejects ids that fail it): start and end with a
  letter or digit; inside, also `-`, `_`, and `.` are allowed (so natural keys
  like a Slack ts `1718900000.123456` or a SemVer `1.2.3` work). **No** path
  separators, **no** leading/trailing dot, and **no** `..` substring. If your
  natural key contains anything else (a space, `/`, `:`, a leading dot), sanitise
  it first — e.g. replace each illegal run with `_`. Note `manageCollection`
  enforces this on every targeted read/write, so an id that only _looks_ fine in
  a full `getItems` listing but violates the rule can't be updated or deleted by
  id — fix the id, don't work around it with raw file I/O.
- **Never write `derived` fields**, and never write an `embed`, `backlinks`,
  or `rollup` field — all are display-only / host-computed (`putItems`
  rejects rows that carry them).
- Leave optional fields out of the row entirely rather than writing empty
  strings.
- For a `ref` field, write the raw target slug, and make sure that record
  actually exists in the target collection — an invalid slug renders as a broken
  link. The host enforces structure and safety; **you own semantic correctness**
  (valid refs, sane values).

### Raw file I/O on records — the escape hatch

Read / Write / Edit on the record files stays available (files are the source
of truth), but it skips `putItems`' pre-write validation — a mistake lands on
disk instead of coming back as a `rejected` row. Reach for it only when the
tool can't do the job: bulk file surgery, or repairing a file so malformed
that `manageCollection` can't address it. If you do write record files
directly:

- **The file MUST be valid JSON.** A malformed record is **silently skipped** at
  read time (logged server-side, but invisible in the UI) — so one bad file out
  of fifteen looks like "fourteen records vanished." The #1 cause is an
  **unescaped double-quote inside a string value**: writing `"title": "がんは"細胞のバグ""`
  closes the string early and corrupts the file. In free-text / prose fields
  (`text`, `markdown`, a long `objective`), either escape every inner ASCII quote
  as `\"`, or — better — use the language's own quotation marks (`「」`/`『』` for
  Japanese, `‘ ’`/`“ ”` or `'…'` for English) so no escaping is needed.
- `presentCollection` re-validates the records and reports any unreadable /
  malformed / schema-violating files back to you (a `⚠️` in its result) — so
  always follow a batch of direct writes with a `presentCollection` call and
  **act on any ⚠️ it returns**, rather than assuming every record landed.
  (This safety net applies after `putItems` batches too, but direct writes are
  where it earns its keep.)

## External data (CSV) collections — `dataSource`

When the user has a data file they want to "manage" / "visualize" / "見たい"
(a student roster, an HR export, a product list — the BI use case), do NOT
import the rows into record files. Define a collection **on top of** the file
with `dataSource` — the file stays the single source of truth and the whole
collection UI (table, kanban, calendar, custom views, remote views) works over
its rows via the host's DuckDB-backed CSV store.

**The schema-inference recipe** (user: "この CSV を管理したい" / "make this CSV a
collection"):

1. **Inspect the file** — Read the first ~30 lines. Note the header row
   (column names), each column's apparent type, and which column uniquely
   identifies a row.
2. **Pick the key column** — set `primaryKey` to that column's name and flag
   its field `primary: true`. Prefer an ID-ish column (student number, SKU,
   email) over a name. Check for duplicates if unsure — duplicated key values
   don't error, but the LAST row silently wins.
   **Declare the key field as `type: "string"` even when the column is
   numeric** (a row number, an integer ID): record ids are strings, and the
   store overwrites the key field's value with the id — a `number`-typed key
   would just hold a string anyway. Consequence to keep in mind: sorting by
   the key column is lexicographic ("10" before "2"); if numeric ordering
   matters to the user, sort by another column.
3. **Declare `fields` matching the column names** — field name = CSV column
   name, verbatim (Japanese column names are fine). Only declared fields
   render as table columns; extra CSV columns still ride along in the record
   detail. Use `number` / `date` / `enum` (when a column has a small closed
   value set) / `string` for the rest — DuckDB sniffs the raw types, the
   field spec controls rendering.
4. **Set `displayField`** to the most human-readable column (a name). This
   matters extra here: a key value that isn't a safe record id (Japanese
   text, spaces) is hex-encoded into the record's address, and
   `displayField` is what keeps lists and notifications readable.
5. **Write the schema** with `dataSource` instead of `dataPath`, plus a
<!-- authoring:staged -->
   normal `SKILL.md`, under `data/skills/<slug>/` — same create flow as any
<!-- /authoring:staged -->
<!-- authoring:direct -->
   normal `SKILL.md`, under `.claude/skills/<slug>/` — same create flow as any
<!-- /authoring:direct -->
   collection. In the SKILL body, point aggregation questions at
   `manageCollection` `queryItems` (see below) — NOT at python/pandas and
   NOT at `getItems`; SKILL.md text outlives help updates, so a wrong
   steer here misroutes every future session on this collection.

Semantics to remember (and to tell the user):

- **Read-only** — no Add/Edit/Delete in the UI, `putItems` refuses, HTTP
  writes answer 405. To change the data, **edit or replace the file itself**
  (you can do that with the normal file tools when asked); open views refresh
  automatically via a file watcher.
- **Encoding** — Shift_JIS / CP932 and UTF-16 files work as-is; the host
  decodes to a cache copy and never rewrites the user's file. Don't convert
  the file to UTF-8 "to be safe" — an Excel re-export would just undo it.
- **Row cap** — `getItems` / the UI list stops at 5,000 rows (a warn is
  logged). Fine for browsing — but NEVER compute an aggregate from
  `getItems` output on a large file (a capped scan gives a silently wrong
  number). Use `queryItems` instead.
- **Aggregation — `manageCollection` `queryItems`**: a structured query over
  the WHOLE file (uncapped scan, DuckDB underneath). Answer counts / sums /
  averages / group-bys with it — don't shell out to python/pandas for
  questions it covers. (It works on EVERY collection — see the Records
  section; this bullet is about the dataSource specifics.) Shape:

  ```json
  {
    "groupBy": ["Category"],
    "aggregates": { "total": { "op": "sum", "column": "Price" }, "n": { "op": "count" } },
    "where": [{ "field": "Availability", "op": "eq", "value": "in_stock" }],
    "orderBy": [{ "field": "total", "dir": "desc" }],
    "limit": 100
  }
  ```

  Ops: `count` (column optional) / `sum` / `avg` / `min` / `max`; `where`
  ops are the familiar `eq/ne/in/gt/gte/lt/lte/contains`; `orderBy` sorts
  by a groupBy column or an aggregate alias; result rows are clamped
  (default 1,000). At least one of `groupBy`/`aggregates` is required.
  `sum`/`avg` skip non-numeric cells. A custom view can run the same
  query shape via `POST <dataUrl>/query` with its read token — see
  `config/helps/custom-view.md` — which is how dataSource dashboards
  chart live data.
- **Not registry material** — dataSource collections can't be imported from
  or contributed to a registry (the data file is machine-local).

Minimal example (Japanese roster, Shift_JIS file dropped at
`data/students.csv`):

```json
{
  "title": "生徒名簿",
  "icon": "school",
  "dataSource": { "type": "csv", "path": "data/students.csv" },
  "primaryKey": "学籍番号",
  "displayField": "氏名",
  "fields": {
    "学籍番号": { "type": "string", "label": "学籍番号", "primary": true },
    "氏名": { "type": "string", "label": "氏名" },
    "学年": { "type": "enum", "label": "学年", "values": ["1", "2", "3"] },
    "入学日": { "type": "date", "label": "入学日" }
  }
}
```

## Alternative storage (sqlite) — `storage`

A collection can keep its records in a single SQLite database file instead of
per-record JSON files: declare `storage` instead of `dataPath`. Unlike
`dataSource` (read-only, user-owned file), a `storage` collection is a normal
WRITABLE collection — every UI, tool, custom view (desktop and remote), and
API surface works identically; only where the rows live changes. The db file
is collection-owned and managed by the host (`records` table, one JSON record
per row keyed by `primaryKey`).

When to use: only when the user explicitly asks for it, or a collection is
expected to grow far beyond what a folder of JSON files handles comfortably
(thousands of records). For everything else prefer `dataPath` — record files
are transparent, diffable, and every feature supports them.

Notes:

- Requires **Node.js >= 22.5** (built-in `node:sqlite`); on an older runtime
  only sqlite collections fail, with a clear error (see
  `config/helps/error-recovery.md`).
- The full write machinery works: `spawn`, `completionField` /
  `triggerField` bells, `singleton`, `ingest`, and mutate actions all go
  through the storage layer, and a watcher on the db file drives bell
  reconciliation + live view refreshes — including after EXTERNAL edits to
  the `.db`.
- The Repair pass validates records through the storage backend (schema
  violations are reported by record id); a row so corrupt the backend
  can't parse it is skipped silently, unlike a malformed record FILE.
- Deleting the collection archives the `.db` alongside the skill under
  `archive/…` and removes the live file.

Minimal example:

```json
{
  "title": "Order History",
  "icon": "receipt_long",
  "storage": { "type": "sqlite", "path": "data/orders.db" },
  "primaryKey": "id",
  "fields": {
    "id": { "type": "string", "label": "ID", "primary": true },
    "item": { "type": "string", "label": "Item" },
    "total": { "type": "number", "label": "Total" }
  }
}
```

## Shared storage (firestore) — `storage`

`{ "type": "firestore" }` keeps a collection's records in a SHARED app rather
than on this machine: they live at `apps/{aid}/collections/{cid}/items`, where
`aid` is the app id and `cid` is this collection's slug.

**Only declare this when the user asks for a shared collection.** It is not a
faster `dataPath` — the records are remote, every read is a round trip, and the
collection is unusable while remote-host is disconnected.

Notes:

- The `storage` block takes NOTHING else. No `path`, no `cid`, no `aid` —
  writing any of them is a validation error, not a dropped key. `aid` is one per
  APP and comes from `app.json` at the repository root; `cid` is always the slug.
- The repository must declare its app, or the collection is refused at discovery:

  `<repository root>/app.json`:

  ```json
  { "aid": "app_salon_7f3a" }
  ```

- Requires a connected remote-host session. Disconnected, every operation fails
  with an actionable message — it never reports an empty collection.
- Authorization is the app's member roster (keyed by email), not the path. A
  signed-in user who is not on the roster gets `permission-denied`.
- Live updates from OTHER members are not delivered yet; this host re-reads on
  its own clock. Bells (`completionField` / `triggerField`) and `spawn` work.
- Deleting the collection is REFUSED: its records are also other members', and
  the delete can neither archive nor remove them.

Minimal example:

```json
{
  "title": "Bookings",
  "icon": "event",
  "storage": { "type": "firestore" },
  "primaryKey": "id",
  "fields": {
    "id": { "type": "string", "label": "ID", "primary": true },
    "customerName": { "type": "string", "label": "Customer" },
    "startAt": { "type": "date", "label": "Start" }
  }
}
```

## End-to-end: creating a new collection skill

1. Pick a `<slug>` (lowercase-hyphen, no `mc-` prefix) and a `dataPath`
   (`data/<name>/items`).
<!-- authoring:staged -->
2. Write `data/skills/<slug>/schema.json` — `title`, `icon`, `dataPath`,
   `primaryKey` (with the matching field flagged `primary: true`), and the
   `fields` map in the order you want columns. Add `actions` +
   `data/skills/<slug>/templates/*.md` only if the collection needs delegated
   behaviour. (The bridge mirrors these into `.claude/skills/<slug>/`.)
3. Write `data/skills/<slug>/SKILL.md` — front-matter `name` + `description`,
   then the record-shape bullets and CRUD conventions.
4. Tell the user it's ready at `/collections/<slug>`. The bridge mirrors the
   files and triggers a re-scan, so the host discovers it without a restart and
   with no host code. If it doesn't appear: first confirm you wrote under
   `data/skills/<slug>/` (NOT `.claude/skills/…`, which is gated and won't
   mirror); then check your `schema.json` passed validation — primary key
<!-- /authoring:staged -->
<!-- authoring:direct -->
2. Write `.claude/skills/<slug>/schema.json` — `title`, `icon`, `dataPath`,
   `primaryKey` (with the matching field flagged `primary: true`), and the
   `fields` map in the order you want columns. Add `actions` +
   `.claude/skills/<slug>/templates/*.md` only if the collection needs delegated
   behaviour.
3. Write `.claude/skills/<slug>/SKILL.md` — front-matter `name` + `description`,
   then the record-shape bullets and CRUD conventions.
4. Tell the user it's ready at `/collections/<slug>`. The host re-scans, so it
   is discovered without a restart and with no host code. If it doesn't appear:
   first confirm you wrote under `.claude/skills/<slug>/` (NOT `data/skills/…`,
   which is never scanned here); then check your `schema.json` passed
   validation — primary key
<!-- /authoring:direct -->
   flagged `primary: true`, `ref`/`embed` have a valid `to`, `enum` has
   `values`, `table` has `of`, `derived` has `formula`, action ids unique,
   `dataPath` under the collection's root, `triggerField` names a real `date` field and
   has the completion pair, `spawn` has `triggerField` and a valid `every`,
   `calendarField` / `calendarEndField` name real `date`/`datetime` fields (and
   `calendarEndField` requires `calendarField`), `calendarTimeField` names a real
   field and requires `calendarField`, `kanbanField` names a real
   `enum` field, any `toggle` field names a real `enum` `field` with its
   `onValue` / `offValue` among that enum's `values`, and `notifyWhen` (if set)
   requires `completionField` and names a real field.
   (A schema that fails validation is logged server-side and silently skipped
   at discovery.)

## Editing an existing collection's schema

To change the structure of a collection that already exists (add a field,
rename a label, add a view or action), go through `manageCollection` rather than
hand-editing the file:

1. `manageCollection` `schemaDocs` — reload this reference for the field DSL
   (pass the section you need as `topic`, e.g. `topic: "kanban"`).
2. `manageCollection` `getSchema` (slug) — read the current `schema.json`
   verbatim. You don't need to know where the file lives.
3. Apply your change to that object, then `manageCollection` `putSchema`
   (slug, schema) — it validates the whole schema against the same rules
<!-- authoring:staged -->
   discovery enforces and either writes it (canonical `data/skills/<slug>/`,
   mirrored for you) or returns the exact field + problem to fix and retry.
<!-- /authoring:staged -->
<!-- authoring:direct -->
   discovery enforces and either writes it (`.claude/skills/<slug>/schema.json`,
   in place) or returns the exact field + problem to fix and retry.
<!-- /authoring:direct -->
4. Call `presentCollection` to show the updated collection.

Why not raw Read / Write / Edit on `schema.json`? A hand-edit that fails
validation is **silently skipped** at discovery — the collection disappears from
the UI with no error. `putSchema` catches the mistake before the write and hands
you an actionable message. (`putSchema` is edit-only and refuses user-scope and
`mc-*` preset collections; create a new collection with the Write flow above.)

## Worked reference: the billing suite

The billing collections are the canonical examples. They ship as **recipes**
(copy-paste schemas + SKILL bodies), not as boot-overwritten presets — read the
recipe when the user wants any of them, and copy the schema verbatim:

- **`config/helps/billing-clients-worklog.md`** (Bundle A):
  - **`clients`** — flat table (`string` / `email` / `text` / `markdown`). The
    simplest possible collection; everything else `ref`s into it.
  - **`worklog`** — adds a `ref` (`clientId → clients`), a `date`, a `number`, a
    `boolean`. A companion data source.
- **`config/helps/billing-invoice.md`** (Bundle B):
  - **`profile`** — one record per issuer identity (primary id `me`); each invoice
    picks one.
  - **`invoice`** — the full toolkit in one schema: a `ref` issuer (`issuerId →
profile`) embedded via an `idField` `embed`, a `ref` client (`clients`), a
    `table` of line items, three `derived` money fields, an `enum` status, and four
    `actions` (PDF always-on; sale / payment / void gated by `status` via `when`).
