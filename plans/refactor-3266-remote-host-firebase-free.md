# refactor: make `@mulmoclaude/core/remote-host` load without firebase (#3266, option A)

## Goal

`./remote-host` calls itself the browser-safe protocol contract, but it statically imported
`firebase/firestore` for two path helpers. Move them to the server surface so the entry loads
without the optional `firebase` peer.

## Change

- `commandsCollection` / `hostDoc` move from `packages/core/src/remote-host/index.ts` to
  `packages/core/src/remote-host/server/paths.ts`, exported from `./remote-host/server`.
- `hostRunner.ts` / `presenceProbe.ts` import them from `./paths.js`.
- `test/workspace/collections/test_optionalFirebasePeer.ts`: `./remote-host` leaves `SDK_BOUND`,
  so the existing sweep now asserts it loads with firebase absent (`import` and `require`).
- `docs/remote-host.md`: the helpers are listed under the server entry.

## BREAKING — release note

`@mulmoclaude/core/remote-host` no longer exports `commandsCollection` / `hostDoc`
(import them from `@mulmoclaude/core/remote-host/server`). Core is bumped to `6.0.0` in this PR
(the publish-drift gate requires a bump whenever core's exports change), and every consumer range
is swept to `^6.0.0`: the launcher (`packages/mulmoclaude`) and every plugin's
`peerDependencies` + `devDependencies`. Publishing 6.0.0 and the plugins is a separate step.

## Known importers

- mulmoclaude (`server/`, `src/`, `packages/`, `e2e*/`, `test/`): none outside core.
- mulmoterminal: none in code (only a mention in `plans/feat-remote-host.md`).
- mulmoserver: has its own copies of both helpers; imports only types from core.
