#!/usr/bin/env node
// @mulmobridge/bluesky — Bluesky bridge for MulmoClaude.
//
// Speaks the chat.bsky.convo.* XRPC API (Direct Messages) via the
// bot account's PDS with the `atproto-proxy: ...#bsky_chat` header.
// Polls chat.bsky.convo.getLog every few seconds for new message
// events and forwards them to MulmoClaude; replies are sent back
// through chat.bsky.convo.sendMessage.
//
// No public URL is needed — all traffic is outbound HTTP.
//
// Required env vars:
//   BLUESKY_HANDLE        — bot handle (e.g. mulmobot.bsky.social)
//   BLUESKY_APP_PASSWORD  — app password from Settings → App Passwords
//
// Optional:
//   BLUESKY_SERVICE       — PDS URL (default https://bsky.social)
//   BLUESKY_ALLOWED_DIDS  — CSV of DIDs allowed to converse (empty = all)

import "dotenv/config";
import { createBridgeClient, chunkText, installProcessGuards } from "@mulmobridge/client";
import { isRecord, parseCsvSet } from "@mulmoclaude/common";

const TRANSPORT_ID = "bluesky";

installProcessGuards({ name: TRANSPORT_ID });
const MAX_DM_LEN = 10_000;
const POLL_INTERVAL_MS = 3_000;
const FETCH_TIMEOUT_MS = 15_000;
const CHAT_PROXY = "did:web:api.bsky.chat#bsky_chat";

const handle = process.env.BLUESKY_HANDLE;
const appPassword = process.env.BLUESKY_APP_PASSWORD;
const service = (process.env.BLUESKY_SERVICE ?? "https://bsky.social").replace(/\/$/, "");
if (!handle || !appPassword) {
  console.error("BLUESKY_HANDLE and BLUESKY_APP_PASSWORD are required.\nSee README for setup instructions.");
  process.exit(1);
}

const allowedDids = parseCsvSet(process.env.BLUESKY_ALLOWED_DIDS);
const allowAll = allowedDids.size === 0;

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

