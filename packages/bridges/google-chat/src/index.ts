#!/usr/bin/env node
// @mulmobridge/google-chat — Google Chat bridge for MulmoClaude.
//
// Google Chat apps can receive events via HTTP endpoint (webhook).
// The bot responds synchronously or asynchronously via the Chat API.
//
// Every incoming request is verified by checking the Authorization
// Bearer JWT against Google's JWKS endpoint. The token must be issued
// by chat@system.gserviceaccount.com with the project number as aud.
//
// Required env vars:
//   GOOGLE_CHAT_PROJECT_NUMBER — Google Cloud project number (for token verification)
//
// Optional:
//   GOOGLE_CHAT_BRIDGE_PORT — Webhook port (default: 3005)
//   GOOGLE_CHAT_SERVICE_ACCOUNT_KEY — Path to service account JSON (for async replies)

import "dotenv/config";
import crypto from "crypto";
import express, { type Request, type Response } from "express";
import { configureTrustProxy, createWebhookRateLimit, listenWebhook } from "@mulmobridge/webhook-runtime";
import { createBridgeClient } from "@mulmobridge/client";
import { isRecord, splitJwtSegments } from "@mulmoclaude/common";

const TRANSPORT_ID = "google-chat";

const projectNumber = process.env.GOOGLE_CHAT_PROJECT_NUMBER;
if (!projectNumber) {
  console.error("GOOGLE_CHAT_PROJECT_NUMBER is required.\nSee README for setup instructions.");
  process.exit(1);
}

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

mulmo.onPush((pushEvent) => {
  // Async push requires Chat API with service account — not
  // available in synchronous webhook mode. Log for now.
  console.log(`[google-chat] push (not delivered): ${pushEvent.chatId} ${pushEvent.message}`);
});

// ── JWT verification (Google Chat OIDC) ────────────────────────
//
// Google Chat sends an Authorization: Bearer <JWT> header.
// We verify the JWT signature using Google's JWKS for the
// chat@system.gserviceaccount.com service account, then check
// iss, aud, and exp claims.

const GOOGLE_CHAT_ISSUER = "chat@system.gserviceaccount.com";
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";
const JWKS_CACHE_TTL_MS = 3600_000; // 1 hour

interface JwkKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

let cachedKeys: JwkKey[] = [];
let cacheExpiresAt = 0;

async function fetchJwks(): Promise<JwkKey[]> {
  if (Date.now() < cacheExpiresAt && cachedKeys.length > 0) {
    return cachedKeys;
  }
  try {
    const res = await fetch(JWKS_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`JWKS fetch failed: ${res.status}`);
    }
    const data: unknown = await res.json();
    if (!isRecord(data) || !Array.isArray(data.keys)) throw new Error("Invalid JWKS response");
    cachedKeys = data.keys.filter(
      (keyCandidate): keyCandidate is JwkKey =>
        isRecord(keyCandidate) && typeof keyCandidate.kid === "string" && typeof keyCandidate.n === "string" && typeof keyCandidate.e === "string",
    );
    cacheExpiresAt = Date.now() + JWKS_CACHE_TTL_MS;
    return cachedKeys;
  } catch (err) {
    console.error(`[google-chat] JWKS fetch error: ${err}`);
    return cachedKeys; // return stale cache if available
  }
}

function base64UrlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signatureInput: string;
  signature: Buffer;
}

function parseJwtParts(token: string): JwtParts | null {
  const segments = splitJwtSegments(token);
  if (segments === null) return null;
  const { headerSegment, payloadSegment, signatureSegment } = segments;
  try {
    const header: unknown = JSON.parse(base64UrlDecode(headerSegment).toString());
    const payload: unknown = JSON.parse(base64UrlDecode(payloadSegment).toString());
    if (!isRecord(header) || !isRecord(payload)) return null;
    return {
      header,
      payload,
      signatureInput: `${headerSegment}.${payloadSegment}`,
      signature: base64UrlDecode(signatureSegment),
    };
  } catch {
    return null;
  }
}

function buildRsaPublicKey(modulus: string, exponent: string): crypto.KeyObject {
  // Convert JWK RSA components to a PEM-encoded public key
  const modulusBuffer = base64UrlDecode(modulus);
  const exponentBuffer = base64UrlDecode(exponent);
  return crypto.createPublicKey({
    key: {
      kty: "RSA",
      n: modulusBuffer.toString("base64"),
      e: exponentBuffer.toString("base64"),
    },
    format: "jwk",
  });
}

