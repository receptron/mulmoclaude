# @mulmobridge/rocketchat

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

Rocket.Chat bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Polls each of the bot user's direct-message rooms via the Rocket.Chat REST API, forwards new messages to MulmoClaude, and posts replies back. Outbound-only — **no public URL needed**.

## Setup

### 1. Create a bot user

On a server you own (e.g. a self-hosted Rocket.Chat), create a dedicated user for the bot. Public SaaS accounts work too.

### 2. Generate a personal access token

Log into Rocket.Chat **as the bot user** (or any account you want the bridge to impersonate) →

1. Avatar → **My Account → Personal Access Tokens**
2. **Add** — uncheck "Ignore Two Factor Authentication" for safety
3. Copy the **Token** and **User ID** (shown only once)

### 3. Run the bridge

```bash
# Testing with mock server
npx @mulmobridge/mock-server &
ROCKETCHAT_URL=https://rocket.example.com \
ROCKETCHAT_USER_ID=... \
ROCKETCHAT_TOKEN=... \
MULMOCLAUDE_AUTH_TOKEN=mock-test-token \
npx @mulmobridge/rocketchat

# With real MulmoClaude
ROCKETCHAT_URL=https://rocket.example.com \
ROCKETCHAT_USER_ID=... \
ROCKETCHAT_TOKEN=... \
npx @mulmobridge/rocketchat
```

DM the bot user from another Rocket.Chat account and you'll get a reply.

## Environment variables

| Variable                       | Required | Default | Description |
|--------------------------------|----------|---------|-------------|
| `ROCKETCHAT_URL`               | yes      | —       | Server URL, e.g. `https://rocket.example.com` |
| `ROCKETCHAT_USER_ID`           | yes      | —       | Bot user ID (from Personal Access Tokens page) |
| `ROCKETCHAT_TOKEN`             | yes      | —       | Personal access token |
| `ROCKETCHAT_ALLOWED_USERS`     | no       | (all)   | CSV of usernames (without `@`) allowed to converse — empty = everyone |
| `ROCKETCHAT_POLL_INTERVAL_SEC` | no       | `5`     | Poll interval in seconds (min 2) |
| `MULMOCLAUDE_AUTH_TOKEN`       | no       | auto    | MulmoClaude bearer token override |
| `MULMOCLAUDE_API_URL`          | no       | auto (`.server-port`, else `http://localhost:3001`) | MulmoClaude server URL |

### Auth token persistence across server restarts

The MulmoClaude server regenerates a fresh bearer token on every startup and writes it to `<workspace>/.session-token` (`$MULMOCLAUDE_WORKSPACE_PATH`, or `~/mulmoclaude` when unset). The bridge reads that file once at launch and keeps the token in memory — so if the server restarts while the bridge is running, the bridge keeps using the **old** token and every API call returns **401**, silently.

**Fix**: set `MULMOCLAUDE_AUTH_TOKEN` to the same long random value on **both** the server and the bridge. The server uses it verbatim instead of regenerating, so the token survives restarts and the bridge stays authenticated.

```bash
# Server (one-time setup — same value across restarts)
MULMOCLAUDE_AUTH_TOKEN=long-random-string yarn dev

# Bridge (separate process / machine — same value)
MULMOCLAUDE_AUTH_TOKEN=long-random-string \
  <bridge-specific-envs> \
  npx <this-package>@latest
```

Recommended: at least 32 characters of random data (the server logs a warning at startup for shorter values).

## How it works

1. On startup the bridge calls `GET /api/v1/me` to confirm the token works.
2. Every `ROCKETCHAT_POLL_INTERVAL_SEC` it lists the bot's DM rooms via `GET /api/v1/im.list` and, per room, fetches messages newer than a cached cursor via `GET /api/v1/im.history?roomId=...&oldest=<iso>`.
3. For each new message not authored by the bot (and whose sender is in the allowlist if set), the bridge forwards the text to MulmoClaude keyed by `roomId`.
4. Replies go back via `POST /api/v1/chat.postMessage`, chunked at 4 000 chars.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `GET /me: 401` | wrong user ID or token | Regenerate from Personal Access Tokens |
| `POST /chat.postMessage: 400` | room doesn't exist or bot not in it | DM the bot user at least once so the DM room is created |
| Messages silently ignored | Sender not in `ROCKETCHAT_ALLOWED_USERS` | Add their username or clear the env var |
| Rate-limit errors on large deploys | Many DM rooms × short poll interval | Raise `ROCKETCHAT_POLL_INTERVAL_SEC` |

## Security notes

- The personal access token grants full read/write as the bot user. Treat like a password.
- A dedicated bot account is strongly recommended — don't reuse your personal account.
- Without `ROCKETCHAT_ALLOWED_USERS`, anyone with an account on the server who DMs the bot will get a reply. Set an allowlist for personal agents.
- This v0.1.0 polls the REST API only. Future releases may add the realtime (DDP) websocket for push delivery.

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
- [`@mulmobridge/google-chat`](https://www.npmjs.com/package/@mulmobridge/google-chat) — Google Chat via MulmoBridge relay
- [`@mulmobridge/irc`](https://www.npmjs.com/package/@mulmobridge/irc) — IRC (Libera, Freenode, custom)
- [`@mulmobridge/line`](https://www.npmjs.com/package/@mulmobridge/line) — LINE Messaging API via MulmoBridge relay
- [`@mulmobridge/line-works`](https://www.npmjs.com/package/@mulmobridge/line-works) — LINE Works (enterprise LINE)
- [`@mulmobridge/mastodon`](https://www.npmjs.com/package/@mulmobridge/mastodon) — Mastodon DMs + mentions
- [`@mulmobridge/matrix`](https://www.npmjs.com/package/@mulmobridge/matrix) — Matrix / Element
- [`@mulmobridge/mattermost`](https://www.npmjs.com/package/@mulmobridge/mattermost) — Mattermost
- [`@mulmobridge/messenger`](https://www.npmjs.com/package/@mulmobridge/messenger) — Facebook Messenger via MulmoBridge relay
- [`@mulmobridge/nostr`](https://www.npmjs.com/package/@mulmobridge/nostr) — Nostr NIP-04 encrypted DMs
- [`@mulmobridge/rocketchat`](https://www.npmjs.com/package/@mulmobridge/rocketchat) — Rocket.Chat  ← **this package**
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
