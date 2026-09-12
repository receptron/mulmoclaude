#!/usr/bin/env node
// Telegram bridge (issue #321). Polls Telegram for incoming
// messages and dispatches them through the shared message router,
// which enforces the chat-ID allowlist, forwards to MulmoClaude,
// and delivers Phase-B pushes back through sendMessage.
//
// Env surface (see docs/message_apps/telegram/README.md):
//   TELEGRAM_BOT_TOKEN          — BotFather token (required)
//   TELEGRAM_ALLOWED_CHAT_IDS   — CSV of integer chat IDs (required
//                                 in practice; empty = deny everyone)
//   MULMOCLAUDE_API_URL         — optional override
//   MULMOCLAUDE_AUTH_TOKEN      — optional override
//   TELEGRAM_POLL_TIMEOUT_SEC   — optional, default 25

import "dotenv/config";
import { createBridgeClient, installProcessGuards } from "@mulmobridge/client";
import { createTelegramApi, type TelegramApi } from "./api.js";
import { parseAllowlist, type Allowlist } from "./allowlist.js";
import { createMessageRouter, type MessageRouter } from "./router.js";

const TRANSPORT_ID = "telegram";

interface EnvConfig {
  botToken: string;
  allowlist: Allowlist;
  pollTimeoutSec: number;
}

function readEnv(): EnvConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || botToken.trim().length === 0) {
    console.error("TELEGRAM_BOT_TOKEN is required. See docs/message_apps/telegram/.");
    process.exit(1);
  }
  let allowlist: Allowlist;
  try {
    allowlist = parseAllowlist(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const pollTimeoutSec = Number(process.env.TELEGRAM_POLL_TIMEOUT_SEC ?? "25");
  if (!Number.isInteger(pollTimeoutSec) || pollTimeoutSec < 0) {
    console.error("TELEGRAM_POLL_TIMEOUT_SEC must be a non-negative integer");
    process.exit(1);
  }
  return { botToken, allowlist, pollTimeoutSec };
}

async function pollLoop(api: TelegramApi, router: MessageRouter, opts: { pollTimeoutSec: number; abortSignal: AbortSignal }): Promise<void> {
  let offset: number | undefined;
  while (!opts.abortSignal.aborted) {
    let updates;
    try {
      updates = await api.getUpdates({
        offset,
        timeoutSec: opts.pollTimeoutSec,
        signal: opts.abortSignal,
      });
    } catch (err) {
      if (opts.abortSignal.aborted) return;
      console.error(`[telegram] getUpdates error: ${String(err)}`);
      // Back off briefly so a broken network doesn't busy-loop.
      await delay(1000);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.message) {
        await router.handleMessage(update.message);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const { botToken, allowlist, pollTimeoutSec } = readEnv();

  console.log("MulmoClaude Telegram bridge");
  console.log(`Allowlist: ${allowlist.size() > 0 ? allowlist.snapshot().join(", ") : "(empty — all chats will be denied)"}`);

  const api = createTelegramApi({ botToken });
  const client = createBridgeClient({ transportId: TRANSPORT_ID });
  const router = createMessageRouter({
    api,
    allowlist,
    sendToMulmo: (chatId, text, attachments) => client.send(chatId, text, attachments),
  });

  // Server → Telegram streaming text chunks (Phase C of #268).
  client.onTextChunk((chunk) => {
    router.handleTextChunk(chunk);
  });

  // Server → Telegram async push (Phase B of #268).
  client.onPush((ev) => {
    router.handlePush(ev).catch((err) => console.error(`[telegram] handlePush failed: ${String(err)}`));
  });

  const abortController = new AbortController();
  // Installed here rather than at module level because the shutdown work needs
  // the controller and the socket. `main().catch` still covers the awaited
  // startup path above, so nothing is unguarded in between.
  installProcessGuards({
    name: TRANSPORT_ID,
    onShutdown: () => {
      abortController.abort();
      client.close();
    },
  });

  await pollLoop(api, router, {
    pollTimeoutSec,
    abortSignal: abortController.signal,
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
