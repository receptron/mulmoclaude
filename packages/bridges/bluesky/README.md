# @mulmobridge/bluesky

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

Bluesky bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Speaks the `chat.bsky.convo.*` XRPC API (Bluesky Direct Messages) via your PDS with the `atproto-proxy` header. Polls for new message events every few seconds — outbound-only, **no public URL needed**.

## Setup

### 1. Create an app password

1. Log into [bsky.app](https://bsky.app) as the account you want to use as the bot (a dedicated bot handle is recommended).
2. Go to **Settings → Privacy and security → App Passwords → Add App Password**.
3. Name it (e.g. `MulmoClaude`). Copy the password — you won't see it again.

> Note: app passwords now require opting in to chat access during creation. Ensure the "Allow access to your direct messages" toggle is **on**.

### 2. Run the bridge

```bash
# Testing with mock server
npx @mulmobridge/mock-server &
BLUESKY_HANDLE=mulmobot.bsky.social \
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
MULMOCLAUDE_AUTH_TOKEN=mock-test-token \
npx @mulmobridge/bluesky

# With real MulmoClaude
BLUESKY_HANDLE=mulmobot.bsky.social \
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
npx @mulmobridge/bluesky
```

Send a DM to the bot account from another Bluesky account — you'll get a reply.

## Environment variables

| Variable                 | Required | Default                  | Description |
|--------------------------|----------|--------------------------|-------------|
| `BLUESKY_HANDLE`         | yes      | —                        | Bot handle, e.g. `mulmobot.bsky.social` |
| `BLUESKY_APP_PASSWORD`   | yes      | —                        | App password with chat access enabled |
| `BLUESKY_SERVICE`        | no       | `https://bsky.social`    | PDS URL (override only for third-party PDSes) |
| `BLUESKY_ALLOWED_DIDS`   | no       | (all)                    | CSV of DIDs allowed to converse — e.g. `did:plc:abc123,did:plc:def456`. Empty = accept everyone |
| `MULMOCLAUDE_AUTH_TOKEN` | no       | auto                     | Override for the MulmoClaude bearer token |
| `MULMOCLAUDE_API_URL`    | no       | auto (`.server-port`, else `http://localhost:3001`)  | MulmoClaude server URL |

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

1. The bridge logs into the bot's PDS with the app password (`com.atproto.server.createSession`), gets an `accessJwt` + `refreshJwt`, and caches them. Expired access tokens are refreshed transparently on 401.
2. Every ~3 s it calls `chat.bsky.convo.getLog` (with the `atproto-proxy: did:web:api.bsky.chat#bsky_chat` header) and processes any `logCreateMessage` entries whose sender isn't the bot itself.
3. The sender's DID is checked against the allowlist (if configured), the message text is forwarded to MulmoClaude with `convoId` as the `externalChatId`, and the reply is sent via `chat.bsky.convo.sendMessage`.
4. Long replies are chunked at 10 000 chars (Bluesky's DM limit).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `createSession failed: 401` | wrong handle or app password | Double-check handle (include `.bsky.social`) and regenerate the app password |
| `chat.bsky.convo.getLog: 403` | app password lacks chat access | Delete and recreate the app password with "Allow access to your direct messages" enabled |
| Bot replies to itself | unlikely — we filter on `sender.did === selfDid`, but if you see it, open an issue | — |
| Messages silently ignored | DID not in `BLUESKY_ALLOWED_DIDS` | Add it to the allowlist, or unset the env var to allow all |

## Security notes

- App passwords are scoped to the bot account only — they can't see or post from your main account. Still, treat like a password.
- A dedicated bot account is strongly recommended; reuse of a personal account means DMs to you become bot-processable.
- Allowlisting via `BLUESKY_ALLOWED_DIDS` is recommended for personal agents. Without it, anyone who DMs the bot can converse with your MulmoClaude.
- No image / embed forwarding in this version — DMs with attachments are delivered as text-only to MulmoClaude. Image support may land in a follow-up once Bluesky DMs officially support media.

## Ecosystem

Part of the [`@mulmobridge/*`](https://www.npmjs.com/~mulmobridge) package family.

**Shared libraries:**

- [`@mulmobridge/client`](https://www.npmjs.com/package/@mulmobridge/client) — socket.io client library used by every bridge below
- [`@mulmobridge/protocol`](https://www.npmjs.com/package/@mulmobridge/protocol) — wire types and constants
- [`@mulmobridge/chat-service`](https://www.npmjs.com/package/@mulmobridge/chat-service) — server-side relay + session store
- [`@mulmobridge/relay`](https://www.npmjs.com/package/@mulmobridge/relay) — Cloudflare Workers webhook proxy
- [`@mulmobridge/mock-server`](https://www.npmjs.com/package/@mulmobridge/mock-server) — mock server for local bridge development

**Bridges** (one npm package per platform):

- [`@mulmobridge/bluesky`](https://www.npmjs.com/package/@mulmobridge/bluesky) — Bluesky DMs over atproto  ← **this package**
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
