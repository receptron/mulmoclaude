// @package-contract — see ./types.ts
//
// Socket.io transport for the bridge chat flow.
//
// Phase A (#268) — bridge → server req/res:
//   handshake.auth: { transportId: string; token?: string }
//   emit("message", { externalChatId, text }, ack)
//     ack receives { ok: true, reply }
//                 | { ok: false, error, status? }
//
// Phase B (#268) — server → bridge async push:
//   Each connected bridge joins room `bridge:${transportId}`.
//   Server emits `push` { chatId, message } to that room via the
//   `pushToBridge(transportId, chatId, message)` helper this module
//   returns. If no sockets are in the room at push time, the
//   message goes to an in-memory queue; the next socket that joins
//   the room drains its transport's queue on connect.
//
// Auth: the handshake is refused unless `auth.token` passes the shared
// bearer rule against `tokenProvider()`, or `authorizeToken` when the host
// supplies one (see ./handshake.ts). The refusal
// is the same generic `unauthorized` every other bearer surface sends, and
// `tokenProvider` is required so a chat socket is never open by accident.
//
// Future phases:
//   C — streaming text chunks via `reply.chunk`
//   D — HTTP endpoint deprecation
//
// See plans/done/feat-chat-socketio.md and plans/done/feat-chat-socketio-phase-b.md.

import type http from "http";
import { Server as SocketServer } from "socket.io";
import type { Socket } from "socket.io";
import type { RelayFn } from "./relay.js";
import type { PushQueue } from "./push-queue.js";
import { isAuthorizedToken, UNAUTHORIZED_MESSAGE } from "@mulmoclaude/common/token-guard";
import { isRecord } from "@mulmoclaude/common";
import { validateHandshakeWith, type BridgeOptions } from "./handshake.js";
import type { Attachment, Logger } from "./types.js";

export const CHAT_SOCKET_PATH = "/ws/chat";

/**
 * Custom socket.io events the chat transport defines. Keys mirror
 * values so grep-and-rename is safe; the union type is what every
 * on/emit site should reference instead of raw string literals.
 * Socket.io built-ins (`connect`, `disconnect`, `connect_error`) are
 * intentionally omitted — those are part of socket.io's own contract,
 * not ours to rename.
 */
export const CHAT_SOCKET_EVENTS = {
  /** bridge → server request (body: `{ externalChatId, text }`); ack
   *  carries `{ ok, reply, error?, status? }`. */
  message: "message",
  /** server → bridge async push (Phase B of #268); body:
   *  `{ chatId, message }`. */
  push: "push",
  /** server → bridge streaming text chunk (Phase C of #268). */
  textChunk: "textChunk",
} as const;
export type ChatSocketEvent = (typeof CHAT_SOCKET_EVENTS)[keyof typeof CHAT_SOCKET_EVENTS];

export type PushFn = (transportId: string, chatId: string, message: string) => void;

export interface ChatSocketDeps {
  relay: RelayFn;
  queue: PushQueue;
  logger: Logger;
  /** Current bearer token the handshake must carry. Null means
   *  bootstrap in progress — refuse everything. */
  tokenProvider: () => string | null;
  /** When set, decides which handshake tokens pass instead of `tokenProvider`. */
  authorizeToken?: ((token: unknown) => boolean) | undefined;
  /** Test seam for how often open sockets are re-checked. */
  revalidateIntervalMs?: number | undefined;
}

export interface ChatSocketHandle {
  io: SocketServer;
  /** Fire-and-forget push to every bridge in `bridge:${transportId}`.
   *  If none are connected, the message is queued for the next
   *  joiner. */
  pushToBridge: PushFn;
}

interface MessagePayload {
  externalChatId?: unknown;
  text?: unknown;
  /** Array of `{ mimeType, data, filename? }` attachments (#382). */
  attachments?: unknown;
}

type MessageAck = { ok: true; reply: string } | { ok: false; error: string; status?: number };

type ParsedMessage =
  | {
      ok: true;
      externalChatId: string;
      text: string;
      attachments?: Attachment[] | undefined;
    }
  | { ok: false; error: string };

// Hard limits to prevent oversized payloads from bridges (DoS /
// accidental misconfiguration). Express's JSON body limit (50 MB)
// is the outer gate; these are tighter, attachment-specific caps.
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB base64
/** Transport ceiling for one socket frame. Headroom over the attachment
 *  budget for the rest of the payload (text, ids, options) so the
 *  application-level cap is what a bridge actually hits. */
