# Custom collection views (LLM-authored HTML)

A **custom view** is an HTML file you write that renders a collection's records
however the user wants — a year-at-a-glance planner, a Gantt bar, a heat-map,
a printable report. The host renders it in a sandboxed iframe over the
collection's data. The user asks for it in plain language ("give me a view that
shows my whole year"); you author the HTML and register it.

Read `config/helps/collection-skills.md` first for the collection/schema DSL.
This file is only about the **desktop view** layer. For a view that runs on the
**phone remote app** (`target: "mobile"` in the `views[]` entry), read
`config/helps/custom-view-remote.md` instead — its runtime contract is
different and incompatible (no token, no dataUrl, no fetch).

## Where the files go

```text
data/skills/<slug>/
  schema.json          ← register the view here, under `views[]`
  views/
    <name>.html        ← the view you author (Write/Edit)
```

**Feed collections** keep their skill files under `feeds/<slug>/` instead of
`data/skills/<slug>/`, so author a feed's view at `feeds/<slug>/views/<name>.html`
and register it in `feeds/<slug>/schema.json`. Everything else below — the
`views[]` entry shape, the runtime contract, the sandbox rules — is identical.

The HTML lives under `views/` and must end in `.html`. Register each view in
the collection's `schema.json`:

```jsonc
{
  "title": "Annual Plan",
  "icon": "calendar_month",
  "dataPath": "data/annual-plan/items",
  "primaryKey": "id",
  "fields": {/* … */},
  "views": [
    { "id": "year", "label": "Year", "icon": "grid_view", "file": "views/year.html", "capabilities": ["read"] },
    { "id": "planner", "label": "Planner", "icon": "edit_calendar", "file": "views/planner.html", "capabilities": ["read", "write"] },
  ],
}
```

- **`id`** — a slug (letters/digits/`-`/`_`). The selector shows one button per view.
- **`label`** — the button text (author it; it is not run through translation).
- **`icon`** — optional Material Symbols icon name.
- **`file`** — `views/<name>.html`, path-safe.
- **`capabilities`** — least privilege. `["read"]` (default) for a view that
  only displays data; `["read","write"]` only if the view edits records.

After you Write the HTML and register it, the view's button appears in the
collection's view-mode selector automatically.

## The runtime contract — `window.__MC_VIEW`

The host injects a bootstrap at the very start of your `<head>`, so it runs
**before any script in your `<head>` or `<body>`** — write your view normally
and `window.__MC_VIEW` is always there. (A `<script>` placed _before_ `<head>`
would run ahead of it and see no `__MC_VIEW`; there is no reason to write one.)

```js
window.__MC_VIEW = {
  slug: "annual-plan", // this collection
  token: "<scoped capability token>", // Authorization bearer
  dataUrl: "http://127.0.0.1:<port>/api/collections/annual-plan/view-data", // absolute, filled in by the host
  onChange: (cb) => unsubscribe, // live refresh — see "Staying live" below
  searchQuery: "", // live text in the app's own search box — see "One search box"
  onSearchQueryChange: (cb) => unsubscribe, // fires when the user types there
  openItem: (id, mode) => void, // open a record in the host's panel — see "Opening a record"
  startChat: (prompt, role) => void, // draft a new chat for the user — see "Starting a chat"
};
```

> **`dataUrl` is a bare base URL, and stays one.** Every endpoint below is
> built by concatenating onto it — `dataUrl + "?fields=…"`, `+ "/query"`,
> `+ "/actions/<id>"`, `+ "/image?path=…"`. It therefore carries no query
> string of its own. (Host note: a host that appends its own parameter here —
> to identify a project, say — corrupts every one of those calls. Scope belongs
> in the token, which is where the host puts it.)

### Reading records

> **Always project `fields`.** The host refuses any read of more than 200
> records that does not pass `?fields=…` or `?ids=…`, because an unscoped
> fetch wastes work and bandwidth on columns your view never reads. Once a
> user's collection grows past the threshold an unprojected view starts
> returning `400` instead of records — write the projection from day one so
> the same view keeps working forever.

