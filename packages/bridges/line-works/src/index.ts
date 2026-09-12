#!/usr/bin/env node
// @mulmobridge/line-works — LINE Works (enterprise LINE) bridge for MulmoClaude.
//
// LINE Works is a separate product from consumer LINE with its own API
// surface: service-account JWT → OAuth access token → Bot Message API.
// Inbound is via webhook (signed HMAC-SHA256 with the bot secret).
// Outbound is via REST with a bearer token that we refresh automatically.
//
// **Public URL required** (LINE Works uses webhook delivery).
//
// Required env vars:
//   LINEWORKS_CLIENT_ID       — app Client ID
//   LINEWORKS_CLIENT_SECRET   — app Client Secret
//   LINEWORKS_SERVICE_ACCOUNT — service account ID (e.g. abc.serviceaccount@example)
//   LINEWORKS_BOT_ID          — numeric Bot ID
//   LINEWORKS_BOT_SECRET      — per-bot secret for webhook signature verification
//   LINEWORKS_PRIVATE_KEY     — PEM string (paste with \n)
//                               -- OR --
//   LINEWORKS_PRIVATE_KEY_FILE — path to PEM file
//
// Optional:
//   LINEWORKS_WEBHOOK_PORT    — HTTP port (default 3013)
//   LINEWORKS_ALLOWED_USERS   — CSV of sender user IDs (empty = all)

import "dotenv/config";
import crypto from "crypto";
import { readFileSync } from "fs";
import type { Request, Response as ExpressResponse } from "express";
import { createBridgeClient, chunkText, installProcessGuards } from "@mulmobridge/client";
import { createWebhookApp, createWebhookRateLimit, verifyHmacSignature, listenWebhook } from "@mulmobridge/webhook-runtime";
import { isRecord, parseCsvSet } from "@mulmoclaude/common";

const TRANSPORT_ID = "line-works";

installProcessGuards({ name: TRANSPORT_ID });
const MAX_TEXT = 1_000;
const FETCH_TIMEOUT_MS = 15_000;
const JWT_TTL_SEC = 3_600;
const TOKEN_REFRESH_MARGIN_SEC = 60;

function readRequiredEnv(): { clientId: string; clientSecret: string; serviceAccount: string; botId: string; botSecret: string; privateKeyPem: string } {
  const clientId = process.env.LINEWORKS_CLIENT_ID;
  const clientSecret = process.env.LINEWORKS_CLIENT_SECRET;
  const serviceAccount = process.env.LINEWORKS_SERVICE_ACCOUNT;
  const botId = process.env.LINEWORKS_BOT_ID;
  const botSecret = process.env.LINEWORKS_BOT_SECRET;
  const privateKeyPem = resolvePrivateKey();
  if (!clientId || !clientSecret || !serviceAccount || !botId || !botSecret || !privateKeyPem) {
    console.error(
      "Required: LINEWORKS_CLIENT_ID, LINEWORKS_CLIENT_SECRET, LINEWORKS_SERVICE_ACCOUNT, LINEWORKS_BOT_ID, LINEWORKS_BOT_SECRET, and one of LINEWORKS_PRIVATE_KEY / LINEWORKS_PRIVATE_KEY_FILE.\n" +
        "See README for setup instructions.",
    );
    process.exit(1);
  }
  return { clientId, clientSecret, serviceAccount, botId, botSecret, privateKeyPem };
}
const { clientId, clientSecret, serviceAccount, botId, botSecret, privateKeyPem } = readRequiredEnv();

function resolvePrivateKey(): string | null {
  const inline = process.env.LINEWORKS_PRIVATE_KEY;
  if (inline) return inline.replace(/\\n/g, "\n");
  const path = process.env.LINEWORKS_PRIVATE_KEY_FILE;
  if (path) {
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      console.error(`Failed to read LINEWORKS_PRIVATE_KEY_FILE=${path}: ${err}`);
      return null;
    }
  }
  return null;
}

const allowedUsers = parseCsvSet(process.env.LINEWORKS_ALLOWED_USERS);
const allowAll = allowedUsers.size === 0;

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

