#!/usr/bin/env node
// @mulmobridge/rocketchat — Rocket.Chat bridge for MulmoClaude.
//
// Uses the REST API with a personal access token. Every poll interval the
// bridge lists direct-message rooms and fetches new messages per room,
// forwarding non-self messages to MulmoClaude and posting replies back.
// Outbound-only — no public URL needed.
//
// Required env vars:
//   ROCKETCHAT_URL      — server URL, e.g. https://rocket.example.com
//   ROCKETCHAT_USER_ID  — bot user ID (Avatar → My Account → Personal Access
//                         Tokens → copy "User ID")
//   ROCKETCHAT_TOKEN    — personal access token for the bot user
//
// Optional:
//   ROCKETCHAT_ALLOWED_USERS      — CSV of usernames allowed (empty = all)
//   ROCKETCHAT_POLL_INTERVAL_SEC  — poll interval seconds (default 5)

import "dotenv/config";
import { createBridgeClient, chunkText, fetchJsonRecord, type JsonRecord, installProcessGuards } from "@mulmobridge/client";
import { isRecord, parseCsvSet } from "@mulmoclaude/common";

const TRANSPORT_ID = "rocketchat";

installProcessGuards({ name: TRANSPORT_ID });
const MAX_MSG_LEN = 4_000;
const FETCH_TIMEOUT_MS = 15_000;

function readRequiredEnv(): { baseUrl: string; userId: string; authToken: string } {
  const baseUrl = (process.env.ROCKETCHAT_URL ?? "").replace(/\/$/, "");
  const userId = process.env.ROCKETCHAT_USER_ID;
  const authToken = process.env.ROCKETCHAT_TOKEN;
  if (!baseUrl || !userId || !authToken) {
    console.error("ROCKETCHAT_URL, ROCKETCHAT_USER_ID, and ROCKETCHAT_TOKEN are required.\nSee README for setup instructions.");
    process.exit(1);
  }
  return { baseUrl, userId, authToken };
}
const { baseUrl, userId, authToken } = readRequiredEnv();

const allowedUsers = parseCsvSet(process.env.ROCKETCHAT_ALLOWED_USERS);
const allowAll = allowedUsers.size === 0;
const pollIntervalSec = Math.max(2, Number(process.env.ROCKETCHAT_POLL_INTERVAL_SEC) || 5);

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });
const apiBase = `${baseUrl}/api/v1`;

