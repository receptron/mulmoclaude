# @mulmobridge/line-works

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

[LINE Works](https://line.worksmobile.com/) (enterprise LINE) bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Note: LINE Works is a **separate product** from consumer LINE — use [@mulmobridge/line](../line/) for the consumer app.

**Public URL required** (LINE Works uses webhook delivery).

## Setup

### 1. Register a Bot in Developer Console

1. Go to [Developer Console](https://dev.worksmobile.com/console/) (admin account needed).
2. **API 2.0 → Applications → Create** — note the **Client ID** and **Client Secret**.
3. **Service Account** — create one; note the ID (looks like `abc.serviceaccount@yourdomain`).
4. **Private Key** — generate and download the PEM. Store it safely.
5. Grant the app the scopes **`bot`** and **`bot.message`**.
6. **Bot** → Create → note the numeric **Bot ID** and generate a **Bot secret**.
7. Add your bot to the domain's Bot Directory so members can message it.

### 2. Expose the bridge

```bash
ngrok http 3013
# → https://abcd.ngrok-free.app
```

### 3. Set the callback URL

In the Developer Console → Bot → **Callback URL**: `https://abcd.ngrok-free.app/callback`.
Toggle on the `Message` event.

### 4. Run the bridge

```bash
LINEWORKS_CLIENT_ID=... \
LINEWORKS_CLIENT_SECRET=... \
LINEWORKS_SERVICE_ACCOUNT=abc.serviceaccount@yourdomain \
LINEWORKS_BOT_ID=1234567 \
LINEWORKS_BOT_SECRET=... \
LINEWORKS_PRIVATE_KEY_FILE=./private_key.pem \
npx @mulmobridge/line-works
```

Send the bot a direct message in LINE Works — you'll get a reply.

## Environment variables

| Variable                       | Required | Default | Description |
|--------------------------------|----------|---------|-------------|
| `LINEWORKS_CLIENT_ID`          | yes      | —       | App Client ID |
| `LINEWORKS_CLIENT_SECRET`      | yes      | —       | App Client Secret |
| `LINEWORKS_SERVICE_ACCOUNT`    | yes      | —       | Service account ID |
| `LINEWORKS_BOT_ID`             | yes      | —       | Numeric Bot ID |
| `LINEWORKS_BOT_SECRET`         | yes      | —       | Per-bot secret (used to verify `X-WORKS-Signature` on webhooks) |
| `LINEWORKS_PRIVATE_KEY`        | either   | —       | PEM string (use `\n` for newlines when putting on a single env line) |
| `LINEWORKS_PRIVATE_KEY_FILE`   | either   | —       | Path to PEM file (alternative to inline env) |
| `LINEWORKS_WEBHOOK_PORT`       | no       | `3013`  | HTTP port |
| `LINEWORKS_ALLOWED_USERS`      | no       | (all)   | CSV of sender `userId`s allowed |
| `MULMOCLAUDE_AUTH_TOKEN`       | no       | auto    | MulmoClaude bearer token override |
| `MULMOCLAUDE_API_URL`          | no       | auto (`.server-port`; waits if nothing is published) | MulmoClaude server URL |

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

## How it works

1. On startup, the bridge caches a JWT assertion signed with the service account private key (RS256).
2. When an API call is needed, it exchanges the assertion for an OAuth access token at `https://auth.worksmobile.com/oauth2/v2.0/token` (grant type `jwt-bearer`, scopes `bot bot.message`). The token is cached until ~60 s before expiry.
3. LINE Works POSTs events to `/callback` with `X-WORKS-Signature` (HMAC-SHA256 of the raw body, base64 encoded) keyed on the per-bot secret. The bridge verifies constant-time, ACKs `200` immediately.
4. For `type=message` + text content, the bridge runs the allowlist, forwards the text to MulmoClaude keyed on `source.userId`, and replies via `POST /v1.0/bots/{botId}/users/{userId}/messages`. Replies are chunked at 1 000 chars (LINE Works' per-message limit is ~1000 for text).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `token: 400 invalid_grant` | Private key doesn't match the service account | Re-download the PEM for the exact service account ID |
| `token: 401 invalid_client` | Client ID / secret wrong | Regenerate in Developer Console |
| Webhook never arrives | Callback URL not HTTPS or event types unchecked | Set HTTPS URL; enable `Message` event type |
| `send failed: 403` | Scope missing | Add `bot` + `bot.message` to the app and reauthorize |

## Security notes

- Four secrets: Client Secret, Bot Secret, Service Account Private Key, Access Token. Treat each like a password. Rotate the private key via Developer Console on any suspected leak.
- LINE Works is domain-scoped. A bot only reaches users inside its domain — no accidental external exposure.
- Use `LINEWORKS_ALLOWED_USERS` to limit which domain members can converse with the agent, especially for personal-data rooms.
- Group / channel messaging is not implemented in v0.1.0 — 1:1 only.

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
- [`@mulmobridge/line-works`](https://www.npmjs.com/package/@mulmobridge/line-works) — LINE Works (enterprise LINE)  ← **this package**
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
