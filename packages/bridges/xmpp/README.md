# @mulmobridge/xmpp

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

XMPP / Jabber bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Connects to any XMPP server (ejabberd, Prosody, Tigase, dino-im.org, snikket.org, …) with a JID + password and bridges `type="chat"` message stanzas to MulmoClaude. Outbound TLS — **no public URL needed**.

## Setup

### 1. Create a JID

Register the bot on any XMPP server. A few public servers that accept registrations:

- [xmpp.jp](https://www.xmpp.jp/) (JP)
- [jabber.de](https://www.jabber.de/) (DE)
- [disroot.org](https://disroot.org/) (NL)
- [yax.im](https://yaxim.org/) (DE)

Or run your own [Prosody](https://prosody.im/) / [ejabberd](https://www.ejabberd.im/).

### 2. Find the service URI

Most servers support both ports; pick one:

- **Implicit TLS (direct TLS, recommended)**: `xmpps://<host>:5223`
- **STARTTLS**: `xmpp://<host>:5222`

If you don't know which your server supports, `xmpps://<domain>:5223` is the common default.

### 3. Run the bridge

```bash
# Testing with mock server
npx @mulmobridge/mock-server &
XMPP_JID=mulmobot@example.com \
XMPP_PASSWORD=... \
XMPP_SERVICE=xmpps://example.com:5223 \
MULMOCLAUDE_AUTH_TOKEN=mock-test-token \
npx @mulmobridge/xmpp

# With real MulmoClaude
XMPP_JID=mulmobot@example.com \
XMPP_PASSWORD=... \
XMPP_SERVICE=xmpps://example.com:5223 \
npx @mulmobridge/xmpp
```

Add the bot as a contact (or send an unsolicited message from an allowlisted JID) and start chatting.

## Environment variables

| Variable                 | Required | Default                 | Description                                                                                                                                                                                                                                                                                                              |
| ------------------------ | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `XMPP_JID`               | yes      | —                       | Full JID, e.g. `mulmobot@example.com`                                                                                                                                                                                                                                                                                    |
| `XMPP_PASSWORD`          | yes      | —                       | Account password                                                                                                                                                                                                                                                                                                         |
| `XMPP_SERVICE`           | yes      | —                       | Connection URI, e.g. `xmpps://example.com:5223` (implicit TLS) or `xmpp://example.com:5222` (STARTTLS)                                                                                                                                                                                                                   |
| `XMPP_ALLOWED_JIDS`      | no       | (all)                   | CSV of bare JIDs allowed to converse, e.g. `alice@example.com,bob@another.im`. Empty = everyone                                                                                                                                                                                                                          |
| `XMPP_RESOURCE`          | no       | `mulmobridge`           | XMPP resource identifier (shows up alongside the JID in some clients)                                                                                                                                                                                                                                                    |
| `XMPP_REPLY_MODE`        | no       | `bare`                  | `bare` (default) sends replies to `user@domain` and lets the server route to whichever resource is active — works for multi-device users. `full` echoes back to the sender's full JID (`user@domain/resource`), useful when the server's roster/carbons config doesn't forward bare-addressed messages to every resource |
| `MULMOCLAUDE_AUTH_TOKEN` | no       | auto                    | MulmoClaude bearer token override                                                                                                                                                                                                                                                                                        |
| `MULMOCLAUDE_API_URL`    | no       | auto (`.server-port`; waits if nothing is published) | MulmoClaude server URL                                                                                                                                                                                                                                                                                                   |

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

1. The bridge connects to `XMPP_SERVICE` and authenticates with `XMPP_JID` + `XMPP_PASSWORD` using `@xmpp/client`.
2. On `online` it broadcasts `<presence/>` so contacts see the bot as available, then listens for `stanza` events.
3. For each incoming `<message type="chat">` (or `type="normal"`) with a `<body>`, the bridge strips the resource from the sender's JID, checks the allowlist, and forwards the plain text to MulmoClaude keyed by the sender's bare JID.
4. MulmoClaude's reply is sent back as another `<message type="chat">` stanza, chunked at 10 000 chars. The `to=` attribute is the sender's bare JID by default — see `XMPP_REPLY_MODE` in the env table above for when to flip to full-JID.

### Bare vs full JID reply

RFC 6121 requires servers to route bare-addressed chat messages to the most-active or all resources, which is normally what you want for a user jumping between phone and laptop. A handful of servers (or custom carbons configurations) deliver bare-addressed messages only to the primary resource, or silently drop them when no resource is "available". If replies reach the sender from one device but not another, set `XMPP_REPLY_MODE=full` so each reply goes straight back to the exact resource the message came from.

## Troubleshooting

| Symptom                          | Cause                                                                           | Fix                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `error: ECONNREFUSED`            | Wrong host/port or server not reachable                                         | Verify the service URI; try the other port                               |
| `error: authentication failed`   | Wrong password or JID domain mismatch                                           | Double-check credentials; some servers require a specific SASL mechanism |
| Bridge sends nothing on receive  | Stanza is not `type="chat"` (likely groupchat or headline)                      | Group-chat support is not implemented yet — send via a direct 1:1 chat   |
| Contacts don't see bot as online | `XMPP_ALLOWED_JIDS` excluded your JID _and_ `<presence/>` not broadcast to them | Ensure bot is added as a contact and approved                            |

## Security notes

- Credentials travel to the XMPP server — always use `xmpps://` (implicit TLS) or `xmpp://` + STARTTLS-required on the server side.
- Public servers may log message metadata. For sensitive agents, run your own Prosody / ejabberd.
- Without `XMPP_ALLOWED_JIDS`, anyone who learns the bot's JID can converse with MulmoClaude. Setting an allowlist is strongly recommended.
- Group-chat (MUC) support is intentionally deferred to v0.2 to avoid accidentally leaking MulmoClaude responses to a whole room; open an issue if you need it.

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
- [`@mulmobridge/webhook`](https://www.npmjs.com/package/@mulmobridge/webhook) — generic HTTP webhook bridge
- [`@mulmobridge/whatsapp`](https://www.npmjs.com/package/@mulmobridge/whatsapp) — WhatsApp Cloud API via MulmoBridge relay
- [`@mulmobridge/xmpp`](https://www.npmjs.com/package/@mulmobridge/xmpp) — XMPP / Jabber  ← **this package**
- [`@mulmobridge/zulip`](https://www.npmjs.com/package/@mulmobridge/zulip) — Zulip

## Related projects

Published from the MulmoClaude monorepo by [Receptron](https://github.com/receptron).

- **[MulmoClaude](https://github.com/receptron/mulmoclaude)** — an open-source AI assistant platform that runs on your own computer. Claude Code as the engine, a personal wiki for long-term memory, schema-driven collections for your data, and chat that summons the right GUI (markdown, charts, forms, spreadsheets, wikis) for each task.
- **[MulmoTerminal](https://github.com/receptron/mulmoterminal)** — a terminal-first cockpit for running many AI coding agents in parallel. One roster showing every session's summary and PR status, tmux-backed session persistence, git-worktree isolation, one-click PRs, and mobile push with remote reply.
- **[MulmoTerminal manual](https://receptron.github.io/mulmoterminal/)** — setup, workflows, feature reference, configuration, mobile notifications, and alternative / local model providers. Available in English and Japanese.
