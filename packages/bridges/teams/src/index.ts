#!/usr/bin/env node
// @mulmobridge/teams — Microsoft Teams bridge for MulmoClaude.
//
// Uses the Bot Framework (`botbuilder`) HTTP adapter: Teams posts activities
// to /api/messages, the SDK validates the JWT, and we reply via the turn
// context. Teams is the only bridge in this repo that *requires* a public
// URL (webhook). Pair it with a tunnel / reverse proxy / public IP — or use
// the MulmoBridge relay once a Teams relay plugin is added.
//
// Required env vars:
//   MICROSOFT_APP_ID       — App ID (aka "MicrosoftAppId") from Azure Bot registration
//   MICROSOFT_APP_PASSWORD — App password (client secret)
//
// Optional:
//   MICROSOFT_APP_TYPE     — "MultiTenant" (default) | "SingleTenant" | "UserAssignedMSI"
//   MICROSOFT_APP_TENANT_ID — required when MICROSOFT_APP_TYPE=SingleTenant
//   TEAMS_BRIDGE_PORT      — HTTP port to listen on (default 3006)
//   TEAMS_ALLOWED_USERS    — CSV of AAD user object IDs (empty = all)

import "dotenv/config";
import express, { type Request, type Response } from "express";
import { CloudAdapter, ConfigurationBotFrameworkAuthentication, TurnContext, type Activity } from "botbuilder";
import { createBridgeClient, chunkText, formatAckReply, installProcessGuards } from "@mulmobridge/client";
import { listenWebhook } from "@mulmobridge/webhook-runtime";
import { parseCsvSet } from "@mulmoclaude/common";
import { extractIncomingMessage } from "./parse.js";

const TRANSPORT_ID = "teams";

installProcessGuards({ name: TRANSPORT_ID });
const MAX_TEAMS_TEXT = 28_000; // Teams message limit is 40k; leave headroom for formatting

function readRequiredEnv(): { appId: string; appPassword: string } {
  const appId = process.env.MICROSOFT_APP_ID;
  const appPassword = process.env.MICROSOFT_APP_PASSWORD;
  if (!appId || !appPassword) {
    console.error("MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD are required.\nSee README for Azure Bot registration instructions.");
    process.exit(1);
  }
  return { appId, appPassword };
}
const { appId, appPassword } = readRequiredEnv();

const allowedUsers = parseCsvSet(process.env.TEAMS_ALLOWED_USERS);
const allowAll = allowedUsers.size === 0;

// The ConfigurationBotFrameworkAuthentication reads from a config object
// keyed with the standard Bot Framework env names. We build it explicitly
// so the env var surface is documented here rather than implicit.
const auth = new ConfigurationBotFrameworkAuthentication({
  MicrosoftAppId: appId,
  MicrosoftAppPassword: appPassword,
  MicrosoftAppType: process.env.MICROSOFT_APP_TYPE ?? "MultiTenant",
  MicrosoftAppTenantId: process.env.MICROSOFT_APP_TENANT_ID ?? "",
});

const adapter = new CloudAdapter(auth);

adapter.onTurnError = async (context, err) => {
  console.error(`[teams] turn error: ${err instanceof Error ? err.message : String(err)}`);
  try {
    await context.sendActivity("Error: bridge encountered an internal error.");
  } catch {
    /* swallow — secondary failures shouldn't crash the process */
  }
};

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

// References to each conversation so the push handler can post back.
const conversationRefs = new Map<string, Partial<Activity>>();

mulmo.onPush((pushEvent) => {
  const ref = conversationRefs.get(pushEvent.chatId);
  if (!ref) {
    console.warn(`[teams] push dropped — no conversation reference for chatId=${pushEvent.chatId}`);
    return;
  }
  adapter
    .continueConversationAsync(appId, ref, async (context) => {
      await sendChunked(context, pushEvent.message);
    })
    .catch((err) => console.error(`[teams] push send failed: ${err}`));
});

// ── Send helpers ────────────────────────────────────────────────

async function sendChunked(context: TurnContext, text: string): Promise<void> {
  const chunks = chunkText(text, MAX_TEAMS_TEXT);
  for (const chunk of chunks) {
    await context.sendActivity(chunk);
  }
}

// ── Incoming handler ────────────────────────────────────────────

async function processMessage(context: TurnContext): Promise<void> {
  const incoming = extractIncomingMessage(context.activity);
  if (!incoming) return;
  const { senderId, chatId, text } = incoming;

  if (!allowAll && !allowedUsers.has(senderId)) {
    console.log(`[teams] denied from=${senderId}`);
    return;
  }

  // Cache conversation reference for server-initiated push delivery.
  conversationRefs.set(chatId, TurnContext.getConversationReference(context.activity));

  console.log(`[teams] message conv=${chatId} from=${senderId} len=${text.length}`);

  try {
    const ack = await mulmo.send(chatId, text);
    await sendChunked(context, formatAckReply(ack));
  } catch (err) {
    console.error(`[teams] message handling failed: ${err}`);
  }
}

// ── HTTP server ─────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.post("/api/messages", async (req: Request, res: Response) => {
  await adapter.process(req, res, (context) => processMessage(context));
});

app.get("/health", (__req: Request, res: Response) => {
  res.json({ status: "ok", transport: TRANSPORT_ID });
});

listenWebhook(app, { envVar: "TEAMS_BRIDGE_PORT", fallback: 3006 }, (port) => {
  console.log("MulmoClaude Teams bridge");
  console.log(`Webhook listening on http://localhost:${port}/api/messages`);
  console.log(`App ID: ${appId}`);
  console.log(`Allowlist: ${allowAll ? "(all)" : [...allowedUsers].join(", ")}`);
});
