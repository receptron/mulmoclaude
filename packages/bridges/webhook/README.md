# @mulmobridge/webhook

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

Generic HTTP-webhook bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). POST JSON to a local endpoint, get the AI reply back in the response body. Useful developer glue for:

- Shell scripts & cron jobs (`curl` to talk to your agent)
- Zapier / n8n / Make / Pipedream webhooks
- Home Assistant automations
- CI / CD pipelines
- Any HTTP-speaking tool

## Quick start

```bash
# Start the bridge (with MulmoClaude running on :3001)
npx @mulmobridge/webhook

# In another terminal
curl -X POST http://localhost:3009/webhook \
  -H 'Content-Type: application/json' \
  -d '{"chatId":"demo","text":"hello from curl"}'

# → {"ok":true,"reply":"Hello! How can I help?"}
```

## Payload

```json
{
  "chatId": "optional-conversation-id",
  "text":  "what the user said"
}
```

- `text` (required) — the user message, non-empty string.
- `chatId` (optional) — conversation key. Reuse the same value across requests to keep a session. Defaults to `"default"` if omitted.

## Response

**Success (200)**:
```json
{ "ok": true, "reply": "…AI reply…" }
```

**Client error (400)** — malformed body.
**Unauthorized (401)** — secret mismatch.
**Upstream error (502)** — MulmoClaude refused / timed out.

## Environment variables

| Variable            | Required | Default    | Description |
|---------------------|----------|------------|-------------|
| `WEBHOOK_PORT`      | no       | `3009`     | HTTP port |
| `WEBHOOK_PATH`      | no       | `/webhook` | Endpoint path |
| `WEBHOOK_SECRET`    | yes (prod) | —        | Shared secret. Every request must include `x-webhook-secret: <value>` header (constant-time compared). The bridge refuses to start without a secret unless `WEBHOOK_ALLOW_OPEN=1` is also set. |
| `WEBHOOK_ALLOW_OPEN`| no       | —          | Set to `1` to run without `WEBHOOK_SECRET` (local testing only). Prints a loud warning and leaves the endpoint unauthenticated — every POST will drive an LLM call. Do **not** expose publicly. |
| `MULMOCLAUDE_AUTH_TOKEN` | no  | auto       | MulmoClaude bearer token override |
| `MULMOCLAUDE_API_URL` | no     | auto (`.server-port`, else `http://localhost:3001`) | MulmoClaude server URL |

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

## Examples

### Shell alias

```bash
alias claude-ask='curl -sS -X POST http://localhost:3009/webhook -H "Content-Type: application/json" -d "$(jq -nR --arg t "$1" -- '\''{text:$t}'\'')" | jq -r .reply'
claude-ask "summarize today's calendar"
```

### With secret

```bash
WEBHOOK_SECRET=$(openssl rand -hex 16) npx @mulmobridge/webhook

curl -X POST http://localhost:3009/webhook \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"text":"hi"}'
```

### Home Assistant

```yaml
rest_command:
  ask_claude:
    url: http://localhost:3009/webhook
    method: POST
    content_type: application/json
    payload: '{"chatId":"home-assistant","text":"{{ question }}"}'
```

## How it works

1. Express listens on `WEBHOOK_PORT` at `WEBHOOK_PATH`.
2. On POST, the secret (if configured) is checked constant-time. The body is parsed as JSON; `text` is required, `chatId` optional (defaults to `"default"`).
3. The bridge forwards to MulmoClaude via `createBridgeClient(...).send()` and streams the reply back synchronously in the HTTP response body.

Push delivery is **not supported** — this endpoint is request/response only. Use a platform-specific bridge (Telegram, LINE, Slack, …) if you need server-initiated push.

## Security notes

- Run only on `localhost` unless you set `WEBHOOK_SECRET`. Without a secret, anyone reaching the port can converse with your agent.
- HTTPS / reverse-proxy is your responsibility if you expose this beyond localhost.
- The secret is compared in constant time — timing attacks won't leak its length after the first character.
- No rate limiting built in. Layer a reverse proxy (nginx, Cloudflare, etc.) for public exposure.

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
- [`@mulmobridge/viber`](https://www.npmjs.com/package/@mulmobridge/viber) — Viber Public Account bots
- [`@mulmobridge/webhook`](https://www.npmjs.com/package/@mulmobridge/webhook) — generic HTTP webhook bridge  ← **this package**
- [`@mulmobridge/whatsapp`](https://www.npmjs.com/package/@mulmobridge/whatsapp) — WhatsApp Cloud API via MulmoBridge relay
- [`@mulmobridge/xmpp`](https://www.npmjs.com/package/@mulmobridge/xmpp) — XMPP / Jabber
- [`@mulmobridge/zulip`](https://www.npmjs.com/package/@mulmobridge/zulip) — Zulip

## Related projects

Published from the MulmoClaude monorepo by [Receptron](https://github.com/receptron).

- **[MulmoClaude](https://github.com/receptron/mulmoclaude)** — an open-source AI assistant platform that runs on your own computer. Claude Code as the engine, a personal wiki for long-term memory, schema-driven collections for your data, and chat that summons the right GUI (markdown, charts, forms, spreadsheets, wikis) for each task.
- **[MulmoTerminal](https://github.com/receptron/mulmoterminal)** — a terminal-first cockpit for running many AI coding agents in parallel. One roster showing every session's summary and PR status, tmux-backed session persistence, git-worktree isolation, one-click PRs, and mobile push with remote reply.
- **[MulmoTerminal manual](https://receptron.github.io/mulmoterminal/)** — setup, workflows, feature reference, configuration, mobile notifications, and alternative / local model providers. Available in English and Japanese.
