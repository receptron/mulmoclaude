#!/usr/bin/env node
// @mulmobridge/mastodon — Mastodon bridge for MulmoClaude.
//
// Subscribes to the user notification stream over WebSocket, picks up
// mentions (which include DMs, since Mastodon DMs are mentions with
// visibility=direct), forwards them to MulmoClaude, and replies as a
// status with in_reply_to_id set and visibility inherited from the
// incoming status.
//
// Required env vars:
//   MASTODON_INSTANCE_URL — e.g. https://mastodon.social
//   MASTODON_ACCESS_TOKEN — bot access token (Preferences → Development
//                           → New application; scopes: read + write + push)
//
// Optional:
//   MASTODON_ALLOWED_ACCTS — CSV of acct strings allowed to converse
//                            (e.g. "alice@mastodon.social,bob@mstdn.jp").
//                            Empty / unset = allow everyone.
//   MASTODON_DM_ONLY       — "true" (default) to only handle direct-
//                            visibility statuses. Set to "false" to also
//                            pick up public / unlisted mentions.

import "dotenv/config";
import WebSocket from "ws";
import { createBridgeClient, chunkText, formatAckReply, frameText, installProcessGuards } from "@mulmobridge/client";
import { isRecord, parseCsvSet } from "@mulmoclaude/common";
import { parseNotificationRaw, parseFrame, type JsonRecord, type ParsedStatus } from "./parse.js";
import { fitBudget, hasRelayableContent, imageMediaEntries, isLostImagesOnly, resolveMessageText, type ImageMedia } from "./media.js";
import { resolvePublicUrl } from "./urlGuard.js";

const TRANSPORT_ID = "mastodon";

installProcessGuards({ name: TRANSPORT_ID });
const MAX_STATUS_LEN = 500; // Mastodon's default soft limit; many instances raise to 1000+
const FETCH_TIMEOUT_MS = 15_000;
/** Cap on one fetched attachment. Without it a remote sender could point the
 *  bridge at an arbitrarily large file and have it buffered, then base64'd. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

const instanceUrl = process.env.MASTODON_INSTANCE_URL;
const accessToken = process.env.MASTODON_ACCESS_TOKEN;
if (!instanceUrl || !accessToken) {
  console.error("MASTODON_INSTANCE_URL and MASTODON_ACCESS_TOKEN are required.\nSee README for setup instructions.");
  process.exit(1);
}

const allowedAccts = parseCsvSet(process.env.MASTODON_ALLOWED_ACCTS);
const allowAll = allowedAccts.size === 0;
const dmOnly = (process.env.MASTODON_DM_ONLY ?? "true").toLowerCase() !== "false";

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });
const apiBase = `${instanceUrl.replace(/\/$/, "")}/api/v1`;
const streamUrl = `${instanceUrl.replace(/^http/, "ws").replace(/\/$/, "")}/api/v1/streaming?stream=user:notification&access_token=${encodeURIComponent(accessToken)}`;
let reconnectBackoffMs = RECONNECT_BASE_MS;

mulmo.onPush((pushEvent) => {
  postStatus(pushEvent.chatId, pushEvent.message, null, "direct").catch((err) => console.error(`[mastodon] push send failed: ${err}`));
});

// ── Mastodon API ─────────────────────────────────────────────────

interface PostStatusOptions {
  inReplyTo: string | null;
  visibility: string;
}

async function postOneStatus(chunk: string, opts: PostStatusOptions): Promise<string> {
  const body: JsonRecord = { status: chunk, visibility: opts.visibility };
  if (opts.inReplyTo) body.in_reply_to_id = opts.inReplyTo;
  let res: Response;
  try {
    res = await fetch(`${apiBase}/statuses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Mastodon status POST network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Mastodon status POST failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  // Mastodon's create-status endpoint always returns a Status object
  // with an `id`. A missing id means the response is malformed; fail
  // loudly instead of returning null, otherwise postStatus's loop
  // would leave `prevId` stale and all later chunks would chain onto
  // the parent of the failed one. See CodeRabbit outside-diff comment
  // on #611.
  const payload: unknown = await res.json().catch((err) => {
    throw new Error(`Mastodon status POST returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!isRecord(payload) || typeof payload.id !== "string") {
    throw new Error("Mastodon status POST response is missing id");
  }
  return payload.id;
}

async function postStatus(chatId: string, text: string, inReplyTo: string | null, visibility: string): Promise<void> {
  // Direct-visibility statuses only deliver to users @-mentioned in
  // the body — a reply carries the mention from the parent via
  // `in_reply_to_id`, but a fresh push (inReplyTo=null) has no parent
  // to inherit from. Prepend the recipient handle so direct pushes
  // actually reach the user. Non-direct visibilities don't need the
  // mention; leave them untouched to avoid noise in public timelines.
  const needsLeadingMention = !inReplyTo && visibility === "direct" && chatId.length > 0;
  const bodyText = needsLeadingMention ? `@${chatId} ${text}` : text;

  // Thread chunk 2+ onto the previous chunk so clients render them as a
  // readable reply chain rather than N parallel replies to the original.
  const chunks = chunkText(bodyText, MAX_STATUS_LEN);
  let prevId: string | null = inReplyTo;
  for (const chunk of chunks) {
    prevId = await postOneStatus(chunk, { inReplyTo: prevId, visibility });
  }
}

// ── Attachment fetching ─────────────────────────────────────────

interface MulmoAttachment {
  mimeType: string;
  data: string;
  filename?: string;
}

/** Read at most `MAX_IMAGE_BYTES`, aborting mid-stream rather than after the
 *  fact — `arrayBuffer()` would have already materialised the whole body. */
