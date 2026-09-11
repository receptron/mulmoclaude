# @mulmobridge/nostr

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

[Nostr](https://nostr.com/) encrypted-DM bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Connects to any list of Nostr relays over WebSocket, handles [NIP-04](https://github.com/nostr-protocol/nips/blob/master/04.md) encrypted direct messages, and replies as a signed `kind=4` event. Outbound-only — **no public URL needed**.

## Setup

### 1. Generate a bot key

A brand-new Nostr identity is just a secret key. One-liner:

```bash
node -e "const { generateSecretKey, getPublicKey, nip19 } = require('nostr-tools'); const sk = generateSecretKey(); console.log('NOSTR_PRIVATE_KEY=' + Buffer.from(sk).toString('hex')); console.log('npub: ' + nip19.npubEncode(getPublicKey(sk)));"
```

Or use any Nostr client (Damus / Amethyst / Iris / Primal) to register and export the secret key (`nsec1…`).

### 2. Pick relays

Public, free relays that accept everyone:

- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.snort.social`
- `wss://nostr.wine`
- `wss://relay.nostr.band`

Start with 2–3. More relays = better reach but more network traffic.

### 3. Run the bridge

```bash
NOSTR_PRIVATE_KEY=your-hex-or-nsec \
NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol \
npx @mulmobridge/nostr
```

Send a Nostr DM to the bot's `npub` from any Nostr client — you'll get a reply.

## Environment variables

| Variable                 | Required | Default | Description |
|--------------------------|----------|---------|-------------|
| `NOSTR_PRIVATE_KEY`      | yes      | —       | 64-char hex or `nsec1…` bech32 bot secret key |
| `NOSTR_RELAYS`           | yes      | —       | CSV of `wss://` relay URLs |
| `NOSTR_ALLOWED_PUBKEYS`  | no       | (all)   | CSV of hex pubkeys allowed to DM the bot (lower-case). Empty = everyone |
| `NOSTR_CURSOR_FILE`      | no       | `~/.mulmoclaude/nostr-cursor.json` | Path for the persisted last-seen event timestamp. Set to an absolute path if you run multiple bots on the same machine |
| `MULMOCLAUDE_AUTH_TOKEN` | no       | auto    | MulmoClaude bearer token override |
| `MULMOCLAUDE_API_URL`    | no       | auto (`.server-port`, else `http://localhost:3001`) | MulmoClaude server URL |

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

1. Bridge derives the bot's pubkey from the secret key and opens WebSocket subscriptions to every relay in `NOSTR_RELAYS`.
2. Filter: `kinds=[4]` + `#p=<botPubkey>` + `since=<cursor>`. The cursor is the `created_at` of the last event we've committed to processing, persisted to `NOSTR_CURSOR_FILE` so restarts don't lose DMs delivered while the bridge was offline. On cold start (no cursor file) we fall back to `now-60s` to avoid replaying ancient history.
3. Every 5 minutes we reopen the subscription on every relay. `nostr-tools`' `SimplePool` does not auto-resume subscriptions when a relay drops the WebSocket, so without this we would silently stop receiving after the first relay hiccup. Duplicate deliveries across the reopen boundary are filtered by event-id dedup.
4. For each inbound event, we verify (`nostr-tools` does it), decrypt with NIP-04 ECDH + AES-CBC, check the sender against the allowlist, and forward the plaintext to MulmoClaude keyed by `sender pubkey (hex)`.
5. Replies are encrypted back with the sender's pubkey, signed as a fresh `kind=4` event, and broadcast to all relays. Any relay accepting it = successful delivery (clients will see the message).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events delivered | Your relays don't replicate inbound kind=4 events | Add a high-availability relay like `wss://relay.damus.io` |
| Decrypt failed | Sender used NIP-44 (newer spec) or non-standard encryption | NIP-44 support is deferred to v0.2 — for now tell the user to send via a NIP-04-compatible client |
| Reply never shows up in the sender's client | All your relays rejected the event (spam filter / rate-limit) | Add more relays; most clients read from many in parallel |

## Security notes

- The secret key is the bot's entire identity. Store it in a secret manager (not plain env / shell history).
- Nostr relays see the **ciphertext** of every DM — the plaintext is only readable by the sender and recipient. Metadata (who talks to whom, when, how much) is public.
- NIP-04 is the legacy standard. NIP-44 is newer with better cryptography but isn't universally deployed yet. This bridge does NIP-04 only in v0.1.0.
- Without `NOSTR_ALLOWED_PUBKEYS`, any Nostr user who DMs the bot pubkey can converse with your MulmoClaude. Use allowlisting for personal agents.
- The bot will also see its own echoes if relays replay events — we filter on `evt.pubkey === ourPubkey` so they're ignored.

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
- [`@mulmobridge/nostr`](https://www.npmjs.com/package/@mulmobridge/nostr) — Nostr NIP-04 encrypted DMs  ← **this package**
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
