#!/usr/bin/env node
// @mulmobridge/zulip — Zulip bridge for MulmoClaude.
//
// Uses the Zulip long-polling events API (no public URL needed).
//
// Required env vars:
//   ZULIP_URL       — e.g. https://your-org.zulipchat.com
//   ZULIP_EMAIL     — Bot email (e.g. mulmo-bot@your-org.zulipchat.com)
//   ZULIP_API_KEY   — Bot API key

import "dotenv/config";
import { createBridgeClient, chunkText, fetchJsonRecord, type JsonRecord, installProcessGuards } from "@mulmobridge/client";
import { isRecord } from "@mulmoclaude/common";

const TRANSPORT_ID = "zulip";

installProcessGuards({ name: TRANSPORT_ID });
const POLL_TIMEOUT_SEC = 30;

const zulipUrl = process.env.ZULIP_URL;
const email = process.env.ZULIP_EMAIL;
const apiKey = process.env.ZULIP_API_KEY;
if (!zulipUrl || !email || !apiKey) {
  console.error("ZULIP_URL, ZULIP_EMAIL, and ZULIP_API_KEY are required.\nSee README for setup instructions.");
  process.exit(1);
}

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });
const apiBase = `${zulipUrl.replace(/\/$/, "")}/api/v1`;
const credentials = `${email}:${apiKey}`;
const authHeader = `Basic ${Buffer.from(credentials).toString("base64")}`;

mulmo.onPush((pushEvent) => {
  sendMessage(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[zulip] push send failed: ${err}`));
});

// ── Zulip API helpers ───────────────────────────────────────────

// fetch helpers — return Record<string, unknown> to avoid `as` casts on JSON.parse
async function zulipPost(path: string, params: Record<string, string>): Promise<JsonRecord> {
  return fetchJsonRecord(
    `${apiBase}${path}`,
    {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    },
    `POST ${path}`,
  );
}

async function zulipGet(path: string, params?: Record<string, string>): Promise<JsonRecord> {
  const queryString = params ? `?${new URLSearchParams(params).toString()}` : "";
  return fetchJsonRecord(
    `${apiBase}${path}${queryString}`,
    { headers: { Authorization: authHeader }, signal: AbortSignal.timeout((POLL_TIMEOUT_SEC + 10) * 1000) },
    `GET ${path}`,
  );
}

async function sendMessage(chatId: string, text: string): Promise<void> {
  // chatId format: "stream:<id>" or "private:<user_id>"
  const MAX = 10000; // Zulip's limit
  const chunks = chunkText(text, MAX);

  for (const chunk of chunks) {
    try {
      if (chatId.startsWith("stream:")) {
        // "stream:<id>[:<topic>]" — the `stream:` prefix guarantees an id
        // segment, so the default only covers a bare "stream:" chatId.
        const [, streamId = "", topic = "MulmoClaude"] = chatId.split(":");
        await zulipPost("/messages", {
          type: "stream",
          to: streamId,
          topic,
          content: chunk,
        });
      } else {
        await zulipPost("/messages", {
          type: "private",
          to: chatId.replace("private:", ""),
          content: chunk,
        });
      }
    } catch (err) {
      console.error(`[zulip] sendMessage error: ${err}`);
    }
  }
}

// ── Event polling ───────────────────────────────────────────────

async function registerQueue(): Promise<{
  queue_id: string;
  last_event_id: number;
}> {
  const result = await zulipPost("/register", {
    event_types: JSON.stringify(["message"]),
  });
  const queue_id = typeof result.queue_id === "string" ? result.queue_id : "";
  const last_event_id = typeof result.last_event_id === "number" ? result.last_event_id : -1;
  return { queue_id, last_event_id };
}

async function processEvents(events: unknown[]): Promise<number | undefined> {
  let latestId: number | undefined;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (typeof event.id === "number") latestId = event.id;
    if (event.type !== "message" || !isRecord(event.message)) continue;
    await handleMessage(event.message);
  }
  return latestId;
}

async function pollLoop(): Promise<void> {
  let { queue_id, last_event_id } = await registerQueue();

  while (true) {
    try {
      const result = await zulipGet("/events", {
        queue_id,
        last_event_id: String(last_event_id),
        dont_block: "false",
      });
      const events = Array.isArray(result.events) ? result.events : [];
      const latestId = await processEvents(events);
      if (latestId !== undefined) last_event_id = latestId;
    } catch (err) {
      console.error(`[zulip] poll error: ${err}`);
      try {
        ({ queue_id, last_event_id } = await registerQueue());
      } catch (regErr) {
        console.error(`[zulip] re-register failed: ${regErr}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
      }
    }
  }
}

async function handleMessage(msg: Record<string, unknown>): Promise<void> {
  const senderEmail = typeof msg.sender_email === "string" ? msg.sender_email : "";
  // Ignore own messages
  if (senderEmail === email) return;
  const content = typeof msg.content === "string" ? msg.content : "";
  const text = content.trim();
  if (!text) return;

  // Build chatId based on message type
  const msgType = typeof msg.type === "string" ? msg.type : "";
  const streamId = typeof msg.stream_id === "number" ? msg.stream_id : null;
  const subject = typeof msg.subject === "string" ? msg.subject : "MulmoClaude";
  const chatId = msgType === "stream" && streamId ? `stream:${streamId}:${subject}` : `private:${senderEmail}`;

  console.log(`[zulip] message type=${msgType} from=${senderEmail} len=${text.length}`);

  try {
    const ack = await mulmo.send(chatId, text);
    if (ack.ok) {
      await sendMessage(chatId, ack.reply ?? "");
    } else {
      const status = ack.status ? ` (${ack.status})` : "";
      await sendMessage(chatId, `Error${status}: ${ack.error ?? "unknown"}`);
    }
  } catch (err) {
    console.error(`[zulip] message handling failed: ${err}`);
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("MulmoClaude Zulip bridge");
  console.log(`Server: ${zulipUrl}`);
  console.log(`Bot: ${email}`);

  await pollLoop();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
