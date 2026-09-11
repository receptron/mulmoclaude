# @mulmobridge/client

Shared socket.io client library for all MulmoBridge bridges. Handles connection setup, bearer-token authentication, and the send/receive wire protocol so each bridge only needs to implement its platform adapter.

## Install

```bash
npm install @mulmobridge/client
# or
yarn add @mulmobridge/client
```

## Exports

| Export | Description |
|---|---|
| `createBridgeClient(opts)` | Create a connected socket.io client with auth |
| `requireBearerToken()` | Read the bearer token or exit with a helpful message |
| `readBridgeToken()` | Read the bearer token (returns `null` if absent) |
| `TOKEN_FILE_PATH` | Path to the workspace's `.session-token` |
| `resolveApiUrl(explicit?)` | Resolve the server URL a bridge should connect to |
| `mimeFromExtension(ext)` | Map file extension to MIME type |
| `isImageMime(mime)` | Check if MIME is an image type |
| `isPdfMime(mime)` | Check if MIME is PDF |
| `isSupportedAttachmentMime(mime)` | Check if MIME can be sent to Claude |
| `parseDataUrl(url)` | Parse `data:mime;base64,data` strings |
| `buildDataUrl(mime, b64)` | Build a data URL from components |
| `MessageAck` | Acknowledgement returned by `client.send()` |
| `PushEvent` | Server-push event delivered to `client.onPush()` |
| `BridgeClientOptions` | Options accepted by `createBridgeClient()` |
| `BridgeClient` | Client interface returned by `createBridgeClient()` |
| `ParsedDataUrl` | Parsed data URL components |

## Usage

```typescript
import { createBridgeClient } from "@mulmobridge/client";

const client = createBridgeClient({ transportId: "my-bridge" });

const ack = await client.send("chat-123", "Hello!");
if (ack.ok) {
  console.log(ack.reply);
}

client.onPush((ev) => {
  console.log(`Push from ${ev.chatId}: ${ev.message}`);
});
```

## Which server it connects to

The MulmoClaude server is **not pinned to port 3001**. It honours `PORT`, and an
implicit default that is already busy walks forward (`Port 3001 busy → using 3002
instead`). Whatever it ends up binding, it publishes to `<workspace>/.server-port`
— the file every out-of-process reader uses to find it.

`createBridgeClient()` resolves the address in this order:

1. `opts.apiUrl` — an explicit value always wins
2. `$MULMOCLAUDE_API_URL`
3. `http://127.0.0.1:<port>` from `<workspace>/.server-port`
4. `http://localhost:3001`

The workspace itself is `$MULMOCLAUDE_WORKSPACE_PATH`, or `~/mulmoclaude` when
that is unset — the same rule the server applies, and the same root the bearer
token is read from.

Only `process.env` is consulted. A `.env` file reaches this library through the
bridge's own `import "dotenv/config"`, which resolves `.env` against the
process's **current working directory** — so a bridge launched from somewhere
else does not see a `MULMOCLAUDE_WORKSPACE_PATH` that lives only in the repo's
`.env`, exactly as it would not see `MULMOCLAUDE_AUTH_TOKEN` there. Export the
variable, or run the bridge from the directory holding the `.env`.

| Export | Resolves |
|---|---|
| `readBridgeToken()` / `tokenFilePath()` | at call time |
| `TOKEN_FILE_PATH` | at import time — a snapshot, kept for compatibility |

The port is read once, when the client is created. A server that restarts onto a
*different* port after that still needs the bridge restarted.

## Ecosystem

