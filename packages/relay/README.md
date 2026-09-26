# @mulmobridge/relay

Cloudflare Workers relay for MulmoBridge. Receives webhooks from messaging platforms (LINE, WhatsApp, Messenger, Google Chat, Telegram, Microsoft Teams), queues messages when MulmoClaude is offline, and forwards them via WebSocket when connected.

## Why

Without the relay, webhook-based bridges (LINE, Messenger, Google Chat, Teams, …) need a public URL — typically via ngrok, which requires manual URL updates on every restart. (Slack is supported separately via `@mulmobridge/slack`, which uses Socket Mode on the user's machine and doesn't need the relay.)

With the relay:

- **Fixed URL** — `<your-name>.workers.dev` never changes
- **Offline queue** — messages are stored and delivered when MulmoClaude reconnects
- **Multi-platform** — one relay handles all platforms simultaneously
- **No ngrok** — deploy once, use forever

## Architecture

```text
LINE ─────────→ /webhook/line         ┐
WhatsApp ─────→ /webhook/whatsapp     │
Messenger ────→ /webhook/messenger    │
Google Chat ──→ /webhook/google-chat  ├→ Durable Object → WS → MulmoClaude
Telegram ─────→ /webhook/telegram     │   (queue if offline)    (home PC)
Teams ────────→ /webhook/teams        ┘
```

## Setup

### 1. Deploy the relay

```bash
# Install wrangler (Cloudflare CLI)
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Clone and deploy
cd packages/relay
wrangler deploy
```

### 2. Configure secrets

Only register secrets for platforms you actually use — the relay's `/health` endpoint reports `configured: true/false` per platform based on whether its secrets are present.

```bash
# Relay authentication token (shared with MulmoClaude) — always required
wrangler secret put RELAY_TOKEN
```

#### LINE

```bash
wrangler secret put LINE_CHANNEL_SECRET        # "Channel secret" in LINE console
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN  # "Channel access token (long-lived)"
```

#### WhatsApp (Meta Cloud API)

```bash
wrangler secret put WHATSAPP_APP_SECRET        # Meta app → Settings → Basic → App Secret
wrangler secret put WHATSAPP_VERIFY_TOKEN      # arbitrary string, repeated in the console verification step
wrangler secret put WHATSAPP_ACCESS_TOKEN      # WhatsApp → API Setup → Access Token
wrangler secret put WHATSAPP_PHONE_NUMBER_ID   # WhatsApp → API Setup → From (Phone Number ID)
```

#### Messenger

```bash
wrangler secret put MESSENGER_APP_SECRET        # Meta app → Settings → Basic → App Secret
wrangler secret put MESSENGER_VERIFY_TOKEN      # arbitrary string, repeated in the console verification step
wrangler secret put MESSENGER_PAGE_ACCESS_TOKEN # Meta app → Messenger → Settings → Page token
```

#### Google Chat

```bash
wrangler secret put GOOGLE_CHAT_PROJECT_NUMBER       # GCP project number (verifies inbound JWT audience)
wrangler secret put GOOGLE_CHAT_SERVICE_ACCOUNT_KEY  # Service-account JSON — paste the full JSON at the prompt
```

#### Telegram

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

#### Microsoft Teams

```bash
wrangler secret put MICROSOFT_APP_ID                # Azure Bot → Configuration → Microsoft App ID
wrangler secret put MICROSOFT_APP_PASSWORD          # Client secret generated for that app
# Only for SingleTenant apps:
wrangler secret put MICROSOFT_APP_TENANT_ID
# Optional: AAD user object ID allowlist (CSV)
wrangler secret put TEAMS_ALLOWED_USERS
```

Also set `MICROSOFT_APP_TYPE` under `[vars]` in `wrangler.toml` (values: `MultiTenant` — default — or `SingleTenant`). It's non-sensitive, so it belongs in vars, not secrets.

### 3. Set webhook URLs in platform consoles

