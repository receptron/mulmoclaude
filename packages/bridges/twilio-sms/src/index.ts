#!/usr/bin/env node
// @mulmobridge/twilio-sms — Twilio SMS bridge for MulmoClaude.
//
// Inbound: Twilio sends form-encoded POST to /sms when an SMS arrives
// on your Twilio number. The bridge validates Twilio's HMAC-SHA1
// X-Twilio-Signature, forwards the text to MulmoClaude, and replies
// via the Twilio REST API. Outbound: Twilio REST API sends SMS.
//
// Required env vars:
//   TWILIO_ACCOUNT_SID  — Account SID from the Twilio console
//   TWILIO_AUTH_TOKEN   — Auth token (used for both REST auth and
//                         X-Twilio-Signature verification)
//   TWILIO_FROM_NUMBER  — Your Twilio number in E.164 form (+15551234567)
//
// Optional:
//   TWILIO_WEBHOOK_PORT    — HTTP port (default 3010)
//   TWILIO_PUBLIC_URL      — Full public URL of /sms, used for signature
//                            verification. Required by default; the
//                            bridge refuses to start without it unless
//                            TWILIO_ALLOW_UNVERIFIED=1 is also set
//                            (dev-only escape hatch).
//   TWILIO_ALLOW_UNVERIFIED — When "1", skip signature verification.
//                            Only for local testing — prints a loud
//                            warning and leaves /sms wide open.
//   TWILIO_ALLOWED_NUMBERS — CSV of sender numbers allowed (empty = all)

import "dotenv/config";
import crypto from "crypto";
import express, { type Request, type Response as ExpressResponse } from "express";
import { createBridgeClient, chunkText } from "@mulmobridge/client";
import { listenWebhook } from "@mulmobridge/webhook-runtime";
import { isRecord, parseCsvSet } from "@mulmoclaude/common";

const TRANSPORT_ID = "twilio-sms";
const MAX_SMS_LEN = 1_600; // Twilio concatenates segments up to 1600 chars
const FETCH_TIMEOUT_MS = 15_000;

function readRequiredEnv(): { accountSid: string; authToken: string; fromNumber: string } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) {
    console.error("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER are required.\nSee README for setup instructions.");
    process.exit(1);
  }
  return { accountSid, authToken, fromNumber };
}
const { accountSid, authToken, fromNumber } = readRequiredEnv();

const publicUrl = process.env.TWILIO_PUBLIC_URL?.replace(/\/$/, "");
const allowUnverified = process.env.TWILIO_ALLOW_UNVERIFIED === "1";
if (!publicUrl && !allowUnverified) {
  console.error(
    "TWILIO_PUBLIC_URL is required for X-Twilio-Signature verification.\n" +
      "For local testing only, you can set TWILIO_ALLOW_UNVERIFIED=1 to skip\n" +
      "verification — but never in production (open webhook).",
  );
  process.exit(1);
}
if (!publicUrl && allowUnverified) {
  console.warn("[twilio-sms] ⚠ TWILIO_ALLOW_UNVERIFIED=1 — signature verification DISABLED. Use only in local testing.");
}
const allowedNumbers = parseCsvSet(process.env.TWILIO_ALLOWED_NUMBERS);
const allowAll = allowedNumbers.size === 0;

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

mulmo.onPush((pushEvent) => {
  sendSms(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[twilio-sms] push send failed: ${err}`));
});

// ── Twilio signature validation ─────────────────────────────────

function expectedSignature(url: string, params: Record<string, string>): string {
  // Twilio: sort params by key, concat key+value, prepend URL, sign with auth token.
  const sortedKeys = Object.keys(params).sort();
  const data = sortedKeys.reduce((acc, key) => acc + key + params[key], url);
  const hmac = crypto.createHmac("sha1", authToken);
  hmac.update(data);
  return hmac.digest("base64");
}

function signatureValid(url: string, params: Record<string, string>, provided: string): boolean {
  const expected = expectedSignature(url, params);
  if (expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

// ── Twilio REST: send SMS ──────────────────────────────────────

async function sendSms(toNumber: string, text: string): Promise<void> {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const chunks = chunkText(text, MAX_SMS_LEN);
  for (const chunk of chunks) {
    const form = new URLSearchParams({ From: fromNumber, To: toNumber, Body: chunk });
    let res: Response;
    try {
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(`[twilio-sms] network error: ${err}`);
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[twilio-sms] send failed: ${res.status} ${detail.slice(0, 200)}`);
    }
  }
}

