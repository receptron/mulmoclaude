#!/usr/bin/env node
// @mulmobridge/line — LINE bridge for MulmoClaude.
//
// Runs a small HTTP server to receive LINE webhook events.
// Requires a public URL (use ngrok for development).
//
// Required env vars:
//   LINE_CHANNEL_SECRET      — Channel secret from LINE Developers Console
//   LINE_CHANNEL_ACCESS_TOKEN — Channel access token (long-lived)
//
// Optional:
//   LINE_BRIDGE_PORT          — Webhook listener port (default: 3002)
//   MULMOCLAUDE_API_URL       — default: the port in <workspace>/.server-port.
//                               With none published the client waits (#3078)
//   MULMOCLAUDE_AUTH_TOKEN    — bearer token

import "dotenv/config";
import type { Request, Response } from "express";
import { createBridgeClient, chunkText, formatAckReply } from "@mulmobridge/client";
import { createWebhookApp, createWebhookRateLimit, verifyHmacSignature, listenWebhook } from "@mulmobridge/webhook-runtime";
import { extractIncomingLineMessage, parseLineWebhookBody } from "./parse.js";

const TRANSPORT_ID = "line";

function readRequiredEnv(): { channelSecret: string; channelAccessToken: string } {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelSecret || !channelAccessToken) {
    console.error("LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN are required.\nSee README for setup instructions.");
    process.exit(1);
  }
  return { channelSecret, channelAccessToken };
}
const { channelSecret, channelAccessToken } = readRequiredEnv();

const client = createBridgeClient({ transportId: TRANSPORT_ID });

client.onPush((pushEvent) => {
  pushMessage(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[line] push send failed: ${err}`));
});

// ── LINE API helpers ────────────────────────────────────────────

/** Download an image attached to an inbound LINE message. Returns
 *  the bytes + Content-Type so the caller can build an Attachment
 *  envelope for the chat-service socket. Returns null when the
 *  fetch fails (network error, 4xx, …) — caller logs and skips. */
async function downloadLineImage(messageId: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  try {
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
      headers: { Authorization: `Bearer ${channelAccessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`[line] downloadLineImage failed: ${res.status}`);
      return null;
    }
    // LINE returns image/jpeg by default but the Data API also
    // serves the original sender format (PNG, GIF, …). Trust the
    // Content-Type header so the photo-EXIF hook (#1222 PR-A) can
    // tell HEIC apart from JPEG and surface the right sidecar.
    const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    const arrayBuffer = await res.arrayBuffer();
    return { bytes: Buffer.from(arrayBuffer), mimeType };
  } catch (err) {
    console.error(`[line] downloadLineImage network error: ${err}`);
    return null;
  }
}

async function pushMessage(userId: string, text: string): Promise<void> {
  const messages = chunkText(text, 5000).map((messageText) => ({
    type: "text",
    text: messageText,
  }));
  // LINE allows max 5 messages per push
  for (let i = 0; i < messages.length; i += 5) {
    try {
      const requestBody = {
        to: userId,
        messages: messages.slice(i, i + 5),
      };
      const res = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${channelAccessToken}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[line] pushMessage failed: ${res.status} ${body.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[line] pushMessage network error: ${err}`);
    }
  }
}

// ── Webhook server ──────────────────────────────────────────────

const app = createWebhookApp();
const webhookRateLimit = createWebhookRateLimit();

app.post("/webhook", webhookRateLimit, async (req: Request, res: Response) => {
  const signature = typeof req.headers["x-line-signature"] === "string" ? req.headers["x-line-signature"] : "";
  const bodyStr = typeof req.body === "string" ? req.body : "";

  if (!signature || !verifyHmacSignature(bodyStr, signature, channelSecret)) {
    res.status(401).send("Invalid signature");
    return;
  }

  res.status(200).send("OK");

  const body = parseLineWebhookBody(bodyStr);
  if (!body) {
    console.error("[line] malformed JSON in webhook body");
    return;
  }

  for (const event of body.events) {
    const incoming = extractIncomingLineMessage(event);
    if (!incoming) continue;

    try {
      if (incoming.kind === "text") {
        console.log(`[line] message user=${incoming.userId} len=${incoming.text.length}`);
        const ack = await client.send(incoming.userId, incoming.text);
        await pushMessage(incoming.userId, formatAckReply(ack));
        continue;
      }
      // kind === "image"
      console.log(`[line] image user=${incoming.userId} messageId=${incoming.imageMessageId}`);
      const image = await downloadLineImage(incoming.imageMessageId);
      if (!image) {
        await pushMessage(incoming.userId, "Sorry, I couldn't fetch that image.");
        continue;
      }
      // chat-service's `parseMessagePayload` rejects empty `text`
      // (`text is required`) so attachment-only messages need a
      // placeholder body. Mirror the Telegram convention (see
      // `packages/bridges/telegram/src/router.ts`) — an instructive
      // prompt rather than a caption, so the agent treats the
      // attachment as the subject and produces a useful response.
      // The post-save EXIF hook (#1222 PR-A) writes a sidecar if
      // GPS data is present. (Codex review on PR #1255 / #1263.)
      const attachments = [{ mimeType: image.mimeType, data: image.bytes.toString("base64") }];
      const placeholderText = "Describe / analyze this file.";
      const ack = await client.send(incoming.userId, placeholderText, attachments);
      await pushMessage(incoming.userId, formatAckReply(ack));
    } catch (err) {
      console.error(`[line] message handling failed: ${err}`);
    }
  }
});

listenWebhook(app, { envVar: "LINE_BRIDGE_PORT", fallback: 3002 }, (port) => {
  console.log("MulmoClaude LINE bridge");
  console.log(`Webhook listening on http://localhost:${port}/webhook`);
  console.log("Set your LINE webhook URL to: <public-url>/webhook");
});
