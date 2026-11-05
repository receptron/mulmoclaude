# @mulmoclaude/core

Shared server-side core for **MulmoClaude** and **MulmoTerminal** — the
subsystems the two hosts always ship together, consolidated behind subpath
exports so they cannot drift apart.

Not a general-purpose library: it exists so one implementation of collections,
wiki, feeds, Google integration, scheduling and the rest serves both hosts.
Every host specific (paths, logging, notification transport, …) is injected
rather than imported, which is what lets the same code run under either.

## Subpath exports

| Area | Entries |
| --- | --- |
| Collections | `./collection`, `./collection/server`, `./collection/paths`, `./collection/firestore`, `./collection/registry`, `./collection/registry/server`, `./collection-watchers` |
| Knowledge | `./wiki`, `./wiki/server`, `./wiki/paths`, `./feeds`, `./feeds/server`, `./feeds/paths` |
| Google | `./google` — OAuth (loopback + PKCE), token store, Calendar / Tasks / Drive REST |
| Runtime | `./scheduler`, `./notifier`, `./skill-bridge`, `./file-change`, `./workspace-setup`, `./artifacts` |
| Remote | `./remote-host`, `./remote-host/server`, `./remote-view` |
| Voice | `./whisper`, `./whisper/client` |
| Plugin support | `./plugin-vue`, `./plugin-vue/i18n` |
| Utilities | `./utils`, `./files`, `./fetch` |

**Server-only**, except the browser-safe entries: `./artifacts`,
`./whisper/client`, `./workspace-setup/slug`, `./translation/client`,
`./remote-view`, `./remote-host` and `./plugin-vue`.

`firebase` is an **optional** peer, and only the entries named for it need it:
`./collection/firestore` and `./remote-host/server`. Every
other entry must LOAD with the package absent — a host that uses no Firestore
installs nothing — under `import` and `require` alike.
`test/workspace/collections/test_optionalFirebasePeer.ts` in the MulmoClaude
repository holds that line: it loads every entry in the exports map, under both
conditions, with `firebase` made unresolvable. It is a sweep, not a static
guarantee — an import added to a module an entry reaches is caught by running
that test, not by the type checker.

A host wires shared collections by handing `setFirestoreAccessor` a
`FirestoreDocs`. Build it with `createFirestoreDocs` from
`./collection/firestore` — that adapter tracks the interface. **Hand-writing an
implementation means a new member is a compile break on upgrade** — which is
what `timestamp` was for anyone who had one.

The package also ships `assets/helps/*` — the help documents the agent reads at
runtime — which is why a change there alone still warrants a release.

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

## License

MIT
