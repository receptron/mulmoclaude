#!/usr/bin/env node
// @mulmobridge/irc — IRC bridge for MulmoClaude.
//
// Required env vars:
//   IRC_SERVER     — e.g. irc.libera.chat
//   IRC_NICK       — bot nickname
//   IRC_CHANNELS   — CSV of channels to join (e.g. #mulmo,#test)
//
// Optional:
//   IRC_PORT       — default 6697 (TLS) or 6667 (plain)
//   IRC_TLS        — true/false (default: true)
//   IRC_PASSWORD   — NickServ or server password

import "dotenv/config";
import { Client as IrcClient } from "irc-framework";
import { createBridgeClient, installProcessGuards } from "@mulmobridge/client";

const TRANSPORT_ID = "irc";

installProcessGuards({ name: TRANSPORT_ID });

const server = process.env.IRC_SERVER;
const nick = process.env.IRC_NICK;
const channelsStr = process.env.IRC_CHANNELS;
if (!server || !nick || !channelsStr) {
  console.error("IRC_SERVER, IRC_NICK, and IRC_CHANNELS are required.\nSee README for setup instructions.");
  process.exit(1);
}

const channels = channelsStr
  .split(",")
  .map((channelName) => channelName.trim())
  .filter(Boolean);
const useTls = (process.env.IRC_TLS ?? "true") !== "false";
const port = Number(process.env.IRC_PORT) || (useTls ? 6697 : 6667);
const password = process.env.IRC_PASSWORD;

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

const irc = new IrcClient();

mulmo.onPush((pushEvent) => {
  // pushEvent.chatId is the channel name
  irc.say(pushEvent.chatId, pushEvent.message);
});

irc.connect({
  host: server,
  port,
  nick,
  tls: useTls,
  ...(password !== undefined ? { password } : {}),
});

irc.on("registered", () => {
  console.log("MulmoClaude IRC bridge");
  console.log(`Connected to ${server}:${port} as ${nick}`);
  for (const channelName of channels) {
    irc.join(channelName);
    console.log(`Joined ${channelName}`);
  }
});

interface IrcMessageEvent {
  target: string;
  nick: string;
  message: string;
}

// `.on` takes a void-returning listener, so an async one hands EventEmitter a
// floating promise: a `mulmo.send` rejection (the server being down is enough)
// becomes an unhandled rejection, which Node turns into process exit — the
// bridge dies on a transient error instead of logging and staying up. Keep the
// async work in a named function and settle it here.
irc.on("message", (event: IrcMessageEvent) => {
  void handleMessage(event).catch((err: unknown) => {
    console.error("[irc] message handling failed:", err);
  });
});

async function handleMessage(event: IrcMessageEvent): Promise<void> {
  // Ignore our own messages
  if (event.nick === nick) return;

  // IRC channel prefixes: #, &, +, ! (RFC 2812 §1.3)
  const isChannel = /^[#&+!]/.test(event.target);
  const chatId = isChannel ? event.target : event.nick;
  const text = event.message.trim();
  if (!text) return;

  // In channels, only respond when mentioned or prefixed with bot nick
  if (isChannel) {
    const mentionPrefix = `${nick}:`;
    const mentionPrefix2 = `${nick},`;
    if (!text.startsWith(mentionPrefix) && !text.startsWith(mentionPrefix2)) {
      return;
    }
    // Strip the mention prefix
    const stripped = text.slice(text.startsWith(mentionPrefix) ? mentionPrefix.length : mentionPrefix2.length).trim();
    if (!stripped) return;

    console.log(`[irc] message channel=${chatId} nick=${event.nick} len=${stripped.length}`);
    const ack = await mulmo.send(chatId, stripped);
    sendReply(chatId, ack);
    return;
  }

  // Private messages — respond directly
  console.log(`[irc] pm from=${event.nick} len=${text.length}`);
  const ack = await mulmo.send(chatId, text);
  sendReply(chatId, ack);
}

function sendReply(target: string, ack: { ok: boolean; reply?: string; error?: string; status?: number }): void {
  if (ack.ok) {
    const text = ack.reply ?? "(empty reply)";
    // IRC messages are max ~512 bytes per line. Chunk at 400 chars.
    const lines = text.split("\n");
    for (const line of lines) {
      for (let i = 0; i < line.length; i += 400) {
        irc.say(target, line.slice(i, i + 400));
      }
    }
  } else {
    const status = ack.status ? ` (${ack.status})` : "";
    irc.say(target, `Error${status}: ${ack.error ?? "unknown"}`);
  }
}

irc.on("close", () => {
  console.log("[irc] disconnected, exiting");
  process.exit(0);
});
