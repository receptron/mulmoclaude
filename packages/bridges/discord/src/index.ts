#!/usr/bin/env node
// @mulmobridge/discord — Discord bridge for MulmoClaude.
//
// Required env vars:
//   DISCORD_BOT_TOKEN      — Bot token from Discord Developer Portal
//
// Optional:
//   DISCORD_ALLOWED_CHANNELS — CSV of channel IDs (empty = allow all)
//   MULMOCLAUDE_API_URL      — default: the port in <workspace>/.server-port,
//                              else http://localhost:3001
//   MULMOCLAUDE_AUTH_TOKEN   — bearer token (or read from workspace)

import "dotenv/config";
import { Client, GatewayIntentBits, Partials, type Message } from "discord.js";
import { createBridgeClient } from "@mulmobridge/client";
import { parseCsvSet } from "@mulmoclaude/common";
import { collectAttachments, resolveMessageText, type DiscordAttachmentLike } from "./attachments.js";

const TRANSPORT_ID = "discord";
const MAX_DISCORD_LENGTH = 2000;

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("DISCORD_BOT_TOKEN is required.\nSee README for setup instructions.");
  process.exit(1);
}

const allowedChannels = parseCsvSet(process.env.DISCORD_ALLOWED_CHANNELS);
const allowAll = allowedChannels.size === 0;

const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  // Partials.Channel is required to receive DM messageCreate events —
  // DM channels are not cached by default in discord.js v14.
  partials: [Partials.Channel],
});

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

mulmo.onPush((pushEvent) => {
  onPushEvent(pushEvent).catch((err) => console.error(`[discord] push handler error: ${err}`));
});

async function onPushEvent(pushEvent: { chatId: string; message: string }): Promise<void> {
  try {
    const channel = discord.channels.cache.get(pushEvent.chatId) ?? (await discord.channels.fetch(pushEvent.chatId).catch(() => null));
    if (channel?.isTextBased() && channel.isSendable()) {
      await sendChunkedToSendable(channel, pushEvent.message);
    } else {
      console.warn(`[discord] push: channel ${pushEvent.chatId} not found or not text-based`);
    }
  } catch (err) {
    console.error(`[discord] push send failed: ${err}`);
  }
}

discord.on("messageCreate", (msg: Message) => {
  onMessageCreate(msg).catch((err) => console.error(`[discord] messageCreate handler error: ${err}`));
});

async function onMessageCreate(msg: Message): Promise<void> {
  if (msg.author.bot) return;
  const { channelId } = msg;
  // Checked before the attachment downloads so a denied channel never
  // makes the bridge fetch anything.
  if (!allowAll && !allowedChannels.has(channelId)) return;

  const text = msg.content.trim();
  const files = [...msg.attachments.values()];
  if (text.length === 0 && files.length === 0) return;

  console.log(`[discord] message channel=${channelId} user=${msg.author.tag} len=${text.length} attachments=${files.length}`);

  try {
    await relayMessage(msg, text, files);
  } catch (err) {
    console.error(`[discord] message handling failed: ${err}`);
  }
}

async function relayMessage(msg: Message, text: string, files: DiscordAttachmentLike[]): Promise<void> {
  const { attachments, dropped } = await collectAttachments(files, { fetchFn: fetch, log: console });

  // Nothing survived on a file-only post: say so instead of relaying a
  // prompt about a file the agent never receives.
  if (text.length === 0 && attachments.length === 0) {
    await msg.reply("Sorry, I could not download that attachment. Please try again.");
    return;
  }

  const ack = await mulmo.send(msg.channelId, resolveMessageText(text, dropped), attachments.length > 0 ? attachments : undefined);
  if (ack.ok) {
    await sendChunked(msg, ack.reply ?? "");
  } else {
    const status = ack.status ? ` (${ack.status})` : "";
    await msg.reply(`Error${status}: ${ack.error ?? "unknown"}`);
  }
}

async function sendChunked(msg: Message, text: string): Promise<void> {
  if (text.length === 0) {
    await msg.reply("(empty reply)");
    return;
  }
  for (let i = 0; i < text.length; i += MAX_DISCORD_LENGTH) {
    const chunk = text.slice(i, i + MAX_DISCORD_LENGTH);
    if (i === 0) {
      await msg.reply(chunk);
    } else if (msg.channel.isSendable()) {
      await msg.channel.send(chunk);
    }
  }
}

async function sendChunkedToSendable(channel: { send: (messageText: string) => Promise<unknown> }, text: string): Promise<void> {
  const content = text.length === 0 ? "(empty reply)" : text;
  for (let i = 0; i < content.length; i += MAX_DISCORD_LENGTH) {
    await channel.send(content.slice(i, i + MAX_DISCORD_LENGTH));
  }
}

discord.once("ready", () => {
  console.log("MulmoClaude Discord bridge");
  console.log(`Logged in as ${discord.user?.tag}`);
  console.log(`Channels: ${allowAll ? "(all)" : [...allowedChannels].join(", ")}`);
});

discord.login(token).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
