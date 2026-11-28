# @mulmoclaude/collection-plugin

The **Collections** plugin (`presentCollection`) for **MulmoClaude** and
**MulmoTerminal** — the Vue surfaces for schema-driven data apps: the chat
View / Preview, page embeds, table / kanban / calendar / day / backlinks views,
the record modal, and i18n in 8 locales.

A collection is an application described by a `schema.json`: fields, relations,
computed values, action buttons and which views to offer. The agent authors that
schema when you describe what you want — a restaurant list, an invoice tracker,
a vocabulary deck — and the records are plain files in your workspace.

The isomorphic engine and the node storage engine live in
[`@mulmoclaude/core/collection`](https://www.npmjs.com/package/@mulmoclaude/core)
and `@mulmoclaude/core/collection/server`; this package is the UI half.

## Google Calendar sync

A collection can declare a `googleCalendar` block and mirror one of the user's
calendars. The host syncs on creation, hourly in the background, and on demand
from the Sync button in the collection header — with no tool call and no tokens
spent per refresh.

## A card from another server

A host binds the UI once with `configureCollectionUi(binding)`, and a card scopes that binding to
the project it was made in. A host that shows a card from ANOTHER server (MulmoTerminal's remote
cells) provides that server's binding around the card, in setup above the card's View:

```ts
provideCollectionUi(() => bindingFor(server));
```

The card's own project scope is then applied to that binding (its `withScope`) rather than to the
global one. Return the same binding object for the same server, so the scoped bindings built from
it are reused. The display language (`localeTag`) and the starter-card translation (`translate`)
stay on the global binding: they belong to the person looking, not to the server a card reads.

## About MulmoClaude and MulmoTerminal

- **[MulmoClaude](https://github.com/receptron/mulmoclaude)** — an AI-native
  application platform built on Claude Code. Chat summons the right GUI for each
  task (documents, charts, forms, wikis, spreadsheets, 3D scenes), and
  everything your assistant accumulates stays as plain files in your own
  workspace, on your own machine.
- **[MulmoTerminal](https://github.com/receptron/mulmoterminal)** — run a whole
  team of coding agents from your browser. Many Claude Code / Codex sessions at
  once in a grid, colour-coded so you see which are working, which need you and
  which are done, plus git worktrees, one-click PRs and cost readouts. One `npx`
  command, no Electron, no config.

📖 **User guide**: <https://receptron.github.io/mulmoterminal/> (日本語 / English)

## Dev loop

```bash
yarn workspace @mulmoclaude/collection-plugin run build
yarn workspace @mulmoclaude/collection-plugin run test
```

## License

MIT