Part of the [`@mulmobridge/*`](https://www.npmjs.com/~mulmobridge) package family.

**Shared libraries:**

- [`@mulmobridge/client`](https://www.npmjs.com/package/@mulmobridge/client) — socket.io client library used by every bridge below  ← **this package**
- [`@mulmobridge/protocol`](https://www.npmjs.com/package/@mulmobridge/protocol) — wire types and constants
- [`@mulmobridge/chat-service`](https://www.npmjs.com/package/@mulmobridge/chat-service) — server-side relay + session store
- [`@mulmobridge/relay`](https://www.npmjs.com/package/@mulmobridge/relay) — Cloudflare Workers webhook proxy
- [`@mulmobridge/mock-server`](https://www.npmjs.com/package/@mulmobridge/mock-server) — mock server for local bridge development

**Bridges** (one npm package per platform):

- [`@mulmobridge/bluesky`](https://www.npmjs.com/package/@mulmobridge/bluesky) — Bluesky DMs over atproto
- [`@mulmobridge/chatwork`](https://www.npmjs.com/package/@mulmobridge/chatwork) — Chatwork (Japanese business chat)
- [`@mulmobridge/cli`](https://www.npmjs.com/package/@mulmobridge/cli) — interactive terminal bridge
- [`@mulmobridge/discord`](https://www.npmjs.com/package/@mulmobridge/discord) — Discord bot via Gateway
- [`@mulmobridge/email`](https://www.npmjs.com/package/@mulmobridge/email) — IMAP poll + SMTP reply, threading preserved
- [`@mulmobridge/google-chat`](https://www.npmjs.com/package/@mulmobridge/google-chat) — Google Chat via MulmoBridge relay
- [`@mulmobridge/irc`](https://www.npmjs.com/package/@mulmobridge/irc) — IRC (Libera, Freenode, custom)
- [`@mulmobridge/line`](https://www.npmjs.com/package/@mulmobridge/line) — LINE Messaging API via MulmoBridge relay
- [`@mulmobridge/line-works`](https://www.npmjs.com/package/@mulmobridge/line-works) — LINE Works (enterprise LINE)
- [`@mulmobridge/mastodon`](https://www.npmjs.com/package/@mulmobridge/mastodon) — Mastodon DMs + mentions
- [`@mulmobridge/matrix`](https://www.npmjs.com/package/@mulmobridge/matrix) — Matrix / Element
- [`@mulmobridge/mattermost`](https://www.npmjs.com/package/@mulmobridge/mattermost) — Mattermost
- [`@mulmobridge/messenger`](https://www.npmjs.com/package/@mulmobridge/messenger) — Facebook Messenger via MulmoBridge relay
- [`@mulmobridge/nostr`](https://www.npmjs.com/package/@mulmobridge/nostr) — Nostr NIP-04 encrypted DMs
- [`@mulmobridge/rocketchat`](https://www.npmjs.com/package/@mulmobridge/rocketchat) — Rocket.Chat
- [`@mulmobridge/signal`](https://www.npmjs.com/package/@mulmobridge/signal) — Signal via signal-cli-rest-api
- [`@mulmobridge/slack`](https://www.npmjs.com/package/@mulmobridge/slack) — Slack Socket Mode
- [`@mulmobridge/teams`](https://www.npmjs.com/package/@mulmobridge/teams) — Microsoft Teams via Bot Framework
- [`@mulmobridge/telegram`](https://www.npmjs.com/package/@mulmobridge/telegram) — Telegram bot
- [`@mulmobridge/twilio-sms`](https://www.npmjs.com/package/@mulmobridge/twilio-sms) — SMS via Twilio Programmable Messaging
- [`@mulmobridge/viber`](https://www.npmjs.com/package/@mulmobridge/viber) — Viber Public Account bots
- [`@mulmobridge/webhook`](https://www.npmjs.com/package/@mulmobridge/webhook) — generic HTTP webhook bridge
- [`@mulmobridge/whatsapp`](https://www.npmjs.com/package/@mulmobridge/whatsapp) — WhatsApp Cloud API via MulmoBridge relay
- [`@mulmobridge/xmpp`](https://www.npmjs.com/package/@mulmobridge/xmpp) — XMPP / Jabber
- [`@mulmobridge/zulip`](https://www.npmjs.com/package/@mulmobridge/zulip) — Zulip

## Related projects

Published from the MulmoClaude monorepo by [Receptron](https://github.com/receptron).

- **[MulmoClaude](https://github.com/receptron/mulmoclaude)** — an open-source AI assistant platform that runs on your own computer. Claude Code as the engine, a personal wiki for long-term memory, schema-driven collections for your data, and chat that summons the right GUI (markdown, charts, forms, spreadsheets, wikis) for each task.
- **[MulmoTerminal](https://github.com/receptron/mulmoterminal)** — a terminal-first cockpit for running many AI coding agents in parallel. One roster showing every session's summary and PR status, tmux-backed session persistence, git-worktree isolation, one-click PRs, and mobile push with remote reply.
- **[MulmoTerminal manual](https://receptron.github.io/mulmoterminal/)** — setup, workflows, feature reference, configuration, mobile notifications, and alternative / local model providers. Available in English and Japanese.

## License

MIT
