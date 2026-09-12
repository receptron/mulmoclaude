#!/usr/bin/env node
// @mulmobridge/matrix — Matrix bridge for MulmoClaude.
//
// Uses the Matrix Client-Server API (works with any Matrix server
// including matrix.org, Element, Synapse, Dendrite, Conduit).
//
// Required env vars:
//   MATRIX_HOMESERVER_URL  — e.g. https://matrix.org
//   MATRIX_ACCESS_TOKEN    — access token for the bot user
//   MATRIX_USER_ID         — e.g. @mulmo-bot:matrix.org
//
// Optional:
//   MATRIX_ALLOWED_ROOMS   — CSV of room IDs (empty = all joined rooms)

import "dotenv/config";
import { createClient, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { createBridgeClient, installProcessGuards } from "@mulmobridge/client";
import { parseCsvSet } from "@mulmoclaude/common";

const TRANSPORT_ID = "matrix";

installProcessGuards({ name: TRANSPORT_ID });

const homeserverUrl = process.env.MATRIX_HOMESERVER_URL;
const accessToken = process.env.MATRIX_ACCESS_TOKEN;
const userId = process.env.MATRIX_USER_ID;
if (!homeserverUrl || !accessToken || !userId) {
  console.error("MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, and MATRIX_USER_ID are required.\nSee README for setup instructions.");
  process.exit(1);
}

const allowedRooms = parseCsvSet(process.env.MATRIX_ALLOWED_ROOMS);
const allowAll = allowedRooms.size === 0;

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

const matrixClient: MatrixClient = createClient({
  baseUrl: homeserverUrl,
  accessToken,
  userId,
});

mulmo.onPush((pushEvent) => {
  matrixClient.sendTextMessage(pushEvent.chatId, pushEvent.message).catch((err: unknown) => console.error(`[matrix] push send failed: ${err}`));
});

// `.on` takes a void-returning listener, so an async one hands the emitter a
// floating promise: a throw in the synchronous prelude (getType/getContent,
// which run before mulmo.send's own error handling) would become an unhandled
// rejection that crashes the process. Keep the listener sync and settle the
// async work with `.catch()`. `RoomEvent.Timeline` is the typed event key —
// the old `"Room.timeline"` string + `as any` cast only masked the emitter's
// precise typing.
matrixClient.on(RoomEvent.Timeline, (event: MatrixEvent, room: Room | undefined) => {
  void handleTimelineEvent(event, room).catch((err: unknown) => {
    console.error(`[matrix] message handling failed: ${err}`);
  });
});

async function handleTimelineEvent(event: MatrixEvent, room: Room | undefined): Promise<void> {
  if (!room) return;
  if (event.getType() !== "m.room.message") return;
  if (event.getSender() === userId) return;

  const content = event.getContent();
  if (content.msgtype !== "m.text") return;
  if (typeof content.body !== "string") return;

  const { roomId } = room;
  const text = content.body;
  if (!text.trim()) return;

  if (!allowAll && !allowedRooms.has(roomId)) return;

  console.log(`[matrix] message room=${roomId} sender=${event.getSender()} len=${text.length}`);

  const ack = await mulmo.send(roomId, text);
  if (ack.ok) {
    await sendChunked(roomId, ack.reply ?? "");
  } else {
    const status = ack.status ? ` (${ack.status})` : "";
    await matrixClient.sendTextMessage(roomId, `Error${status}: ${ack.error ?? "unknown"}`);
  }
}

async function sendChunked(roomId: string, text: string): Promise<void> {
  // Matrix has no strict char limit but we chunk at 4000 for readability
  const MAX = 4000;
  if (text.length === 0) {
    await matrixClient.sendTextMessage(roomId, "(empty reply)");
    return;
  }
  for (let i = 0; i < text.length; i += MAX) {
    await matrixClient.sendTextMessage(roomId, text.slice(i, i + MAX));
  }
}

async function main(): Promise<void> {
  console.log("MulmoClaude Matrix bridge");
  console.log(`Homeserver: ${homeserverUrl}`);
  console.log(`User: ${userId}`);
  console.log(`Rooms: ${allowAll ? "(all joined)" : [...allowedRooms].join(", ")}`);

  await matrixClient.startClient({ initialSyncLimit: 0 });
  console.log("Connected to Matrix.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
