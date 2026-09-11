# @mulmobridge/viber

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

[Viber](https://www.viber.com/) Public Account chatbot bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Receives user messages via HTTPS webhook, replies via the Viber Bot REST API. Popular in Eastern Europe, Southeast Asia, and parts of the Middle East.

**Public URL required** (Viber only supports webhook delivery).

## Setup

### 1. Create a Public Account (Bot)

1. Open Viber app → **More → Public Accounts → Create Account**.
2. Complete the onboarding; pick a category.
3. On the admin panel ([partners.viber.com](https://partners.viber.com/)) → **Your Account → Edit Info → Chatbot / Subscribe Bot** → copy the **Authentication Token**.

### 2. Expose the bridge

```bash
ngrok http 3012
# → https://abcd.ngrok-free.app
```

### 3. Set the webhook

Once you have the public URL, register it with Viber. Either via the admin panel, or via a one-off HTTP call:

```bash
curl -X POST https://chatapi.viber.com/pa/set_webhook \
  -H "X-Viber-Auth-Token: <VIBER_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://abcd.ngrok-free.app/viber","event_types":["message"]}'
```

### 4. Run the bridge

```bash
VIBER_AUTH_TOKEN=... \
npx @mulmobridge/viber
```

Send a message to your Public Account from the Viber app — you'll get a reply.

## Environment variables

| Variable               | Required | Default         | Description |
|------------------------|----------|-----------------|-------------|
| `VIBER_AUTH_TOKEN`     | yes      | —               | Public Account auth token from the admin panel |
| `VIBER_SENDER_NAME`    | no       | `MulmoClaude`   | Display name used on outbound messages |
| `VIBER_WEBHOOK_PORT`   | no       | `3012`          | HTTP port |
| `VIBER_ALLOWED_USERS`  | no       | (all)           | CSV of Viber user IDs allowed (empty = everyone who messages the bot) |
| `MULMOCLAUDE_AUTH_TOKEN` | no     | auto            | MulmoClaude bearer token override |
| `MULMOCLAUDE_API_URL`  | no       | auto (`.server-port`, else `http://localhost:3001`) | MulmoClaude server URL |

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

1. Viber POSTs event JSON to `/viber` with an `X-Viber-Content-Signature` header (HMAC-SHA256 of the raw body keyed on the auth token).
2. The bridge verifies the signature in constant time and ACKs `200` immediately so Viber doesn't retry.
3. For `event:"message"` with `message.type === "text"`, the bridge runs the allowlist, then forwards `message.text` to MulmoClaude keyed by `sender.id`.
4. Replies go out via `POST /pa/send_message` with the auth token in the `X-Viber-Auth-Token` header. Chunked at 7 000 chars.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Webhook registration returns `{"status":10,"status_message":"No URL parameter supplied."}` | Typo in set_webhook call | Re-check JSON body |
| Invalid signature on all events | Rotation mismatch between `VIBER_AUTH_TOKEN` and the token used to register the webhook | Re-register the webhook using the current token |
| `send non-zero status: {"status":6,…}` | Receiver hasn't messaged your bot first | Viber requires the user to start the conversation before you can push to them |

## Security notes

- The auth token is both the bot's identity and the webhook signing key — rotate it via the admin panel if it leaks.
- `VIBER_ALLOWED_USERS` is recommended. Without it, anyone who finds your Public Account can chat with your agent.
- Viber's chat history is controlled by the Viber app — the bridge itself keeps no local message log.

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
- [`@mulmobridge/twilio-sms`](https://www.npmjs.com/package/@mulmobridge/twilio-sms) — SMS via Twilio Programmable Messaging
- [`@mulmobridge/viber`](https://www.npmjs.com/package/@mulmobridge/viber) — Viber Public Account bots  ← **this package**
- [`@mulmobridge/webhook`](https://www.npmjs.com/package/@mulmobridge/webhook) — generic HTTP webhook bridge
- [`@mulmobridge/whatsapp`](https://www.npmjs.com/package/@mulmobridge/whatsapp) — WhatsApp Cloud API via MulmoBridge relay
- [`@mulmobridge/xmpp`](https://www.npmjs.com/package/@mulmobridge/xmpp) — XMPP / Jabber
- [`@mulmobridge/zulip`](https://www.npmjs.com/package/@mulmobridge/zulip) — Zulip

## Related projects

Published from the MulmoClaude monorepo by [Receptron](https://github.com/receptron).

- **[MulmoClaude](https://github.com/receptron/mulmoclaude)** — an open-source AI assistant platform that runs on your own computer. Claude Code as the engine, a personal wiki for long-term memory, schema-driven collections for your data, and chat that summons the right GUI (markdown, charts, forms, spreadsheets, wikis) for each task.
- **[MulmoTerminal](https://github.com/receptron/mulmoterminal)** — a terminal-first cockpit for running many AI coding agents in parallel. One roster showing every session's summary and PR status, tmux-backed session persistence, git-worktree isolation, one-click PRs, and mobile push with remote reply.
- **[MulmoTerminal manual](https://receptron.github.io/mulmoterminal/)** — setup, workflows, feature reference, configuration, mobile notifications, and alternative / local model providers. Available in English and Japanese.
