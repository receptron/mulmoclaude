# @mulmoclaude/accounting-plugin

Double-entry accounting plugin for MulmoClaude and MulmoTerminal. Three surfaces: ./shared (isomorphic enums/meta, browser-safe), ./vue (chat View/Preview + canvas app), ./server (createAccountingRouter — the workspace-file-backed backend, wired via dependency injection so it pulls zero host-only infra).

A plugin for [MulmoClaude](https://github.com/receptron/mulmoclaude) and [MulmoTerminal](https://github.com/receptron/mulmoterminal) — loaded by the host, not run standalone.

## Host wiring

A single-workspace host (MulmoClaude) wires three calls once at boot:

```ts
configureAccountingServer({ workspaceRoot, logger });
initAccountingEventPublisher(pubsub);
app.use(createAccountingRouter());
```

A host that serves one root per project directory (MulmoTerminal) wires the same three
differently:

```ts
configureAccountingServer({
  workspaceRoot: null,                    // explicit-root mode: a forgotten root throws
  logger,
  channelScopeForRoot: (root) => projectIdForRoot(root), // opaque id, or null for the default root
});
initAccountingEventPublisher(pubsub);     // unchanged — the scope comes from the dep above
app.use(createAccountingRouter({ resolveWorkspaceRoot: (req) => rootForRequest(req) }));
configureAccountingHost({ apiCall, subscribe, localeTag, projectScope });  // the Vue surface
```

Both are opt-in and default to today's behaviour. The invariants behind them:

1. **A bookId is unique within a root and nowhere else.** Anything keyed by bookId alone —
   a channel, a rebuild queue, a card — is a cross-project collision waiting to happen.
2. **`workspaceRoot: null` is the safety net.** With N roots, a forgotten root is not a
   crash but a silent read or write against the wrong project; explicit-root mode turns it
   into a clear throw.
3. **A project is named by an opaque id, never a path.** Channel names and card envelopes
   reach the browser; an absolute root there publishes the user's home directory.
4. **The model never picks a project.** `manageAccounting`'s schema has no project
   parameter (pinned by a test), and this package never resolves one off a request body —
   only the host's own `resolveWorkspaceRoot` does.

A host that shows a card from ANOTHER server (MulmoTerminal's remote cells) sends that card's
requests and subscriptions there by providing a pair around the card, in setup above the View:

```ts
provideAccountingHost({ apiCall: apiCallTo(server), subscribe: subscribeTo(server), projectScope });
```

Everything below it — the View's own `provideAccountingApi`, every `useAccountingApi`, and the
book channels — goes through that pair. A card that names no project falls back to that host's
`projectScope`, or to no project when it is omitted: the global host's active project is an id on
another server. Nothing provided, everything uses `configureAccountingHost`'s.

## Dev loop

```bash
yarn workspace @mulmoclaude/accounting-plugin run build
yarn workspace @mulmoclaude/accounting-plugin run test
```

## Related projects

Used by both MulmoClaude and MulmoTerminal, and published from the MulmoClaude monorepo by [Receptron](https://github.com/receptron).

- **[MulmoClaude](https://github.com/receptron/mulmoclaude)** — an open-source AI assistant platform that runs on your own computer. Claude Code as the engine, a personal wiki for long-term memory, schema-driven collections for your data, and chat that summons the right GUI (markdown, charts, forms, spreadsheets, wikis) for each task.
- **[MulmoTerminal](https://github.com/receptron/mulmoterminal)** — a terminal-first cockpit for running many AI coding agents in parallel. One roster showing every session's summary and PR status, tmux-backed session persistence, git-worktree isolation, one-click PRs, and mobile push with remote reply.
- **[MulmoTerminal manual](https://receptron.github.io/mulmoterminal/)** — setup, workflows, feature reference, configuration, mobile notifications, and alternative / local model providers. Available in English and Japanese.
