# Bridge Protocol

**Audience:** anyone writing a new bridge process — a program that
glues one external messaging platform (Telegram, LINE, Slack,
Discord, the CLI, a web page, …) to MulmoClaude's chat service.

This is the wire-level contract. It is deliberately small: a
bridge is ~100–200 lines of platform-side code plus the boilerplate
covered here. The boilerplate for TypeScript bridges is already
wrapped in [`@mulmobridge/client`](../packages/client/).
Non-Node implementations (Python, Go, anything with a socket.io
4.x client) can follow this document directly.

For the architectural context (why bridges are separate processes,
how they fit into the five layers), see
[`plans/done/messaging_layers_guide.md`](../plans/done/messaging_layers_guide.md).

---

## Transport

| Thing | Value |
|---|---|
| Protocol | [socket.io](https://socket.io) 4.x |
| Path | `/ws/chat` |
| Host | `http://127.0.0.1:<port>`, where `<port>` is the number in `<workspace>/.server-port` (server binds `127.0.0.1` only). No default: with nothing published, WAIT — see [Finding the server](#finding-the-server) |
| Transport | `websocket` (long-polling skipped — loopback always upgrades) |

The server is written with `socket.io` 4.8.x. Clients **must** be
major-compatible. `socket.io-client` at the same major version is
the easy path in Node; most other languages have a community
implementation that tracks protocol v5.

---

## Finding the server

**Do not hardcode 3001.** The server honours `PORT`, and an implicit
default that is already busy walks forward (`Port 3001 busy → using
3002 instead`). It publishes the port it actually bound to
`<workspace>/.server-port` — a bare integer plus a newline, `chmod
0600` — and that file is how anything outside the process finds it
(#2650 / #2981 / #3078).

Resolve in this order:

1. An explicit setting your bridge accepts (`MULMOCLAUDE_API_URL` in
   the Node bridges).
2. `<workspace>/.server-port` → `http://127.0.0.1:<port>`. Accept
   decimal digits only and range-check `1..65535`; anything else
   means "nothing published", not a port.

**With neither, wait — do not fall back to `http://localhost:3001`.**
Presenting a bearer token at an address the workspace never named is
the thing to avoid, and the window is not narrow: the server writes
`.session-token` before it binds its port, with sandbox setup (a
Docker image build on a cold start) in between, so "token readable,
port absent" can last minutes (#3078).

Address `127.0.0.1`, not `localhost`: the server binds the IPv4
loopback explicitly, while `localhost` resolves to `::1` first on a
dual-stack host — and if something IS listening there, you connect to
it and never fall back.

A bridge that skips step 2 fails in two ways, one of them silent:
with nothing on 3001 it retries forever against nothing, and with a
DIFFERENT instance on 3001 it connects to that one — cleanly
authenticated, no error — and answers the wrong server's users.

---

### Re-read the pair on every connection failure

Both files are rewritten when the server restarts, and a socket's URL is
fixed when the socket is built — so resolving once pins your bridge to
the generation it started against (#3078). Re-read them whenever a
connection attempt fails, and when the pair has CHANGED, rebuild the
socket against the new values.

Two details decide whether this works:

- **A failed connection is the trigger, not an auth error.** `invalid
  token` only arrives when you still reach the server, i.e. when the
  port happened not to change. When the port did change, nothing
  answers and all you get is a refused connection.
- **Rebuild only when the pair moved.** A server that is merely down
  produces an unbroken stream of refusals; tearing the socket down for
  each one replaces your socket library's reconnection with a worse
  copy of it.

Mid-restart both files are briefly absent. That is not a new
generation — it is the absence of one — so treat it as "keep waiting",
never as a reason to fall back or exit.

---


## Authentication

Every bridge needs the current server bearer token (#272). Two
ways to resolve it, in this order:

1. `MULMOCLAUDE_AUTH_TOKEN` environment variable. Set this
   explicitly when running the bridge on a different host than the
   server, or when pinning the token across server restarts (#316).
2. `<workspace>/.session-token`. The server writes this at startup,
   `chmod 0600`. Read it as UTF-8, trim whitespace.

If neither yields a non-empty string, exit with a message pointing
the user at `yarn dev` / `MULMOCLAUDE_AUTH_TOKEN`.

`<workspace>` is `$MULMOCLAUDE_WORKSPACE_PATH`, or `~/mulmoclaude`
when that is unset — the same root `.server-port` lives in. The two
files are a pair the server rewrites together on every startup, so
resolve them from one root rather than two.

---

## Handshake

Connect with `auth: { transportId, token }`:

```ts
import { io } from "socket.io-client";
import { resolveApiUrl } from "@mulmobridge/client"; // or resolve it yourself —
                                                    // see "Minimal TypeScript bridge"

const socket = io(resolveApiUrl(), {
  path: "/ws/chat",
  auth: {
    transportId: "cli",     // required — identifies your bridge
    token: "<bearer token>", // required when the server has auth on
  },
  transports: ["websocket"],
});
```

### Required fields

- `transportId: string` — non-empty. Stable identifier per bridge
  family (`cli`, `telegram`, `line`, `slack`, `discord-mybot`, …).
  Used to scope per-bridge chat state on disk
  (`~/mulmoclaude/transports/<transportId>/…`) and as the
  server→bridge push room key.
- `token: string` — the bearer token from the workspace file / env
  var. Required when the server is configured with auth (the
  default).

### Rejection cases

The server emits `connect_error` with one of these messages. A
bridge should pattern-match these exact strings to give the user a
useful recovery hint:

| Message | Meaning | Fix |
|---|---|---|
| `transportId is required` | `auth.transportId` missing / empty / non-string | Check your handshake payload |
| `token is required` | Server has auth on; `auth.token` missing | Set `MULMOCLAUDE_AUTH_TOKEN` or ensure `.session-token` is readable |
| `invalid token` | Provided token ≠ current server token | Server was restarted — re-read the token and reconnect |
| `server auth not ready` | Server process booting; token not yet written | Retry in a second |
| `handshake auth is required` | `auth` absent entirely | Pass an `auth` object to `io(...)` |

Anything else is a platform-level connection error (network, TLS,
wrong port). Surface it verbatim.

---

## Events

### `message` — bridge → server (with ack)

Send a user turn. Use socket.io's built-in ack callback to await
the reply:

```ts
socket
  .timeout(6 * 60 * 1000) // > server's 5-minute reply timeout
  .emit(
    "message",
    { externalChatId: "terminal", text: "hello" },
    (err, ack) => { /* ... */ },
  );
```

Payload:

- `externalChatId: string` — non-empty. Your platform's chat /
  conversation identifier. For Telegram this is the `chat.id`; for
  Slack a channel ID; for a CLI a fixed string like `"terminal"`.
  The server uses `(transportId, externalChatId)` as the key for
  chat state (which claude session to route into, last-role, last-
  activity timestamp).
- `text: string` — non-empty. The user's message, UTF-8. Trim
  leading / trailing whitespace yourself if you care; the server
  trims before dispatching.
- `attachments?: Attachment[]` — optional array of file
  attachments (#382). Each entry has `{ mimeType: string, data:
  string, filename?: string }` where `data` is base64-encoded
  content. The server filters by mimeType: `image/*` becomes
  vision content blocks for Claude; other types are logged and
  skipped for now. Multiple images are supported (one content
  block per attachment).

Ack shape:

```ts
type MessageAck =
  | { ok: true; reply: string }
  | { ok: false; error: string; status?: number };
```

- `reply` — assistant text. May be empty string if the assistant
  finished without producing text (e.g. a tool-only turn).
- `error` — human-readable reason. `status` mirrors the HTTP path's
  status code where meaningful (`400` for validation, `500` for
  internal, `409` is turned into `ok: true` with a "please wait"
  reply).

Timeout strategy: the server uses a 5-minute reply timeout. Use a
client-side timeout slightly longer (6 minutes in `_lib/client.ts`)
so the server's timeout wins and you get a textual reply rather
than a client-side cancellation.

### `push` — server → bridge (Phase B of #268)

Subscribe:

```ts
socket.on("push", ({ chatId, message }) => {
  // Deliver via your platform. Telegram:
  //   telegramSendMessage(BOT_TOKEN, chatId, message)
  // CLI just prints.
});
```

Payload: `{ chatId: string; message: string }`.

- `chatId` — the externalChatId the server-side scheduler /
  task-manager wants to reach.
- `message` — the text to deliver verbatim. The server has no
  knowledge of your platform's markup flavor.

No ack. Push delivery is best-effort at the socket layer. If the
bridge needs "delivered" confirmation, a future phase will add a
`push.ack` callback; until then, platform-side confirmation (e.g.
Telegram's `sendMessage` response) is the closest equivalent.

**Room semantics:** each connected bridge auto-joins
`bridge:${transportId}`. Multiple bridges with the same transportId
all receive the same pushes. If no bridge is connected at push
time, the server queues the message in-memory per transport; the
next bridge to connect drains that transport's queue to *its* own
socket (not to the room — so a second late-joining bridge doesn't
re-receive already-drained messages).

---

## Minimal TypeScript bridge

```ts
import { io } from "socket.io-client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// "Finding the server", inlined — never a hardcoded 3001.
const workspace = process.env.MULMOCLAUDE_WORKSPACE_PATH || path.join(os.homedir(), "mulmoclaude");
const published = (() => {
  try {
    const raw = fs.readFileSync(path.join(workspace, ".server-port"), "utf-8").trim();
    if (!/^\d+$/.test(raw)) return null;
    const port = Number.parseInt(raw, 10);
    return port >= 1 && port <= 65535 ? `http://127.0.0.1:${port}` : null;
  } catch {
    return null;
  }
})();
// No default: an address the workspace never named is not a place to present a
// bearer token. With nothing published, wait and re-read (see above).
const apiUrl = process.env.MULMOCLAUDE_API_URL || published;
if (!apiUrl) throw new Error("no server published yet — retry rather than guessing a port");

const socket = io(apiUrl, {
  path: "/ws/chat",
  auth: {
    transportId: "demo",
    token: process.env.MULMOCLAUDE_AUTH_TOKEN!,
  },
  transports: ["websocket"],
});

socket.on("connect", () => console.log(`Connected: ${socket.id}`));
socket.on("connect_error", (err) => console.error(err.message));
socket.on("push", (ev) => console.log(`[push] ${ev.chatId}: ${ev.message}`));

// Send a turn
await new Promise<void>((resolve) => {
  socket.timeout(360_000).emit(
    "message",
    { externalChatId: "test", text: "Hello" },
    (err, ack) => {
      if (err) console.error(`timeout: ${err.message}`);
      else console.log(ack);
      resolve();
    },
  );
});
```

For the production-grade TS version with error paths baked in, use
`createBridgeClient` from [`@mulmobridge/client`](../packages/client/)
— `packages/bridges/cli/src/index.ts` is a ~40-line example built on top of it.

---

## Operational notes

- **Server restart rewrites BOTH sidecars.** Re-read the pair on
  every failed connection and rebuild when it has changed — see
  "Re-read the pair on every connection failure" above. Do not wait
  for `invalid token`: a restart that lands on a different port never
  produces one, because nothing answers. Pinning the token with
  `MULMOCLAUDE_AUTH_TOKEN` on both sides (#316) is for a bridge on a
  DIFFERENT machine, which cannot read the workspace at all.
- **Bridges are stateless.** All chat state lives server-side under
  `~/mulmoclaude/transports/<transportId>/chats/<externalChatId>.json`.
  A bridge can be killed and restarted freely.
- **One bridge process per platform.** Run multiple bridges
  concurrently (`yarn cli` plus a Telegram bridge plus …) — they're
  independent processes sharing only the server.
- **Platform-specific concerns are yours.** Rate limits, message
  length caps, markdown flavor, typing indicators, reply-token
  expiry (LINE) — the server doesn't know. Handle them in your
  bridge.

---

## Related reading

- [`plans/done/messaging_layers_guide.md`](../plans/done/messaging_layers_guide.md) — architecture, why out-of-process
- [`plans/done/messaging_transports.md`](../plans/done/messaging_transports.md) — design decisions log
- [`plans/done/feat-chat-socketio.md`](../plans/done/feat-chat-socketio.md) — Phase A (socket transport)
- [`plans/done/feat-chat-socketio-phase-b.md`](../plans/done/feat-chat-socketio-phase-b.md) — Phase B (server→bridge push)
- [`docs/developer.md` § Auth](developer.md) — bearer token details
