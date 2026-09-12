# @mulmobridge/line

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

LINE bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Uses webhook events — requires a public URL (ngrok for development).

## Setup

### 1. Create a LINE Messaging API Channel

1. Go to [LINE Developers Console](https://developers.line.biz/console/) → create a Provider → create a **Messaging API** channel
2. Note the **Channel secret** (Basic settings tab)
3. Issue a **Channel access token** (Messaging API tab → long-lived)

### 2. Set up ngrok (for development)

[ngrok](https://ngrok.com) is a tunneling tool that exposes a local port to the internet so LINE's webhooks can reach your machine.

```bash
brew install ngrok
ngrok config add-authtoken <your-token>  # from ngrok dashboard
ngrok http 3002
# Copy the https://xxxx.ngrok-free.app URL
```

### 3. Configure the webhook

In the LINE Developers Console → Messaging API tab:

- **Webhook URL**: `https://xxxx.ngrok-free.app/webhook` — the trailing `/webhook` is **required** (without it you get 404)
- **Use webhook**: enabled
- **Auto-reply messages**: disabled (LINE Official Account settings → Auto-reply messages → OFF, otherwise you get double replies)

### 4. Run the bridge

```bash
# With mock server (testing)
npx @mulmobridge/mock-server &
LINE_CHANNEL_SECRET=... \
LINE_CHANNEL_ACCESS_TOKEN=... \
MULMOCLAUDE_AUTH_TOKEN=mock-test-token \
npx @mulmobridge/line

# With real MulmoClaude
LINE_CHANNEL_SECRET=... \
LINE_CHANNEL_ACCESS_TOKEN=... \
npx @mulmobridge/line
```

### 5. Add the bot as a friend

Scan the QR code in the LINE Developers Console → Messaging API tab. Send a message — MulmoClaude replies.

## Environment Variables

| Variable                    | Required | Description                                                                                                                                                                                                                                                                 |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LINE_CHANNEL_SECRET`       | Yes      | Channel secret for signature verification                                                                                                                                                                                                                                   |
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes      | Long-lived channel access token                                                                                                                                                                                                                                             |
| `LINE_BRIDGE_PORT`          | No       | Webhook port (default: 3002; `0` asks the OS for a free port)                                                                                                                                                                                                               |
| `MULMOCLAUDE_API_URL`       | No       | Default: auto (`.server-port`; waits if nothing is published)                                                                                                                                                                                                               |
| `MULMOCLAUDE_AUTH_TOKEN`    | No       | Bearer token                                                                                                                                                                                                                                                                |
| `LINE_BRIDGE_DEFAULT_ROLE`  | No       | Role id to seed new bridge sessions with (e.g. `coder`, `general`). Applied ONLY when a line session first appears — once the user switches role via `/role <id>` the session's own role wins. Unknown role ids silently fall back to the server's default with a warn log. |
| `BRIDGE_DEFAULT_ROLE`       | No       | Same as above but shared across every bridge. Transport-specific `LINE_BRIDGE_DEFAULT_ROLE` wins when both are set.                                                                                                                                                         |

An unusable value (a typo, a number outside 0-65535) stops the bridge with a message naming
the variable, rather than silently starting on the default. A port already in use is reported
the same way (#3084).

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

## Notes

- LINE reply tokens expire in **1 minute**. Since Claude responses can take longer, the bridge uses **push messages** instead of reply messages. This requires your bot to be a verified/certified account for push to work with all users, OR the user must have added the bot as a friend first.
- LINE limits messages to 5 per push call and ~5000 chars per message. Long replies are automatically chunked.
- **Inbound media** — text and image messages are forwarded to the agent. Image bytes are downloaded via the LINE Data API (`/v2/bot/message/<id>/content`) using the same channel access token; the actual format (JPEG / PNG / HEIC depending on sender) is preserved via the response Content-Type. The photo-EXIF auto-capture flow ([#1222](https://github.com/receptron/mulmoclaude/issues/1222)) writes a sidecar at `data/locations/...` when GPS data is present. Video / audio / file / sticker messages are not forwarded yet.

## Detailed Setup Guide

For step-by-step instructions with troubleshooting:

- [English](https://github.com/receptron/mulmoclaude/blob/main/docs/message_apps/line/README.md)
- [Japanese](https://github.com/receptron/mulmoclaude/blob/main/docs/message_apps/line/README.ja.md)

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
- [`@mulmobridge/line`](https://www.npmjs.com/package/@mulmobridge/line) — LINE Messaging API via MulmoBridge relay ← **this package**
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
