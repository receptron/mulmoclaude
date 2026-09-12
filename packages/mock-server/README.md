# @mulmobridge/mock-server

> **Experimental** — this package is under active development. We'd love your help testing it! If something doesn't work, please [open an issue](https://github.com/receptron/mulmoclaude/issues/new) and paste the `--verbose` terminal output. Your reports help us ship better bridges faster.

A mock [MulmoClaude](https://github.com/receptron/mulmoclaude) server for testing messaging bridges. It speaks the full MulmoBridge protocol (socket.io + bearer auth) and echoes your messages back — **no Claude API key needed, no MulmoClaude installation required**.

## What is MulmoClaude?

[MulmoClaude](https://github.com/receptron/mulmoclaude) is a GUI-chat agent app powered by Claude Code. It produces rich visual output — documents, spreadsheets, charts, images — and maintains a personal wiki as long-term memory. MulmoClaude runs as a local server and can be accessed from messaging apps like Telegram, Slack, LINE, Discord, and more through **bridge** processes.

This mock server lets you test your bridge without running the full MulmoClaude stack.

## Quick Start

```bash
# Terminal 1: start the mock server
npx @mulmobridge/mock-server

# Terminal 2: connect the CLI bridge
MULMOCLAUDE_AUTH_TOKEN=mock-test-token npx @mulmobridge/cli
```

Type a message in the CLI — the mock echoes it back with `[echo]` prefix.

## Testing with Telegram

```bash
# Terminal 1: mock server
npx @mulmobridge/mock-server --verbose

# Terminal 2: Telegram bridge
MULMOCLAUDE_AUTH_TOKEN=mock-test-token \
TELEGRAM_BOT_TOKEN=<your-bot-token> \
TELEGRAM_ALLOWED_CHAT_IDS=<your-chat-id> \
npx @mulmobridge/telegram
```

Send a message from your phone → the bot echoes it back. Send a photo or document — the echo shows the attachment type and size, confirming the file was received.

For Telegram bot setup (BotFather, getting your chat ID), see the [Telegram bridge docs](https://github.com/receptron/mulmoclaude/blob/main/docs/message_apps/telegram/README.md).

## Options

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `3001` | Listen port |
| `--token <s>` | `mock-test-token` | Bearer token for auth |
| `--slow <ms>` | `0` | Delay before replies (simulates agent thinking time) |
| `--error` | off | Always return error acks (test error handling) |
| `--reject-auth` | off | Reject all connections (test auth error paths) |
| `--verbose`, `-v` | off | Full protocol trace (recommended for bug reports) |
| `--log-file <path>` | — | Write verbose log to a file |

## What the mock supports

- **Socket.io handshake** — same `auth: { transportId, token }` as production
- **`message` event with ack** — echoes text + lists attachments
- **`push` event** — trigger via `POST /mock/push` (see below)
- **Slash commands** — `/help`, `/reset`, `/roles`, `/role <id>`, `/status`
- **Bearer token auth** — rejects wrong tokens with the same error messages as production

## Simulating server→bridge push

```bash
curl -X POST http://localhost:3001/mock/push \
  -H "Content-Type: application/json" \
  -d '{"transportId":"cli","chatId":"terminal","message":"Scheduled reminder!"}'
```

The mock delivers the push to all connected bridges with matching `transportId`.

## Reporting bugs

Run with `--verbose` and copy the terminal output:

```bash
npx @mulmobridge/mock-server --verbose 2>&1 | tee debug.log
```

The verbose log includes everything we need to diagnose the issue:
- Server + Node + OS versions
- Auth handshake details
- Full message payloads (attachment data shown as size, not content)
- Ack payloads
- Latency per message
- Disconnect reasons

**Before pasting:** the mock token is a placeholder (`mock-test-token`), but review the log for any real tokens, chat IDs, or message text you don't want public. Redact them with `[REDACTED]`. If the log contains sensitive content, use a [private security report](https://github.com/receptron/mulmoclaude/security/advisories/new) instead of a public issue.

Paste the log into your [GitHub issue](https://github.com/receptron/mulmoclaude/issues/new).

## Switching to real MulmoClaude

Once your bridge works with the mock, switch to the real server:

```bash
# 1. Unset MULMOCLAUDE_AUTH_TOKEN — the mock's token is not the real server's
#    (stopping the mock is optional; see the note below)
# 2. Install and start MulmoClaude
git clone https://github.com/receptron/mulmoclaude.git
cd mulmoclaude && yarn install && yarn dev

# 3. Connect your bridge (token is auto-read from the workspace)
npx @mulmobridge/telegram
```

> **Important: unset `MULMOCLAUDE_AUTH_TOKEN` before you switch.** The port is no longer
> the thing that bites. Both default to `3001`, but MulmoClaude walks forward off a busy
> default and publishes the port it actually bound to `<workspace>/.server-port`, which is
> where the bridge reads it — so the two can run side by side and the bridge still finds the
> real server. What does bite is the token: leave `mock-test-token` exported and the bridge
> presents the mock's credential to MulmoClaude, which rejects it (`bearer token rejected`),
> and it will keep retrying with the wrong one. A pinned token is also the one case where a
> bridge still falls back to `http://localhost:3001` while the real server has not published
> a port yet — and that address is the mock. Unset it and the bridge reads the workspace for
> both halves.

## Supported bridge platforms

| Platform | Package | Status |
|---|---|---|
| CLI | [`@mulmobridge/cli`](https://www.npmjs.com/package/@mulmobridge/cli) | Stable |
| Telegram | [`@mulmobridge/telegram`](https://www.npmjs.com/package/@mulmobridge/telegram) | Stable |
| Discord | [`@mulmobridge/discord`](https://www.npmjs.com/package/@mulmobridge/discord) | Experimental |
| Slack | [`@mulmobridge/slack`](https://www.npmjs.com/package/@mulmobridge/slack) | Experimental |
| LINE | [`@mulmobridge/line`](https://www.npmjs.com/package/@mulmobridge/line) | Experimental |
| WhatsApp | [`@mulmobridge/whatsapp`](https://www.npmjs.com/package/@mulmobridge/whatsapp) | Experimental |
| Matrix | [`@mulmobridge/matrix`](https://www.npmjs.com/package/@mulmobridge/matrix) | Experimental |
| IRC | [`@mulmobridge/irc`](https://www.npmjs.com/package/@mulmobridge/irc) | Experimental |

Want to build a bridge for your platform? The [bridge protocol docs](https://github.com/receptron/mulmoclaude/blob/main/docs/bridge-protocol.md) cover the full wire-level contract. Any language with a socket.io 4.x client works.

## Ecosystem

Part of the [`@mulmobridge/*`](https://www.npmjs.com/~mulmobridge) package family.

**Shared libraries:**

- [`@mulmobridge/client`](https://www.npmjs.com/package/@mulmobridge/client) — socket.io client library used by every bridge below
- [`@mulmobridge/protocol`](https://www.npmjs.com/package/@mulmobridge/protocol) — wire types and constants
- [`@mulmobridge/chat-service`](https://www.npmjs.com/package/@mulmobridge/chat-service) — server-side relay + session store
- [`@mulmobridge/relay`](https://www.npmjs.com/package/@mulmobridge/relay) — Cloudflare Workers webhook proxy
- [`@mulmobridge/mock-server`](https://www.npmjs.com/package/@mulmobridge/mock-server) — mock server for local bridge development  ← **this package**

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
