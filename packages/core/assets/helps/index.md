# About MulmoClaude

MulmoClaude is a GUI front-end for Claude Code. It lets you talk to Claude Code through a chat interface with rich visual output, powered by the **GUI Chat Protocol** — a plugin layer that allows Claude to render structured results (documents, spreadsheets, mind maps, images, and more) directly in the canvas alongside the conversation.

Under the hood it uses the Claude Code Agent SDK as its LLM core. Claude has full access to your workspace files and can use built-in tools (read, write, bash, search) as well as GUI Chat Protocol plugins registered as MCP servers.

**Core philosophy**: The workspace is the database. Files are the source of truth. Claude is the intelligent interface.

## Roles

- **General** — Everyday assistant: task management, scheduling, wiki, mind maps, and general Q&A.
- **Office** — Creates documents, spreadsheets, presentations, and MulmoScript slideshows.
- **Guide & Planner** — Collects your needs via a form, then produces a rich illustrated guide or plan. Works for recipes, travel itineraries, fitness programs, event planning, study guides, DIY projects, and more.
- **Artist** — Generates and edits images, opens a drawing canvas, and creates 3D scenes.
- **Tutor** — Assesses your knowledge level, then teaches any topic with structured documents and visuals.
- **Storyteller** — Crafts illustrated narrative stories as a MulmoScript storyboard.
- **Storyteller Plus** — Like Storyteller, with consistent character images across beats.
- **Settings** — Manages information sources, skills, and scheduled automations for the workspace.
- _(Additional roles may be defined by the user in the workspace.)_

## Key Capabilities

- Build **collections** — schema-driven data apps (todo lists, trackers, ledgers, decks) with table / calendar / kanban / dashboard views, plus LLM-authored **custom views**; manage a calendar scheduler
- Present documents and spreadsheets with rich formatting
- Generate and edit images
- Create interactive mind maps
- Generate and edit HTML pages / 3D scenes
- Present MulmoScript multimedia stories
- Manage a personal knowledge wiki
- Switch between roles mid-conversation
- Ask clarifying questions via interactive forms
- Play browser games

## Collections — Apps from Data

Collections are MulmoClaude's most distinctive capability: a **schema-driven data app declared in a single small JSON file**, with no database, ORM, or migration tool. You describe a data model, cross-record relations, computed fields, and per-record action buttons in a `schema.json`; the host reads that DSL and renders a full app — table, calendar, kanban board, and dashboard views — over a folder of plain `<id>.json` records. The same primitives power todo lists, recipe boxes, stock portfolios, invoice ledgers, vocabulary decks, and curricula, all without any app-specific host code. This is the core philosophy made concrete: a `schema.json` plus a folder of records **is** the app.

Because Claude authors and edits the schema for you in conversation, you build and reshape these apps just by talking — "add a priority field," "track this as a kanban," "make rent recur monthly" — and the collection updates live. We call this **vibe crafting**: the end-user counterpart of a developer's "vibe coding" — you describe the app you want and Claude builds it, with the schema validated and custom views sandboxed so you get the power without the pitfalls. Records stay validated, computed fields (totals, cross-collection lookups) recompute on every render, and completion bells / recurring obligations are declared in the same schema.

See [Collection skills](config/helps/collection-skills.md) for the full schema DSL.

## Custom Views — Views the Built-ins Don't Cover

When the built-in table / calendar / kanban / dashboard views don't fit what you want to _see_ — a year-at-a-glance planner, a Gantt bar, a heat-map, a printable report — Claude authors a **custom view**: a single HTML file rendered in a sandboxed iframe over the collection's records. It reads (and optionally writes) records through a scoped token, stays live as the data changes, and can hand work back to a chat — all without any view-specific host code. The view is data, just like the rest of the collection, so you can ask for an entirely new way to look at your data in plain language and get it.

See [Custom views](config/helps/custom-view.md) for the authoring contract. A
view can also target the **mobile remote app** (`target: "mobile"`) — rendered
on the user's phone and previewed on the desktop in a phone-sized frame; that
variant has a different, incompatible runtime contract described in
[Remote custom views](config/helps/custom-view-remote.md).

## Wiki — Long-Term Memory

The wiki (`wiki/` in the workspace) acts as Claude's long-term memory. Unlike the conversation history which resets each session, the wiki is a persistent, compounding knowledge base that Claude builds and maintains over time. You feed it sources — articles, URLs, notes — and Claude ingests them into structured, interlinked Markdown pages. The more you add, the smarter it gets.

See [Wiki](config/helps/wiki.md) for details on how it works.

## Help Pages