function verifyRsaSignature(signatureInput: string, signature: Buffer, key: crypto.KeyObject, alg: string): boolean {
  const hashMap: Record<string, string> = {
    RS256: "sha256",
    RS384: "sha384",
    RS512: "sha512",
  };
  const hash = hashMap[alg];
  if (!hash) return false;
  return crypto.createVerify(hash).update(signatureInput).verify(key, signature);
}

async function verifyGoogleChatToken(authHeader: string | undefined): Promise<boolean> {
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const token = authHeader.slice(prefix.length).trim();
  if (!token) return false;

  const jwt = parseJwtParts(token);
  if (!jwt) return false;

  // Verify claims
  const { payload, header } = jwt;
  if (payload.iss !== GOOGLE_CHAT_ISSUER) return false;
  if (String(payload.aud) !== projectNumber) return false;
  if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
    return false;
  }

  // Find matching key
  const keyId = typeof header.kid === "string" ? header.kid : "";
  const alg = typeof header.alg === "string" ? header.alg : "RS256";
  const keys = await fetchJwks();
  const jwk = keys.find((keyEntry) => keyEntry.kid === keyId);
  if (!jwk) return false;

  try {
    const modulus = jwk["n"];
    const exponent = jwk["e"];
    const pubKey = buildRsaPublicKey(modulus, exponent);
    return verifyRsaSignature(jwt.signatureInput, jwt.signature, pubKey, alg);
  } catch {
    return false;
  }
}

// ── Webhook server ──────────────────────────────────────────────

const BODY_LIMIT = "1mb";

const webhookRateLimit = createWebhookRateLimit();

function redactId(resourceId: string): string {
  return resourceId.length > 6 ? `${resourceId.slice(0, 3)}***${resourceId.slice(-3)}` : "***";
}

const app = express();
app.disable("x-powered-by");
configureTrustProxy(app);
// express.json (not the shared createWebhookApp's text parser): Google
// Chat's request is a signed JWT in the Authorization header, verified
// separately, so the JSON body is parsed directly.
app.use(express.json({ limit: BODY_LIMIT }));

function extractEventType(body: unknown): string {
  if (!isRecord(body) || typeof body.type !== "string") return "";
  return body.type;
}

interface ParsedMessage {
  spaceName: string;
  senderName: string;
  text: string;
}

function extractMessage(body: unknown): ParsedMessage | null {
  if (!isRecord(body)) return null;
  const msg = body.message;
  if (!isRecord(msg)) return null;
  if (typeof msg.text !== "string") return null;
  const { space } = msg;
  if (!isRecord(space) || typeof space.name !== "string") return null;
  const { sender } = msg;
  const senderName = isRecord(sender) && typeof sender.displayName === "string" ? sender.displayName : "unknown";
  return { spaceName: space.name, senderName, text: msg.text };
}

// Webhook events. Rate-limited per-IP via `webhookRateLimit`; the
// middleware writes the 429 response itself when the cap is hit so
// the handler body only sees admitted requests.
app.post("/", webhookRateLimit, async (req: Request, res: Response) => {
  // Verify the request is from Google Chat
  const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
  const verified = await verifyGoogleChatToken(authHeader);
  if (!verified) {
    console.warn("[google-chat] AUTH_FAILED: JWT verification failed");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const eventType = extractEventType(req.body);

  if (eventType === "ADDED_TO_SPACE") {
    res.json({ text: "Hello! I'm MulmoClaude. Send me a message." });
    return;
  }

  if (eventType !== "MESSAGE") {
    res.json({});
    return;
  }

  const parsed = extractMessage(req.body);
  if (!parsed || !parsed.text.trim()) {
    res.status(400).json({ error: "PAYLOAD_INVALID" });
    return;
  }

  const { spaceName, senderName, text } = parsed;

  console.log(`[google-chat] message space=${redactId(spaceName)} sender=${redactId(senderName)} len=${text.length}`);

  try {
    const ack = await mulmo.send(spaceName, text.trim());
    if (ack.ok) {
      res.json({ text: ack.reply ?? "(empty reply)" });
    } else {
      const status = ack.status ? ` (${ack.status})` : "";
      console.error(`[google-chat] UPSTREAM_ERROR: ${ack.error ?? "unknown"}`);
      res.json({ text: `Error${status}: ${ack.error ?? "unknown"}` });
    }
  } catch (err) {
    console.error(`[google-chat] UPSTREAM_ERROR: ${err}`);
    res.status(500).json({ error: "Internal error" });
  }
});

listenWebhook(app, { envVar: "GOOGLE_CHAT_BRIDGE_PORT", fallback: 3005 }, (port) => {
  console.log("MulmoClaude Google Chat bridge");
  console.log(`Webhook listening on http://localhost:${port}/`);
  console.log("Configure your Google Chat app endpoint to: <public-url>/");
});
