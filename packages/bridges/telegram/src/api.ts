import { mimeFromExtension, buildDataUrl } from "@mulmobridge/client";

// Raw `fetch` wrapper for the Telegram Bot API. Only the two methods
// the bridge actually uses (`getUpdates`, `sendMessage`) are exposed.
//
// Why raw fetch + no dep: the Telegram client-lib ecosystem is heavy
// (event buses, middleware pipelines, type trees). We're driving two
// endpoints; ~60 lines of fetch is cheaper than a dep's security-
// review / lockfile footprint, and it leaves no doubt about which
// methods touch the network.
//
// Message-length handling (4096 char cap, markdown mode, media
// uploads) is deliberately out of scope for this file — the caller
// in `packages/bridges/telegram/src/index.ts` decides how to chunk long replies.

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  caption?: string;
  date: number;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  username?: string;
  title?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name: string;
}

export interface TelegramApiOptions {
  botToken: string;
  /** Base URL override for tests / self-hosted Telegram Bot API. */
  baseUrl?: string;
  /** Injectable fetch for tests — defaults to global. */
  fetchImpl?: typeof fetch;
}

export interface GetUpdatesOptions {
  offset?: number | undefined;
  timeoutSec?: number | undefined;
  signal?: AbortSignal | undefined;
}

export type TelegramChatAction = "typing";

export interface TelegramApi {
  getUpdates(opts?: GetUpdatesOptions): Promise<TelegramUpdate[]>;
  /** Send a message and return its message_id (needed for editMessageText). */
  sendMessage(chatId: number, text: string): Promise<number>;
  /** Edit an existing message in place. Used for streaming text updates. */
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
  /** Show a chat action such as "typing…" until the next message or about 5 s. */
  sendChatAction(chatId: number, action: TelegramChatAction): Promise<void>;
  /** Download any file by file_id via the Telegram getFile API.
   *  Returns a data URL (`data:<mime>;base64,...`).
   *  Works for photos, documents, audio, etc. */
  downloadFile(fileId: string, fallbackMime?: string): Promise<string>;
}

const DEFAULT_BASE = "https://api.telegram.org";

export function createTelegramApi(opts: TelegramApiOptions): TelegramApi {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `${baseUrl}/bot${opts.botToken}`;

  return {
    async getUpdates(gu: GetUpdatesOptions = {}) {
      const params = new URLSearchParams();
      if (gu.offset !== undefined) params.set("offset", String(gu.offset));
      if (gu.timeoutSec !== undefined) {
        params.set("timeout", String(gu.timeoutSec));
      }
      const url = `${base}/getUpdates?${params.toString()}`;

      const res = await fetchImpl(url, gu.signal !== undefined ? { signal: gu.signal } : {});
      if (!res.ok) {
        throw new Error(`getUpdates failed: ${res.status} ${await safeText(res)}`);
      }
      const body = (await res.json()) as {
        ok: boolean;
        description?: string;
        result?: TelegramUpdate[];
      };
      if (!body.ok || !Array.isArray(body.result)) {
        throw new Error(`getUpdates API error: ${body.description ?? "unknown"}`);
      }
      return body.result;
    },

    async sendMessage(chatId, text) {
      const res = await fetchImpl(`${base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) {
        throw new Error(`sendMessage failed: ${res.status} ${await safeText(res)}`);
      }
      const body = (await res.json()) as {
        ok: boolean;
        description?: string;
        result?: { message_id: number };
      };
      if (!body.ok) {
        throw new Error(`sendMessage API error: ${body.description ?? "unknown"}`);
      }
      return body.result?.message_id ?? 0;
    },

    async editMessageText(chatId, messageId, text) {
      const res = await fetchImpl(`${base}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text,
        }),
      });
      if (!res.ok) {
        // editMessageText fails if the text is unchanged (Telegram
        // returns 400 "message is not modified"). Swallow silently.
        return;
      }
    },

    async sendChatAction(chatId, action) {
      const res = await fetchImpl(`${base}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action }),
      });
      if (!res.ok) {
        throw new Error(`sendChatAction failed: ${res.status} ${await safeText(res)}`);
      }
      const failure = apiFailureDescription(await res.json().catch(() => null));
      if (failure !== null) {
        throw new Error(`sendChatAction API error: ${failure}`);
      }
    },

    async downloadFile(fileId, fallbackMime = "application/octet-stream") {
      const getFileRes = await fetchImpl(`${base}/getFile?file_id=${encodeURIComponent(fileId)}`);
      if (!getFileRes.ok) {
        throw new Error(`getFile failed: ${getFileRes.status} ${await safeText(getFileRes)}`);
      }
      const getFileBody = (await getFileRes.json()) as {
        ok: boolean;
        description?: string;
        result?: { file_path?: string };
      };
      if (!getFileBody.ok || !getFileBody.result?.file_path) {
        throw new Error(`getFile API error: ${getFileBody.description ?? "no file_path"}`);
      }
      const fileUrl = `${baseUrl}/file/bot${opts.botToken}/${getFileBody.result.file_path}`;
      const fileRes = await fetchImpl(fileUrl);
      if (!fileRes.ok) {
        throw new Error(`file download failed: ${fileRes.status}`);
      }
      const buffer = await fileRes.arrayBuffer();
      const b64 = Buffer.from(buffer).toString("base64");
      // Prefer the caller-supplied MIME (Telegram's doc.mime_type is
      // authoritative). Fall back to extension-based inference only
      // when the caller passed the generic default.
      const ext = getFileBody.result.file_path.split(".").pop() ?? "";
      const mediaType = fallbackMime !== "application/octet-stream" ? fallbackMime : mimeFromExtension(ext, fallbackMime);
      return buildDataUrl(mediaType, b64);
    },
  };
}

/** The description of a `{ ok: false }` Bot API body, or null when the body does not report a failure. */
export function apiFailureDescription(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("ok" in body) || body.ok !== false) return null;
  return "description" in body && typeof body.description === "string" ? body.description : "unknown";
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}