- [Wiki](config/helps/wiki.md) — how the personal knowledge wiki works, its folder layout, page format, and operations
- [Gemini API Key](config/helps/gemini.md) — why `GEMINI_API_KEY` is strongly recommended (images, audio, video) and how to get one from Google AI Studio
- [MulmoScript](config/helps/mulmoscript.md) — format reference for authoring multimedia stories: beats, image types, speech, audio, and a minimal example
- [Business Presentation Template](config/helps/business.md) — MulmoScript template and rules for business presentations in the Office role
- [Presentation Deck](config/helps/presentation-deck.md) — authoring business decks two ways: structured `slide` layouts (title/stats/table/timeline/…) or animated `html_tailwind` + `animation: true`, with full worked samples
- [Storyteller Template](config/helps/storyteller.md) — MulmoScript template and rules for character-driven narrated stories in the Storyteller role
- [Guide & Planner Templates](config/helps/guide.md) — document structures and form-field hints per guide type for the Guide & Planner role
- [Spreadsheet](config/helps/spreadsheet.md) — cell format, formulas, date handling, and format codes for the presentSpreadsheet plugin
- [presentHtml](config/helps/presenthtml.md) — self-contained HTML rules and the three-`../` relative-path convention used by the presentHtml plugin to keep generated files portable under `file://`
- [Sandbox](config/helps/sandbox.md) — how the Docker sandbox isolates the agent, what it can access, and how to disable it
- [Error recovery](config/helps/error-recovery.md) — the lookup the agent reads on tool failures (sandbox gh/git/SSH, Marp PDF, registry import, build/workspace, plugin runtime, a bridge gone quiet), plus the triage for a “broken” report
- [Bug-report FAQ](config/helps/bug-report-faq.md) — symptoms that turn out to be configuration or by design (voice input, push, chat titles, journal, connector tools, preset skills, custom views); says where to read the live value, never what it is
- [Telegram Bridge](config/helps/telegram.md) — how to talk to MulmoClaude from the Telegram app: creating a bot, starting the bridge, allowlisting chat IDs, commands, and troubleshooting
- [Remote host](config/helps/remote-host.md) — drive MulmoClaude from a phone at mulmoserver.web.app: Google sign-in connect, host online vs. offline (queued chats, 7-day expiry), photo attachments, and the security model
- [Feeds](config/helps/feeds.md) — register a self-refreshing data feed (RSS/Atom/JSON) by authoring `feeds/<slug>/schema.json`: schema shape, the `ingest` block, raw-item field mapping, and `maxItems` retention
- [Google Calendar sync](config/helps/google-calendar-collection.md) — mirror a Google calendar into a collection with a `googleCalendar` block: field mapping, why the primary field holds the event id, and how deletions propagate
- [The `google` tool](config/helps/google.md) — every `kind` for Calendar, Tasks and Drive: reading, creating, editing and deleting events and tasks, the timezone-offset rule, patch semantics, and what `drive.file` scope cannot see
- [GitHub repositories in the workspace](config/helps/github.md) — clone-destination rules under `github/<name>/` and how to handle existing directories with matching or different remotes
- [Collection skills](config/helps/collection-skills.md) — build a data app (model + UI + relations + computed fields + action buttons) by authoring a `schema.json` collection skill: the DSL, field types, derived formulas, actions, records
- [Custom views](config/helps/custom-view.md) — give a collection a view the built-ins don't cover (year/quarter overview, Gantt): an HTML file under `views/`, registered in `schema.json`, rendered in a sandboxed iframe over the records
- [Remote custom views](config/helps/custom-view-remote.md) — author a collection view for the **phone remote app** (`target: "mobile"` in `views[]`): records via the `getItems` bridge (no token, no fetch), mobile-first layout rules, phone-frame preview
- [Todo list collection](config/helps/todo-collection.md) — the canonical recipe for building or migrating a todo / task list: full schema (status enum + `done` toggle + priority bells), `SKILL.md`, and legacy `todo-plugin` migration steps
- [Vocabulary collection](config/helps/vocabulary.md) — recipe for a language-learning word deck (any language): `proficiency` enum + `mastered` toggle + `meaning`/`example` fields, a kanban for drag-to-promote review, and bulk-add / quiz workflows
- [Lessons collection](config/helps/lessons-collection.md) — recipe for a multi-session **curriculum** (any topic): one lesson per record, a `status` kanban, a `file` link to each lesson's HTML, and per-lesson + course-level **Learn** actions run by the Tutor
- [Clients + Worklog](config/helps/billing-clients-worklog.md) — recipe for a client database and a per-client timesheet (Bundle A of the billing suite); set this up before invoicing
- [Invoicing](config/helps/billing-invoice.md) — recipe for an invoice ledger + business profile with line items, host-computed totals, and PDF / bookkeeping action buttons (Bundle B; references the clients + worklog from Bundle A)
- [Portfolio tracker](config/helps/portfolio-tracker.md) — recipe for a paired stock-quotes watchlist + holdings portfolio whose price/value are computed live from the quotes via a cross-collection derived ref
- [Egress sync](config/helps/egress-sync.md) — push a collection's records OUT to an external system (Notion, Sheets, a REST API): snapshot-diff pattern for an agent "Sync" action, `externalId` write-back, reference template

## Workspace Layout

```
~/mulmoclaude/
  chat/          ← session tool results (.jsonl per session)
  todos/         ← todo items
  calendar/      ← calendar events
  contacts/      ← address book
  wiki/          ← personal knowledge wiki (long-term memory)
  config/helps/  ← help pages (synced from app on every start)
  memory.md      ← distilled facts loaded into every session
```
