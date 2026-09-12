#!/usr/bin/env node
// @mulmobridge/nostr — Nostr encrypted DM bridge for MulmoClaude.
//
// Connects to a list of Nostr relays over WebSocket, subscribes to
// kind=4 (encrypted DM) events tagged to our pubkey, decrypts with
// NIP-04 (ECDH + AES-CBC), forwards to MulmoClaude, and replies as a
// signed kind=4 event broadcast to the same relays.
//
// Outbound-only — no public URL needed. The bot's identity is its
// private key; multiple clients / relays can observe the same identity
// concurrently without extra setup.
//
// Required env vars:
//   NOSTR_PRIVATE_KEY — 64-char hex secret key (nsec1… also accepted)
//   NOSTR_RELAYS      — CSV of wss:// relay URLs, e.g.
//                       wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social
//
// Optional:
//   NOSTR_ALLOWED_PUBKEYS — CSV of hex pubkeys allowed (empty = all)
//   NOSTR_CURSOR_FILE     — path for the last-seen timestamp (default
//                           ~/.mulmoclaude/nostr-cursor.json). Persists
//                           across restarts so we don't re-fetch old DMs
//                           but also don't lose DMs delivered while the
//                           bridge was offline.

import "dotenv/config";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SimplePool, finalizeEvent, getPublicKey, nip04, nip19, type Event } from "nostr-tools";
import { createBridgeClient, chunkText, installProcessGuards } from "@mulmobridge/client";
import { isErrorWithCode, parseCsvList, parseCsvSet } from "@mulmoclaude/common";

const TRANSPORT_ID = "nostr";
const MAX_DM_LEN = 50_000;
const KIND_ENCRYPTED_DM = 4;
// Cold-start safety window: when there's no persisted cursor, only pull
// events from the last 60 s so a fresh install doesn't replay ancient
// history. Warm restarts use the persisted cursor instead.
const SUBSCRIBE_SINCE_LOOKBACK_SEC = 60;
// Resubscribe cadence: SimplePool.subscribeMany opens relay WebSockets
// and attaches a single NIP-01 REQ. nostr-tools does not auto-resume
// that REQ when a relay closes the socket (network blip, relay restart,
// long-idle timeout), so without periodic re-subscription we would miss
// every DM delivered after the first drop. Dedup + cursor advance keep
// the replay cost negligible.
const RESUBSCRIBE_INTERVAL_MS = 5 * 60 * 1_000;
// Debounce cursor writes so a chatty conversation doesn't thrash the
// disk. We still flush on shutdown; see installShutdownFlush().
const CURSOR_WRITE_DEBOUNCE_MS = 2_000;

const rawKey = process.env.NOSTR_PRIVATE_KEY;
const relayCsv = process.env.NOSTR_RELAYS;
if (!rawKey || !relayCsv) {
  console.error("NOSTR_PRIVATE_KEY and NOSTR_RELAYS are required.\nSee README for setup instructions.");
  process.exit(1);
}

const relays = parseCsvList(relayCsv);

const privateKeyBytes = decodeKey(rawKey);
const publicKey = getPublicKey(privateKeyBytes);

const allowedPubkeys = parseCsvSet(process.env.NOSTR_ALLOWED_PUBKEYS, { lowercase: true });
const allowAll = allowedPubkeys.size === 0;

const mulmo = createBridgeClient({ transportId: TRANSPORT_ID });
const pool = new SimplePool();

mulmo.onPush((pushEvent) => {
  sendDm(pushEvent.chatId, pushEvent.message).catch((err) => console.error(`[nostr] push send failed: ${err}`));
});

// ── Key handling ────────────────────────────────────────────────

function decodeKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      console.error(`Expected nsec bech32 key, got type ${decoded.type}`);
      process.exit(1);
    }
    return decoded.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    console.error("NOSTR_PRIVATE_KEY must be 64-char hex or nsec1...");
    process.exit(1);
  }
  const out = new Uint8Array(32);
  for (let idx = 0; idx < 32; idx++) {
    out[idx] = parseInt(trimmed.slice(idx * 2, idx * 2 + 2), 16);
  }
  return out;
}