```js
const { token, dataUrl } = window.__MC_VIEW;
// List the columns this view actually reads — never send `dataUrl` raw.
const url = dataUrl + "?fields=" + encodeURIComponent("title,start,end,status");
const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
if (!res.ok) {
  // Surface the server's reason (the 400 carries `{ error: "<message>" }`),
  // not just the status code — that text is what tells the user / Claude
  // how to fix the call (e.g. "pass `fields` to project only the columns").
  const detail = await res.text();
  throw new Error("load failed (" + res.status + "): " + detail);
}
const { items } = await res.json(); // { collection, count, items: [...] }
```

Records come back **with computed fields already resolved** (derived formulas,
toggles, embeds) — the same numbers the user sees elsewhere.

- **`?fields=a,b,c`** — only these columns per record (the primary key is always
  included). Use this on every read; it is mandatory above 200 records.
- **`?ids=x,y,z`** — only these specific record ids. Use it when the view edits
  / shows one record at a time. Combinable with `fields`.
- The primary key is always returned regardless of `fields`.

### Aggregation queries (`read` capability)

A view can run structured aggregations over the collection — on a
`dataSource` (CSV) collection this scans the WHOLE file (the record read
above is row-capped at 5,000 there, so an aggregate computed from it would
be silently wrong); on any other collection (file-backed or sqlite
`storage`) it aggregates the ENRICHED records, so computed fields
(`derived` / `rollup` / `toggle`) are queryable columns:

```js
const res = await fetch(dataUrl + "/query", {
  method: "POST",
  headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  body: JSON.stringify({
    query: {
      groupBy: ["Category"],
      aggregates: { total: { op: "sum", column: "Price" }, n: { op: "count" } },
      where: [{ field: "Availability", op: "eq", value: "in_stock" }],
      orderBy: [{ field: "total", dir: "desc" }],
      limit: 100,
    },
  }),
});
const { rows } = await res.json(); // [{ Category, total, n }, ...] — chart these
```

- Ops: `count` (column optional) / `sum` / `avg` / `min` / `max`; `where`
  ops: `eq/ne/in/gt/gte/lt/lte/contains`; at least one of
  `groupBy`/`aggregates`; `orderBy` sorts by a groupBy column or an
  aggregate alias; result rows clamp at 1,000 by default.
- Aggregate aliases (the keys of `aggregates`) must be simple ASCII
  identifiers (`/^[A-Za-z_]\w{0,63}$/`) — non-ASCII keys (e.g. Japanese)
  are rejected by validation. This applies **only to aliases**: column
  references (`column`, `groupBy`, `where.field`) accept the source's
  headers as-is, including non-ASCII CSV headers like `価格`.
- Structured JSON only — there is **no SQL surface**, by design.
- Combine with `onChange` (below) to stay live: in the callback, re-run
  **this POST query** (wrap it in your own `refresh()` and register that)
  — NOT the `?fields=` record read from the section above, which would
  silently repaint an aggregation view with non-aggregated data. A
  replaced CSV or edited records then redraw the chart — that's a live
  dashboard.

### Writing records (only with the `write` capability)

```js
const res = await fetch(dataUrl, {
  method: "PUT",
  headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  body: JSON.stringify({ items: [{ id: "task-3", start: "2026-07-01" }], mode: "merge" }),
});
const { written, rejected } = await res.json(); // fix & re-send any rejected rows
```

- `mode`: `"merge"` (update only the fields you send — use this for edits),
  `"upsert"` (replace the whole record), `"create"` (fail if the id exists).
- Each row must carry the collection's `primaryKey`.
- **Never** send computed fields (`derived` / `toggle` / `embed`) — they are
  rejected. Write the underlying enum for a toggle.
- **There is no delete** from a view. A view can never do more than the agent's
  own data tools.

Surface any `rejected` rows to the user with their `problem` text — don't fail
silently.

### Invoking a `kind: "mutate"` action (only with the `write` capability)

If the schema declares a `kind: "mutate"` action (a declarative state
transition — e.g. an `assign` button with `require`/`params`/`set`), invoke it
instead of re-encoding the same field writes as a PUT: the server re-checks the
action's `require` gate, validates the `params`, and applies the `set`
atomically — one source of truth for the transition, in the schema.

```js
const res = await fetch(dataUrl + "/actions/assign", {
  method: "POST",
  headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  body: JSON.stringify({ itemId: "task-3", params: { assignee: "kai" } }),
});
if (res.ok) {
  const { item } = await res.json(); // the written record
} else {
  const { error } = await res.json(); // 400 bad param / 409 require not met — show it
}
```

- `itemId` is the record's primary-key value; `params` only if the action
  declares them.
