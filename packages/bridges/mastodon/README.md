# @mulmobridge/mastodon

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

Mastodon bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Subscribes to your bot account's streaming notifications and forwards DMs (and optionally public mentions) to MulmoClaude. Outbound-only WebSocket — **no public URL / tunnel / relay needed**.

## Images

Images attached to a DM are downloaded and forwarded, so you can post a screenshot and ask about it. A DM with **only** images and no caption is forwarded too, with `Describe / analyze this file.` as the body.

- 8 MB per image. Images that fail to download are noted in the body MulmoClaude receives.
- If every image in a caption-less DM fails to download, the bridge replies with an error instead of relaying.
- Only Mastodon's `image` media type is forwarded — `video`, `gifv` and `audio` are left alone.
- A DM whose entire body is the bot's handle counts as "no caption" — the handle is not sent as the prompt.

## Setup

### 1. Create a bot account + access token

1. Sign up or log into a Mastodon instance (e.g. `mastodon.social`). A dedicated bot account is recommended.
2. Go to **Preferences → Development → New application**.
3. Name it (e.g. `MulmoClaude`). Required scopes: `read`, `write`, `push`.
4. Copy the **Access token** shown after creating the application.

### 2. Run the bridge

```bash
# Testing with mock server
npx @mulmobridge/mock-server &
MASTODON_INSTANCE_URL=https://mastodon.social \
MASTODON_ACCESS_TOKEN=... \
MULMOCLAUDE_AUTH_TOKEN=mock-test-token \
npx @mulmobridge/mastodon

# With real MulmoClaude
MASTODON_INSTANCE_URL=https://mastodon.social \
MASTODON_ACCESS_TOKEN=... \
npx @mulmobridge/mastodon
```

Send a DM (`visibility: direct`) to the bot account from another account — you'll get a reply.

## Environment variables

| Variable                   | Required | Default | Description |
|----------------------------|----------|---------|-------------|
| `MASTODON_INSTANCE_URL`    | yes      | —       | Instance base URL, e.g. `https://mastodon.social` |
| `MASTODON_ACCESS_TOKEN`    | yes      | —       | Bot account access token (from Preferences → Development) |
| `MASTODON_ALLOWED_ACCTS`   | no       | (all)   | CSV of `acct` strings allowed to converse — e.g. `alice@mastodon.social,bob@mstdn.jp`. Empty = accept everyone |
| `MASTODON_DM_ONLY`         | no       | `true`  | `true` only processes `direct`-visibility statuses; `false` also handles public / unlisted mentions |
| `MULMOCLAUDE_AUTH_TOKEN`   | no       | auto    | Override for the MulmoClaude bearer token (auto-read from `~/mulmoclaude/.session-token` otherwise) |
| `MULMOCLAUDE_API_URL`      | no       | auto (`.server-port`, else `http://localhost:3001`) | MulmoClaude server URL |

### Auth token persistence across server restarts

The MulmoClaude server regenerates a fresh bearer token on every startup and writes it to `~/mulmoclaude/.session-token`. The bridge reads that file once at launch and keeps the token in memory — so if the server restarts while the bridge is running, the bridge keeps using the **old** token and every API call returns **401**, silently.

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

1. The bridge opens a WebSocket to `/api/v1/streaming?stream=user:notification` with your access token.
2. When the bot receives a mention notification, the bridge checks the `visibility` (DM-only filter) and the `acct` (allowlist), strips HTML + leading `@bot` tokens from the status content, fetches any image attachments, and forwards the message to MulmoClaude with the sender's `acct` as `externalChatId`.
3. MulmoClaude's reply is posted back as a status with `in_reply_to_id` pointing at the original status and the same `visibility` — so a DM stays a DM, a public mention replies publicly.
4. Long replies are chunked at 500 chars (Mastodon's default — many instances raise this; 500 is the safe floor).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MASTODON_INSTANCE_URL and MASTODON_ACCESS_TOKEN are required` | env vars missing | Export them or add to `.env` |
| `[mastodon] stream error: 401` | token invalid / revoked | Regenerate the access token in Preferences → Development |
| Messages silently ignored | `MASTODON_DM_ONLY=true` and status is public | Set `MASTODON_DM_ONLY=false` or DM the bot instead of mentioning |
| Bridge reconnects in a loop | instance WebSocket disabled | Some instances disable streaming; use a different instance or run locally |

## Security notes

- The access token grants full read + write + push to the bot account. Treat like a password.
- Bot accounts are best created as separate accounts — revoking the token won't affect your main identity.
- Allowlisting via `MASTODON_ALLOWED_ACCTS` is recommended for personal agents. Without it, anyone who mentions the bot will get a reply.
- Image attachments are re-fetched from Mastodon's media CDN, base64 encoded, and forwarded to MulmoClaude. They don't transit any third party.

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
- [`@mulmobridge/mastodon`](https://www.npmjs.com/package/@mulmobridge/mastodon) — Mastodon DMs + mentions  ← **this package**
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
