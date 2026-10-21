// Message-routing logic for the Telegram bridge. Kept separate from
// `index.ts` so it can be exercised with stubbed deps (no real
// Telegram API, no real MulmoClaude socket, no env reads). The
// entrypoint in index.ts is then just: read env → wire real deps →
// drive the polling loop.

import type { TelegramApi, TelegramMessage } from "./api.js";
import type { Allowlist } from "./allowlist.js";
import type { Attachment } from "@mulmobridge/protocol";
import { parseDataUrl, replyAfterProcessingIndicator, type MessageAck, type PushEvent } from "@mulmobridge/client";

// Telegram caps a single message at 4096 chars. We split long
// replies naively; pretty formatting (preserve markdown, break on
// sentence boundaries) is a follow-up.
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

export type SendToMulmoFn = (externalChatId: string, text: string, attachments?: Attachment[]) => Promise<MessageAck>;

export interface RouterDeps {
  api: TelegramApi;
  allowlist: Allowlist;
  sendToMulmo: SendToMulmoFn;
  /** Structured logger. Console-compatible shape — `[telegram]`
   *  prefix is the router's responsibility. */
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface MessageRouter {
  handleMessage(msg: TelegramMessage): Promise<void>;
  handlePush(ev: PushEvent): Promise<void>;
  /** Called for each streaming text chunk from the server. */
  handleTextChunk(chunk: string): void;
  /** For tests / debugging: chat IDs we've already sent the
   *  access-denied notice to. */
  deniedAlreadyNotified(): ReadonlySet<number>;
}

const defaultLog = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

interface AttachmentResult {
  attachments: Attachment[];
  failed: boolean;
}

/** One media slot of a message: downloaded, absent, or download failed. */
type MediaOutcome = { attachment: Attachment } | { failed: true } | null;

// Minimum interval between editMessageText calls to avoid Telegram
// rate limits. 1 second is conservative; Telegram allows ~30 edits
// per minute per chat.
const STREAM_EDIT_INTERVAL_MS = 1000;

// Telegram shows a chat action for about 5 s, or until the next message.
const TYPING_REFRESH_MS = 4_000;

/** Posts the final reply; runs once "typing…" is down. */
type Deliver = () => Promise<void>;

export function createMessageRouter(deps: RouterDeps): MessageRouter {
  const { api, allowlist, sendToMulmo } = deps;
  const log = deps.log ?? defaultLog;

  // One denial reply per chat per bridge lifetime — restart clears.
  const deniedAlreadyNotified = new Set<number>();

  // Streaming state: while a relay is in flight, chunks accumulate
  // here. A timer periodically flushes them via editMessageText.
  let streamChatId: number | null = null;
  let streamMessageId: number | null = null;
  let streamAccumulated = "";
  let streamDirty = false;
  let streamTimer: ReturnType<typeof setInterval> | null = null;

  function startStream(chatId: number): void {
    streamChatId = chatId;
    streamMessageId = null;
    streamAccumulated = "";
    streamDirty = false;
    streamTimer = setInterval(flushStream, STREAM_EDIT_INTERVAL_MS);
  }

  function stopStream(): void {
    if (streamTimer !== null) {
      clearInterval(streamTimer);
      streamTimer = null;
    }
    streamChatId = null;
    streamMessageId = null;
    streamAccumulated = "";
    streamDirty = false;
  }

  function flushStream(): void {
    if (!streamDirty || streamChatId === null) return;
    streamDirty = false;
    const chatId = streamChatId;
    const text = streamAccumulated || "…";
    if (streamMessageId === null) {
      // First flush: send a new message
      api
        .sendMessage(chatId, text)
        .then((msgId) => {
          streamMessageId = msgId;
        })
        .catch((err) => {
          log.error(`[telegram] stream sendMessage failed: ${String(err)}`);
        });
    } else {
      // Subsequent flushes: edit existing message
      api.editMessageText(chatId, streamMessageId, text).catch((err) => {
        log.error(`[telegram] stream editMessage failed: ${String(err)}`);
      });
    }
  }

  // Download all media from a message. Telegram messages are usually
  // exclusive (photo OR document), but forwarded messages or future
  // API changes could carry both. We collect all available attachments
  // rather than picking one.
  async function downloadPhoto(msg: TelegramMessage): Promise<MediaOutcome> {
    // Telegram lists photo sizes smallest-first, so the last entry is
    // the highest resolution available.
    const largest = Array.isArray(msg.photo) ? msg.photo[msg.photo.length - 1] : undefined;
    if (!largest) return null;
    try {
      const parsed = parseDataUrl(await api.downloadFile(largest.file_id, "image/jpeg"));
      return parsed ? { attachment: { mimeType: parsed.mimeType, data: parsed.data } } : null;
    } catch (err) {
      log.error(`[telegram] photo download failed: ${String(err)}`);
      return { failed: true };
    }
  }

  async function downloadDocument(msg: TelegramMessage): Promise<MediaOutcome> {
    const doc = msg.document;
    if (!doc) return null;
    const fallbackMime = doc.mime_type ?? "application/octet-stream";
    try {
      const parsed = parseDataUrl(await api.downloadFile(doc.file_id, fallbackMime));
      if (!parsed) return null;
      const filename = doc.file_name !== undefined ? { filename: doc.file_name } : {};
      return { attachment: { mimeType: parsed.mimeType, data: parsed.data, ...filename } };
    } catch (err) {
      log.error(`[telegram] document download failed: ${String(err)}`);
      return { failed: true };
    }
  }

  async function tryDownloadAttachments(msg: TelegramMessage): Promise<AttachmentResult> {
    const outcomes = [await downloadPhoto(msg), await downloadDocument(msg)];
    const attachments = outcomes.flatMap((outcome) => (outcome && "attachment" in outcome ? [outcome.attachment] : []));
    const anyFailed = outcomes.some((outcome) => outcome !== null && "failed" in outcome);
    if (attachments.length === 0 && anyFailed) {
      return { attachments: [], failed: true };
    }
    return { attachments, failed: false };
  }

  async function sendReply(chatId: number, ack: MessageAck): Promise<void> {
    if (ack.ok) {
      await sendChunked(api, chatId, ack.reply ?? "");
    } else {
      const status = ack.status ? ` (${ack.status})` : "";
      await sendChunked(api, chatId, `Error${status}: ${ack.error ?? "unknown"}`);
    }
  }

  async function handleAllowed(msg: TelegramMessage): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text ?? msg.caption ?? "";
    const hasMedia = (Array.isArray(msg.photo) && msg.photo.length > 0) || msg.document !== undefined;
    if (text.trim().length === 0 && !hasMedia) return;

    const mediaLabel = buildMediaLabel(msg);
    log.info(`[telegram] accepted chat=${chatId} user=@${userLabel(msg)} len=${text.length}${mediaLabel}`);

    await replyAfterProcessingIndicator(
      () => api.sendChatAction(chatId, "typing"),
      { produce: () => relay(msg, chatId, text), post: (deliver) => deliver() },
      { refreshMs: TYPING_REFRESH_MS, label: "telegram", log },
    );
  }

