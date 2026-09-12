#!/usr/bin/env node
// @mulmobridge/chatwork — Chatwork bridge for MulmoClaude.
//
// Polls each room the bot is a member of for unread messages, forwards
// them to MulmoClaude, and sends replies via the REST API. Outbound-only
// — no public URL required.
//
// Required env vars:
//   CHATWORK_API_TOKEN — API token from My → Service Integration
//
// Optional:
//   CHATWORK_ALLOWED_ROOMS      — CSV of room_ids the bot should listen in
//                                 (empty = every room the bot is a member of)
//   CHATWORK_POLL_INTERVAL_SEC  — poll interval seconds (default 5)
//   CHATWORK_ROOMS_TTL_SEC      — TTL for the GET /rooms cache used in
//                                 "allow all" mode (default 180)
//
// Rate-limit posture (Chatwork's published cap is 300 requests / 5 min):
//   - When CHATWORK_ALLOWED_ROOMS is set, every cycle costs
//     (rooms_in_allowlist) GET /rooms/{id}/messages.
//   - Otherwise it additionally costs ~1 GET /rooms per CHATWORK_ROOMS_TTL_SEC
//     window (cached between calls — we don't re-enumerate every poll).
//   - A 429 response triggers exponential backoff (1s → 2s → 4s … capped
//     at 60s) and honours Retry-After when the server supplies it.

import "dotenv/config";
import { createBridgeClient, chunkText, installProcessGuards } from "@mulmobridge/client";
import { isRecord, parseCsvSet } from "@mulmoclaude/common";

const TRANSPORT_ID = "chatwork";

installProcessGuards({ name: TRANSPORT_ID });
const API_BASE = "https://api.chatwork.com/v2";
const MAX_MSG_LEN = 40_000; // Chatwork's practical limit is generous; chunk conservatively
const FETCH_TIMEOUT_MS = 15_000;

function readRequiredEnv(): { apiToken: string } {
  const apiToken = process.env.CHATWORK_API_TOKEN;
  if (!apiToken) {
    console.error("CHATWORK_API_TOKEN is required.\nSee README for setup instructions.");
    process.exit(1);
  }
  return { apiToken };
}
const { apiToken } = readRequiredEnv();

const allowedRooms = parseCsvSet(process.env.CHATWORK_ALLOWED_ROOMS);
const allowAll = allowedRooms.size === 0;
const pollIntervalSec = Math.max(2, Number(process.env.CHATWORK_POLL_INTERVAL_SEC) || 5);
const roomsTtlMs = Math.max(30, Number(process.env.CHATWORK_ROOMS_TTL_SEC) || 180) * 1000;

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

