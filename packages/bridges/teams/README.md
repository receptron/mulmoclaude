# @mulmobridge/teams

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

Microsoft Teams bridge for [MulmoClaude](https://github.com/receptron/mulmoclaude). Uses the official [Bot Framework](https://learn.microsoft.com/en-us/azure/bot-service/) webhook protocol via the `botbuilder` SDK. Teams posts activities to the bridge's `/api/messages` endpoint — so this bridge **requires a public URL** (ngrok / Cloudflare Tunnel / reverse proxy).

## Setup

Teams is the most involved bridge because of Azure AD. Plan ~15 min.

### 1. Register an Azure Bot

1. Go to the [Azure Portal](https://portal.azure.com/) → **Create a resource** → search **Azure Bot** → **Create**.
2. Bot handle: pick one (e.g. `mulmobridge-bot`).
3. Subscription / Resource Group: any (free tier works).
4. Pricing tier: **F0** (free) or **S1**.
5. Microsoft App ID → **Create new Microsoft App ID** → **Multi-tenant** (recommended).
6. Create, then open the resource → **Configuration**:
   - Copy **Microsoft App ID** → this is `MICROSOFT_APP_ID`.
   - Click **Manage Password** → **New client secret** → copy the **Value** (once only) → this is `MICROSOFT_APP_PASSWORD`.
7. Still in **Configuration**, set **Messaging endpoint** to `https://<your-public-url>/api/messages` (fill in after you start the bridge + tunnel).

### 2. Add the Teams channel

In the Azure Bot resource → **Channels** → **Microsoft Teams** → Agree → Save.

### 3. Install the bot in Teams

1. Get **Bot App ID** (same as `MICROSOFT_APP_ID`).
2. In Teams, **Apps** → **Manage your apps** → **Upload an app** → **Upload a custom app** → choose a manifest zip. A minimal manifest is:

   ```json
   {
     "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
     "manifestVersion": "1.17",
     "version": "0.1.0",
     "id": "<NEW_GUID>",
     "packageName": "com.example.mulmobridge",
     "developer": {
       "name": "MulmoBridge",
       "websiteUrl": "https://example.com",
       "privacyUrl": "https://example.com/privacy",
       "termsOfUseUrl": "https://example.com/terms"
     },
     "icons": { "color": "color.png", "outline": "outline.png" },
     "name": { "short": "MulmoBridge", "full": "MulmoBridge for MulmoClaude" },
     "description": { "short": "Talk to MulmoClaude from Teams.", "full": "Bridges Microsoft Teams DMs to a MulmoClaude agent." },
     "accentColor": "#2d89ef",
     "bots": [
       {
         "botId": "<MICROSOFT_APP_ID>",
         "scopes": ["personal", "team", "groupchat"],
         "supportsFiles": false,
         "isNotificationOnly": false
       }
     ],
     "permissions": ["identity", "messageTeamMembers"],
     "validDomains": []
   }
   ```

   Generate a fresh GUID for `id`, substitute `<MICROSOFT_APP_ID>` for `botId`. Zip the manifest.json plus two placeholder PNGs (color.png 192×192 and outline.png 32×32) into an App Package.

### 4. Expose the bridge with a tunnel

```bash
ngrok http 3006
# copy the https URL, paste into Azure Bot → Configuration → Messaging endpoint
# (append /api/messages)
```

### 5. Run the bridge

```bash
# With real MulmoClaude
MICROSOFT_APP_ID=... \
MICROSOFT_APP_PASSWORD=... \
npx @mulmobridge/teams
```

Message your bot in Teams — DM or @mention in a channel — and you'll get a reply.

## Environment variables

| Variable                  | Required    | Default                                              | Description                                                        |
| ------------------------- | ----------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| `MICROSOFT_APP_ID`        | yes         | —                                                    | Azure Bot App ID (aka MicrosoftAppId)                              |
| `MICROSOFT_APP_PASSWORD`  | yes         | —                                                    | Azure Bot client secret                                            |
| `MICROSOFT_APP_TYPE`      | no          | `MultiTenant`                                        | `MultiTenant` / `SingleTenant` / `UserAssignedMSI`                 |
| `MICROSOFT_APP_TENANT_ID` | conditional | —                                                    | Required when `MICROSOFT_APP_TYPE=SingleTenant`                    |
| `TEAMS_BRIDGE_PORT`       | no          | `3006`                                               | HTTP port to listen on (`0` asks the OS for a free port)           |
| `TEAMS_ALLOWED_USERS`     | no          | (all)                                                | CSV of AAD user object IDs — empty = accept everyone in the tenant |
| `MULMOCLAUDE_AUTH_TOKEN`  | no          | auto                                                 | MulmoClaude bearer token override                                  |
| `MULMOCLAUDE_API_URL`     | no          | auto (`.server-port`; waits if nothing is published) | MulmoClaude server URL                                             |

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

## How it works

1. Teams sends every user activity to `POST /api/messages` signed with a Bearer JWT issued by Azure AD. The Bot Framework SDK validates the token against Azure's JWKS using the configured `MICROSOFT_APP_ID` + `MICROSOFT_APP_PASSWORD`.
2. For `type=message` activities, the bridge caches a conversation reference (needed for server-initiated pushes), then forwards `activity.text` to MulmoClaude keyed by `activity.conversation.id`.
3. Replies go back via `TurnContext.sendActivity`, chunked at ~28 k chars.
4. When MulmoClaude pushes an event (e.g. scheduler notification), the bridge uses `adapter.continueConversationAsync` with the cached reference to deliver it to Teams.

## Troubleshooting

| Symptom                        | Cause                                          | Fix                                                                      |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------ |
| 401 on `/api/messages`         | Wrong app ID / password                        | Double-check Azure Bot → Configuration                                   |
| Bot doesn't reply in Teams     | Messaging endpoint not set or tunnel URL stale | Update Azure Bot → Configuration → Messaging endpoint                    |
| `ngrok` URL changes on restart | Free ngrok plan assigns random URLs            | Use a reserved domain, Cloudflare Tunnel, or static ingress              |
| Push messages dropped          | No conversation reference yet cached           | User must message the bot first — push works from the second turn onward |

## Security notes

- The client secret grants bot-impersonation in the entire AAD tenant. Store it as a proper secret (env var, vault, Azure Key Vault) and rotate on schedule.
- Teams endpoints must be HTTPS — Azure rejects plain HTTP messaging endpoints. Use a tunnel with a valid cert.
- Use `TEAMS_ALLOWED_USERS` (AAD user object IDs) to restrict access when deploying to a multi-user tenant.
- Bot Framework requires Azure AD — there is no passwordless / self-hosted path. For a fully self-hosted Teams alternative, consider `@mulmobridge/mattermost` or `@mulmobridge/rocketchat`.

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
- [`@mulmobridge/teams`](https://www.npmjs.com/package/@mulmobridge/teams) — Microsoft Teams via Bot Framework ← **this package**
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
