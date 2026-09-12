# @mulmobridge/signal

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

Signal bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Talks to a locally running [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) daemon — typically a Docker container — over WebSocket (incoming) + REST (outgoing). The daemon handles the actual Signal network, so this bridge stays stateless and lightweight.

## Architecture

```text
  Signal network
        │
        ▼
┌────────────────────────┐      ┌───────────────────────────┐
│ signal-cli-rest-api    │◄────►│ @mulmobridge/signal        │────► MulmoClaude
│ (Docker on your host)  │      │ (WebSocket receive,        │
│ port 8080              │      │  REST send)                │
└────────────────────────┘      └───────────────────────────┘
```

## Setup

### 1. Run signal-cli-rest-api

Easiest way — Docker:

```bash
docker run -d --name signal-api --restart=always \
  -p 8080:8080 \
  -v $HOME/.local/share/signal-api:/home/.local/share/signal-cli \
  -e 'MODE=json-rpc' \
  bbernhard/signal-cli-rest-api
```

### 2. Register (or link) a Signal number

Two options — pick one:

**Register a new number** (you'll receive a verification SMS / voice call):

```bash
curl -X POST http://localhost:8080/v1/register/+81901234567
curl -X POST http://localhost:8080/v1/register/+81901234567/verify/123456
```

**Link as a secondary device** (uses your existing Signal account; pair via QR code — see [signal-cli-rest-api docs](https://github.com/bbernhard/signal-cli-rest-api#link-a-device)).

### 3. Run the bridge

```bash
# Testing with mock server
npx @mulmobridge/mock-server &
SIGNAL_API_URL=http://localhost:8080 \
SIGNAL_NUMBER=+81901234567 \
MULMOCLAUDE_AUTH_TOKEN=mock-test-token \
npx @mulmobridge/signal

# With real MulmoClaude
SIGNAL_API_URL=http://localhost:8080 \
SIGNAL_NUMBER=+81901234567 \
npx @mulmobridge/signal
```

Send a Signal message to the bot number from another Signal account — you'll get a reply.

## Environment variables

| Variable                 | Required | Default | Description |
|--------------------------|----------|---------|-------------|
| `SIGNAL_API_URL`         | yes      | —       | signal-cli-rest-api base URL, e.g. `http://localhost:8080` |
| `SIGNAL_NUMBER`          | yes      | —       | Bot's registered Signal number in E.164 form (e.g. `+81901234567`) |
| `SIGNAL_ALLOWED_NUMBERS` | no       | (all)   | CSV of sender numbers allowed, e.g. `+81901111111,+81902222222`. Empty = accept everyone |
| `MULMOCLAUDE_AUTH_TOKEN` | no       | auto    | MulmoClaude bearer token override |
| `MULMOCLAUDE_API_URL`    | no       | auto (`.server-port`; waits if nothing is published) | MulmoClaude server URL |

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

1. The bridge opens a WebSocket to `ws://<SIGNAL_API_URL>/v1/receive/<SIGNAL_NUMBER>`. The daemon relays every inbound Signal envelope to this stream as JSON.
2. For each envelope containing a `dataMessage.message`, the bridge verifies the sender is in the allowlist (if set), then forwards the text to MulmoClaude keyed by the sender's phone number.
3. Replies are POSTed back via `POST /v2/send` with `number` (bot) + `recipients` (sender), chunked at 4 000 chars.
4. Stream drops are recovered via exponential backoff reconnect.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `stream error: ECONNREFUSED` | daemon not running or wrong port | `docker logs signal-api`; check `SIGNAL_API_URL` |
| `send failed: 400` | number not registered to the daemon | Re-register or re-link |
| No messages appear | daemon not in `json-rpc` mode | Restart the container with `-e MODE=json-rpc` |
| Duplicate replies | Multiple bridge processes attached to the same daemon | Ensure only one instance is running |

## Security notes

- signal-cli-rest-api stores the Signal private key under its data volume. **Back up and protect this volume** — loss = re-registration; leak = account impersonation.
- Bind the daemon to `localhost` (or a private network) — never expose port 8080 to the public internet.
- Use `SIGNAL_ALLOWED_NUMBERS` to limit who can converse with your agent. Signal doesn't have spam filtering as strict as some platforms.
- A dedicated Signal number is strongly recommended. Linking as a secondary device reuses your personal account, which means bot replies come from your own identity.

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
- [`@mulmobridge/signal`](https://www.npmjs.com/package/@mulmobridge/signal) — Signal via signal-cli-rest-api  ← **this package**
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
