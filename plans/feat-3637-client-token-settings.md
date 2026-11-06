# feat: client tokens in Settings — list, revoke, last used (#3637)

Stage 3 of #3618. Issuing stays on the CLI (decided on #3637): the browser
never sees a token's value.

## Last used

- Kept in memory per token id, at minute resolution, and written to
  `~/.mulmoclaude/client-tokens-usage.json` (0600) at most once per flush
  interval and on graceful shutdown. Never per request.
- Separate from `client-tokens.json` on purpose: rewriting the store would make
  the server re-read it on every flush and contend with the CLI for its lock.
- Recorded where the principal is resolved, so HTTP and both sockets count. An
  open socket counts as in use (its periodic re-check resolves the token).
- A flush keeps only ids still in the store, so a revoked token's entry goes —
  except when the store reads as empty, which an unreadable store also does.
- A failed write stays dirty and is retried on the next flush delay.
- An unreadable usage file is treated as empty: the timestamps are advisory, and
  losing them must never refuse a request.

## API (owner only — `/config` is already in `OWNER_ONLY_PREFIXES`)

- `GET /api/config/client-tokens` → `{ tokens: [{ name, id, createdAt, scopes, lastUsedAt | null }] }`.
  No value, no hash.
- `DELETE /api/config/client-tokens/:name?id=<id>` → `{ revoked: name }`; 404
  when no such token; 409 while a CLI token command holds the lock, when the
  name now belongs to another id, or when the store holds entries this server
  cannot read (a rewrite would drop them). Same lock and same
  `revokeClientToken` as `mulmoclaude token revoke`.
- The listing reads the store fresh and fails on an unreadable one, so the page
  never shows "no tokens" for a broken file; it also reports unreadable entries.

## UI

`SettingsClientTokensTab.vue` in the "server" group, before Quit: the list, an
empty state naming the CLI command, and a revoke button with an inline confirm.
Strings in all 8 locales.

## Tests

- Pure: minute rounding, change detection, usage file parse (malformed in every
  shape), listing merge.
- Tracker: flush writes only when dirty, prunes revoked ids, survives a broken file.
- Route: list shape (no secrets), revoke, 404, 409 under a held lock, and a
  client token refused with 403.
- e2e (mocked API): list renders, revoke confirm removes the row, empty state.
- Live: a running server, tokens issued by the CLI, used, listed and revoked from
  the page.
