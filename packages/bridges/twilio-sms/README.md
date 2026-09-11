# @mulmobridge/twilio-sms

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

SMS bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude) via [Twilio Programmable Messaging](https://www.twilio.com/messaging). Every phone on Earth can text your AI agent — no app install needed.

**Public URL required** (Twilio posts a webhook every time an SMS arrives on your number).

## Setup

### 1. Get a Twilio number

1. Sign up at [twilio.com](https://www.twilio.com/) (trial includes credits).
2. **Phone Numbers → Buy a Number** → pick one with SMS capability.
3. Note the **Account SID** + **Auth Token** (Twilio console top-right / Settings → General).

### 2. Expose the bridge with a tunnel

```bash
ngrok http 3010
# copy the https URL — e.g. https://abcd.ngrok-free.app
```

### 3. Configure the Twilio number

In the Twilio console, open the number → **Messaging → A Message Comes In** → Webhook, method **HTTP POST** → URL `https://<your-tunnel>/sms`.

### 4. Run the bridge

```bash
TWILIO_ACCOUNT_SID=AC... \
TWILIO_AUTH_TOKEN=... \
TWILIO_FROM_NUMBER=+15551234567 \
TWILIO_PUBLIC_URL=https://abcd.ngrok-free.app \
npx @mulmobridge/twilio-sms
```

Text the Twilio number — you'll get a reply.

## Environment variables

| Variable                 | Required    | Default | Description |
|--------------------------|-------------|---------|-------------|
| `TWILIO_ACCOUNT_SID`     | yes         | —       | Twilio Account SID |
| `TWILIO_AUTH_TOKEN`      | yes         | —       | Twilio Auth Token (used for REST + signature verification) |
| `TWILIO_FROM_NUMBER`     | yes         | —       | Your Twilio number in E.164, e.g. `+15551234567` |
| `TWILIO_WEBHOOK_PORT`    | no          | `3010`  | HTTP port |
| `TWILIO_PUBLIC_URL`      | yes (prod)  | —       | Full public URL the bridge is reachable at (e.g. `https://abcd.ngrok-free.app`, including any query string Twilio signs). Required to verify Twilio's `X-Twilio-Signature`. The bridge refuses to start without it unless `TWILIO_ALLOW_UNVERIFIED=1` is also set. |
| `TWILIO_ALLOW_UNVERIFIED`| no          | —       | Set to `1` to skip signature verification (local testing only). Prints a loud warning and leaves `/sms` wide open. Do **not** set in production. |
| `TWILIO_ALLOWED_NUMBERS` | no          | (all)   | CSV of sender E.164 numbers allowed (empty = accept every number) |
| `MULMOCLAUDE_AUTH_TOKEN` | no          | auto    | MulmoClaude bearer token override |
| `MULMOCLAUDE_API_URL`    | no          | auto (`.server-port`, else `http://localhost:3001`) | MulmoClaude server URL |

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

1. Twilio posts form-encoded `From`, `To`, `Body`, `MessageSid` to `/sms` every time an SMS arrives.
2. The bridge verifies `X-Twilio-Signature` (HMAC-SHA1 over the full URL — including query string — + sorted form params) using the auth token. `TWILIO_PUBLIC_URL` must match the URL Twilio sees (scheme + host + optional path prefix); the request's actual query string is read from `req.originalUrl`.
3. We ACK `204` immediately so Twilio doesn't retry, then (asynchronously) forward the trimmed body to MulmoClaude keyed by the sender's number.
4. The reply is sent back via `POST /2010-04-01/Accounts/{SID}/Messages.json` with Basic auth; long replies are chunked at 1 600 chars (Twilio's concatenated-SMS ceiling).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 401 at Twilio side | Signature verification failed | Verify `TWILIO_PUBLIC_URL` matches the URL Twilio actually hits (scheme + host + path, no trailing `/`) |
| No reply delivered | `Messages.json` REST call failing | `docker logs` / `npx` output will show `[twilio-sms] send failed: …`. Common cause: trial account can only message verified numbers |
| Duplicate replies | Twilio retried before ACK | Ensure reachable `https://` endpoint (not HTTP) and the bridge responds 2xx under 15 s |

## Security notes

- The auth token is equivalent to root credentials on your Twilio account. Rotate in the console if leaked.
- `TWILIO_PUBLIC_URL` is strongly recommended — without it, anyone who finds your webhook can impersonate Twilio and converse with your agent.
- Trial Twilio accounts can only SMS pre-verified numbers. Upgrade to production before real use.
- SMS is plaintext — don't discuss secrets over it. Use Signal / WhatsApp / Matrix instead for sensitive content.

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
- [`@mulmobridge/rocketchat`](https://www.npmjs.com/package/@mulmobridge/rocketchat) — Rocket.Chat
- [`@mulmobridge/signal`](https://www.npmjs.com/package/@mulmobridge/signal) — Signal via signal-cli-rest-api
- [`@mulmobridge/slack`](https://www.npmjs.com/package/@mulmobridge/slack) — Slack Socket Mode
- [`@mulmobridge/teams`](https://www.npmjs.com/package/@mulmobridge/teams) — Microsoft Teams via Bot Framework
- [`@mulmobridge/telegram`](https://www.npmjs.com/package/@mulmobridge/telegram) — Telegram bot
- [`@mulmobridge/twilio-sms`](https://www.npmjs.com/package/@mulmobridge/twilio-sms) — SMS via Twilio Programmable Messaging  ← **this package**
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
