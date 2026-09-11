// Shared socket.io client wrapper for every MulmoClaude bridge.
//
// A bridge is a small process that glues one external messaging
// platform (CLI / Telegram / LINE / Slack / …) to MulmoClaude's
// chat-service. Every bridge needs the exact same socket setup:
// read the bearer token, connect to `/ws/chat` with
// `{ transportId, token }`, handle connect / disconnect / token-
// mismatch, and send / receive on the two wire events (`message`
// with ack, `push` from the server). That machinery lives here so
// each new bridge file is just the platform adapter.
//
// See `docs/bridge-protocol.md` for the wire-level contract and a
// minimal non-Node equivalent.

import { io, type Socket } from "socket.io-client";
import { CHAT_SOCKET_EVENTS, CHAT_SOCKET_PATH, type Attachment, type BridgeOptions } from "@mulmobridge/protocol";
import { readBridgeToken, tokenFilePath } from "./token.js";
import { readBridgeEnvOptions } from "./options.js";
import { resolveApiUrl } from "./apiUrl.js";

// 6 min > the server's REPLY_TIMEOUT_MS (5 min) so the server's
// timeout surfaces as a reply, not a client-side cancellation.
const REPLY_TIMEOUT_MS = 6 * 60 * 1000;

export interface MessageAck {
  ok: boolean;
  reply?: string;
  error?: string;
  status?: number;
}

export interface PushEvent {
  chatId: string;
  message: string;
}

export interface BridgeClientOptions {
  /** Required. Identifier for this bridge in the handshake.
   *  Matches `handshake.auth.transportId` server-side. */
  transportId: string;
  /** Defaults to `$MULMOCLAUDE_API_URL`, then the port the server
   *  published to `<workspace>/.server-port`, then
   *  `http://localhost:3001` (#3078). */
  apiUrl?: string;
  /** Flat primitive bag forwarded to the host app's startChat
   *  callback via the handshake (`BridgeOptions` from the
   *  protocol). Values must be string / number / boolean — nested
   *  objects are rejected server-side by the chat-service. If
   *  omitted, the client auto-scrapes `<TRANSPORT>_BRIDGE_*` /
   *  `BRIDGE_*` env vars (producing string values). Pass `{}`
   *  explicitly to opt out of the scrape. */
  options?: BridgeOptions;
}

export interface BridgeClient {
  /** Send a user turn to MulmoClaude, wait for the assistant reply. */
  send(externalChatId: string, text: string, attachments?: Attachment[]): Promise<MessageAck>;
  /** Subscribe to server → bridge async pushes (Phase B of #268). */
  onPush(handler: (event: PushEvent) => void): void;
  /** Subscribe to streaming text chunks during a relay (Phase C of
   *  #268). Each chunk is a fragment of the assistant's response,
   *  emitted in real time as the agent generates text. The final
   *  ack from `send()` still carries the full response. */
  onTextChunk(handler: (chunk: string) => void): void;
  /** Called each time the socket (re-)establishes a connection. */
  onConnect(handler: () => void): void;
  /** Called when the socket disconnects. */
  onDisconnect(handler: (reason: string) => void): void;
  /** Explicit shutdown. */
  close(): void;
  /** Escape hatch — raw socket for anything the helpers don't cover. */
  socket: Socket;
}

/**
 * Resolve the bearer token from the workspace / env var, exit with
 * a clear error if absent. Kept separate so bridges that want to
 * surface the error differently (e.g. print to a platform channel)
 * can call `readBridgeToken()` directly.
 */
export function requireBearerToken(): string {
  const token = readBridgeToken();
  if (token !== null) return token;
  // `tokenFilePath()` rather than `TOKEN_FILE_PATH`, which is fixed at module
  // load: a bridge that imports this before `dotenv/config` would otherwise be
  // told to look somewhere the token was never going to be.
  process.stderr.write(
    `No bearer token found. The MulmoClaude server writes one to\n` +
      `  ${tokenFilePath()}\n` +
      `at startup (mode 0600). Start the server with \`yarn dev\` (or\n` +
      `\`npm run dev\`) first, or set MULMOCLAUDE_AUTH_TOKEN to the\n` +
      `same value the server is using.\n`,
  );
  return process.exit(1) as never;
}

export function createBridgeClient(opts: BridgeClientOptions): BridgeClient {
  // Token BEFORE port, because the server writes them in that order too: a
  // restart landing between these two reads can only hand us an OLD token with
  // a NEW port, never the reverse. That pairing fails loudly — the right server
  // answers `invalid token`, which the connect handler explains — where the
  // reverse would send a fresh token to the port the server just left (Codex).
  const token = requireBearerToken();
  const apiUrl = resolveApiUrl(opts.apiUrl);
  // `opts.options === undefined` → scrape env automatically.
  // `opts.options === {}` → opt out of the scrape explicitly.
  const options = opts.options ?? readBridgeEnvOptions(opts.transportId, process.env);
  // Only include the `options` key in the handshake when there's
  // something to send — keeps old servers unaware of the field from
  // ever seeing an empty object on the wire.
  const auth: Record<string, unknown> = { transportId: opts.transportId, token };
  if (Object.keys(options).length > 0) auth.options = options;

  const socket = io(apiUrl, {
    path: CHAT_SOCKET_PATH,
    auth,
    transports: ["websocket"],
  });

  installDefaultLogging(socket);

  return {
    send: (externalChatId, text, attachments) => sendMessage(socket, externalChatId, text, attachments),
    onPush: (handler) => {
      socket.on(CHAT_SOCKET_EVENTS.push, handler);
    },
    onTextChunk: (handler) => {
      socket.on(CHAT_SOCKET_EVENTS.textChunk, (event: { text: string }) => {
        handler(event.text);
      });
    },
    onConnect: (handler) => {
      socket.on("connect", handler);
    },
    onDisconnect: (handler) => {
      socket.on("disconnect", handler);
    },
    close: () => {
      socket.disconnect();
    },
    socket,
  };
}

function sendMessage(socket: Socket, externalChatId: string, text: string, attachments?: Attachment[]): Promise<MessageAck> {
  const payload: Record<string, unknown> = { externalChatId, text };
  if (attachments && attachments.length > 0) payload.attachments = attachments;
  return new Promise((resolve) => {
    socket.timeout(REPLY_TIMEOUT_MS).emit(CHAT_SOCKET_EVENTS.message, payload, (err: Error | null, ack: MessageAck | undefined) => {
      if (err) {
        resolve({ ok: false, error: `timeout: ${err.message}` });
        return;
      }
      resolve(ack ?? { ok: false, error: "no ack from server" });
    });
  });
}

function installDefaultLogging(socket: Socket): void {
  socket.on("connect", () => {
    console.log(`Connected (${socket.id}).`);
  });
  socket.on("disconnect", (reason) => {
    console.error(`\nDisconnected: ${reason}`);
  });
  socket.on("connect_error", (err) => {
    const msg = err.message;
    // Token-mismatch recovery: the server rewrites its token on
    // every restart, so an old bridge will see "invalid token"
    // right after the server bounces. Tell the user instead of
    // spinning silently.
    if (msg === "invalid token" || msg === "server auth not ready") {
      console.error(
        "\nConnect error: bearer token rejected. The server likely\n" +
          "restarted since this bridge started — re-run the bridge to\n" +
          "pick up the new token.\n",
      );
      return;
    }
    console.error(`\nConnect error: ${msg}`);
  });
}