const MAX_SOCKET_PAYLOAD_BYTES = MAX_ATTACHMENT_TOTAL_BYTES + 4 * 1024 * 1024;

export function bridgeRoom(transportId: string): string {
  return `bridge:${transportId}`;
}

// A refused handshake leaves the engine.io connection open, and that one
// connection can keep sending CONNECT packets; one line per connection keeps
// a misconfigured bridge diagnosable without letting a loop fill the log.
// The address is logged, the token never.
const warnedConnections = new WeakSet<object>();

function warnRefusedOnce(logger: Logger, socket: Socket, error: string): void {
  if (warnedConnections.has(socket.conn)) return;
  warnedConnections.add(socket.conn);
  logger.warn("chat-service", "handshake refused", { address: socket.handshake.address, error });
}

// A token is checked at the handshake, and a revoked one must not keep an
// already-open socket: each message re-checks it, and a periodic sweep drops
// sockets that are only receiving pushes.
const REVALIDATE_INTERVAL_MS = 5_000;

const handshakeToken = (socket: Socket): unknown => (isRecord(socket.handshake.auth) ? socket.handshake.auth.token : undefined);

function startRevalidation(server: http.Server, io: SocketServer, authorizeToken: (token: unknown) => boolean, intervalMs: number): void {
  const timer = setInterval(() => {
    io.sockets.sockets.forEach((socket) => {
      if (!authorizeToken(handshakeToken(socket))) socket.disconnect(true);
    });
  }, intervalMs);
  timer.unref();
  server.once("close", () => clearInterval(timer));
}

export function attachChatSocket(server: http.Server, deps: ChatSocketDeps): ChatSocketHandle {
  const { relay, queue, logger, tokenProvider } = deps;
  const authorizeToken = deps.authorizeToken ?? ((token: unknown): boolean => isAuthorizedToken(token, tokenProvider()));

  const io = new SocketServer(server, {
    path: CHAT_SOCKET_PATH,
    // Loopback-only deployment; skip long-polling negotiation for
    // the same reason `/ws/pubsub` does (#311).
    transports: ["websocket"],
    // Socket.IO's default is 1 MB — below the attachment budget
    // `parseAttachments` enforces, so a bridge shipping a 900 KB image
    // had its connection closed before the ack instead of a reply.
    // `parseAttachments` stays the real gate; this only has to be
    // wide enough not to pre-empt it.
    maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
  });

  io.use((socket, next) => {
    const result = validateHandshakeWith(socket.handshake.auth, authorizeToken);
    if (!result.ok) {
      warnRefusedOnce(logger, socket, result.error);
      next(new Error(result.error));
      return;
    }
    socket.data.transportId = result.transportId;
    // Stash options on the socket so every subsequent message from
    // this bridge inherits the same config without re-sending it.
    socket.data.bridgeOptions = result.options;
    next();
  });

  startRevalidation(server, io, authorizeToken, deps.revalidateIntervalMs ?? REVALIDATE_INTERVAL_MS);

  io.on("connection", (socket: Socket) => {
    const transportId: string = socket.data.transportId;
    const room = bridgeRoom(transportId);
    socket.join(room);

    // Flush any messages queued while this transport had no live
    // socket. Emit only to *this* socket, not the room, so a
    // second bridge joining seconds later doesn't re-receive the
    // already-drained messages.
    const queued = queue.drainFor(transportId);
    if (queued.length > 0) {
      logger.info("chat-service", "flushing push queue", {
        socketId: socket.id,
        transportId,
        count: queued.length,
      });
      for (const item of queued) {
        socket.emit(CHAT_SOCKET_EVENTS.push, {
          chatId: item.chatId,
          message: item.message,
        });
      }
    }

    logger.info("chat-service", "socket connected", {
      socketId: socket.id,
      transportId,
    });

    socket.on("disconnect", (reason: string) => {
      logger.info("chat-service", "socket disconnected", {
        socketId: socket.id,
        transportId,
        reason,
      });
    });

    socket.on(CHAT_SOCKET_EVENTS.message, async (payload: MessagePayload, ack?: (reply: MessageAck) => void) => {
      if (typeof ack !== "function") {
        logger.warn("chat-service", "socket message missing ack", {
          socketId: socket.id,
          transportId,
        });
        return;
      }
      if (!authorizeToken(handshakeToken(socket))) {
        ack({ ok: false, error: UNAUTHORIZED_MESSAGE, status: 401 });
        socket.disconnect(true);
        return;
      }

      const parsed = parseMessagePayload(payload);
      if (!parsed.ok) {
        ack({ ok: false, error: parsed.error, status: 400 });
        return;
      }

      const result = await relay({
        transportId,
        externalChatId: parsed.externalChatId,
        text: parsed.text,
        attachments: parsed.attachments,
        // Options captured at handshake time (see io.use). Empty
        // object when the bridge didn't send any — the host app
        // treats absence and empty identically.
        bridgeOptions: (socket.data.bridgeOptions as BridgeOptions | undefined) ?? {},
        // Stream text chunks to this bridge socket in real time
        // (Phase C of #268). The ack still returns the full text
        // for backward compatibility.
        onChunk: (text) => {
          socket.emit(CHAT_SOCKET_EVENTS.textChunk, { text });
        },
      });

      if (result.kind === "ok") {
        ack({ ok: true, reply: result.reply });
      } else {
        ack({ ok: false, error: result.message, status: result.status });
      }
    });
  });

  const pushToBridge: PushFn = (transportId, chatId, message) => {
    const room = bridgeRoom(transportId);
    // `io.sockets.adapter.rooms` is the authoritative view of which
    // rooms have members right now. Using it here (vs. a separate
    // membership counter we'd have to maintain) keeps us honest
    // about what socket.io actually knows.
    const hasLive = (io.sockets.adapter.rooms.get(room)?.size ?? 0) > 0;
    if (hasLive) {
      io.to(room).emit(CHAT_SOCKET_EVENTS.push, { chatId, message });
      return;
    }
    queue.enqueue(transportId, { chatId, message, enqueuedAt: Date.now() });
    logger.info("chat-service", "push queued (no live bridge)", {
      transportId,
      chatId,
      queueSize: queue.sizeFor(transportId),
    });
  };

  return { io, pushToBridge };
}

