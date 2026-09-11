# @mulmobridge/email

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

Email bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Polls an IMAP mailbox for unread mail and replies via SMTP preserving threading (`In-Reply-To` + `References`). Outbound-only — **no public URL needed**.

Good for **async / slow workflows** where you don't need instant replies: delegate tasks by email, get structured results back in your inbox.

## Setup

### 1. Get a mailbox

Any IMAP+SMTP-capable mailbox works. A dedicated mailbox is strongly recommended — the bridge marks messages as `\Seen` after processing.

- **Gmail** — create an [app password](https://myaccount.google.com/apppasswords) (requires 2FA). Use `imap.gmail.com:993` / `smtp.gmail.com:465` (TLS) or `587` (STARTTLS).
- **Fastmail / iCloud / Outlook** — similarly, prefer app passwords.
- **Self-hosted** (Postfix + Dovecot, mailcow, Stalwart) — use your regular credentials.

### 2. Run the bridge

```bash
EMAIL_IMAP_HOST=imap.gmail.com \
EMAIL_IMAP_USER=mulmobot@gmail.com \
EMAIL_IMAP_PASSWORD=your-app-password \
EMAIL_SMTP_HOST=smtp.gmail.com \
EMAIL_SMTP_USER=mulmobot@gmail.com \
EMAIL_SMTP_PASSWORD=your-app-password \
EMAIL_FROM=mulmobot@gmail.com \
npx @mulmobridge/email
```

Send an email to the bot address — you'll get a reply threaded under your original message.

## Environment variables

| Variable                   | Required | Default | Description |
|----------------------------|----------|---------|-------------|
| `EMAIL_IMAP_HOST`          | yes      | —       | IMAP server hostname |
| `EMAIL_IMAP_USER`          | yes      | —       | IMAP username |
| `EMAIL_IMAP_PASSWORD`      | yes      | —       | IMAP password (use an app password for Gmail / Fastmail) |
| `EMAIL_IMAP_PORT`          | no       | `993`   | IMAP port |
| `EMAIL_IMAP_TLS`           | no       | `true`  | Use implicit TLS (`false` for plain + STARTTLS) |
| `EMAIL_SMTP_HOST`          | yes      | —       | SMTP server hostname |
| `EMAIL_SMTP_USER`          | yes      | —       | SMTP username |
| `EMAIL_SMTP_PASSWORD`      | yes      | —       | SMTP password |
| `EMAIL_SMTP_PORT`          | no       | `587`   | SMTP port |
| `EMAIL_SMTP_TLS`           | no       | auto    | `true` for implicit TLS (`465`), `false` for STARTTLS (`587`). Auto-detected from port if unset |
| `EMAIL_FROM`               | yes      | —       | Bot's email address (usually equal to `EMAIL_SMTP_USER`) |
| `EMAIL_ALLOWED_SENDERS`    | no       | (all)   | CSV of allowed sender addresses (case-insensitive) |
| `EMAIL_POLL_INTERVAL_SEC`  | no       | `30`    | Poll interval in seconds (min 10) |
| `MULMOCLAUDE_AUTH_TOKEN`   | no       | auto    | MulmoClaude bearer token override |
| `MULMOCLAUDE_API_URL`      | no       | auto (`.server-port`, else `http://localhost:3001`) | MulmoClaude server URL |

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

1. At startup, the bridge logs into IMAP via `imapflow` and enters a poll loop on `INBOX`.
2. Every `EMAIL_POLL_INTERVAL_SEC`, `SEARCH UNSEEN` returns new messages. Each is fetched, parsed with `mailparser`, and (after allowlist check) forwarded to MulmoClaude keyed by the sender's address.
3. The reply goes out via `nodemailer` with `In-Reply-To` = original `Message-ID` and `References` = full thread chain, so mail clients render it as a proper thread reply.
4. Processed messages are flagged `\Seen` so they aren't re-processed on restart.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `NO Invalid credentials` | Using raw password on Gmail / Fastmail | Create an app password with IMAP + SMTP scopes |
| Replies end up in recipient's Spam | Lack of SPF / DKIM on the bot domain | Send from a provider that already signs (Gmail, Fastmail, etc.) or set up DKIM on your own server |
| Reply not threaded in the sender's client | Client ignored `References` | Some corporate clients strip threading headers — not fixable bridge-side |
| Mail loop (bridge replies to its own replies) | The bridge's own `From` address is in `EMAIL_ALLOWED_SENDERS` | Remove it, or use a separate address for the bot |

## Security notes

- Use a dedicated bot mailbox. Revocation of the app password then won't affect your personal mail.
- The IMAP password is read-write — the bridge can delete mail if compromised. Store it via a secret manager, not plain env.
- Allowlist via `EMAIL_ALLOWED_SENDERS` is strongly recommended. Without it, **anyone** who emails the bot can converse with your MulmoClaude, and spam is a real risk.
- Replies include the bot's response text in plain email. Don't bridge sensitive content unless both mailboxes are under your control.
- Attachments are not processed in v0.1.0 — image / PDF forwarding may land in a follow-up.

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
- [`@mulmobridge/email`](https://www.npmjs.com/package/@mulmobridge/email) — IMAP poll + SMTP reply, threading preserved  ← **this package**
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
