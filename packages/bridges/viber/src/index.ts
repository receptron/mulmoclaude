#!/usr/bin/env node
// @mulmobridge/viber — Viber Public Account bot bridge for MulmoClaude.
//
// Viber posts events to a configured webhook and the bot replies via the
// Viber Bot REST API. Signature verification uses HMAC-SHA256 of the raw
// body keyed on the auth token (X-Viber-Content-Signature header).
//
// **Public URL required** (Viber only supports webhook delivery).
//
// Required env vars:
//   VIBER_AUTH_TOKEN — Public Account token from the Viber Admin Panel
//
// Optional:
//   VIBER_SENDER_NAME  — Display name used when sending (default "MulmoClaude")
//   VIBER_WEBHOOK_PORT — HTTP port (default 3012)
//   VIBER_ALLOWED_USERS — CSV of sender user IDs allowed (empty = all)

import "dotenv/config";
import type { Request, Response as ExpressResponse } from "express";
import { createBridgeClient, chunkText } from "@mulmobridge/client";
import { createWebhookApp, createWebhookRateLimit, verifyHmacSignature, listenWebhook } from "@mulmobridge/webhook-runtime";
import { isRecord, parseCsvSet } from "@mulmoclaude/common";

const TRANSPORT_ID = "viber";
const MAX_VIBER_TEXT = 7_000;
const FETCH_TIMEOUT_MS = 15_000;
const VIBER_API = "https://chatapi.viber.com/pa";

function readRequiredEnv(): { authToken: string } {
  const authToken = process.env.VIBER_AUTH_TOKEN;
  if (!authToken) {
    console.error("VIBER_AUTH_TOKEN is required.\nSee README for setup instructions.");
    process.exit(1);
  }
  return { authToken };
}
const { authToken } = readRequiredEnv();

const senderName = process.env.VIBER_SENDER_NAME ?? "MulmoClaude";
const allowedUsers = parseCsvSet(process.env.VIBER_ALLOWED_USERS);
const allowAll = allowedUsers.size === 0;

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

mulmo.onPush((pushEvent) => {
  sendViber(decodeChatId(pushEvent.chatId), pushEvent.message).catch((err) => console.error(`[viber] push send failed: ${err}`));
});

// Viber user ids (the `sender.id` field in a MessageEvent) commonly
// contain `=` padding (e.g. "01234567890A=") — base64-style output
// from Viber's internal encoding. MulmoClaude's chat-service restricts
// chat ids to `/^[\w.-]+$/`, which rejects `=`. Wrap the raw id in
// base64url (which drops padding) on receive, and unwrap on push so
// Viber's Send API sees the original bytes again.
function encodeChatId(rawId: string): string {
  return Buffer.from(rawId, "utf-8").toString("base64url");
}

function decodeChatId(encodedId: string): string {
  return Buffer.from(encodedId, "base64url").toString("utf-8");
}

// ── Viber REST: send ───────────────────────────────────────────

async function sendViber(receiverId: string, text: string): Promise<void> {
  const chunks = chunkText(text, MAX_VIBER_TEXT);
  for (const chunk of chunks) {
    let res: Response;
    try {
      res = await fetch(`${VIBER_API}/send_message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Viber-Auth-Token": authToken },
        body: JSON.stringify({
          receiver: receiverId,
          type: "text",
          text: chunk,
          sender: { name: senderName },
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(`[viber] network error: ${err}`);
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[viber] send failed: ${res.status} ${detail.slice(0, 200)}`);
      continue;
    }
    // Viber returns {status: 0} on success; log non-zero as warnings
    const body: unknown = await res.json().catch(() => null);
    if (body && typeof body === "object" && "status" in body && body.status !== 0) {
      console.warn(`[viber] send non-zero status: ${JSON.stringify(body)}`);
    }
  }
}

// ── Webhook handler ────────────────────────────────────────────

interface IncomingViber {
  // Raw Viber user id, e.g. "01234567890A=". Kept so allowlist /
  // log lookups compare against what the operator actually sees in
  // the Viber admin console. Encoded when handed to chat-service.
  rawSenderId: string;
  text: string;
}

function parseMessageEvent(body: unknown): IncomingViber | null {
  if (!isRecord(body)) return null;
  if (body.event !== "message") return null;
  const sender = isRecord(body.sender) ? body.sender : null;
  const message = isRecord(body.message) ? body.message : null;
  if (!sender || !message) return null;
  const rawSenderId = typeof sender.id === "string" ? sender.id : "";
  const textFieldOk = message.type === "text" && typeof message.text === "string";
  const text = textFieldOk ? String(message.text).trim() : "";
  if (!rawSenderId || !text) return null;
  return { rawSenderId, text };
}

// bodyLimit 1mb: Viber can send larger payloads than Express's 100kb default.
const app = createWebhookApp({ bodyLimit: "1mb" });
const webhookRateLimit = createWebhookRateLimit();

app.get("/health", (__req, res) => {
  res.json({ status: "ok", transport: TRANSPORT_ID });
});

app.post("/viber", webhookRateLimit, async (req: Request, res: ExpressResponse) => {
  const signature = typeof req.headers["x-viber-content-signature"] === "string" ? req.headers["x-viber-content-signature"] : "";
  const rawBody = typeof req.body === "string" ? req.body : "";

  if (!signature || !verifyHmacSignature(rawBody, signature, authToken, "sha256", "hex")) {
    console.warn("[viber] AUTH_FAILED: signature mismatch");
    res.status(401).send("Invalid signature");
    return;
  }

  // ACK immediately so Viber doesn't retry.
  res.status(200).send("OK");

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return;
  }

  const incoming = parseMessageEvent(body);
  if (!incoming) return;

  // Allowlist compares against the raw operator-visible user id, not
  // the encoded form the chat-service sees.
  if (!allowAll && !allowedUsers.has(incoming.rawSenderId)) {
    console.log(`[viber] denied from=${incoming.rawSenderId}`);
    return;
  }

  console.log(`[viber] message from=${incoming.rawSenderId.slice(0, 8)}… len=${incoming.text.length}`);

  const encodedChatId = encodeChatId(incoming.rawSenderId);

  try {
    const ack = await mulmo.send(encodedChatId, incoming.text);
    if (ack.ok) {
      await sendViber(incoming.rawSenderId, ack.reply ?? "");
    } else {
      const statusSuffix = ack.status ? ` (${ack.status})` : "";
      await sendViber(incoming.rawSenderId, `Error${statusSuffix}: ${ack.error ?? "unknown"}`);
    }
  } catch (err) {
    console.error(`[viber] message handling failed: ${err}`);
  }
});

listenWebhook(app, { envVar: "VIBER_WEBHOOK_PORT", fallback: 3012 }, (port) => {
  console.log("MulmoClaude Viber bridge");
  console.log(`Webhook listening on http://localhost:${port}/viber`);
  console.log(`Sender: ${senderName}`);
  console.log(`Allowlist: ${allowAll ? "(all)" : [...allowedUsers].join(", ")}`);
});
