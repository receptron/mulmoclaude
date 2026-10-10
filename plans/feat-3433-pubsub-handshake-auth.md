# feat: require the bearer token on the `/ws/pubsub` handshake (#3433)

## Problem

Every `/api/*` call presents the per-startup bearer token, but the `/ws/pubsub` socket.io
handshake accepts anyone who can reach the port. Loopback binding is the only thing holding it
back, and a tunnel, reverse proxy or sibling process defeats that. Any such client can subscribe
to `session.<id>` and read the agent's events as they stream.

## Approach

The client sends the token in the socket.io `auth` payload, and a server middleware applies the
rule `bearerAuth` applies to the HTTP header (shared `isAuthorizedToken`: constant-time compare,
non-empty on both sides, one generic refusal) and refuses the handshake otherwise. This is
stricter than the bridge chat socket (`validateHandshake` in `@mulmobridge/chat-service`), which
still compares with `!==`, answers with distinguishing messages and accepts every handshake when
no token provider is given; that package is a leaf and cannot import the shared rule, so it is a
follow-up of its own.

### Server

- `server/api/auth/tokenEquals.ts` — the timing-safe compare lifted out of `bearerAuth.ts` so
  both guards share one copy. It compares BYTE lengths before `timingSafeEqual`, the way
  `viewToken.ts` already does: a candidate with the same character count but multi-byte
  characters used to make `timingSafeEqual` throw, which Express turned into a 500 instead of a
  401. `bearerAuth` now fails closed there too.
- `server/events/pub-sub/handshakeAuth.ts` — pure rule, no I/O: `isAuthorizedPubSubHandshake(auth,
  expectedToken)`. True only when the server has a token and `auth.token` is a string equal to it.
  Every other shape (missing auth, non-object, non-string token, empty, wrong value, server token
  not ready) is refused.
- `server/events/pub-sub/index.ts` — `createPubSub(server, { tokenProvider })` installs an
  `ioServer.use` middleware that calls the rule and refuses with the same generic `unauthorized`
  message `bearerAuth` uses. `tokenProvider` is required, so a pubsub cannot be created open by
  accident. One `log.warn` per refusal, carrying the peer address and never the token.
- `server/index.ts` — passes `getCurrentToken`, the provider the chat socket already uses.

### Client

- `src/utils/api.ts` — `getAuthToken()` next to `setAuthToken()`, so the socket reads the same
  token the HTTP calls attach.
- `src/composables/usePubSub.ts` — `io({ auth: { token } })`. On `connect_error`, a refusal from
  the server middleware is told apart from a transport failure by `socket.active`: socket.io stops
  retrying after a middleware refusal (the socket is destroyed), whereas a transport failure keeps
  retrying on its own. A refusal is published through `liveUpdatesRefused` (a module-level ref,
  like `backendReachable`) and logged to the console.
- `src/components/LiveUpdatesRefusedBanner.vue` — mounted in `App.vue` under the offline banner.
  Says the server refused this page's token (it has most likely restarted) and offers Reload,
  which fetches index.html and with it the new token. New i18n keys in all 8 locales.

### Why a banner and not a silent retry

The token is regenerated at every server start. After a restart the page holds a stale token, so
a reconnect would be refused forever; retrying would only hide that. socket.io already stops on a
middleware refusal — the banner is what makes the stop visible, the way a 401 on `/api` surfaces
as an error today.

### Every `/ws/pubsub` subscriber

`grep -rn "ws/pubsub"` over the repo: the SPA composable, and the Playwright mocks. No bridge, no
plugin and no package connects to it (`@mulmobridge/client` uses the chat socket). The Playwright
mocks hand-roll the socket.io handshake and matched the connect packet as the exact string `40`;
with an `auth` payload the packet is `40{"token":…}`, so they would have hung silently. The three
copies now go through one fixture helper that acks the connect packet only when the token is the
one `playwright.config.ts` injects, and otherwise answers with a socket.io `CONNECT_ERROR` — so
a client that stops sending the token fails the suite instead of timing out.

## Tests

- `test/server/test_tokenEquals.ts` — equal / unequal / different lengths / the multi-byte case
  that used to throw.
- `test/pub-sub/test_handshakeAuth.ts` — the rule in both directions over every input shape.
- `test/pub-sub/test_index.ts` — real server + real client: no token, wrong token and right token;
  the refusal leaves `socket.active === false` (the property the SPA relies on); the round-trip
  tests now connect with the token.
- `e2e/tests/pubsub-handshake-auth.spec.ts` — the SPA sends the injected token in the connect
  packet and receives events after the ack; a refused handshake shows the banner with a Reload
  button; an accepted one does not.
- Existing `chat-flow`, `chatinput-buffer`, `streaming-autoscroll`, `stack-*` specs keep proving
  that events still arrive, now through the token-checking mock.

## Out of scope

- `/api/files/*` stays token-free (`<img src>` cannot carry a header).
- Exposing the server beyond loopback still needs an authenticating proxy in front; documenting
  that setup belongs to #3425.
- The server logs one `warn` per engine.io connection it refuses. A refused connection stays
  open and can keep sending CONNECT packets, so a line per packet would let one client fill the
  log; one per connection keeps a misconfigured relay diagnosable.
