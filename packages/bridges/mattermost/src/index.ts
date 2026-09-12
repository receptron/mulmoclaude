#!/usr/bin/env node
// @mulmobridge/mattermost — Mattermost bridge for MulmoClaude.
//
// Uses the Mattermost WebSocket API (no public URL needed).
//
// Required env vars:
//   MATTERMOST_URL        — e.g. https://mattermost.example.com
//   MATTERMOST_BOT_TOKEN  — Bot account access token
//
// Optional:
//   MATTERMOST_ALLOWED_CHANNELS — CSV of channel IDs (empty = all)

import "dotenv/config";
import WebSocket from "ws";
import { createBridgeClient, chunkText, asJsonRecord, installProcessGuards } from "@mulmobridge/client";
import { isRecord, parseCsvSet } from "@mulmoclaude/common";

const TRANSPORT_ID = "mattermost";

installProcessGuards({ name: TRANSPORT_ID });

function readRequiredEnv(): { mmUrl: string; botToken: string } {
  const mmUrl = process.env.MATTERMOST_URL;
  const botToken = process.env.MATTERMOST_BOT_TOKEN;
  if (!mmUrl || !botToken) {
    console.error("MATTERMOST_URL and MATTERMOST_BOT_TOKEN are required.\nSee README for setup instructions.");
    process.exit(1);
  }
  return { mmUrl, botToken };
}
const { mmUrl, botToken } = readRequiredEnv();

const allowedChannels = parseCsvSet(process.env.MATTERMOST_ALLOWED_CHANNELS);
const allowAll = allowedChannels.size === 0;

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });
let botUserId: string | null = null;

mulmo.onPush((pushEvent) => {
  postMessage(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[mattermost] push send failed: ${err}`));
});

// ── Mattermost REST API ─────────────────────────────────────────

const apiBase = `${mmUrl.replace(/\/$/, "")}/api/v4`;

async function apiGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return asJsonRecord(await res.json());
}

async function postMessage(channelId: string, text: string): Promise<void> {
  const MAX = 4000;
  const chunks = chunkText(text, MAX);
  for (const chunk of chunks) {
    try {
      const res = await fetch(`${apiBase}/posts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ channel_id: channelId, message: chunk }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[mattermost] postMessage failed: ${res.status} ${body.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[mattermost] postMessage error: ${err}`);
    }
  }
}

// ── WebSocket event stream ──────────────────────────────────────

function connectWebSocket(): void {
  const wsUrl = mmUrl.replace(/^http/, "ws").replace(/\/$/, "");
  const webSocket = new WebSocket(`${wsUrl}/api/v4/websocket`, {
    headers: { Authorization: `Bearer ${botToken}` },
  });

  webSocket.on("open", () => {
    console.log("[mattermost] WebSocket connected");
    // Authenticate
    webSocket.send(
      JSON.stringify({
        seq: 1,
        action: "authentication_challenge",
        data: { token: botToken },
      }),
    );
  });

  // Listener stays sync so a rejection has somewhere to go — an async listener
  // hands its promise to the emitter, which drops it.
  webSocket.on("message", (data) => {
    onWebSocketMessage(data).catch((err) => console.error(`[mattermost] message handler error: ${err}`));
  });

  webSocket.on("close", () => {
    console.log("[mattermost] WebSocket closed, reconnecting in 5s...");
    setTimeout(connectWebSocket, 5000);
  });

  webSocket.on("error", (err) => {
    console.error(`[mattermost] WebSocket error: ${err.message}`);
  });
}

interface PostedMessage {
  userId: string;
  channelId: string;
  message: string;
}

// Parse a Mattermost `posted` WebSocket frame into the fields we act on. The
// frame is untyped JSON with a stringified `post` payload nested inside;
// returns null for anything that isn't a usable posted message.
function parsePostedMessage(raw: string): PostedMessage | null {
  const event: unknown = JSON.parse(raw);
  if (!isRecord(event) || event.event !== "posted" || !isRecord(event.data) || typeof event.data.post !== "string" || !event.data.post) return null;
  const post: unknown = JSON.parse(event.data.post);
  if (!isRecord(post)) return null;
  return {
    userId: typeof post.user_id === "string" ? post.user_id : "",
    channelId: typeof post.channel_id === "string" ? post.channel_id : "",
    message: typeof post.message === "string" ? post.message : "",
  };
}

async function onWebSocketMessage(data: { toString: () => string }): Promise<void> {
  try {
    const posted = parsePostedMessage(data.toString());
    if (!posted) return;
    const { userId, channelId, message } = posted;

    // Ignore own messages
    if (userId === botUserId) return;
    if (!message.trim()) return;
    if (!allowAll && !allowedChannels.has(channelId)) return;

    console.log(`[mattermost] message channel=${channelId} user=${userId} len=${message.length}`);

    const ack = await mulmo.send(channelId, message);
    if (ack.ok) {
      await postMessage(channelId, ack.reply ?? "");
    } else {
      const status = ack.status ? ` (${ack.status})` : "";
      await postMessage(channelId, `Error${status}: ${ack.error ?? "unknown"}`);
    }
  } catch (err) {
    console.error(`[mattermost] message handling failed: ${err}`);
  }
}

async function main(): Promise<void> {
  const currentUser = await apiGet("/users/me");
  const currentUserId = typeof currentUser.id === "string" ? currentUser.id : "";
  const username = typeof currentUser.username === "string" ? currentUser.username : "unknown";
  botUserId = currentUserId;

  console.log("MulmoClaude Mattermost bridge");
  console.log(`Server: ${mmUrl}`);
  console.log(`Bot: ${username}`);
  console.log(`Channels: ${allowAll ? "(all)" : [...allowedChannels].join(", ")}`);

  connectWebSocket();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