- **Mutate kind only.** `chat` / `agent` actions can never be invoked with a
  view token (they start LLM work) — you get a 403.
- A 409 means the record's current state fails the action's `require` — treat
  it as "button disabled", not an error to retry.

### Displaying images — `GET <dataUrl>/image`

An `image`-type field stores a path relative to the collection's own root — the
workspace or project folder it lives in (`data/attachments/…`,
`data/<name>/logos/…`) that a sandboxed view cannot load directly — the
iframe has an opaque origin and `<img>` can't attach the bearer token. To
render one, ask the host to resolve it into a downscaled thumbnail:

```js
// Request the image field in your projection so you have its path,
// then resolve each path into a data: URL and assign it to the <img>.
const res = await fetch(dataUrl + "/image?path=" + encodeURIComponent(item.photo) + "&maxEdge=256", {
  headers: { Authorization: "Bearer " + token },
});
if (res.ok) {
  const { dataUrl: src } = await res.json();
  img.src = src; // "data:image/jpeg;base64,…"
} // non-ok: leave the placeholder — 404 = not an image-field value / unresolvable
```

**Never fire one fetch per image in parallel** (`Promise.all` over every
record) — the host caps in-flight `/image` + `/query` requests at **4 per
collection** and answers the rest **429**, so a first paint of a dozen
images half-fails. Resolve through a small worker pool instead:

```js
// Throttled resolver: N paths, at most 3 in flight, one retry on 429.
async function resolveImages(paths, onResolved, workers = 3) {
  const queue = [...paths];
  const work = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      let res = await fetch(dataUrl + "/image?path=" + encodeURIComponent(path) + "&maxEdge=256", {
        headers: { Authorization: "Bearer " + token },
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 500));
        res = await fetch(dataUrl + "/image?path=" + encodeURIComponent(path) + "&maxEdge=256", {
          headers: { Authorization: "Bearer " + token },
        });
      }
      if (res.ok) onResolved(path, (await res.json()).dataUrl);
    }
  };
  await Promise.all(Array.from({ length: workers }, work));
}
```

- **Only current image-field values resolve.** The host checks `path`
  against the collection's records: it must be the CURRENT value of a
  schema `image`-type field — the token cannot read arbitrary workspace
  files. A stale or hand-built path answers 404.
- `maxEdge` clamps to 64–1024 (default 512) — request the size you render.
- **429 = concurrency/rate limit, not a bad path.** Both a shared in-flight
  cap (4 per collection, shared with `/query`) and a per-minute budget guard
  this endpoint; a 429'd path resolves fine on retry — never mark it failed
  without one.
- Cache the resolved `data:` URLs per path in your view (a simple `Map`)
  and re-resolve inside your `onChange` callback only for paths you haven't
  seen — each request re-scans the records server-side.
- A record field holding a public **`https:` URL needs none of this** —
  `<img src>` may load any https host directly (see the sandbox rules).
- **Do NOT base64-embed images into the view HTML itself.** It bloats the
  file, goes stale the moment a record's image changes, and needs manual
  regeneration — this endpoint (or an https URL field) is always the
  better answer.

### Staying live — `onChange`

By default a view paints once, on load. To keep it fresh, register a callback —
it runs whenever the collection's data changes on the server:

```js
// Same projection rule as the initial read — list the columns this view uses.
const url = dataUrl + "?fields=" + encodeURIComponent("title,start,end,status");
async function render() {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) return; // surface the body if you want a richer error UI
  const { items } = await res.json();
  // …draw items…
}
render(); // initial paint
window.__MC_VIEW.onChange(render); // live refresh on every server-side change
```

What you need to know:

- **It fires for every writer** — the assistant adding/editing a record in chat,
  an edit from another browser tab, a feed refresh, and auto-generated recurring
  records. Your view stays in sync no matter who changed the data.
- **Make the callback a full re-fetch + re-render** (like `render` above). It is
  a "something changed, reload" signal — it carries no record data — and one
  callback may stand in for several rapid changes.
- **It is already debounced** (a burst of changes collapses to one call) — do
  **not** add your own throttle.
- **No extra capability needed** — a read-only view can use `onChange`.
- It returns an **unsubscribe** function; you rarely need it (the view is torn
  down with the iframe), but it's there for fine-grained control.

### One search box — `searchQuery` / `onSearchQueryChange`