  /** Everything up to the final reply, run while "typing…" shows; returns the
   *  step that delivers the reply, which runs once the indicator is down. */
  async function relay(msg: TelegramMessage, chatId: number, text: string): Promise<Deliver> {
    const { attachments, failed } = await tryDownloadAttachments(msg);

    // Attachment-only message where download failed: bail out instead
    // of sending a query without the actual file.
    if (failed && text.trim().length === 0) {
      return async () => {
        await api.sendMessage(chatId, "Sorry, I could not download the attachment. Please try again.").catch(() => {});
      };
    }

    // Surface the attachment failure so the user knows the file was lost.
    const messageText = resolveMessageText(text, failed);

    // Start streaming: chunks will arrive via handleTextChunk and
    // be sent/edited in the Telegram chat in real time.
    startStream(chatId);
    const ack = await sendToMulmo(String(chatId), messageText, attachments.length > 0 ? attachments : undefined);
    // Final flush + capture the message id before stopStream clears it.
    flushStream();
    const sentMsgId = streamMessageId;
    stopStream();
    return () => deliverFinal(chatId, sentMsgId, ack);
  }

  // If streaming sent the text, do a final edit with the full ack
  // to catch any trailing chunks. If no streaming happened,
  // send the full reply as a new message.
  async function deliverFinal(chatId: number, sentMsgId: number | null, ack: MessageAck): Promise<void> {
    if (sentMsgId !== null && ack.ok) {
      await api.editMessageText(chatId, sentMsgId, ack.reply ?? "").catch(() => {});
    } else if (sentMsgId === null) {
      await sendReply(chatId, ack);
    }
  }

  async function handleDenied(msg: TelegramMessage): Promise<void> {
    const chatId = msg.chat.id;
    log.warn(`[telegram] denied chat=${chatId} user=@${userLabel(msg)} — not on allowlist`);
    if (deniedAlreadyNotified.has(chatId)) return;
    deniedAlreadyNotified.add(chatId);
    try {
      await api.sendMessage(chatId, "Access denied. Contact the operator to be added to the allowlist.");
    } catch (err) {
      log.error(`[telegram] access-denied reply failed: ${String(err)}`);
    }
  }

  return {
    async handleMessage(msg) {
      if (allowlist.allows(msg.chat.id)) {
        await handleAllowed(msg);
      } else {
        await handleDenied(msg);
      }
    },

    async handlePush(ev) {
      const chatId = Number(ev.chatId);
      if (!Number.isInteger(chatId)) {
        log.warn(`[telegram] push chatId is not integer: ${ev.chatId}`);
        return;
      }
      if (!allowlist.allows(chatId)) {
        log.warn(`[telegram] push denied: chat ${chatId} not on allowlist`);
        return;
      }
      try {
        await sendChunked(api, chatId, ev.message);
      } catch (err) {
        log.error(`[telegram] push sendMessage failed: ${String(err)}`);
      }
    },

    handleTextChunk(chunk: string) {
      if (streamChatId === null) return;
      streamAccumulated += chunk;
      streamDirty = true;
    },

    deniedAlreadyNotified() {
      return deniedAlreadyNotified;
    },
  };
}

async function sendChunked(api: TelegramApi, chatId: number, text: string): Promise<void> {
  if (text.length === 0) {
    await api.sendMessage(chatId, "(empty reply)");
    return;
  }
  for (let i = 0; i < text.length; i += TELEGRAM_MAX_MESSAGE_CHARS) {
    await api.sendMessage(chatId, text.slice(i, i + TELEGRAM_MAX_MESSAGE_CHARS));
  }
}

function resolveMessageText(text: string, attachmentFailed: boolean): string {
  const hasText = text.trim().length > 0;
  if (attachmentFailed && hasText) {
    return `${text}\n\n(note: attached file could not be downloaded)`;
  }
  if (hasText) return text;
  return "Describe / analyze this file.";
}

function buildMediaLabel(msg: TelegramMessage): string {
  if (msg.document) {
    const hint = msg.document.file_name ?? msg.document.mime_type ?? "unknown";
    return ` +file(${hint})`;
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) return " +photo";
  return "";
}

function userLabel(msg: TelegramMessage): string {
  return msg.from?.username ?? msg.from?.first_name ?? "unknown";
}
