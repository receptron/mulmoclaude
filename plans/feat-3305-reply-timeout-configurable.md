# feat: make the bridge reply timeout configurable (#3305)

## Problem

The chat-service stops waiting for an agent reply after a fixed 5 minutes
(`packages/chat-service/src/relay.ts`), returns what has streamed so far, and
unsubscribes — text the agent produces after that is dropped. The bridge client
has its own fixed 6-minute ack timer (`packages/client/src/client.ts`) chosen to
outlast the server's. Raising only the server side lets the client's timer fire
first, so the bridge gets `timeout: no ack` instead of the reply.

## Approach — one setting, read by both sides

The setting travels on the existing bridge-options channel
(`BRIDGE_*` / `<TRANSPORT>_BRIDGE_*` → handshake → `bridgeOptions`):

- `BRIDGE_REPLY_TIMEOUT_MS` / `<TRANSPORT>_BRIDGE_REPLY_TIMEOUT_MS` → `replyTimeoutMs`
- chat-service: `bridgeOptions.replyTimeoutMs` is the reply-collection limit
- client: the same value plus a fixed margin is the ack limit
- relay path: `replyTimeoutMs` joins the `RELAY_*` allowlist
  (`RELAY_REPLY_TIMEOUT_MS` / `RELAY_<PLATFORM>_REPLY_TIMEOUT_MS`)

The rule lives once, as a pure function in `@mulmobridge/protocol`
(`resolveReplyTimeoutMs`, `ackTimeoutMsFor`), because it is a wire contract:
the client must wait longer than the server.

## Value rules

- absent / empty → default 5 minutes, no warning (existing behaviour unchanged)
- not a positive integer (letters, decimals, `0`, negatives, whitespace) → default + warning
- above the `setTimeout` ceiling (minus the client margin) → clamped + warning;
  Node fires an over-limit timer after 1 ms, which would turn "wait longer" into
  "give up at once"

## Out of scope

- Delivering text that arrives after the limit (push path) — separate issue
- The HTTP relay route, which is also bounded by Node's default `requestTimeout`
- Queued turns in the same chat wait for the longer limit (existing serializer) — documented

## Versioning

`@mulmobridge/protocol` gains runtime exports → bump to 1.1.0 (drift gate) and
sweep consumer ranges to `^1.1.0`.
