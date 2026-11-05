# feat: named, individually revocable client tokens (#3618)

## Goal

Let several clients (bridges, n8n, scripts, other agents) each hold their own
bearer token for `/api/*`, `/ws/pubsub` and `/ws/chat`, so one can be revoked
without touching the others. First of the three PRs proposed on the issue.

## Decisions (agreed with the user)

- Issue / revoke from the CLI only (`mulmoclaude token add|list|revoke`,
  `yarn token …` in a checkout). Settings UI is a later PR.
- A client token is refused (403) on the host-management paths: settings,
  secrets, roles, skills, plugins, automations, hooks, MCP, shutdown, remote
  host, Google linking, diagnostics, `/api/agent` (direct agent runs). Asked
  for by the reporter; bridge chats (`/api/transports/…`, `/ws/chat`) stay
  open, since a bridge is the main client. The record carries `scopes`
  (`["full"]`) so narrowing (read-only, per collection) needs no migration.
- The owner-only list is a deny-list; a test fails when a routed
  `/api/<segment>` is in neither it nor the explicit open list, so a new
  route has to be classified on purpose.

## Design

- The owner token (`currentToken`, `MULMOCLAUDE_AUTH_TOKEN`) is untouched: the
  browser, the agent's MCP child and the view-token signing key keep using it.
- Client tokens live in `~/.mulmoclaude/client-tokens.json` (0600, dir 0700),
  outside the workspace, next to `secrets/`. Only a SHA-256 of each token is
  stored; the token itself is printed once by `token add`.
- Format `mct_<16 hex id>_<64 hex secret>`. The id selects the record, the
  hash is compared in constant time. Logs carry name / id only.
- `resolvePrincipal` (pure, `clientTokenRule.ts`) decides owner / client /
  refused. Owner first; the store is only consulted for a presented token in
  the client format, so a server with no client tokens does no extra I/O.
  No owner token yet (pre-bootstrap) still refuses everything.
- The server re-reads the store when its stat (ino, size, mtime) changes, so
  `revoke` takes effect on the next request without a restart. An unreadable
  or malformed file yields no client tokens (fails closed) and logs once.
- There is no HTTP API for the store, so a client token cannot mint tokens.
- `/ws/chat` lives in `@mulmobridge/chat-service`: it gains an optional
  `authorizeToken` dep; without it the old `tokenProvider` rule applies.
  An npm-installed launcher gets client tokens on `/ws/chat` only after that
  package is published; until then `/ws/chat` keeps accepting the owner token
  only (fails closed).

## Out of scope

- Scopes beyond `full`; settings UI; last-used timestamps.