// ── HTTP server ────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));

app.get("/health", (__req, res) => {
  res.json({ status: "ok", transport: TRANSPORT_ID });
});

interface TwilioBody {
  From: string;
  To: string;
  Body: string;
  MessageSid: string;
}

function parseTwilioBody(body: unknown): TwilioBody | null {
  if (!isRecord(body)) return null;
  const record = body;
  const from = typeof record.From === "string" ? record.From : "";
  const toField = typeof record.To === "string" ? record.To : "";
  const text = typeof record.Body === "string" ? record.Body : "";
  const messageSid = typeof record.MessageSid === "string" ? record.MessageSid : "";
  if (!from || !toField || !messageSid) return null;
  return { From: from, To: toField, Body: text, MessageSid: messageSid };
}

/** The string-valued subset of a form body, for signature computation.
 *
 *  Takes `unknown` because the caller has an Express `req.body`. A non-record
 *  yields `{}`, which produces a signature that cannot match — fail closed,
 *  the same outcome as an absent body. */
function stringifyParams(body: unknown): Record<string, string> {
  if (!isRecord(body)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

app.post("/sms", async (req: Request, res: ExpressResponse) => {
  const parsed = parseTwilioBody(req.body);
  if (!parsed) {
    res.status(400).send("Bad Request");
    return;
  }

  if (publicUrl) {
    const sig = typeof req.headers["x-twilio-signature"] === "string" ? req.headers["x-twilio-signature"] : "";
    const params = stringifyParams(req.body);
    // Twilio signs the *full* URL it POSTed to — including query string.
    // `req.originalUrl` keeps the querystring that Twilio saw, whereas
    // `req.path` is just "/sms". Without this, any webhook URL with a
    // query parameter (e.g. ?env=prod) would fail verification.
    const fullUrl = `${publicUrl}${req.originalUrl}`;
    if (!sig || !signatureValid(fullUrl, params, sig)) {
      console.warn("[twilio-sms] AUTH_FAILED: X-Twilio-Signature mismatch");
      res.status(401).send("Invalid signature");
      return;
    }
  }

  // ACK right away so Twilio doesn't retry; we'll send the reply asynchronously.
  res.status(204).end();

  if (!allowAll && !allowedNumbers.has(parsed.From)) {
    console.log(`[twilio-sms] denied from=${parsed.From}`);
    return;
  }

  const text = parsed.Body.trim();
  if (!text) return;

  console.log(`[twilio-sms] message from=${parsed.From} len=${text.length}`);

  try {
    const ack = await mulmo.send(parsed.From, text);
    if (ack.ok) {
      await sendSms(parsed.From, ack.reply ?? "");
    } else {
      const status = ack.status ? ` (${ack.status})` : "";
      await sendSms(parsed.From, `Error${status}: ${ack.error ?? "unknown"}`);
    }
  } catch (err) {
    console.error(`[twilio-sms] message handling failed: ${err}`);
  }
});

listenWebhook(app, { envVar: "TWILIO_WEBHOOK_PORT", fallback: 3010 }, (port) => {
  console.log("MulmoClaude Twilio SMS bridge");
  console.log(`Webhook listening on http://localhost:${port}/sms`);
  console.log(`From number: ${fromNumber}`);
  console.log(`Public URL: ${publicUrl ?? "(not set — signature verification OFF)"}`);
  console.log(`Allowlist: ${allowAll ? "(all)" : [...allowedNumbers].join(", ")}`);
});
