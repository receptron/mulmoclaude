# @mulmobridge/google-chat

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

Google Chat bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Uses HTTP endpoint mode (synchronous responses).

## Setup

### 1. Create a Google Chat App

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create or select a project
2. Enable the **Google Chat API**
3. Go to **APIs & Services → Credentials** and note your **Project Number**
4. Configure the Chat app:
   - **App name**: MulmoClaude
   - **App URL**: your public endpoint (ngrok for dev)
   - **Functionality**: receive 1:1 messages and join spaces

### 2. Set up ngrok

```bash
ngrok http 3005
```

### 3. Run the bridge

```bash
# Testing with mock server
npx @mulmobridge/mock-server &
GOOGLE_CHAT_PROJECT_NUMBER=123456 \
MULMOCLAUDE_AUTH_TOKEN=mock-test-token \
npx @mulmobridge/google-chat

# With real MulmoClaude
GOOGLE_CHAT_PROJECT_NUMBER=123456 \
npx @mulmobridge/google-chat
```

### 4. Message the bot

In Google Chat, find your app and send it a direct message.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CHAT_PROJECT_NUMBER` | Yes | Google Cloud project number |
| `GOOGLE_CHAT_BRIDGE_PORT` | No | Webhook port (default: 3005) |
| `MULMOCLAUDE_API_URL` | No | Default: auto (`.server-port`; waits if nothing is published) |
| `MULMOCLAUDE_AUTH_TOKEN` | No | Bearer token |
| `GOOGLE_CHAT_BRIDGE_DEFAULT_ROLE` | No | Role id to seed new bridge sessions with (e.g. `coder`, `general`). Applied ONLY when a google-chat session first appears — once the user switches role via `/role <id>` the session's own role wins. Unknown role ids silently fall back to the server's default with a warn log. |
| `BRIDGE_DEFAULT_ROLE` | No | Same as above but shared across every bridge. Transport-specific `GOOGLE_CHAT_BRIDGE_DEFAULT_ROLE` wins when both are set. |

### Auth token persistence across server restarts

The MulmoClaude server regenerates a fresh bearer token on every startup and writes it to `<workspace>/.session-token` (`$MULMOCLAUDE_WORKSPACE_PATH`, or `~/mulmoclaude` when unset), alongside the port it bound in `.server-port`.

**The bridge follows a restart on its own.** When the connection fails it re-reads both files, and if the server came back as a different generation — new token, new port, or both — it rebuilds its socket against it (#3078). You do not have to restart the bridge.

Pinning the token is still useful when the bridge runs **on a different machine** from the server, where it cannot read the workspace at all: set `MULMOCLAUDE_AUTH_TOKEN` to the same long random value on both sides. The server then uses it verbatim instead of regenerating.

```bash
# Server (one-time setup — same value across restarts)
MULMOCLAUDE_AUTH_TOKEN=long-random-string yarn dev

# Bridge (separate process / machine — same value)
MULMOCLAUDE_AUTH_TOKEN=long-random-string \
  <bridge-specific-envs> \
  npx <this-package>@latest
```

Recommended: at least 32 characters of random data (the server logs a warning at startup for shorter values).

## Security — Request Verification

Every incoming webhook request is verified using Google's OIDC JWT mechanism:

1. The `Authorization: Bearer <token>` header is extracted
2. The JWT signature is verified against Google's JWKS endpoint (`https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com`)
3. The following claims are checked:
   - `iss` must be `chat@system.gserviceaccount.com`
   - `aud` must match `GOOGLE_CHAT_PROJECT_NUMBER`
   - `exp` must not be in the past
4. Requests that fail verification receive `401 Unauthorized`

This prevents spoofed requests from arbitrary third parties.

## Limitations

- **Synchronous mode only**: Google Chat expects a response within 30 seconds. Agent responses that take longer will time out. For async responses, a service account with the Chat API is needed (future enhancement).
- **No push delivery**: server→bridge push requires the async Chat API with a service account. Currently pushes are logged but not delivered.

## Ecosystem

Part of the [`@mulmobridge/*`](https://www.npmjs.com/~mulmobridge) package family.

**Shared libraries:**

- [`@mulmobridge/client`](https://www.npmjs.com/package/@mulmobridge/client) — socket.io client library used by every bridge below
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
- [`@mulmobridge/google-chat`](https://www.npmjs.com/package/@mulmobridge/google-chat) — Google Chat via MulmoBridge relay  ← **this package**
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