mulmo.onPush((pushEvent) => {
  sendDm(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[bluesky] push send failed: ${err}`));
});

// ── Session management ─────────────────────────────────────────

interface Session {
  did: string;
  accessJwt: string;
  refreshJwt: string;
}

let session: Session | null = null;

type JsonRecord = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function createSession(): Promise<Session> {
  const res = await fetch(`${service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createSession failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error("createSession: non-object response");
  const did = asString(body.did);
  const accessJwt = asString(body.accessJwt);
  const refreshJwt = asString(body.refreshJwt);
  if (!did || !accessJwt || !refreshJwt) throw new Error("createSession: missing fields");
  return { did, accessJwt, refreshJwt };
}

async function refreshSession(current: Session): Promise<Session> {
  const res = await fetch(`${service}/xrpc/com.atproto.server.refreshSession`, {
    method: "POST",
    headers: { Authorization: `Bearer ${current.refreshJwt}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`refreshSession failed: ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error("refreshSession: non-object response");
  return {
    did: asString(body.did) || current.did,
    accessJwt: asString(body.accessJwt),
    refreshJwt: asString(body.refreshJwt),
  };
}

async function ensureSession(): Promise<Session> {
  if (!session) session = await createSession();
  return session;
}

// ── Chat XRPC helpers ──────────────────────────────────────────

function chatHeaders(accessJwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessJwt}`,
    "atproto-proxy": CHAT_PROXY,
  };
}

async function doChatFetch(method: "GET" | "POST", url: string, body: JsonRecord | undefined, accessJwt: string): Promise<Response> {
  const headers = chatHeaders(accessJwt);
  if (method === "POST") headers["Content-Type"] = "application/json";
  const payload = method === "POST" && body ? JSON.stringify(body) : undefined;
  return fetch(url, {
    method,
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

async function reauth(current: Session): Promise<void> {
  try {
    session = await refreshSession(current);
  } catch {
    session = await createSession();
  }
}

async function parseChatResponse(res: Response, method: string, path: string): Promise<JsonRecord> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  const json: unknown = await res.json();
  return isRecord(json) ? json : {};
}

async function chatRequest(method: "GET" | "POST", path: string, body?: JsonRecord, query?: Record<string, string>): Promise<JsonRecord> {
  const querystring = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : "";
  const url = `${service}/xrpc/${path}${querystring}`;

  const first = await doChatFetch(method, url, body, (await ensureSession()).accessJwt);
  if (first.status !== 401) return parseChatResponse(first, method, path);

  await reauth(await ensureSession());
  const second = await doChatFetch(method, url, body, (await ensureSession()).accessJwt);
  return parseChatResponse(second, method, path);
}

// ── Send / receive ─────────────────────────────────────────────

async function sendDm(convoId: string, text: string): Promise<void> {
  const chunks = chunkText(text, MAX_DM_LEN);
  for (const chunk of chunks) {
    await chatRequest("POST", "chat.bsky.convo.sendMessage", {
      convoId,
      message: { text: chunk },
    });
  }
}

interface IncomingMessage {
  convoId: string;
  senderDid: string;
  text: string;
}

function parseMessageLog(log: JsonRecord, selfDid: string): IncomingMessage | null {
  if (log.$type !== "chat.bsky.convo.defs#logCreateMessage") return null;
  const convoId = asString(log.convoId);
  const { message } = log;
  if (!isRecord(message)) return null;
  const text = asString(message.text);
  if (!text) return null;
  const sender = isRecord(message.sender) ? message.sender : null;
  const senderDid = sender ? asString(sender.did) : "";
  if (!convoId || !senderDid) return null;
  if (senderDid === selfDid) return null; // ignore our own
  return { convoId, senderDid, text };
}

async function handleMessage(msg: IncomingMessage): Promise<void> {
  if (!allowAll && !allowedDids.has(msg.senderDid)) {
    console.log(`[bluesky] denied from=${msg.senderDid}`);
    return;
  }
  console.log(`[bluesky] message convo=${msg.convoId} from=${msg.senderDid} len=${msg.text.length}`);
  try {
    const ack = await mulmo.send(msg.convoId, msg.text);
    if (ack.ok) {
      await sendDm(msg.convoId, ack.reply ?? "");
    } else {
      const status = ack.status ? ` (${ack.status})` : "";
      await sendDm(msg.convoId, `Error${status}: ${ack.error ?? "unknown"}`);
    }
  } catch (err) {
    console.error(`[bluesky] message handling failed: ${err}`);
  }
}

// ── Poll loop ──────────────────────────────────────────────────

async function processLogEntries(logs: unknown[], selfDid: string): Promise<void> {
  for (const entry of logs) {
    if (!isRecord(entry)) continue;
    const parsed = parseMessageLog(entry, selfDid);
    if (parsed) await handleMessage(parsed);
  }
}

async function pollOnce(cursor: string | undefined): Promise<string | undefined> {
  const query: Record<string, string> = cursor ? { cursor } : {};
  const result = await chatRequest("GET", "chat.bsky.convo.getLog", undefined, query);
  const logs = Array.isArray(result.logs) ? result.logs : [];
  const selfDid = (await ensureSession()).did;
  await processLogEntries(logs, selfDid);
  return asString(result.cursor) || cursor;
}

async function pollLoop(): Promise<void> {
  let cursor: string | undefined;

  while (true) {
    try {
      if (!cursor) {
        // Don't enter the main poll path until we have a cursor; otherwise a
        // transient startup failure can cause old DMs to be replayed.
        const initial = await chatRequest("GET", "chat.bsky.convo.getLog", undefined, {});
        cursor = asString(initial.cursor) || undefined;
        if (!cursor) {
          throw new Error("initial getLog returned no cursor");
        }
      } else {
        cursor = await pollOnce(cursor);
      }
    } catch (err) {
      const phase = cursor ? "poll" : "initial getLog";
      console.error(`[bluesky] ${phase} failed: ${err}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("MulmoClaude Bluesky bridge");
  console.log(`Service: ${service}`);
  console.log(`Handle: ${handle}`);
  console.log(`Allowlist: ${allowAll ? "(all)" : [...allowedDids].join(", ")}`);

  await ensureSession();
  console.log(`[bluesky] session established did=${session?.did}`);
  await pollLoop();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