// ── Send ────────────────────────────────────────────────────────

async function sendDm(recipientPubkey: string, text: string): Promise<void> {
  const chunks = chunkText(text, MAX_DM_LEN);
  for (const chunk of chunks) {
    try {
      const ciphertext = nip04.encrypt(privateKeyBytes, recipientPubkey, chunk);
      const signed = finalizeEvent(
        {
          kind: KIND_ENCRYPTED_DM,
          created_at: Math.floor(Date.now() / 1_000),
          tags: [["p", recipientPubkey]],
          content: ciphertext,
        },
        privateKeyBytes,
      );
      await Promise.any(pool.publish(relays, signed));
    } catch (err) {
      console.error(`[nostr] send error: ${err}`);
    }
  }
}

// ── Receive ─────────────────────────────────────────────────────

// Same Nostr event arrives once per subscribed relay (our subscribeMany
// fan-in aggregates them). Drop duplicates by `evt.id`: Nostr event ids
// are sha256 hashes, so collisions are statistically impossible.
// The Map is capped to bound memory on a long-running process; oldest
// entries roll off once we exceed the cap.
const SEEN_EVENT_MAX = 10_000;
const seenEventIds = new Map<string, number>();

function markSeenOnce(eventId: string): boolean {
  if (seenEventIds.has(eventId)) return false;
  seenEventIds.set(eventId, Date.now());
  if (seenEventIds.size > SEEN_EVENT_MAX) {
    // Map preserves insertion order; delete the oldest.
    const oldest = seenEventIds.keys().next().value;
    if (oldest !== undefined) seenEventIds.delete(oldest);
  }
  return true;
}

async function handleEvent(evt: Event): Promise<void> {
  if (evt.kind !== KIND_ENCRYPTED_DM) return;
  if (evt.pubkey === publicKey) return; // ignore our own echoes
  if (!markSeenOnce(evt.id)) return; // already processed via another relay

  // Advance the resume cursor as soon as we've committed to processing
  // the event — even if decrypt/forward fails below, we don't want to
  // re-fetch this event on next startup.
  noteEventSeenAt(evt.created_at);

  const senderPubkey = evt.pubkey.toLowerCase();
  if (!allowAll && !allowedPubkeys.has(senderPubkey)) {
    console.log(`[nostr] denied from=${senderPubkey.slice(0, 12)}…`);
    return;
  }

  let plaintext: string;
  try {
    plaintext = nip04.decrypt(privateKeyBytes, evt.pubkey, evt.content);
  } catch (err) {
    console.warn(`[nostr] decrypt failed from=${senderPubkey.slice(0, 12)}…: ${err}`);
    return;
  }

  const text = plaintext.trim();
  if (!text) return;

  console.log(`[nostr] message from=${senderPubkey.slice(0, 12)}… len=${text.length}`);

  try {
    const ack = await mulmo.send(senderPubkey, text);
    if (ack.ok) {
      await sendDm(senderPubkey, ack.reply ?? "");
    } else {
      const statusSuffix = ack.status ? ` (${ack.status})` : "";
      const errMessage = ack.error ?? "unknown";
      await sendDm(senderPubkey, `Error${statusSuffix}: ${errMessage}`);
    }
  } catch (err) {
    console.error(`[nostr] handleEvent error: ${err}`);
  }
}

// ── Cursor persistence ──────────────────────────────────────────

// Last `created_at` we've committed to processing. Used as the `since`
// filter on (re)subscribe so a restart or relay drop doesn't lose DMs
// delivered while we were gone. `0` = no persisted cursor yet; startup
// falls back to SUBSCRIBE_SINCE_LOOKBACK_SEC in that case.
const cursorState = { lastSeenAt: 0 };
const cursorFile = process.env.NOSTR_CURSOR_FILE?.trim() || join(homedir(), ".mulmoclaude", "nostr-cursor.json");

let cursorWriteTimer: ReturnType<typeof setTimeout> | null = null;
let cursorWriteInFlight: Promise<void> = Promise.resolve();

