#!/usr/bin/env node
// @mulmobridge/webhook — Generic webhook bridge for MulmoClaude.
//
// Any HTTP-speaking tool can POST JSON to this bridge and get the AI
// reply back in the response body. Useful as developer-facing glue
// when you want to trigger a MulmoClaude turn from a script, a shell
// pipeline, a CI job, Zapier, n8n, Home Assistant automations, etc.
//
// The bridge is synchronous: the request stays open until MulmoClaude
// replies (or the bridge client's 6-minute timeout fires). For async
// delivery, use one of the platform-specific bridges instead.
//
// Required env vars:
//   WEBHOOK_SECRET   — Shared secret. Requests must carry a matching
//                      `x-webhook-secret` header (constant-time compared).
//                      To run without auth (local dev only), set
//                      WEBHOOK_ALLOW_OPEN=1 as an explicit opt-in.
//
// Optional:
//   WEBHOOK_PORT          — HTTP port (default 3009)
//   WEBHOOK_PATH          — Endpoint path (default "/webhook")
//   WEBHOOK_ALLOW_OPEN    — When "1", skip auth entirely (dev only).
//                           Prints a loud warning and leaves the
//                           endpoint wide open on every LLM call.

import "dotenv/config";
import crypto from "crypto";
import express, { type Request, type Response } from "express";
import { createBridgeClient, installProcessGuards } from "@mulmobridge/client";
import { listenWebhook } from "@mulmobridge/webhook-runtime";
import { isRecord } from "@mulmoclaude/common";

const TRANSPORT_ID = "webhook";

installProcessGuards({ name: TRANSPORT_ID });
const ENDPOINT = process.env.WEBHOOK_PATH ?? "/webhook";
const secret = process.env.WEBHOOK_SECRET ?? "";
const allowOpen = process.env.WEBHOOK_ALLOW_OPEN === "1";

// Require authentication by default. An open webhook in front of a
// real LLM is an abuse / cost / rate-limit vector — the caller must
// either set WEBHOOK_SECRET or opt into open mode explicitly.
if (!secret && !allowOpen) {
  console.error(
    "WEBHOOK_SECRET is required.\n" +
      "For local testing only, you can set WEBHOOK_ALLOW_OPEN=1 to run without auth —\n" +
      "but never expose such an instance to the public internet.",
  );
  process.exit(1);
}
if (!secret && allowOpen) {
  console.warn("[webhook] ⚠ WEBHOOK_ALLOW_OPEN=1 — endpoint is UNAUTHENTICATED. Every POST drives an LLM call. Do not expose publicly.");
}

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

mulmo.onPush((pushEvent) => {
  // Generic webhook is request/response — there is no channel to push to.
  // Server-initiated pushes land here and are logged; bind a platform-
  // specific bridge if you need push delivery.
  console.log(`[webhook] push (not delivered): chatId=${pushEvent.chatId} len=${pushEvent.message.length}`);
});

// ── Secret check ────────────────────────────────────────────────

function secretOk(provided: string | undefined): boolean {
  if (!secret) return true;
  if (!provided) return false;
  if (provided.length !== secret.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
  } catch {
    return false;
  }
}

// ── Payload extraction ─────────────────────────────────────────

interface Extracted {
  chatId: string;
  text: string;
}

function extractPayload(body: unknown): Extracted | null {
  if (!isRecord(body)) return null;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const chatId = typeof body.chatId === "string" && body.chatId.length > 0 ? body.chatId : "default";
  if (!text) return null;
  return { chatId, text };
}

// ── HTTP server ────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (__req, res) => {
  res.json({ status: "ok", transport: TRANSPORT_ID });
});

app.post(ENDPOINT, async (req: Request, res: Response) => {
  const provided = typeof req.headers["x-webhook-secret"] === "string" ? req.headers["x-webhook-secret"] : undefined;
  if (!secretOk(provided)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const payload = extractPayload(req.body);
  if (!payload) {
    res.status(400).json({ ok: false, error: "body must be JSON with at least { text: string } (chatId is optional)" });
    return;
  }

  console.log(`[webhook] message chatId=${payload.chatId} len=${payload.text.length}`);

  try {
    const ack = await mulmo.send(payload.chatId, payload.text);
    if (ack.ok) {
      res.json({ ok: true, reply: ack.reply ?? "" });
    } else {
      res.status(502).json({ ok: false, error: ack.error ?? "upstream error", status: ack.status });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[webhook] handler error: ${msg}`);
    res.status(500).json({ ok: false, error: msg });
  }
});

listenWebhook(app, { envVar: "WEBHOOK_PORT", fallback: 3009 }, (port) => {
  console.log("MulmoClaude Webhook bridge");
  console.log(`Listening on http://localhost:${port}${ENDPOINT}`);
  console.log(`Secret: ${secret ? "(set — x-webhook-secret required)" : "(none — open endpoint)"}`);
});
