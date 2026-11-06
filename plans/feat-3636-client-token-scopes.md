# feat: scoped client tokens — read-only and per-collection (#3636)

Stage 2 of #3618. Stage 1 (#3622) gave every client token the same reach: all
non-owner-only paths, both sockets.

## Scopes

A token's `scopes` is either `["full"]` (as today) or a combination of:

- `read` — only `GET` / `HEAD`.
- `collection:<slug>` — only `/api/collections/<slug>/…` for the listed slugs,
  plus `GET /api/collections`, which the handler filters to those slugs.

`full` cannot be combined with anything. A store record with an unknown scope,
or `full` mixed with others, is invalid and authorizes nothing (an older server
reading a newer store fails closed the same way).

## Rules (decided on #3636)

- The owner-only refusal (`clientTokenAccess.ts`) runs first, unchanged.
- `/collections/ontology` is refused to a collection-scoped token: it names every
  collection and how they reference each other.
- A collection-scoped token is refused on every path outside `/collections`.
- The slug segment is compared exactly, after decoding it on its own; a `.` /
  `..` segment or an undecodable path is refused. Refusal is the direction every
  doubtful case takes.
- `/ws/pubsub` and `/ws/chat` accept only the owner token or a `full` client
  token. The chat socket's periodic re-check uses the same rule.
- `GET /api/files/*` stays bearer-exempt, so a scoped token cannot stop a file
  read. Documented, not fixed here (#3627).

## Shape

- `server/api/auth/clientTokenScope.ts` — pure: parse a scope, validate a scope
  set, `isWithinClientTokenScopes(scopes, { method, path })`,
  `canUseSockets(scopes)`, `isCollectionInScope(scopes, slug)`.
- `clientTokenRule.ts` — records validate scopes through it; `addClientToken`
  takes `scopes`.
- `clientTokenCommands.ts` — `token add <name> [--scope <scope>]...`.
- `bearerAuth.ts` — 403 when out of scope; `principal.ts` exposes the request's
  principal for the list filter and a socket check.
- `server/index.ts` — sockets use the socket check.

## Tests

`test/server/test_clientTokenScopes.ts` covers the pure rule in both directions
(allowed and refused: methods, slugs, case, encoding, dot segments, ontology,
mixed `full`); the CLI and middleware cases extend `test_clientTokens.ts`.
Verified against a running server: each scope on HTTP and both sockets.