function parseMessagePayload(payload: MessagePayload): ParsedMessage {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "payload must be an object" };
  }
  const externalChatId = typeof payload.externalChatId === "string" ? payload.externalChatId.trim() : "";
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!externalChatId) {
    return { ok: false, error: "externalChatId is required" };
  }
  if (!text) {
    return { ok: false, error: "text is required" };
  }
  const attachments = parseAttachments(payload.attachments);
  return { ok: true, externalChatId, text, attachments };
}

export function parseAttachments(raw: unknown): Attachment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const valid: Attachment[] = [];
  let totalBytes = 0;
  for (const item of raw) {
    if (valid.length >= MAX_ATTACHMENT_COUNT) break;
    const entry = parseOneAttachment(item);
    if (!entry) continue;
    if (entry.data) {
      totalBytes += entry.data.length;
      if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) break;
    }
    valid.push(entry);
  }
  return valid.length > 0 ? valid : undefined;
}

// Accept either the inline `{ data, mimeType }` shape (bridges
// shipping raw bytes) or the path-only `{ path }` shape (Vue UI and
// any bridge that uploads to `data/attachments/` first). Either is
// valid per the exported `Attachment` type. The earlier parser only
// recognised the first shape, so a typed `{ path }` payload from a
// socket client passed type-check but got silently dropped at the
// wire boundary (#1050 review).
//
// Wire-boundary path guard: a malicious bridge can ship arbitrary
// strings as `path`. The downstream `isAttachmentPath` enforcement
// in the server is the authoritative gate, but defence-in-depth at
// each layer is required for external code (#1099 review). Reject
// absolute paths and any traversal segment up front so a payload
// like `path: "../../etc/passwd"` never reaches the relay.
// Windows-style drive-letter absolute path (`C:\…` or `C:/…`).
// `isSafeAttachmentPath` rejects these too — a malicious bridge
// can't ship a host-absolute path under any platform convention
// (#1099 review iter-2).
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;

function isSafeAttachmentPath(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (WINDOWS_DRIVE_PATH_RE.test(value)) return false;
  for (const segment of value.split(/[/\\]/)) {
    if (segment === "..") return false;
  }
  return true;
}

export function parseOneAttachment(item: unknown): Attachment | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const filename = typeof record.filename === "string" && record.filename.length > 0 ? record.filename : undefined;
  if (typeof record.mimeType === "string" && typeof record.data === "string") {
    return { mimeType: record.mimeType, data: record.data, ...(filename ? { filename } : {}) };
  }
  if (typeof record.path === "string" && isSafeAttachmentPath(record.path)) {
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
    return { path: record.path, ...(mimeType ? { mimeType } : {}), ...(filename ? { filename } : {}) };
  }
  return null;
}