The app's **standard search box stays on screen while your view renders**, so
the user expects it to drive your view too. It does: the host relays what they
type into the sandboxed frame.

**Do not build a second search box.** Read the host's, and you get the
behaviour the user already assumes.

```js
const v = window.__MC_VIEW;

function render() {
  const q = v.searchQuery.trim().toLowerCase();
  const hits = q ? records.filter((r) => matches(r, q)) : records;
  // …draw hits, highlight where each one matched…
}

v.onSearchQueryChange(render); // the user typed in the app's search box
v.onChange(reload); // the data changed (a separate wire — see above)
render();
```

What you need to know:

- **`searchQuery` is always current.** It updates the instant the user types, so
  reading it inside your own render (as above) is never a keystroke behind.
- **The callback is debounced** — it runs once typing pauses (~150 ms), not
  once per keystroke — and receives the query as its argument
  (`onSearchQueryChange((q) => …)`), so you can use either source.
- **An empty string means the box is empty** — show everything, don't show
  nothing. It fires on clearing too.
- **It is scoped to this collection and this session.** Switching collections
  clears the box; nothing is persisted.
- **Navigating your frame away ends it.** The query arrives on a private
  channel bound to the document the host built, so a page your view navigates
  to gets no further queries — deliberately, since the text is the user's own.
  If that page asks the host for the channel, the host reinstalls your view
  over it rather than handing it over. Open outbound links with
  `target="_blank"` (see the sandbox rules) and your view keeps running.
- **Reloading your own view is fine.** `location.reload()` makes the host
  reinstall the view and hand it a fresh channel, seeded with whatever is in
  the search box — so the query you see after a reload is the current one, not
  an empty string.
- **Replacing the document is allowed a few times, not endlessly.** Each
  reinstall — after a reload or after another page claims the channel — costs
  the host a rebuild, so it grants **at most 3** between one user-initiated
  view change and the next (switching view or collection resets the budget).
  Past that your view still renders and still reads its data; only the search
  channel stays disconnected, and `searchQuery` stops updating. Use `onChange`
  to refresh rather than reloading the frame, and you will never reach it.
- **One direction only.** You read the user's query; you cannot write the app's
  search box from view code. If your view needs a filter the box can't express
  (a date range, a facet), add that control yourself and combine it with
  `searchQuery`.
- **No extra capability needed**, and it is **not** a data reload: it never
  fires `onChange`, and `onChange` never fires this.

This is what makes a "search" view worth writing — the built-in box only
filters table rows, so a view that shows **which field matched**, with a
highlighted snippet, is a real upgrade the user drives from the box they were
already using.

### Opening a record — `openItem`

Your view owns the _layout_ (a grid, a chart, a board); it doesn't have to
rebuild a form to view or edit one record. Call `openItem` to hand a record to
the host's own panel — the same detail/edit modal the user gets clicking a row
in the table view — centred over your view:

```js
window.__MC_VIEW.openItem("task-3"); // read-only detail (default)
window.__MC_VIEW.openItem("task-3", "edit"); // jump straight into the editor
```

- **`id`** — the record's `primaryKey` value. If it isn't a loaded record,
  nothing happens (fire-and-forget; returns nothing).
- **`mode`** — `"view"` (default) opens read-only detail with the panel's own
  Edit button; `"edit"` opens the editor directly.
- **No `write` capability required — even for `"edit"`.** Opening the host's
  panel is a _user_ action in the host's trusted UI: the user still has to press
  Save, and the write goes through the host, not your scoped token. So a
  `["read"]` view can offer a full "edit this record" affordance without
  widening its own capabilities. (Capabilities gate what your view's _code_ may
  do to the data; they don't restrict what the user may do through the host.)
- **Pair it with `onChange`.** After the user saves in the panel, your
  `onChange` callback fires (the data changed), so a live view repaints itself —
  no extra wiring needed.

This is the right tool whenever a record's full detail is richer than your
view's summary, or whenever the user wants to edit but you don't want a
`write`-capable view doing its own PUTs.

### Starting a chat — `startChat`

Your view can't reach external services or run a skill on its own (the sandbox
blocks it). Instead, hand the work to a chat: `startChat` opens a **new chat
session with your prompt prefilled in the composer** — as an editable draft. It
does **not** send. The user reads it, edits if they want, and presses Send (or
clears it). The agent in that approved chat does the real work — file a GitHub
issue and write the URL back, fetch a link's title/image and save them, or just
start from a task record.

