#!/usr/bin/env node
// @mulmobridge/slack — Slack bridge for MulmoClaude.
//
// Uses Slack Socket Mode (no public URL needed).
//
// Required env vars:
//   SLACK_BOT_TOKEN     — xoxb-... (Bot User OAuth Token)
//   SLACK_APP_TOKEN     — xapp-... (App-Level Token with connections:write)
//
// Optional:
//   SLACK_ALLOWED_CHANNELS     — CSV of channel IDs (empty = allow all)
//   SLACK_SESSION_GRANULARITY  — "channel" (default) | "thread" | "auto"
//                                Controls how a single Slack channel is split
//                                into MulmoClaude sessions. See README.md.
//   SLACK_ACK_REACTION         — unset / "0" = off (default)
//                                "1" = on with default ":eyes:"
//                                any other emoji shortcode (no colons) = on with that emoji
//                                Requires the `reactions:write` bot scope.
//   MULMOCLAUDE_API_URL        — default: the port in <workspace>/.server-port,
//                                else http://localhost:3001
//   MULMOCLAUDE_AUTH_TOKEN     — bearer token (or read from workspace)

import "dotenv/config";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { createBridgeClient, formatAckReply } from "@mulmobridge/client";
import { parseCsvSet } from "@mulmoclaude/common";
import { buildExternalChatId, effectiveThreadTs, parseExternalChatId, parseGranularity } from "./sessionId.js";
import { parseAckReaction } from "./ackReaction.js";
import { redactUser } from "./redactUser.js";

const TRANSPORT_ID = "slack";

const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
if (!botToken || !appToken) {
  console.error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required.\nSee README for setup instructions.");
  process.exit(1);
}

const allowedChannels = parseCsvSet(process.env.SLACK_ALLOWED_CHANNELS);
const allowAll = allowedChannels.size === 0;

// The explicit `T` return annotation is what lets TS see `process.exit`'s
// `never` and accept the catch branch as non-returning.
function parseEnvOrExit<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    console.error(`[slack] ${err instanceof Error ? err.message : String(err)}`);
  }
  return process.exit(1);
}

const granularity = parseEnvOrExit(() => parseGranularity(process.env.SLACK_SESSION_GRANULARITY));

const ackEmoji = parseEnvOrExit(() => parseAckReaction(process.env.SLACK_ACK_REACTION));

const web = new WebClient(botToken);
const socketMode = new SocketModeClient({ appToken });

const client = createBridgeClient({ transportId: TRANSPORT_ID });

// Resolve the bot's own user ID so we can ignore our own messages
let botUserId: string | null = null;

client.onPush((pushEvent) => {
  const { channel, threadTs } = parseExternalChatId(pushEvent.chatId);
  web.chat
    .postMessage({
      channel,
      text: pushEvent.message,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    })
    .catch((err) => console.error(`[slack] push send failed: ${err}`));
});

/** The slice of Socket Mode's `message` envelope this bridge reads. Spelled out
 *  because extracting the handler out of the `.on(…)` call loses the inferred
 *  parameter type. `thread_ts` / `channel_type` are consumed by
 *  `effectiveThreadTs`, which takes them as `unknown`. */
interface SlackMessageEnvelope {
  event: {
    subtype?: unknown;
    bot_id?: unknown;
    user?: string;
    channel: string;
    text?: string;
    ts?: unknown;
    thread_ts?: unknown;
    channel_type?: unknown;
  };
  ack: () => Promise<void>;
}

// Listener stays sync so a rejection has somewhere to go — an async listener
// hands its promise to the emitter, which drops it.
socketMode.on("message", (envelope: SlackMessageEnvelope) => {
  onSocketMessage(envelope).catch((err) => console.error(`[slack] message handler error: ${err}`));
});

async function onSocketMessage({ event, ack }: SlackMessageEnvelope): Promise<void> {
  await ack();

  // Ignore bot's own messages, message_changed, etc.
  if (event.subtype) return;
  if (event.bot_id) return;
  if (botUserId && event.user === botUserId) return;

  const channelId: string = event.channel;
  const threadTs = effectiveThreadTs(event, granularity);
  const text: string = event.text ?? "";
  if (!text.trim()) return;

  if (!allowAll && !allowedChannels.has(channelId)) {
    console.log(`[slack] denied channel=${channelId}`);
    return;
  }

  const externalChatId = buildExternalChatId(channelId, threadTs, granularity);
  console.log(`[slack] message channel=${channelId} thread_ts=${threadTs ?? "-"} session=${externalChatId} user=${redactUser(event.user)} len=${text.length}`);

  sendAckReaction(channelId, event.ts);

  try {
    const ackResult = await client.send(externalChatId, text);
    await sendChunked(channelId, threadTs, formatAckReply(ackResult));
  } catch (err) {
    console.error(`[slack] message handling failed: ${err}`);
  }
}

// Fire-and-forget "seen" reaction. Deliberately not awaited so the
// agent processing starts immediately; errors (missing_scope,
// already_reacted, rate-limit, message_not_found, …) are logged and
// swallowed so they never stop the main handler.
function sendAckReaction(channel: string, eventTs: unknown): void {
  if (ackEmoji === null) return;
  if (typeof eventTs !== "string") return;
  web.reactions.add({ channel, timestamp: eventTs, name: ackEmoji }).catch((err) => console.warn(`[slack] reactions.add failed (continuing): ${err}`));
}

async function sendChunked(channel: string, threadTs: string | undefined, text: string): Promise<void> {
  // Slack's max message length is ~40,000 chars but we chunk at 4000
  // for readability (matching Telegram's approach).
  const MAX = 4000;
  const baseArgs = threadTs ? { channel, thread_ts: threadTs } : { channel };
  if (text.length === 0) {
    await web.chat.postMessage({ ...baseArgs, text: "(empty reply)" });
    return;
  }
  for (let i = 0; i < text.length; i += MAX) {
    await web.chat.postMessage({
      ...baseArgs,
      text: text.slice(i, i + MAX),
    });
  }
}

async function main(): Promise<void> {
  // Get bot user ID
  const authResult = await web.auth.test();
  const rawUserId = authResult.user_id;
  botUserId = typeof rawUserId === "string" ? rawUserId : null;

  console.log("MulmoClaude Slack bridge");
  console.log(`Channels: ${allowAll ? "(all)" : [...allowedChannels].join(", ")}`);
  console.log(`Session granularity: ${granularity}`);
  console.log(`Ack reaction: ${ackEmoji ?? "(disabled)"}`);

  await socketMode.start();
  console.log("Connected to Slack (Socket Mode).");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
