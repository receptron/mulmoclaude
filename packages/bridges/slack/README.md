# @mulmobridge/slack

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new). Your feedback helps us improve.

Slack bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Uses **Socket Mode** — no public URL or ngrok needed.

日本語: [`README.ja.md`](README.ja.md)

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it (e.g. "MulmoClaude") and pick your workspace

### 2. Configure permissions

**OAuth & Permissions** → add these Bot Token Scopes:
- `chat:write` — send messages
- `channels:history` — read messages in public channels
- `groups:history` — read messages in private channels
- `im:history` — read direct messages
- `mpim:history` — read group DMs
- `reactions:write` — **optional**, only needed if you enable `SLACK_ACK_REACTION` (see below)

### 3. Enable Socket Mode

**Socket Mode** → toggle **Enable Socket Mode** → create an App-Level Token with `connections:write` scope. Copy the `xapp-...` token.

### 4. Enable Events

**Event Subscriptions** → toggle **Enable Events** → subscribe to:
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

### 5. Install to workspace

**Install App** → **Install to Workspace** → copy the `xoxb-...` Bot User OAuth Token.

### 6. Run the bridge

```bash
# With mock server (for testing)
npx @mulmobridge/mock-server &
SLACK_BOT_TOKEN=xoxb-... \
SLACK_APP_TOKEN=xapp-... \
MULMOCLAUDE_AUTH_TOKEN=mock-test-token \
npx @mulmobridge/slack

# With real MulmoClaude
SLACK_BOT_TOKEN=xoxb-... \
SLACK_APP_TOKEN=xapp-... \
npx @mulmobridge/slack
```

### 7. Invite the bot

In Slack, invite the bot to a channel: `/invite @MulmoClaude`

---

## Session granularity (new!)

> **What's a "session"?** In MulmoClaude, a *session* is one continuous conversation with the AI — it remembers what you said earlier and builds on it. Each Slack bridge setting below decides **how many sessions one Slack channel maps to**.

You pick the behaviour via the `SLACK_SESSION_GRANULARITY` environment variable. Three modes:

### 🗂 `channel` (default) — one session per channel

Everything posted in `#ai-help` counts as **one long conversation**, no matter who posts or whether they use threads.

```text
#ai-help
├── Alice: "Summarize yesterday's standup"          ┐
├── Alice: "Translate that to Japanese"             │  ← One session.
├── Bob:  "What about the action items?"            │    AI remembers
│   ├── Alice: "Focus on the ones assigned to me"   │    every message
│   └── Bob:  "Cool, thanks"                        │    above.
└── Alice: "Draft a status update based on that"    ┘
```

**When to use:** small teams or a private `@claude` DM where every message is part of the same running conversation.

**Watch out:** after a few weeks, the session accumulates a lot of context. The AI starts pulling in stale details, and responses get slower / more expensive. Start a *new channel* if you want a fresh start.

### 🧵 `thread` — one session per Slack thread (auto-created)

Each top-level post **auto-creates a thread on the first bot reply**, and every message inside that thread is one isolated session. Fire off several top-level posts on different topics and each one becomes its own thread — replies don't interleave at channel level.

```text
#ai-help
├── Alice: "Summarize yesterday's standup" ────────┐
│   └── 🤖: "Here is the summary…"                   ├  ← Thread session #1
│       Alice: "Now translate to Japanese"          │    (auto-created by
│       🤖: "…"                                      │     the bot's reply)
│
├── Bob: "What about the action items?" ───────────┐
│   └── 🤖: "Action items were…"                     ├  ← Thread session #2
│       Bob: "Who owns the deploy one?"             │    (separate topic,
│       🤖: "…"                                      │     separate thread)
│
└── Alice: "Draft a status update" ────────────────┐
    └── 🤖: "Here is a draft…"                       ├  ← Thread session #3
        Dev: "Include the deploy notes too"        │    (can be continued
        🤖: "…"                                      │     by anyone)
```

**When to use:** a shared `#ai-help` or `#general` with multiple people asking unrelated questions. Threads keep conversations separate so the AI doesn't mix "Alice's translation task" with "Bob's deploy question".

**Watch out:**

- Behaviour change in v0.2+: the bot now **always** replies inside a thread in this mode. Previously, top-level posts stayed top-level. If you liked the old behaviour, use `channel` or `auto`.
- Because each thread = a new session, the AI doesn't automatically know context from other threads in the same channel. If Alice asks the bot in a thread "use the same style as yesterday's post", the bot won't find that post unless Alice quotes it or opens the thread from that post.
- DMs are unaffected — threading inside a 1:1 is meaningless, so DMs always stay top-level.

### 🤖 `auto` — opt-in threading (reserved for future auto-detection)