```js
const task = items.find((r) => r.id === id);
window.__MC_VIEW.startChat(`Create a GitHub issue for this task and write the URL back to record ${id}:\n\n` + `Title: ${task.title}\n${task.body}`);
```

- **`prompt`** — the seed text. Empty / whitespace-only is ignored (no empty
  chat). Build it from your records — that's the whole point.
- **`role`** _(optional second argument)_ — a built-in role id to preselect for
  the new session (e.g. `"office"`, `"investor"`); validated by the host. Omit it
  and the chat opens in **General** — which is what you usually want.
- **No capability required.** Your view's code only _proposes text into an input
  field_ — nothing is created, fetched, or written until the **user** presses
  Send, at which point it's an ordinary agent run they authored. So a `["read"]`
  view can offer "start work on this" buttons freely.
- **Pair it with `onChange`.** When the chat's agent later writes back to a
  record, your `onChange` callback fires and a live view repaints.

Use this — not a hidden flag the user has to reconcile later — whenever a button
should _start backend work_: the user stays in the loop through trusted first-
party UI, and the action runs as a normal, visible, cancellable agent turn.

## Sandbox rules (what the view may and may not do)

The view runs in a `sandbox="allow-scripts"` iframe with a strict CSP:

- **Inline `<script>` and `<style>` only.** External scripts/styles/fonts must
  come from the allowed CDNs: `cdn.jsdelivr.net`, `unpkg.com`,
  `cdnjs.cloudflare.com`, `fonts.googleapis.com`, `fonts.gstatic.com`,
  `cdn.plot.ly` — so charting libraries (Chart.js, Plotly, D3) load fine from
  those CDNs. No other external hosts.
- **`<img>` may load from any `https:` host** (plus `data:` / `blob:`), so an
  image URL stored in a record — a feed's article thumbnail, a poster, an
  avatar — renders directly. (Images are the one resource type not pinned to the
  CDN allowlist; everything else above still is.)
- **`<audio>` / `<video>` may load from any `https:` host** (plus the origin and
  `data:` / `blob:`), so a record's media URL — a podcast feed's `.mp3`, a
  video enclosure — plays directly.
- **`fetch` (and XHR / WebSocket / `sendBeacon`) is allowed ONLY to
  `window.__MC_VIEW.dataUrl`'s origin.** All other origins are blocked — no
  phone-home, no third-party analytics, no fetching weather / prices / etc.
  directly from the view. If the user needs external data, put it in a (feed)
  collection and read it through `dataUrl`. (This is the channel that actually
  matters for keeping the scoped token and records from leaking off-box.) When a
  button should _do_ outside work — file an issue, fetch a link's metadata, run a
  skill — don't try to reach out from view code; use **`startChat`** (above) to
  hand the task to a user-approved chat.
- No access to cookies, `localStorage`, or the parent page — the iframe has an
  opaque origin. The token is the only credential, and it is scoped to this one
  collection.
- **Opening external links is allowed** — use `<a href="…" target="_blank"
rel="noopener">` (or `window.open(url, "_blank")`) to open a record's URL in a
  new browser tab, e.g. a feed card linking to its article. The link opens as a
  normal tab. (A plain same-tab `<a href>` would try to navigate the sandboxed
  frame itself and is blocked, so always use `target="_blank"` for outbound
  links.)
- Build a full HTML document with a `<head>` (the host injects its bootstrap at
  the start of `<head>`).

## Editing / iterating

To change a view later, just Read and Edit its `views/<name>.html` file under the
collection's skill dir (`data/skills/<slug>/` — or `feeds/<slug>/` for a feed);
its path is in the schema's `views[]`. To remove one, delete the file and its
`views[]` entry — or use the collection's settings gear (the per-collection
config modal) in the UI, which does both for you.

---

## Example 1 — Year overview (read-only)

A 12-month grid that plots each record on its start month. Schema has `date`
fields `start` / `end` and a `title`. `capabilities: ["read"]`.