| Platform    | Webhook URL                                      | Where to register                                                                                                                                 |
| ----------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| LINE        | `https://<name>.workers.dev/webhook/line`        | [LINE Developers Console](https://developers.line.biz/console/) → channel → **Messaging API** → **Webhook URL**                                   |
| WhatsApp    | `https://<name>.workers.dev/webhook/whatsapp`    | [Meta for Developers](https://developers.facebook.com/apps/) → WhatsApp → **Configuration** → **Webhook** (use `WHATSAPP_VERIFY_TOKEN` at prompt) |
| Messenger   | `https://<name>.workers.dev/webhook/messenger`   | [Meta for Developers](https://developers.facebook.com/apps/) → Messenger → **Settings** → **Webhooks** (use `MESSENGER_VERIFY_TOKEN` at prompt)   |
| Google Chat | `https://<name>.workers.dev/webhook/google-chat` | [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Google Chat API → **Configuration** → **App URL**                   |
| Telegram    | `https://<name>.workers.dev/webhook/telegram`    | Set via Bot API call (see below)                                                                                                                  |
| Teams       | `https://<name>.workers.dev/webhook/teams`       | [Azure Portal](https://portal.azure.com/) → Azure Bot resource → **Configuration** → **Messaging endpoint**                                       |

Telegram is the odd one out — no GUI, set via API:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<name>.workers.dev/webhook/telegram&secret_token=<SECRET>"
```

**Meta-family verify token note**: Both WhatsApp and Messenger use the Graph webhook verification handshake. When you paste the webhook URL in the Meta console, it prompts for a "Verify Token" — enter the same string you stored in `WHATSAPP_VERIFY_TOKEN` / `MESSENGER_VERIFY_TOKEN` respectively. The relay's GET handler returns the `hub.challenge` echo only when the token matches.

### 4. Connect MulmoClaude

Add to `.env`:

```dotenv
RELAY_URL=wss://<name>.workers.dev/ws
RELAY_TOKEN=<same token as step 2>
```

## Endpoints

| Method | Path                   | Description                                                                                                                    |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/health`              | Health check + configured platforms                                                                                            |
| GET    | `/ws`                  | WebSocket (MulmoClaude connection, bearer auth)                                                                                |
| POST   | `/webhook/line`        | LINE webhook (HMAC-SHA256 verified)                                                                                            |
| POST   | `/webhook/whatsapp`    | WhatsApp Cloud API webhook (Meta signature + `hub.verify_token` echo for GET)                                                  |
| POST   | `/webhook/messenger`   | Messenger webhook (Meta signature + `hub.verify_token` echo for GET)                                                           |
| POST   | `/webhook/google-chat` | Google Chat webhook (JWT `iss=chat@system.gserviceaccount.com`, audience = `GOOGLE_CHAT_PROJECT_NUMBER`)                       |
| POST   | `/webhook/telegram`    | Telegram webhook (secret token verified)                                                                                       |
| POST   | `/webhook/teams`       | Microsoft Teams webhook (Azure AD JWT verified, aud = `MICROSOFT_APP_ID`; non-message activities acked 200 without forwarding) |

## Per-platform default role (host-app side)

The MulmoClaude server can pin a different default role per relay platform. Set these env vars on the **host app** (the MulmoClaude process that connects to this Worker — _not_ on the Worker itself):

| Variable                          | Effect                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- |
| `RELAY_DEFAULT_ROLE`              | Blanket fallback applied to every relay-routed platform                 |
| `RELAY_LINE_DEFAULT_ROLE`         | LINE-only override                                                      |
| `RELAY_WHATSAPP_DEFAULT_ROLE`     | WhatsApp-only override                                                  |
| `RELAY_MESSENGER_DEFAULT_ROLE`    | Messenger-only override                                                 |
| `RELAY_GOOGLE_CHAT_DEFAULT_ROLE`  | Google Chat-only override (note `_GOOGLE_CHAT_`, not `_GOOGLE-CHAT_`)   |
| `RELAY_TEAMS_DEFAULT_ROLE`        | Microsoft Teams-only override                                           |

Per-platform overrides win over the blanket form on conflict. A new chat session opened via a relay-forwarded message starts in the resolved role; existing sessions keep whatever role they were created with. See [#739](https://github.com/receptron/mulmoclaude/issues/739) for the design and `server/events/resolveRelayBridgeOptions.ts` for the implementation.

The reply timeout — how long the host waits for the agent before replying with whatever text has streamed so far (default 5 minutes) — resolves the same way: `RELAY_REPLY_TIMEOUT_MS` for every platform, `RELAY_<PLATFORM>_REPLY_TIMEOUT_MS` for one, in milliseconds.

For symmetry: native bridge processes (e.g. `yarn slack`) use `<TRANSPORT>_BRIDGE_DEFAULT_ROLE` / `<TRANSPORT>_BRIDGE_REPLY_TIMEOUT_MS` instead — that scrape lives in `@mulmobridge/client`. The two schemes are intentionally parallel; pick the one matching your deployment topology.

## Security

- **Webhook verification**: Each platform's signature is verified before processing
- **WebSocket auth**: Bearer token required for MulmoClaude connection
- **TLS**: All connections are HTTPS/WSS (Cloudflare provides certificates)
- **1-connection limit**: Only one MulmoClaude can connect at a time
- **Body size limit**: 1MB max per webhook request
- **Queue limit**: 1000 messages max (oldest dropped when exceeded)

## Adding a new platform (developer notes)

The relay uses a plugin architecture. Each platform is a self-contained
file in `src/webhooks/` that implements `PlatformPlugin`:

```typescript
// src/webhooks/google-chat.ts (real example — ship shape)
const googleChatPlugin: PlatformPlugin = {
  name: PLATFORMS.googleChat,
  mode: CONNECTION_MODES.webhook,
  webhookPath: "/webhook/google-chat",
  isConfigured: (env) => !!env.GOOGLE_CHAT_PROJECT_NUMBER,
  handleWebhook: async (request, body, env) => {
    /* verify JWT, parse event, return RelayMessage[] */
  },
  sendResponse: async (chatId, text, env) => {
    /* POST to https://chat.googleapis.com/v1/{chatId}/messages */
  },
};
registerPlatform(googleChatPlugin);
```

Three connection modes are defined in `CONNECTION_MODES`; today only `webhook` is wired up (every real plugin uses it). `polling` and `persistent` are reserved for future platforms that can't post webhooks — e.g. a Discord Gateway integration would be `persistent`.

| Mode         | Examples (shipped)                                       | Method                          |
| ------------ | -------------------------------------------------------- | ------------------------------- |
| `webhook`    | LINE, WhatsApp, Messenger, Google Chat, Telegram, Teams  | Platform POSTs to relay URL     |
| `polling`    | — (reserved)                                             | Relay fetches from platform API |
| `persistent` | — (reserved)                                             | Relay maintains WS to platform  |

### Relay vs Bridge packages

|                | Relay              | Bridge (`@mulmobridge/*`) |
| -------------- | ------------------ | ------------------------- |
| Runs on        | Cloud (CF Workers) | User's computer           |
| Public URL     | Permanent          | Requires ngrok            |
| Offline queue  | Yes                | No                        |
| Multi-platform | One relay          | One process each          |

Both can coexist. Some platforms via Relay, others via local Bridge.

## Ecosystem

Part of the [`@mulmobridge/*`](https://www.npmjs.com/~mulmobridge) package family.

**Shared libraries:**

- [`@mulmobridge/client`](https://www.npmjs.com/package/@mulmobridge/client) — socket.io client library used by every bridge below
- [`@mulmobridge/protocol`](https://www.npmjs.com/package/@mulmobridge/protocol) — wire types and constants
- [`@mulmobridge/chat-service`](https://www.npmjs.com/package/@mulmobridge/chat-service) — server-side relay + session store
- [`@mulmobridge/relay`](https://www.npmjs.com/package/@mulmobridge/relay) — Cloudflare Workers webhook proxy  ← **this package**
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

MIT