Works like `channel` for top-level posts but keeps thread-scoped sessions when users manually start a thread. Reserved for a future smarter behaviour (e.g., "infer from channel naming conventions").

### Quick comparison

| Mode | Root post | Thread reply | Best for |
|---|---|---|---|
| `channel` *(default)* | → channel session (top-level reply) | → **channel session** (same conversation, threaded reply) | 1:1 DMs, small teams |
| `thread` | → **auto-creates a thread** (new session per topic) | → thread session (new conversation) | Busy shared channels, multi-topic users |
| `auto` | → channel session (top-level reply) | → thread session (new conversation) | Future-proof, opt-in threading |

### How to choose

| You want… | Set it to… |
|---|---|
| "Keep it simple. All messages in one channel = one conversation." | `channel` (or just leave it unset) |
| "Don't mix my question with other people's questions in the same channel." | `thread` |
| "I'll leave it for the future. Pick a reasonable default for me." | `auto` |

### Switching modes safely

Changing the granularity **does not delete any existing sessions**. It only changes how *new* messages map to sessions. Your old conversations stay intact in the MulmoClaude UI.

That said, if you switch from `channel` → `thread`, messages that were previously part of one long channel session will — from this point on — spawn new thread sessions instead. The AI won't automatically "port" the old context into the new threads.

---

## Ack reaction (👀)

Add an emoji reaction to every inbound message the bridge processes, so the user gets an immediate "the bot saw me" signal — before the agent has finished thinking. Off by default; opt in with `SLACK_ACK_REACTION`.

| `SLACK_ACK_REACTION` value | Behaviour |
|---|---|
| unset / empty / `0` / `false` / `off` / `no` | Off (default) |
| `1` / `true` / `on` / `yes` | On, reacts with `:eyes:` |
| Any other emoji shortcode (no colons) | On, reacts with that emoji |

Emoji shortcode rules: lowercase letters, digits, `_`, `+`, `-`. No surrounding colons. Both standard emoji (`white_check_mark`, `thumbsup`) and custom workspace emoji (`my_bot_ack`) work.

```bash
# Examples
SLACK_ACK_REACTION=1                    # 👀
SLACK_ACK_REACTION=white_check_mark     # ✅
SLACK_ACK_REACTION=my_bot_ack           # custom workspace emoji
```

**Operator setup**: add the `reactions:write` Bot Token Scope in **OAuth & Permissions** and reinstall the app. Without the scope, the reaction call fails with `missing_scope` — the bridge logs a warning and continues normally, so the rest of the bot still works.

**Design**: the reaction call is fire-and-forget — the agent starts processing immediately, not after the reaction lands. The reaction is not removed when the reply arrives; it stays as a "seen" indicator.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | `xoxb-...` Bot User OAuth Token |
| `SLACK_APP_TOKEN` | Yes | `xapp-...` App-Level Token (connections:write) |
| `SLACK_ALLOWED_CHANNELS` | No | CSV of channel IDs to restrict access (empty = all) |
| `SLACK_SESSION_GRANULARITY` | No | `channel` *(default)* \| `thread` \| `auto`. See above. |
| `SLACK_ACK_REACTION` | No | Off by default. `1` enables with 👀; any other emoji shortcode selects a custom emoji. Requires the `reactions:write` scope when enabled. See above. |
| `SLACK_BRIDGE_DEFAULT_ROLE` | No | Role id to seed new bridge sessions with (e.g. `slack`, `coder`). Applied ONLY when a Slack session first appears — once the user switches role via `/role <id>` the session's own role wins. Unknown role ids silently fall back to the server's default with a warn log. |
| `BRIDGE_DEFAULT_ROLE` | No | Same as above but shared across every bridge. Transport-specific `SLACK_BRIDGE_DEFAULT_ROLE` wins when both are set. |
| `MULMOCLAUDE_API_URL` | No | Default: auto (`.server-port`; waits if nothing is published) |
| `MULMOCLAUDE_AUTH_TOKEN` | No | Bearer token (auto-read from workspace if not set) |

### Bridge options passthrough

`SLACK_BRIDGE_*` and `BRIDGE_*` env vars are automatically forwarded to the server as a camelCased options bag (e.g. `SLACK_BRIDGE_DEFAULT_ROLE=slack` → `options.defaultRole = "slack"`). The MulmoClaude server reads `defaultRole`; other host apps using `@mulmobridge/client` can define their own keys without any protocol change. See `plans/done/feat-bridge-options-passthrough.md` for the full convention.

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
- [`@mulmobridge/slack`](https://www.npmjs.com/package/@mulmobridge/slack) — Slack Socket Mode  ← **this package**
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
