# Telegram Bridge

The Telegram bridge lets you talk to your MulmoClaude from the Telegram app on your phone or desktop. Your own custom Telegram bot forwards messages to the MulmoClaude server running on your computer, and replies come back through the same bot.

This is useful when you want to reach your MulmoClaude away from your computer — on a walk, from a phone, or from a friend's device — without exposing the server to the public internet.

## How It Works

- You create a **bot** with Telegram's BotFather; it gives you a token.
- You run a **bridge process** (`yarn telegram`) on the same machine as the MulmoClaude server. The bridge uses your bot token to receive messages from Telegram, forwards them to MulmoClaude over the loopback port the server actually bound, and sends the replies back to the Telegram user. It finds that port itself — see "Restarting the server" below.
- A short **allowlist** of Telegram chat IDs controls who can talk to the bot. Everyone else gets `"Access denied"`.

Your computer has to be on and connected to the internet for the bot to respond. Close the laptop → the bot goes silent.

## Prerequisites

- MulmoClaude checked out and runnable (`yarn dev` works).
- A Telegram account.
- Two terminals free: one for `yarn dev`, one for `yarn telegram`.

## Step 1 — Create the Bot with BotFather

1. In Telegram, search for `@BotFather` (the official account has a blue check) and start a chat.
2. Send `/newbot`.
3. Answer the two prompts:
   - **Display name** — what appears in the chat header. Anything, e.g. `"Alice's MulmoClaude"`.
   - **Username** — must end in `bot` and be unique on Telegram, e.g. `alice_mulmoclaude_bot`.
4. BotFather replies with a **token** like `1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`. This token is the bot's password — anyone who has it can impersonate the bot. Keep it secret.

Optional polish (can be done anytime later via BotFather):

- `/setdescription` — text shown when users open the chat for the first time.
- `/setuserpic` — the bot's avatar.
- `/setprivacy` → `Disable` — lets the bot see all messages in group chats (by default it only sees messages starting with `/`).

## Step 2 — Start MulmoClaude and the Bridge

In terminal A, start MulmoClaude:

```bash
yarn dev
```

Wait until you see `[server] listening port=…`. The number is whatever the server bound: it honours `PORT`, and an implicit default that is already busy walks forward. You do not need to note it — the bridge reads it from the workspace.

In terminal B, start the bridge. Leave the allowlist **empty on purpose** for the first run — you will need to discover your own chat ID before you can add it.

```bash
export TELEGRAM_BOT_TOKEN='1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
export TELEGRAM_ALLOWED_CHAT_IDS=''
yarn telegram
```

Expected output:

```
MulmoClaude Telegram bridge
Allowlist: (empty — all chats will be denied)
Connected (<socket id>).
```

## Step 3 — Find Your Chat ID and Allowlist It

1. In Telegram, open your new bot (search the username you picked) and send it any message — `hi` works.
2. In terminal B, you will see a log line like:
   ```
   [telegram] denied chat=987654321 user=@alice — not on allowlist
   ```
   That number (`987654321`) is **your Telegram chat ID**.
3. Stop the bridge (`Ctrl+C`), put your ID in the allowlist, restart:

   ```bash
   export TELEGRAM_ALLOWED_CHAT_IDS='987654321'
   yarn telegram
   ```

4. Send the bot another message. MulmoClaude should now reply.

## Step 4 — Invite a Friend

To let another person use your MulmoClaude:

1. Share the bot's username with them; they search for it on Telegram and send it a message.
2. Their chat ID appears in terminal B's `denied` log line, just like yours did in Step 3.
3. Append their ID (comma-separated) and restart the bridge:

   ```bash
   export TELEGRAM_ALLOWED_CHAT_IDS='987654321,123456789'
   yarn telegram
   ```

4. When they message the bot again, it works.

To avoid re-exporting every time, put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_CHAT_IDS` in a `.env` file at the repo root. The bridge auto-loads `.env` on startup via `dotenv/config`, so the vars take effect just by restarting `yarn telegram` — no shell `export` needed.

```dotenv
# .env (repo root)
TELEGRAM_BOT_TOKEN=1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw
TELEGRAM_ALLOWED_CHAT_IDS=987654321,123456789
```

## Bot Commands

These are typed directly into the Telegram chat. They mirror the CLI:

- `/help` — show available commands.
- `/reset` — start a fresh conversation session (drops prior context).
- `/roles` — list available roles.
- `/role <id>` — switch to a specific role (e.g. `/role office`).
- `/status` — show the current session info (session ID, current role).
- `//<skill> [args...]` — shortcut for `/reset` followed by `/<skill> [args...]`: start a fresh session and run the skill (with any args) in one tap (e.g. `//mag2 https://example.com/post`).

Any other text is treated as a message to the assistant.

## Troubleshooting

**`Connect error: bearer token rejected`** — MulmoClaude was restarted, so its bearer token changed. Restart `yarn telegram` to pick up the new one. To avoid this, pin `MULMOCLAUDE_AUTH_TOKEN` to the same value on both sides (see `docs/developer.md` §Auth).

**`TELEGRAM_ALLOWED_CHAT_IDS: "foo" is not an integer chat id`** — typo in the allowlist. Chat IDs are plain integers only — no spaces, quotes, or `#` prefix. Negative integers (for group chats) are allowed.

**Friend gets `"Access denied"` after you added their ID** — the allowlist is read once at startup. Restart `yarn telegram` after changing `TELEGRAM_ALLOWED_CHAT_IDS`.

**Messages stop flowing with no error** — check that `yarn dev` is still running. If the MulmoClaude server is down, the bridge stays up but has nothing to forward to. The next inbound message will log `Connect error` or `Disconnected`.

**Bot responds in a group chat you did not expect** — group chat IDs are **negative**. If you want the bot to work in a specific group, add that negative ID. By default BotFather enables "group privacy mode", so the bot only sees messages starting with `/` in groups — toggle it via BotFather's `/setprivacy` if you need full visibility.

## Security Notes

- The bot token is a password. If it leaks, regenerate it via BotFather's `/revoke`.
- The allowlist is the only thing standing between "my friends" and "every Telegram user on Earth". Keep it current — remove chat IDs when you no longer want that person to have access, and restart the bridge.
- The bridge logs chat IDs, usernames, and message lengths, but **not** message contents or the bot token. If you need a full audit trail, record it separately.
- The MulmoClaude bearer token never leaves your machine. The bridge only ever talks to the IPv4 loopback (`127.0.0.1`), whatever port the server bound; your friends talk to Telegram's servers, which then talk to your bridge.

## Full Operator Guide

For the complete operator walkthrough (including screenshots-worthy step numbering and a Japanese translation), see `docs/message_apps/telegram/README.md` (English) and `docs/message_apps/telegram/README.ja.md` (Japanese) in the MulmoClaude repository.