mulmo.onPush((pushEvent) => {
  sendLineWorks(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[line-works] push send failed: ${err}`));
});

// ── JWT → OAuth access token ────────────────────────────────────

interface TokenCache {
  accessToken: string;
  expiresAtMs: number;
}
let tokenCache: TokenCache | null = null;

function stripBase64Padding(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x3d /* '=' */) end--;
  return value.slice(0, end);
}

function base64Url(input: Buffer | string): string {
  const base64 = Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return stripBase64Padding(base64);
}

function buildAssertion(): string {
  const nowSec = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: clientId,
      sub: serviceAccount,
      iat: nowSec,
      exp: nowSec + JWT_TTL_SEC,
    }),
  );
  const data = `${header}.${payload}`;
  const sig = crypto.createSign("RSA-SHA256").update(data).sign(privateKeyPem);
  return `${data}.${base64Url(sig)}`;
}

async function fetchAccessToken(): Promise<TokenCache> {
  const assertion = buildAssertion();
  const form = new URLSearchParams({
    assertion,
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "bot bot.message",
  });
  const res = await fetch("https://auth.worksmobile.com/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LINE Works token: ${res.status} ${text.slice(0, 200)}`);
  }
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error("LINE Works token: unexpected response");
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3_600;
  if (!accessToken) throw new Error("LINE Works token: missing access_token");
  return { accessToken, expiresAtMs: Date.now() + (expiresIn - TOKEN_REFRESH_MARGIN_SEC) * 1_000 };
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAtMs > Date.now()) return tokenCache.accessToken;
  tokenCache = await fetchAccessToken();
  return tokenCache.accessToken;
}

// ── Send ────────────────────────────────────────────────────────

async function sendLineWorks(userId: string, text: string): Promise<void> {
  const token = await getAccessToken();
  const chunks = chunkText(text, MAX_TEXT);
  for (const chunk of chunks) {
    let res: Response;
    try {
      res = await fetch(`https://www.worksapis.com/v1.0/bots/${encodeURIComponent(botId)}/users/${encodeURIComponent(userId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: { type: "text", text: chunk } }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(`[line-works] network error: ${err}`);
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[line-works] send failed: ${res.status} ${detail.slice(0, 200)}`);
    }
  }
}

// ── Payload parsing ────────────────────────────────────────────

interface IncomingLineWorks {
  userId: string;
  text: string;
}

function parseEvent(body: unknown): IncomingLineWorks | null {
  if (!isRecord(body)) return null;
  if (body.type !== "message") return null;
  const source = isRecord(body.source) ? body.source : null;
  const content = isRecord(body.content) ? body.content : null;
  if (!source || !content) return null;
  const userId = typeof source.userId === "string" ? source.userId : "";
  const text = content.type === "text" && typeof content.text === "string" ? String(content.text).trim() : "";
  if (!userId || !text) return null;
  return { userId, text };
}

// ── HTTP server ────────────────────────────────────────────────

// bodyLimit 1mb: LINE WORKS can send larger payloads than Express's 100kb default.
const app = createWebhookApp({ bodyLimit: "1mb" });
const callbackRateLimit = createWebhookRateLimit();

app.get("/health", (__req, res) => {
  res.json({ status: "ok", transport: TRANSPORT_ID });
});

app.post("/callback", callbackRateLimit, async (req: Request, res: ExpressResponse) => {
  const signature = typeof req.headers["x-works-signature"] === "string" ? req.headers["x-works-signature"] : "";
  const rawBody = typeof req.body === "string" ? req.body : "";
  if (!signature || !verifyHmacSignature(rawBody, signature, botSecret, "sha256", "base64")) {
    console.warn("[line-works] AUTH_FAILED: signature mismatch");
    res.status(401).send("Invalid signature");
    return;
  }

  res.status(200).send("OK");

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return;
  }
  const incoming = parseEvent(parsedBody);
  if (!incoming) return;

  if (!allowAll && !allowedUsers.has(incoming.userId)) {
    console.log(`[line-works] denied from=${incoming.userId}`);
    return;
  }

  console.log(`[line-works] message from=${incoming.userId.slice(0, 8)}… len=${incoming.text.length}`);

  try {
    const ack = await mulmo.send(incoming.userId, incoming.text);
    if (ack.ok) {
      await sendLineWorks(incoming.userId, ack.reply ?? "");
    } else {
      const statusSuffix = ack.status ? ` (${ack.status})` : "";
      await sendLineWorks(incoming.userId, `Error${statusSuffix}: ${ack.error ?? "unknown"}`);
    }
  } catch (err) {
    console.error(`[line-works] message handling failed: ${err}`);
  }
});

listenWebhook(app, { envVar: "LINEWORKS_WEBHOOK_PORT", fallback: 3013 }, (port) => {
  console.log("MulmoClaude LINE Works bridge");
  console.log(`Webhook listening on http://localhost:${port}/callback`);
  console.log(`Bot ID: ${botId}`);
  console.log(`Allowlist: ${allowAll ? "(all)" : [...allowedUsers].join(", ")}`);
});