mulmo.onPush((pushEvent) => {
  sendMessage(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[chatwork] push send failed: ${err}`));
});

// ── Chatwork REST helpers ───────────────────────────────────────

type JsonRecord = Record<string, unknown>;

// Shared 429 backoff — any 429 response pauses all subsequent
// requests until `retryAfter`. Keeps multiple concurrent callers
// (e.g. sendMessage during a poll cycle) from hammering the API
// once the cap has been hit.
let retryAfter = 0;
let backoffStreakMs = 1000;

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  if (retryAfter > now) {
    await sleep(retryAfter - now);
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((done) => setTimeout(done, delayMs));
}

function parseRetryAfter(headerValue: string | null): number {
  if (!headerValue) return 0;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const when = Date.parse(headerValue);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 0;
}

async function cwFetch(method: "GET" | "POST" | "PUT", path: string, form?: Record<string, string>): Promise<unknown> {
  await waitForRateLimit();
  const headers: Record<string, string> = { "X-ChatWorkToken": apiToken };
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 204) {
    backoffStreakMs = 1000;
    return null;
  }
  if (res.status === 429) {
    const headerDelay = parseRetryAfter(res.headers.get("retry-after"));
    const delay = Math.min(60_000, Math.max(headerDelay, backoffStreakMs));
    retryAfter = Date.now() + delay;
    backoffStreakMs = Math.min(60_000, backoffStreakMs * 2);
    console.warn(`[chatwork] 429 rate-limited — backing off ${delay}ms (source: ${headerDelay ? "retry-after" : "exp"})`);
    throw new Error(`${method} ${path}: 429 rate-limited (retry after ${delay}ms)`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  backoffStreakMs = 1000;
  return res.json();
}

// ── Bot identity ────────────────────────────────────────────────

async function getBotAccountId(): Promise<number> {
  const profile = await cwFetch("GET", "/me");
  if (!isRecord(profile) || typeof profile.account_id !== "number") {
    throw new Error("/me returned unexpected shape");
  }
  return profile.account_id;
}

// Cache the GET /rooms result in "allow all" mode. Without this
// the bridge burns one extra request per poll interval just to
// discover the same room list — 5s interval × 1 req = 12 req/min
// on top of the messages polls. Room membership changes are rare
// in practice, so a few-minute TTL is a reasonable default.
interface RoomsCache {
  ids: string[];
  fetchedAt: number;
}
let roomsCache: RoomsCache | null = null;

async function getRoomIds(): Promise<string[]> {
  const now = Date.now();
  if (roomsCache && now - roomsCache.fetchedAt < roomsTtlMs) {
    return roomsCache.ids;
  }
  const rooms = await cwFetch("GET", "/rooms");
  if (!Array.isArray(rooms)) {
    return roomsCache?.ids ?? [];
  }
  const ids = rooms.filter((room): room is JsonRecord => isRecord(room) && typeof room.room_id === "number").map((room) => String(room.room_id));
  roomsCache = { ids, fetchedAt: now };
  return ids;
}

// ── Send / receive ──────────────────────────────────────────────

async function sendMessage(roomId: string, text: string): Promise<void> {
  const chunks = chunkText(text, MAX_MSG_LEN);
  for (const chunk of chunks) {
    try {
      await cwFetch("POST", `/rooms/${roomId}/messages`, { body: chunk });
    } catch (err) {
      console.error(`[chatwork] sendMessage error: ${err}`);
    }
  }
}

interface ParsedMessage {
  messageId: string;
  accountId: number;
  accountName: string;
  body: string;
}

function parseMessage(raw: unknown): ParsedMessage | null {
  if (!isRecord(raw)) return null;
  const messageId = typeof raw.message_id === "string" ? raw.message_id : "";
  const body = typeof raw.body === "string" ? raw.body : "";
  const account = isRecord(raw.account) ? raw.account : null;
  if (!messageId || !body || !account) return null;
  const accountId = typeof account.account_id === "number" ? account.account_id : -1;
  const accountName = typeof account.name === "string" ? account.name : "unknown";
  return { messageId, accountId, accountName, body };
}

async function handleRoomMessage(roomId: string, botId: number, msg: ParsedMessage): Promise<void> {
  if (msg.accountId === botId) return; // ignore our own messages
  const text = stripChatworkTags(msg.body);
  if (!text) return;

  console.log(`[chatwork] message room=${roomId} from=${msg.accountName}(${msg.accountId}) len=${text.length}`);

  try {
    const ack = await mulmo.send(roomId, text);
    if (ack.ok) {
      await sendMessage(roomId, ack.reply ?? "");
    } else {
      const status = ack.status ? ` (${ack.status})` : "";
      await sendMessage(roomId, `Error${status}: ${ack.error ?? "unknown"}`);
    }
  } catch (err) {
    console.error(`[chatwork] message handling failed: ${err}`);
  }
}

function stripChatworkTags(body: string): string {
  // Remove common Chatwork tags: [To:id], [rp aid=id to=mid], [piconname:id], [qt]...[/qt], [info]...[/info]
  return body
    .replace(/\[To:\d+\]\s*/g, "")
    .replace(/\[rp[^\]]*\]\s*/g, "")
    .replace(/\[piconname:\d+\]\s*/g, "")
    .replace(/\[qt\][\s\S]*?\[\/qt\]/g, "")
    .replace(/\[info\]([\s\S]*?)\[\/info\]/g, "$1")
    .replace(/\[title\]([\s\S]*?)\[\/title\]/g, "$1")
    .trim();
}

// ── Poll loop ───────────────────────────────────────────────────

async function pollRoom(roomId: string, botId: number): Promise<void> {
  const result = await cwFetch("GET", `/rooms/${roomId}/messages?force=0`);
  if (!Array.isArray(result)) return; // 204 → null, or no new messages
  for (const raw of result) {
    const parsed = parseMessage(raw);
    if (parsed) await handleRoomMessage(roomId, botId, parsed);
  }
}

async function resolveActiveRooms(): Promise<string[]> {
  if (!allowAll) return [...allowedRooms];
  return getRoomIds();
}

async function pollLoop(botId: number): Promise<void> {
  while (true) {
    try {
      const rooms = await resolveActiveRooms();
      for (const roomId of rooms) {
        try {
          await pollRoom(roomId, botId);
        } catch (err) {
          console.error(`[chatwork] pollRoom ${roomId} error: ${err}`);
        }
      }
    } catch (err) {
      console.error(`[chatwork] poll loop error: ${err}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalSec * 1000));
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("MulmoClaude Chatwork bridge");
  console.log(`Allowlist: ${allowAll ? "(all bot rooms)" : [...allowedRooms].join(", ")}`);
  console.log(`Poll interval: ${pollIntervalSec}s`);

  const botId = await getBotAccountId();
  console.log(`[chatwork] bot account_id=${botId}`);
  await pollLoop(botId);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
