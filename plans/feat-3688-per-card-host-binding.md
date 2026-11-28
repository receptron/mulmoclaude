# A host binds one card's collection or accounting requests to another server (#3688)

## Why

MulmoTerminal shows a Linux machine's sessions on a Mac (receptron/mulmoterminal#3506). A remote
cell's Canvas cards read from that machine. Plugins that dispatch through `useRuntime()` already
do, because the host's runtime decides where each card's dispatch goes. Collections and accounting
do not dispatch through the runtime: each takes one global binding from the host, and a card can
only narrow it to a PROJECT, not to another server.

## What changes

- **`@mulmoclaude/collection-plugin`:**
  - `provideCollectionUi(() => binding)` puts a host's binding around a subtree.
  - `provideCollectionScope` now scopes the binding around it (the host's, or the global one)
    instead of always the global one.
  - `resolveScopedCollectionUi(scope, base)` takes that base, and memoises per base and scope,
    since two servers can hold the same project id.
- **`@mulmoclaude/accounting-plugin`:**
  - `provideAccountingHost({ apiCall, subscribe })` puts a network client and a pub/sub transport
    around a subtree (`src/vue/treeHost.ts`).
  - The View's `provideAccountingApi`, every `useAccountingApi` and both book channels go through it.
  - A card that names no project falls back to the provided host's optional `projectScope`, or to
    none: the global host's active project is an id on another server (`useProjectScope`, used by
    the View, the loose `useAccountingApi` and both channels).
- The collection display language and starter-card translation stay on the global binding: they
  belong to the person looking, not to the server a card reads.
- The scoped-binding cache is weak on its base, so a binding for a server nobody shows is released.

Nothing provided, every request and subscription goes exactly where it went before, so MulmoClaude
and a MulmoTerminal local cell are unchanged.

## Decisions (#3688)

- Option A: a provide function per package, rather than widening `withScope`.
- MulmoTerminal starts read-only: its gateway refuses the writes. Nothing in these packages marks a
  binding read-only.
- No change notifications for a remote card: MulmoTerminal provides a `subscribe` that does nothing.

## Tests

- `test/plugins/collection/test_cardScope.ts`: the base a scope is resolved on, the cache per base,
  and a mounted tree with and without a host binding.
- `packages/plugins/accounting-plugin/test/test_treeHost.ts`: a mounted tree's requests and both
  channels through a provided pair, the project a component outside the View's own binding names
  (none, or the provided host's, while the global host has an active one), and the global pair and
  project when nothing is provided.
