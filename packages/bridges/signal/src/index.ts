#!/usr/bin/env node
// @mulmobridge/signal — Signal bridge for MulmoClaude.
//
// Talks to a running signal-cli-rest-api daemon (https://github.com/
// bbernhard/signal-cli-rest-api) — typically a local Docker container.
// Opens a WebSocket for incoming messages and POSTs outgoing replies
// via the daemon's REST endpoint. All traffic is local (bridge ↔ daemon),
// then the daemon handles the actual Signal network connection.
//
// Required env vars:
//   SIGNAL_API_URL — daemon base URL, e.g. http://localhost:8080
//   SIGNAL_NUMBER  — bot's registered Signal number in E.164 form,
//                    e.g. +81901234567
//
// Optional:
//   SIGNAL_ALLOWED_NUMBERS — CSV of sender numbers allowed (empty = all)

import "dotenv/config";
import WebSocket from "ws";
import { createBridgeClient, chunkText, frameText, installProcessGuards } from "@mulmobridge/client";
import { isRecord, parseCsvSet } from "@mulmoclaude/common";

const TRANSPORT_ID = "signal";

installProcessGuards({ name: TRANSPORT_ID });
const MAX_SIGNAL_TEXT = 4_000;
const FETCH_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

const apiUrl = (process.env.SIGNAL_API_URL ?? "").replace(/\/$/, "");
const botNumber = process.env.SIGNAL_NUMBER;
if (!apiUrl || !botNumber) {
  console.error("SIGNAL_API_URL and SIGNAL_NUMBER are required.\nSee README for setup instructions.");
  process.exit(1);
}

const allowedNumbers = parseCsvSet(process.env.SIGNAL_ALLOWED_NUMBERS);
const allowAll = allowedNumbers.size === 0;

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });
const wsUrl = `${apiUrl.replace(/^http/, "ws")}/v1/receive/${encodeURIComponent(botNumber)}`;

