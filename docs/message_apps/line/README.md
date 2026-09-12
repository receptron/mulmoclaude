# MulmoClaude — LINE bridge

Talk to your MulmoClaude from the LINE app. This guide is for
**operators** — the person running MulmoClaude on their machine and
sharing the bot with friends / family.

Japanese: [`README.ja.md`](README.ja.md)

> **Experimental** — please test and [report issues](https://github.com/receptron/mulmoclaude/issues/new).

---

## What you'll have when you're done

- A LINE Official Account (bot) that forwards messages to the
  MulmoClaude running on your computer.
- ngrok exposing a local port so LINE's webhooks can reach your machine.
- `yarn dev` in one terminal, ngrok in another, and the LINE bridge
  in a third — all on your machine.

Your computer has to be on and connected to the internet for the
bot to respond. Close the laptop, the bot goes silent.

> **Tip**: Don't want to deal with ngrok? Use the
> [MulmoBridge Relay](../relay/README.md) instead — a permanent
> cloud URL with offline message queuing. No ngrok needed.
> Setup: `/setup-relay` in Claude Code.

### How it differs from Telegram

Telegram uses polling (the bot asks the server for new messages),
so no incoming port is opened and ngrok is not needed. LINE uses
webhooks (LINE's server sends HTTP requests to your machine), so
ngrok is required. Telegram is simpler from a security perspective.

---

## Step 1 — Set up ngrok

ngrok is a tunneling tool that exposes a local port to the internet.
LINE's webhooks need it to reach your machine.

### Install

```bash
brew install ngrok
```

### Create an account and set your authtoken

1. Sign up at [ngrok.com](https://ngrok.com) (GitHub login works)
2. Copy the authtoken from the dashboard
3. Run:

```bash
ngrok config add-authtoken <your-token>
```

### Start ngrok

```bash
ngrok http 3002
```

Note the `https://xxxx.ngrok-free.app` URL — you'll need it in Step 3.

---

## Step 2 — Create a LINE Messaging API Channel

1. Go to [LINE Developers Console](https://developers.line.biz/console/)
2. Create a **Provider** (if you don't have one)
3. Create a **Messaging API** channel
4. Note the **Channel secret** (Basic settings tab)
5. Issue a **Channel access token** (Messaging API tab, long-lived) and note it

---

## Step 3 — Configure the webhook

In the LINE Developers Console, Messaging API tab:

- **Webhook URL**: `https://xxxx.ngrok-free.app/webhook`
  - **The trailing `/webhook` is required.** Without it, POSTs go to `/` and return 404.
- **Use webhook**: enabled

### Disable auto-reply messages

LINE Official Accounts send default greeting / auto-reply messages.
These interfere with MulmoClaude's responses (you'll get double replies).

Go to LINE Official Account settings, **Auto-reply messages**, turn it OFF.

---

## Step 4 — Set environment variables

Add to `.env` in the project root:

```dotenv
LINE_CHANNEL_SECRET=xxxxxx
LINE_CHANNEL_ACCESS_TOKEN=xxxxxx
```

Full variable reference: [packages/bridges/line/README.md](../../../packages/bridges/line/README.md).

---

## Step 5 — Start MulmoClaude and the bridge

In terminal A, start MulmoClaude:

```bash
yarn dev
```

Wait for `[server] listening port=3001`.

In terminal B, start ngrok (if not already running):

```bash
ngrok http 3002
```

In terminal C, start the LINE bridge (`yarn dev` automatically builds
`packages/bridges/line/dist/` via the `predev` script, so no manual build needed):

```bash
node packages/bridges/line/dist/index.js
```

> **Note**: `npx @mulmobridge/line` does not work inside the monorepo
> (yarn workspaces doesn't create the bin symlink). Use `node` directly.

---

## Step 6 — Add the bot as a friend and send a message

Scan the QR code in the LINE Developers Console (Messaging API tab)
to add the bot. Send a message — MulmoClaude replies.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| ngrok shows `POST / 404 Not Found` | Webhook URL missing `/webhook` | Add `/webhook` to the URL in LINE Console |
| Bot sends double replies | LINE auto-reply is ON | LINE Official Account settings, Auto-reply messages, OFF |
| `LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN are required` | Env vars not loaded | Add to `.env` or export them |
| `sh: mulmobridge-line: command not found` | `npx` can't find the bin in the monorepo | Use `node packages/bridges/line/dist/index.js` |
| `Connect error: bearer token rejected` | MulmoClaude server restarted, token changed | Nothing — the bridge re-reads the token and reconnects on its own (#3078). Still saying it? The server has not finished starting. |
| No reply, no error | `yarn dev` is not running | Check the MulmoClaude server |

---

## Security notes

- **Only run ngrok when you need it** — stop it when done. While
  running, port 3002 is exposed to the internet.
- LINE's Channel secret signature verification rejects forged
  requests, but the ngrok URL itself is publicly accessible.
- Treat Channel secret and Channel access token like passwords.
  If leaked, reissue them in the LINE Developers Console.
- MulmoClaude's bearer token never leaves your machine. The LINE
  bridge connects to the IPv4 loopback only.