`data/skills/annual-plan/views/year.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        font-family: system-ui, sans-serif;
        margin: 0;
        padding: 16px;
        color: #1e293b;
      }
      h1 {
        font-size: 16px;
        margin: 0 0 12px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
      }
      .month {
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 8px;
        min-height: 90px;
      }
      .month h2 {
        font-size: 12px;
        color: #64748b;
        margin: 0 0 6px;
      }
      .chip {
        font-size: 12px;
        background: #eef2ff;
        color: #3730a3;
        border-radius: 4px;
        padding: 2px 6px;
        margin-bottom: 4px;
        cursor: pointer;
      }
      .err {
        color: #b91c1c;
      }
    </style>
  </head>
  <body>
    <h1>Year overview</h1>
    <div id="root">Loading…</div>
    <script>
      const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      async function main() {
        const { token, dataUrl } = window.__MC_VIEW;
        const url = dataUrl + "?fields=" + encodeURIComponent("title,start");
        const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
        if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()));
        const { items } = await res.json();
        const buckets = MONTHS.map(() => []);
        for (const it of items) {
          const m = it.start ? new Date(it.start).getMonth() : -1;
          if (m >= 0 && m < 12) buckets[m].push(it); // keep the item, not just its title — we need the id
        }
        const root = document.getElementById("root");
        root.className = "grid";
        root.innerHTML = MONTHS.map(
          (name, i) =>
            '<div class="month"><h2>' +
            name +
            "</h2>" +
            buckets[i].map((it) => '<div class="chip" data-id="' + it.id + '">' + (it.title || it.id) + "</div>").join("") +
            "</div>",
        ).join("");
        // Click a chip → open that record in the host's panel (read-only detail;
        // the panel's own Edit button takes it from there). Pass "edit" to jump
        // straight into the editor — no `write` capability needed.
        root.onclick = (e) => {
          const chip = e.target.closest(".chip");
          if (chip) window.__MC_VIEW.openItem(chip.dataset.id);
        };
      }
      main().catch((e) => {
        document.getElementById("root").innerHTML = '<span class="err">Could not load: ' + e.message + "</span>";
      });
      // Live refresh: re-run whenever the collection's data changes server-side.
      window.__MC_VIEW.onChange(() => main().catch(() => {}));
    </script>
  </body>
</html>
```

## Example 2 — Weekly planner (read + write)

Seven day columns; clicking a record bumps its `start` date forward a day and
writes it back. `capabilities: ["read","write"]`.

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        font-family: system-ui, sans-serif;
        margin: 0;
        padding: 16px;
      }
      .row {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 6px;
      }
      .day {
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 6px;
        min-height: 80px;
      }
      .task {
        font-size: 12px;
        background: #f1f5f9;
        border-radius: 4px;
        padding: 3px 6px;
        margin-bottom: 4px;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <div id="root">Loading…</div>
    <script>
      const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const { token, dataUrl } = window.__MC_VIEW;
      const auth = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
      const readUrl = dataUrl + "?fields=" + encodeURIComponent("title,start");

      async function read() {
        const res = await fetch(readUrl, { headers: { Authorization: "Bearer " + token } });
        if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()));
        return (await res.json()).items;
      }
      async function bump(item) {
        const next = new Date(item.start || Date.now());
        next.setDate(next.getDate() + 1);
        const res = await fetch(dataUrl, {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({ items: [{ id: item.id, start: next.toISOString().slice(0, 10) }], mode: "merge" }),
        });
        const { rejected } = await res.json();
        if (rejected && rejected.length) alert(rejected[0].problem);
        render();
      }
      async function render() {
        const items = await read();
        const cols = DAYS.map(() => []);
        for (const it of items) {
          const d = it.start ? (new Date(it.start).getDay() + 6) % 7 : 0;
          cols[d].push(it);
        }
        const root = document.getElementById("root");
        root.className = "row";
        root.innerHTML = DAYS.map((d, i) => '<div class="day" data-i="' + i + '"><b>' + d + "</b></div>").join("");
        DAYS.forEach((_, i) => {
          const cell = root.querySelector('[data-i="' + i + '"]');
          for (const it of cols[i]) {
            const el = document.createElement("div");
            el.className = "task";
            el.textContent = it.title || it.id;
            el.onclick = () => bump(it);
            cell.appendChild(el);
          }
        });
      }
      render().catch((e) => {
        document.getElementById("root").textContent = "Could not load: " + e.message;
      });
      // Live refresh: re-render on any server-side change (incl. our own writes
      // landing, and edits from the assistant or another tab).
      window.__MC_VIEW.onChange(() => render().catch(() => {}));
    </script>
  </body>
</html>
```