mulmo.onPush((pushEvent) => {
  sendSignal(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[signal] push send failed: ${err}`));
});

// ── Send ────────────────────────────────────────────────────────

// Chat-id encoding mirrors signal-cli-rest-api recipient conventions:
//   - 1:1 DM:   E.164 number (e.g. "+81901234567")
//   - Group v2: "group.<base64-id>" — signal-cli accepts this as a
//               recipient on /v2/send, so there's nothing to decode
//               on the send path, we just pass chatId through.
async function sendSignal(chatId: string, text: string): Promise<void> {
  const chunks = chunkText(text, MAX_SIGNAL_TEXT);
  for (const chunk of chunks) {
    let res: Response;
    try {
      res = await fetch(`${apiUrl}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: chunk,
          number: botNumber,
          recipients: [chatId],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(`[signal] send network error: ${err}`);
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[signal] send failed: ${res.status} ${detail.slice(0, 200)}`);
    }
  }
}

// ── Receive ─────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

interface IncomingSignal {
  sourceNumber: string;
  /** Stable conversation id. For DMs = sourceNumber; for groups =
   *  "group.<base64-id>" so signal-cli-rest-api can route replies
   *  back to the group on /v2/send. This is also what MulmoClaude
   *  keys its session on, so DM and group threads stay separate. */
  chatId: string;
  /** True iff the message arrived in a group conversation. */
  isGroup: boolean;
  text: string;
}

function extractGroupId(dataMessage: JsonRecord): string {
  // Signal envelopes from signal-cli-rest-api surface groups in one of
  // two shapes depending on daemon version:
  //   - v2: dataMessage.groupInfo.groupId (base64)
  //   - new: dataMessage.groupV2.id (also base64)
  // Either form is accepted as a recipient prefix.
  const groupV2 = isRecord(dataMessage.groupV2) ? dataMessage.groupV2 : null;
  if (groupV2 && typeof groupV2.id === "string" && groupV2.id.length > 0) return groupV2.id;
  const info = isRecord(dataMessage.groupInfo) ? dataMessage.groupInfo : null;
  if (info && typeof info.groupId === "string" && info.groupId.length > 0) return info.groupId;
  return "";
}

// E.164: `+` followed by 1-15 digits, first digit non-zero. Signal
// accepts this exact shape; the bot can only reply to senders whose
// phone is on file.
const E164_PHONE = /^\+[1-9]\d{1,14}$/;

function parseEnvelope(raw: string): IncomingSignal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const envelope = isRecord(parsed.envelope) ? parsed.envelope : null;
  if (!envelope) return null;

  // Signal envelopes carry both `source` (may be phone or UUID) and
  // `sourceNumber` (E.164 phone or null). The `/v2/send` API requires
  // E.164 phone numbers as recipients, so a UUID fallback will 400.
  // Username-only senders (no phone on file) will have sourceNumber:
  // null — we can't reply to them at all, so drop the message rather
  // than attempt a failing send. See CodeRabbit review on #611.
  const sourceNumber = typeof envelope.sourceNumber === "string" && E164_PHONE.test(envelope.sourceNumber) ? envelope.sourceNumber : "";
  const dataMessage = isRecord(envelope.dataMessage) ? envelope.dataMessage : null;
  const text = dataMessage && typeof dataMessage.message === "string" ? dataMessage.message.trim() : "";
  if (!sourceNumber || !text || !dataMessage) return null;

  const groupId = extractGroupId(dataMessage);
  const chatId = groupId ? `group.${groupId}` : sourceNumber;
  return { sourceNumber, chatId, isGroup: Boolean(groupId), text };
}

async function handleEnvelope(raw: string): Promise<void> {
  const msg = parseEnvelope(raw);
  if (!msg) return;

  // Allowlist still checks the HUMAN sender — a group chat where only
  // one user is whitelisted should still only respond to that user.
  if (!allowAll && !allowedNumbers.has(msg.sourceNumber)) {
    console.log(`[signal] denied from=${msg.sourceNumber}`);
    return;
  }

  const kind = msg.isGroup ? "group" : "dm";
  console.log(`[signal] ${kind} message from=${msg.sourceNumber} chatId=${msg.chatId} len=${msg.text.length}`);

  try {
    // chatId keeps group threads separate from the sender's DM thread
    // on the MulmoClaude side. Replies go to the same conversation
    // the message came from (group → group, DM → sender).
    const ack = await mulmo.send(msg.chatId, msg.text);
    if (ack.ok) {
      await sendSignal(msg.chatId, ack.reply ?? "");
    } else {
      const status = ack.status ? ` (${ack.status})` : "";
      await sendSignal(msg.chatId, `Error${status}: ${ack.error ?? "unknown"}`);
    }
  } catch (err) {
    console.error(`[signal] handleEnvelope error: ${err}`);
  }
}

// ── WebSocket loop ──────────────────────────────────────────────

// Reconnect delay lives at module scope so each new connect() call
// sees the value accumulated across previous failures. Previously
// `let backoffMs` inside connect() meant every reconnect reset to
// RECONNECT_BASE_MS — the "exponential backoff" was in practice a
// 1 s retry loop while the daemon was down.
let backoffMs = RECONNECT_BASE_MS;

function connect(): void {
  const socket = new WebSocket(wsUrl);

  socket.on("open", () => {
    console.log(`[signal] receive stream connected`);
    backoffMs = RECONNECT_BASE_MS;
  });

  socket.on("message", (buffer) => {
    handleEnvelope(frameText(buffer)).catch((err) => console.error(`[signal] envelope handler error: ${err}`));
  });

  socket.on("error", (err) => {
    console.error(`[signal] stream error: ${err.message}`);
  });

  socket.on("close", (code, reason) => {
    const delayMs = backoffMs;
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    console.warn(`[signal] stream closed code=${code} reason=${reason.toString().slice(0, 100)}; reconnecting in ${delayMs}ms (next ${backoffMs}ms)`);
    setTimeout(() => connect(), delayMs);
  });
}

// ── Main ────────────────────────────────────────────────────────

console.log("MulmoClaude Signal bridge");
console.log(`Daemon: ${apiUrl}`);
console.log(`Bot number: ${botNumber}`);
console.log(`Allowlist: ${allowAll ? "(all)" : [...allowedNumbers].join(", ")}`);

connect();