async function readCappedBody(res: Response): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
  const { body } = res;
  if (!body) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function fetchImageAttachment(rawUrl: string): Promise<MulmoAttachment | null> {
  // The URL comes from a remote sender, so it has to clear the SSRF guard
  // before it can become an outbound request.
  const url = await resolvePublicUrl(rawUrl);
  if (url === null) {
    console.warn("[mastodon] image fetch refused: url failed the safety check");
    return null;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type") ?? "image/jpeg";
    const buf = await readCappedBody(res);
    if (buf === null) {
      console.warn("[mastodon] image fetch refused: body over the size cap");
      return null;
    }
    return { mimeType, data: buf.toString("base64") };
  } catch (err) {
    console.warn(`[mastodon] image fetch failed: ${err}`);
    return null;
  }
}

async function collectImageAttachments(media: ImageMedia[]): Promise<MulmoAttachment[]> {
  const out: MulmoAttachment[] = [];
  for (const item of media) {
    const att = await fetchImageAttachment(item.url);
    if (att) out.push(att);
  }
  // Four images at the 8 MB cap are 42 MB of base64 — past both the
  // server's attachment budget and the socket frame. Trim here so the
  // caller can count what was left out.
  return fitBudget(out);
}

// ── Notification handling ───────────────────────────────────────

function shouldSkipNotification(parsed: ParsedStatus): string | null {
  if (dmOnly && parsed.visibility !== "direct") {
    return `skip non-DM from=${parsed.senderAcct} visibility=${parsed.visibility}`;
  }
  if (!allowAll && !allowedAccts.has(parsed.senderAcct)) {
    return `denied from=${parsed.senderAcct}`;
  }
  return null;
}

async function handleNotification(raw: string): Promise<void> {
  const parsed = parseNotificationRaw(raw);
  if (!parsed) return;

  const skipReason = shouldSkipNotification(parsed);
  if (skipReason) {
    console.log(`[mastodon] ${skipReason}`);
    return;
  }

  // Images are looked at before the empty-body check so an image-only
  // DM (no caption) still flows through.
  const media = imageMediaEntries(parsed.media);
  if (!hasRelayableContent(parsed.text, media.length)) return;

  try {
    await relayStatus(parsed, media);
  } catch (err) {
    console.error(`[mastodon] message handling failed: ${err}`);
  }
}

async function relayStatus(parsed: ParsedStatus, media: ImageMedia[]): Promise<void> {
  const attachments = await collectImageAttachments(media);
  const dropped = media.length - attachments.length;
  console.log(`[mastodon] message from=${parsed.senderAcct} len=${parsed.text.length} attachments=${attachments.length} dropped=${dropped}`);

  // Nothing survived on an image-only DM: say so, rather than relaying a
  // prompt about an image the agent never receives.
  if (isLostImagesOnly(parsed.text, attachments.length)) {
    await postStatus(parsed.senderAcct, "Sorry, I could not download that image. Please try again.", parsed.statusId, parsed.visibility);
    return;
  }

  const ack = await mulmo.send(parsed.senderAcct, resolveMessageText(parsed.text, dropped), attachments.length > 0 ? attachments : undefined);
  await postStatus(parsed.senderAcct, formatAckReply(ack), parsed.statusId, parsed.visibility);
}

// ── WebSocket stream ────────────────────────────────────────────

function connect(): void {
  const socket = new WebSocket(streamUrl);

  socket.on("open", () => {
    console.log(`[mastodon] stream connected: ${instanceUrl}`);
    reconnectBackoffMs = RECONNECT_BASE_MS;
  });

  socket.on("message", (buffer) => {
    const frame = parseFrame(frameText(buffer));
    if (!frame || frame.event !== "notification") return;
    handleNotification(frame.payload).catch((err) => console.error(`[mastodon] notification handler error: ${err}`));
  });

  socket.on("error", (err) => {
    console.error(`[mastodon] stream error: ${err.message}`);
  });

  socket.on("close", (code, reason) => {
    const retryDelayMs = reconnectBackoffMs;
    console.warn(`[mastodon] stream closed code=${code} reason=${reason.toString().slice(0, 100)}; reconnecting in ${retryDelayMs}ms`);
    setTimeout(() => {
      reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, RECONNECT_MAX_MS);
      connect();
    }, retryDelayMs);
  });
}

// ── Main ─────────────────────────────────────────────────────────

console.log("MulmoClaude Mastodon bridge");
console.log(`Instance: ${instanceUrl}`);
console.log(`DM-only: ${dmOnly}`);
console.log(`Allowlist: ${allowAll ? "(all)" : [...allowedAccts].join(", ")}`);

connect();