mulmo.onPush((pushEvent) => {
  postMessage(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[rocketchat] push send failed: ${err}`));
});

// ── REST helpers ────────────────────────────────────────────────

// `Array.isArray(x: unknown)` narrows to `any[]`, which reintroduces `any`;
// this preserves the element type as `unknown` so downstream stays checked.
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function authHeaders(): Record<string, string> {
  return {
    "X-Auth-Token": authToken,
    "X-User-Id": userId,
  };
}

async function rcGet(path: string, query?: Record<string, string>): Promise<JsonRecord> {
  const queryString = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : "";
  return fetchJsonRecord(`${apiBase}${path}${queryString}`, { headers: authHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }, `GET ${path}`);
}

async function rcPost(path: string, body: JsonRecord): Promise<JsonRecord> {
  return fetchJsonRecord(
    `${apiBase}${path}`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
    `POST ${path}`,
  );
}

// ── Send / receive ──────────────────────────────────────────────

async function postMessage(roomId: string, text: string): Promise<void> {
  const chunks = chunkText(text, MAX_MSG_LEN);
  for (const chunk of chunks) {
    try {
      await rcPost("/chat.postMessage", { roomId, text: chunk });
    } catch (err) {
      console.error(`[rocketchat] postMessage error: ${err}`);
    }
  }
}

interface IncomingMessage {
  msgId: string;
  roomId: string;
  senderUsername: string;
  senderId: string;
  text: string;
  tsIso: string;
}

function parseMessage(raw: unknown, roomId: string): IncomingMessage | null {
  if (!isRecord(raw)) return null;
  const msgId = typeof raw._id === "string" ? raw._id : "";
  const text = typeof raw.msg === "string" ? raw.msg : "";
  const user = isRecord(raw.u) ? raw.u : null;
  const senderUsername = user && typeof user.username === "string" ? user.username : "";
  const senderId = user && typeof user._id === "string" ? user._id : "";
  const tsIso = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
  if (!msgId || !text || !senderUsername || !senderId) return null;
  return { msgId, roomId, senderUsername, senderId, text, tsIso };
}

async function handleIncoming(msg: IncomingMessage): Promise<void> {
  if (msg.senderId === userId) return; // ignore self
  if (!allowAll && !allowedUsers.has(msg.senderUsername)) {
    console.log(`[rocketchat] denied from=${msg.senderUsername}`);
    return;
  }
  console.log(`[rocketchat] message room=${msg.roomId} from=${msg.senderUsername} len=${msg.text.length}`);

  try {
    const ack = await mulmo.send(msg.roomId, msg.text);
    if (ack.ok) {
      await postMessage(msg.roomId, ack.reply ?? "");
    } else {
      const status = ack.status ? ` (${ack.status})` : "";
      await postMessage(msg.roomId, `Error${status}: ${ack.error ?? "unknown"}`);
    }
  } catch (err) {
    console.error(`[rocketchat] handleIncoming error: ${err}`);
  }
}

// ── Poll loop ───────────────────────────────────────────────────

// Rocket.Chat's list endpoints cap at 100 per call and tell you the
// total in the response envelope. Page through by `offset` until we've
// seen every room — pre-paging, a deployment with >100 DMs would have
// silently ignored everything beyond the first 100 rooms.
const ROOMS_PAGE_SIZE = 100;
// `im.history` caps at 50 per call too. Without paging, a room that
// accumulates >50 new messages between polls (long idle, a chatty user)
// would lose everything past the first 50 because the cursor still
// advances to the newest returned timestamp.
const HISTORY_PAGE_SIZE = 50;
// Safety cap on history pages per poll cycle. At 50 × 50 = 2,500
// messages it's already well beyond anything a real conversation
// produces per interval; guards against pathological loops.
const HISTORY_MAX_PAGES = 50;

async function listDmRoomIds(): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  // `total` is returned by Rocket.Chat alongside the paged result;
  // loop until we've fetched every row. Fallback to "stop when a
  // page returns fewer rows than requested" in case `total` is
  // missing on some server versions.
  while (true) {
    const result = await rcGet("/im.list", {
      count: String(ROOMS_PAGE_SIZE),
      offset: String(offset),
    });
    const rooms = Array.isArray(result.ims) ? result.ims : [];
    for (const room of rooms) {
      if (isRecord(room) && typeof room._id === "string") ids.push(room._id);
    }
    offset += rooms.length;
    const total = typeof result.total === "number" ? result.total : null;
    const done = rooms.length < ROOMS_PAGE_SIZE || (total !== null && offset >= total);
    if (done) break;
  }
  return ids;
}

async function pollRoom(roomId: string, oldestIso: string): Promise<string> {
  // Fetch pages of history starting at `oldestIso` until the server
  // returns fewer than HISTORY_PAGE_SIZE rows (nothing left in the
  // window) or HISTORY_MAX_PAGES is hit. We narrow the `oldest`
  // cursor forward each page so we don't re-fetch messages we've
  // already processed.
  let cursorIso = oldestIso;
  let newestIso = oldestIso;

  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    const result = await rcGet("/im.history", {
      roomId,
      oldest: cursorIso,
      inclusive: "false",
      count: String(HISTORY_PAGE_SIZE),
    });
    const messages: unknown[] = isUnknownArray(result.messages) ? result.messages : [];
    if (messages.length === 0) break;

    const sorted = [...messages].reverse(); // API returns newest-first
    for (const raw of sorted) {
      const parsed = parseMessage(raw, roomId);
      if (!parsed) continue;
      await handleIncoming(parsed);
      if (parsed.tsIso > newestIso) newestIso = parsed.tsIso;
    }

    // If this page didn't fill up, the window is exhausted. Otherwise,
    // advance the cursor to the newest message in this batch so the
    // next page picks up from there.
    if (messages.length < HISTORY_PAGE_SIZE) break;
    cursorIso = newestIso;
  }
  return newestIso;
}

async function pollLoop(): Promise<void> {
  const cursors = new Map<string, string>();

  while (true) {
    try {
      const rooms = await listDmRoomIds();
      for (const roomId of rooms) {
        // First time we see a room, rewind the cursor by one poll
        // interval so the message that triggered room creation (often
        // the user's first DM) is still captured on the next
        // /im.history call. A pure `new Date().toISOString()` cursor
        // would place the `oldest` boundary at or after the first
        // message's ts, dropping it with `inclusive: "false"`.
        let cursor = cursors.get(roomId);
        if (!cursor) {
          cursor = new Date(Date.now() - pollIntervalSec * 1000).toISOString();
          cursors.set(roomId, cursor);
        }
        try {
          const newestIso = await pollRoom(roomId, cursor);
          cursors.set(roomId, newestIso);
        } catch (err) {
          console.error(`[rocketchat] pollRoom ${roomId} error: ${err}`);
        }
      }
    } catch (err) {
      console.error(`[rocketchat] poll loop error: ${err}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalSec * 1000));
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("MulmoClaude Rocket.Chat bridge");
  console.log(`Server: ${baseUrl}`);
  console.log(`Allowlist: ${allowAll ? "(all)" : [...allowedUsers].join(", ")}`);
  console.log(`Poll interval: ${pollIntervalSec}s`);

  // Smoke-test auth by hitting /me
  const profile = await rcGet("/me");
  console.log(`[rocketchat] authenticated as ${String(profile.username)}`);

  await pollLoop();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
