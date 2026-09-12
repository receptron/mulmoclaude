#!/usr/bin/env node
// @mulmobridge/xmpp — XMPP / Jabber bridge for MulmoClaude.
//
// Connects to any XMPP server (ejabberd, Prosody, dino, Tigase, …) with
// a JID + password and bridges chat-type message stanzas into MulmoClaude.
// Outbound-only TCP over TLS — no public URL needed.
//
// Required env vars:
//   XMPP_JID       — full JID, e.g. mulmobot@example.com
//   XMPP_PASSWORD  — account password (or app-specific password if the
//                    server supports that)
//   XMPP_SERVICE   — connection URI, e.g. xmpps://example.com:5223 (implicit TLS)
//                    or xmpp://example.com:5222 (STARTTLS)
//
// Optional:
//   XMPP_ALLOWED_JIDS — CSV of bare JIDs allowed to converse (empty = all)
//   XMPP_RESOURCE     — resource identifier (default "mulmobridge")
//   XMPP_REPLY_MODE   — "bare" (default) or "full".
//                       "bare" sends to user@domain, letting the server
//                       route to whichever resource is currently active —
//                       the portable default that works for multi-device
//                       users. "full" echoes the sender's full JID back
//                       (user@domain/resource), useful for deployments
//                       where the roster / carbons config doesn't forward
//                       bare-addressed messages to every resource.

import "dotenv/config";
import xmppPkg, { type XmlElement } from "@xmpp/client";
import { createBridgeClient, chunkText, formatAckReply, installProcessGuards } from "@mulmobridge/client";
import { parseCsvSet } from "@mulmoclaude/common";
import { splitJid, parseStanzaFields } from "./parse.js";

const { client, xml } = xmppPkg;

const TRANSPORT_ID = "xmpp";

installProcessGuards({ name: TRANSPORT_ID });
const MAX_BODY_LEN = 10_000;

const jid = process.env.XMPP_JID;
const password = process.env.XMPP_PASSWORD;
const service = process.env.XMPP_SERVICE;
if (!jid || !password || !service) {
  console.error("XMPP_JID, XMPP_PASSWORD, and XMPP_SERVICE are required.\nSee README for setup instructions.");
  process.exit(1);
}

const resource = process.env.XMPP_RESOURCE ?? "mulmobridge";
const replyMode = (process.env.XMPP_REPLY_MODE ?? "bare").toLowerCase();
if (replyMode !== "bare" && replyMode !== "full") {
  console.error(`XMPP_REPLY_MODE must be "bare" or "full" — got "${replyMode}"`);
  process.exit(1);
}
const replyWithFullJid = replyMode === "full";
const allowedJids = parseCsvSet(process.env.XMPP_ALLOWED_JIDS, { lowercase: true });
const allowAll = allowedJids.size === 0;

const { username, domain } = splitJid(jid);
if (!username || !domain) {
  console.error(`XMPP_JID must be in the form user@domain — got "${jid}"`);
  process.exit(1);
}

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });

const xmpp = client({ service, domain, username, password, resource });

mulmo.onPush((pushEvent) => {
  sendChat(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[xmpp] push send failed: ${err}`));
});

// ── Send ────────────────────────────────────────────────────────

async function sendChat(toJid: string, text: string): Promise<void> {
  const chunks = chunkText(text, MAX_BODY_LEN);
  for (const chunk of chunks) {
    try {
      await xmpp.send(xml("message", { to: toJid, type: "chat" }, xml("body", {}, chunk)));
    } catch (err) {
      console.error(`[xmpp] send error: ${err}`);
    }
  }
}

// ── Receive ─────────────────────────────────────────────────────

async function handleStanza(stanza: XmlElement): Promise<void> {
  const parsed = parseStanzaFields({
    isMessage: stanza.is("message"),
    type: stanza.attrs.type,
    from: stanza.attrs.from,
    body: stanza.getChildText("body"),
    selfBare: `${username}@${domain}`.toLowerCase(),
  });
  if (!parsed) return;
  const { from, senderBare, body } = parsed;

  if (!allowAll && !allowedJids.has(senderBare)) {
    console.log(`[xmpp] denied from=${senderBare}`);
    return;
  }

  // chatId stays bare so session identity is stable across reconnects
  // (same user talking from their phone later still lands on the same
  // chat). The outbound address differs only when XMPP_REPLY_MODE=full
  // is explicitly requested — see env doc at top of file.
  const replyTo = replyWithFullJid ? from : senderBare;

  const replyToHint = replyWithFullJid ? ` replyTo=${from}` : "";
  console.log(`[xmpp] message from=${senderBare} len=${body.length}${replyToHint}`);

  try {
    const ack = await mulmo.send(senderBare, body);
    await sendChat(replyTo, formatAckReply(ack));
  } catch (err) {
    console.error(`[xmpp] handleStanza error: ${err}`);
  }
}

// ── Lifecycle ───────────────────────────────────────────────────

xmpp.on("error", (err: Error) => {
  console.error(`[xmpp] error: ${err.message}`);
});

xmpp.on("offline", () => {
  console.warn("[xmpp] offline");
});

xmpp.on("online", (address: { toString: () => string }) => {
  console.log(`[xmpp] online as ${address.toString()}`);
  // Presence broadcast so contacts can see the bot is available. Same shape as
  // the "stanza" handler below: the listener stays sync so the send's rejection
  // has somewhere to go instead of escaping the emitter.
  xmpp.send(xml("presence")).catch((err) => console.error(`[xmpp] presence broadcast failed: ${err}`));
});

xmpp.on("stanza", (stanza: XmlElement) => {
  handleStanza(stanza).catch((err) => console.error(`[xmpp] stanza handler error: ${err}`));
});

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("MulmoClaude XMPP bridge");
  console.log(`JID: ${username}@${domain}/${resource}`);
  console.log(`Service: ${service}`);
  console.log(`Reply mode: ${replyWithFullJid ? "full (include resource)" : "bare"}`);
  console.log(`Allowlist: ${allowAll ? "(all)" : [...allowedJids].join(", ")}`);

  await xmpp.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
