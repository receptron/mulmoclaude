#!/usr/bin/env node
// @mulmobridge/whatsapp — WhatsApp bridge for MulmoClaude.
//
// Uses Meta's WhatsApp Cloud API (webhook mode).
//
// Required env vars:
//   WHATSAPP_ACCESS_TOKEN    — permanent access token
//   WHATSAPP_PHONE_NUMBER_ID — phone number ID from Meta dashboard
//   WHATSAPP_VERIFY_TOKEN    — any string for webhook verification
//   WHATSAPP_APP_SECRET      — App secret for x-hub-signature-256 HMAC
//
// Optional:
//   WHATSAPP_BRIDGE_PORT      — webhook port (default: 3003)
//   WHATSAPP_ALLOWED_NUMBERS  — CSV of phone numbers (empty = all)

import "dotenv/config";
import { createBridgeClient } from "@mulmobridge/client";
import { createWebhookApp, registerMetaWebhook, listenWebhook } from "@mulmobridge/webhook-runtime";
import { parseCsvSet } from "@mulmoclaude/common";
import { extractWhatsAppMessages, type WhatsAppTextMessage } from "@mulmoclaude/common/meta-webhook";

const TRANSPORT_ID = "whatsapp";
const FETCH_TIMEOUT_MS = 30_000;

function readRequiredEnv(): { accessToken: string; phoneNumberId: string; verifyToken: string; appSecret: string } {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!accessToken || !phoneNumberId || !verifyToken || !appSecret) {
    console.error(
      "WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, and WHATSAPP_APP_SECRET are required.\nSee README for setup instructions.",
    );
    process.exit(1);
  }
  return { accessToken, phoneNumberId, verifyToken, appSecret };
}
const { accessToken, phoneNumberId, verifyToken, appSecret } = readRequiredEnv();

const allowedNumbers = parseCsvSet(process.env.WHATSAPP_ALLOWED_NUMBERS);
const allowAll = allowedNumbers.size === 0;

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

mulmo.onPush((pushEvent) => {
  sendWhatsAppMessage(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[whatsapp] push send failed: ${err}`));
});

// ── WhatsApp Cloud API ──────────────────────────────────────────

const API_BASE = `https://graph.facebook.com/v21.0/${phoneNumberId}`;

async function sendWhatsAppMessage(recipientId: string, text: string): Promise<void> {
  const MAX = 4096;
  const chunks =
    text.length === 0
      ? ["(empty reply)"]
      : Array.from({ length: Math.ceil(text.length / MAX) }, (_, chunkIndex) => text.slice(chunkIndex * MAX, (chunkIndex + 1) * MAX));

  for (const chunk of chunks) {
    try {
      const res = await fetch(`${API_BASE}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: recipientId,
          type: "text",
          text: { body: chunk },
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[whatsapp] sendMessage failed: ${res.status} ${body.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[whatsapp] sendMessage error: ${err}`);
    }
  }
}

// ── Webhook server ──────────────────────────────────────────────

const app = createWebhookApp();

async function processOneMessage(msg: WhatsAppTextMessage): Promise<void> {
  if (!allowAll && !allowedNumbers.has(msg.from)) {
    console.log(`[whatsapp] denied from=${msg.from}`);
    return;
  }

  console.log(`[whatsapp] message from=${msg.from} len=${msg.text.body.length}`);

  try {
    const ack = await mulmo.send(msg.from, msg.text.body);
    if (ack.ok) {
      await sendWhatsAppMessage(msg.from, ack.reply ?? "");
    } else {
      const status = ack.status ? ` (${ack.status})` : "";
      await sendWhatsAppMessage(msg.from, `Error${status}: ${ack.error ?? "unknown"}`);
    }
  } catch (err) {
    console.error(`[whatsapp] message handling failed: ${err}`);
  }
}

/** `undefined` is an unambiguous parse-failure sentinel — JSON has no
 *  `undefined` literal, so a valid body can never produce it. */
function parseWebhookJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

async function handleWebhookBody(rawBody: string): Promise<void> {
  const parsed = parseWebhookJson(rawBody);
  if (parsed === undefined) {
    console.error("[whatsapp] malformed JSON in webhook body");
    return;
  }
  for (const msg of extractWhatsAppMessages(parsed)) {
    await processOneMessage(msg);
  }
}

registerMetaWebhook(app, { verifyToken, appSecret, label: "whatsapp", ackBody: "OK", onBody: handleWebhookBody });

listenWebhook(app, { envVar: "WHATSAPP_BRIDGE_PORT", fallback: 3003 }, (port) => {
  console.log("MulmoClaude WhatsApp bridge");
  console.log(`Webhook listening on http://localhost:${port}/webhook`);
});