function noteEventSeenAt(createdAtSec: number): void {
  if (!Number.isFinite(createdAtSec) || createdAtSec <= cursorState.lastSeenAt) return;
  cursorState.lastSeenAt = createdAtSec;
  if (cursorWriteTimer) return;
  cursorWriteTimer = setTimeout(() => {
    cursorWriteTimer = null;
    cursorWriteInFlight = writeCursorFile(cursorState.lastSeenAt);
  }, CURSOR_WRITE_DEBOUNCE_MS);
}

async function writeCursorFile(lastSeenAt: number): Promise<void> {
  try {
    await mkdir(dirname(cursorFile), { recursive: true });
    const tmp = `${cursorFile}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ lastSeenAt })}\n`, "utf-8");
    await rename(tmp, cursorFile);
  } catch (err) {
    console.warn(`[nostr] cursor write failed (${cursorFile}): ${err}`);
  }
}

async function loadCursor(): Promise<void> {
  try {
    const raw = await readFile(cursorFile, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "lastSeenAt" in parsed) {
      const { lastSeenAt: value } = parsed;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        cursorState.lastSeenAt = Math.floor(value);
      }
    }
  } catch (err) {
    // ENOENT on first run is expected; anything else is worth surfacing
    // but not fatal — we fall back to the lookback window.
    const code = isErrorWithCode(err) ? err.code : undefined;
    if (code !== "ENOENT") {
      console.warn(`[nostr] cursor load failed (${cursorFile}): ${err}`);
    }
  }
}

function installShutdownFlush(): void {
  // Flush any debounced cursor write before exit so we don't re-process
  // the last batch of events on next startup.
  const flush = async (): Promise<void> => {
    if (cursorWriteTimer) {
      clearTimeout(cursorWriteTimer);
      cursorWriteTimer = null;
      await writeCursorFile(cursorState.lastSeenAt);
    } else {
      await cursorWriteInFlight;
    }
  };
  installProcessGuards({ name: TRANSPORT_ID, onShutdown: flush });
}

// ── Subscription ────────────────────────────────────────────────

// Close the previous SubCloser before opening a new one. nostr-tools'
// dedupe on the pool side, plus our markSeenOnce Map, make the brief
// overlap-or-gap from close→re-open harmless.
type SubCloser = ReturnType<typeof pool.subscribeMany>;
let currentSub: SubCloser | null = null;

function subscribe(): void {
  // Use the persisted cursor if we have one, otherwise fall back to a
  // short lookback so a cold start doesn't re-fetch the whole relay
  // history. `since` is inclusive per NIP-01, so duplicate deliveries
  // of the boundary event are dropped by markSeenOnce.
  const sinceFromCursor = cursorState.lastSeenAt;
  const sinceFromLookback = Math.floor(Date.now() / 1_000) - SUBSCRIBE_SINCE_LOOKBACK_SEC;
  const since = sinceFromCursor > 0 ? sinceFromCursor : sinceFromLookback;

  currentSub?.close();
  currentSub = pool.subscribeMany(
    relays,
    {
      kinds: [KIND_ENCRYPTED_DM],
      "#p": [publicKey],
      since,
    },
    {
      onevent: (evt) => {
        handleEvent(evt).catch((err) => console.error(`[nostr] event handler error: ${err}`));
      },
      oneose: () => {
        console.log("[nostr] end-of-stored-events from all relays");
      },
    },
  );
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("MulmoClaude Nostr bridge");
  console.log(`Pubkey: ${publicKey}`);
  console.log(`npub: ${nip19.npubEncode(publicKey)}`);
  console.log(`Relays: ${relays.join(", ")}`);
  const allowlistSummary = allowAll ? "(all)" : `${allowedPubkeys.size} pubkey(s)`;
  console.log(`Allowlist: ${allowlistSummary}`);
  console.log(`Cursor file: ${cursorFile}`);

  await loadCursor();
  if (cursorState.lastSeenAt > 0) {
    console.log(`[nostr] resuming from cursor=${new Date(cursorState.lastSeenAt * 1_000).toISOString()}`);
  } else {
    console.log(`[nostr] cold start — lookback=${SUBSCRIBE_SINCE_LOOKBACK_SEC}s`);
  }

  installShutdownFlush();
  subscribe();
  setInterval(subscribe, RESUBSCRIBE_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
