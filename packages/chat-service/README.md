# @mulmobridge/chat-service

Server-side chat service for [MulmoBridge](https://github.com/receptron/mulmoclaude) — provides socket.io + REST endpoints that connect external bridges (CLI, Telegram, etc.) to a Claude Code agent.

## Install

```bash
npm install @mulmobridge/chat-service express socket.io
```

> `express` and `socket.io` are peer dependencies.

## Overview

The chat-service is a **DI-pure factory** — all host-app concerns (agent runner, session events, role lookup, file persistence, logger) are injected via `ChatServiceDeps`. No direct imports from the host application.

```typescript
import { createChatService } from "@mulmobridge/chat-service";

const chatService = createChatService({
  startChat,        // your agent entry point
  onSessionEvent,   // session event subscriber
  loadAllRoles,     // role list provider
  getRole,          // single role lookup
  defaultRoleId,    // fallback role
  transportsDir,    // directory for transport state files
  logger,           // structured logger ({ error, warn, info, debug })
  tokenProvider,    // required: the current bearer token the /ws/chat handshake must carry
});

// Mount the Express router
app.use(chatService.router);

// Attach socket.io to the HTTP server
chatService.attachSocket(httpServer);
```

`tokenProvider` returns the current bearer token, or `null` while the host has
none yet; every handshake is refused until it returns one. A refused token
answers `connect_error` with the generic `unauthorized` — the same message
`/api/*` sends — never with which part failed. The wire contract is in
`docs/bridge-protocol.md` in the repository.

`authorizeToken` (optional, since 2.1.0) replaces that comparison for a host
that accepts more than one token: it receives the presented token and returns
whether it passes. It must refuse everything while the host has no token of
its own. Since 2.1.0, open sockets are also re-checked every few seconds and on
every message, so a token the host stops accepting is disconnected.

## Architecture

```text
┌─────────────┐     socket.io      ┌──────────────────┐
│ CLI bridge   │ ◄──────────────► │  chat-service     │
│ TG bridge    │    /ws/chat       │  (this package)   │
│ ...          │                   │                   │
└─────────────┘     REST           │  ┌─────────────┐ │
                  /api/transports  │  │ relay.ts     │ │ ──► startChat()
                                   │  │ socket.ts    │ │ ──► onSessionEvent()
                                   │  │ chat-state   │ │ ──► file persistence
                                   │  │ commands.ts  │ │ ──► /reset, /role
                                   │  │ push-queue   │ │ ──► server→bridge push
                                   │  └─────────────┘ │
                                   └──────────────────┘
```

## Exports

| Export | Description |
|---|---|
| `createChatService(deps)` | Factory — returns `{ router, attachSocket, pushToBridge }` |
| `createRelay(deps)` | Core relay logic (HTTP + socket.io both call this) |
| `CHAT_SOCKET_EVENTS` | Re-exported from `@mulmobridge/protocol` |
| `ChatServiceDeps` | Dependency injection interface |
| `StartChatFn` / `StartChatParams` / `StartChatResult` | Agent entry point types |
| `Attachment` | File attachment interface |

## Part of the MulmoBridge ecosystem

| Package | Description |
|---|---|
| [@mulmobridge/protocol](https://www.npmjs.com/package/@mulmobridge/protocol) | Wire protocol types and constants |
| **@mulmobridge/chat-service** | Server-side chat service (this package) |
| [@mulmobridge/client](https://www.npmjs.com/package/@mulmobridge/client) | Bridge client library |
| [@mulmobridge/cli](https://www.npmjs.com/package/@mulmobridge/cli) | CLI bridge |
| [@mulmobridge/telegram](https://www.npmjs.com/package/@mulmobridge/telegram) | Telegram bridge |

## Ecosystem

Part of the [`@mulmobridge/*`](https://www.npmjs.com/~mulmobridge) package family.

**Shared libraries:**

- [`@mulmobridge/client`](https://www.npmjs.com/package/@mulmobridge/client) — socket.io client library used by every bridge below
- [`@mulmobridge/protocol`](https://www.npmjs.com/package/@mulmobridge/protocol) — wire types and constants
- [`@mulmobridge/chat-service`](https://www.npmjs.com/package/@mulmobridge/chat-service) — server-side relay + session store  ← **this package**
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

MIT — [Receptron Team](https://github.com/receptron)
