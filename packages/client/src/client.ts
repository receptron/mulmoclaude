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
import { resolveApiUrl, resolvePublishedApiUrl } from "./apiUrl.js";
import { backoffMs, credentialsChanged, type Credentials } from "./supervisor.js";

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
  /** Escape hatch — the socket in use NOW. Read it per use rather than
   *  caching it: the client replaces the socket when the server comes back
   *  as a different generation (#3078). */
  readonly socket: Socket;
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

/** Every subscription the caller made, so a replacement socket gets them all. */
interface Subscriptions {
  push: ((event: PushEvent) => void)[];
  textChunk: ((chunk: string) => void)[];
  connect: (() => void)[];
  disconnect: ((reason: string) => void)[];
}

const emptySubscriptions = (): Subscriptions => ({ push: [], textChunk: [], connect: [], disconnect: [] });

/** The handshake bag. `options` is omitted when empty so a server too old to
 *  know the field never sees an empty object on the wire. */
function buildAuth(transportId: string, token: string, options: BridgeOptions): Record<string, unknown> {
  const auth: Record<string, unknown> = { transportId, token };
  if (Object.keys(options).length > 0) auth.options = options;
  return auth;
}

function attach(socket: Socket, subscriptions: Subscriptions): void {
  subscriptions.push.forEach((handler) => socket.on(CHAT_SOCKET_EVENTS.push, handler));
  subscriptions.textChunk.forEach((handler) =>
    socket.on(CHAT_SOCKET_EVENTS.textChunk, (event: { text: string }) => {
      handler(event.text);
    }),
  );
  subscriptions.connect.forEach((handler) => socket.on("connect", handler));
  subscriptions.disconnect.forEach((handler) => socket.on("disconnect", handler));
}

export function createBridgeClient(opts: BridgeClientOptions): BridgeClient {
  // Token BEFORE port. A restart rewrites both files and nothing marks them as
  // one generation, so a bridge starting mid-restart can read a torn pair in
  // either order. What the order decides is WHICH tear it gets. Port first
  // yields a NEW token with an OLD port — a fresh credential sent to the port
  // the server has just left. Token first mostly yields the opposite, an OLD
  // token with a NEW port, which the right server answers `invalid token`; the
  // dangerous pairing survives only in the narrow window where BOTH reads fall
  // between the token write and the port publish (Codex, #3082).
  const token = requireBearerToken();
  // `opts.options === undefined` → scrape env automatically.
  // `opts.options === {}` → opt out of the scrape explicitly.
  const options = opts.options ?? readBridgeEnvOptions(opts.transportId, process.env);
  const subscriptions = emptySubscriptions();

  const pending: Pending = new Set();
  let current: Credentials = { apiUrl: resolveApiUrl(opts.apiUrl), token };
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  /** The pair as the workspace has it NOW, or null while the server is mid-restart.
   *
   *  BOTH halves have to be present. The startup default is deliberately not
   *  consulted here: the server clears `.server-port` before writing the new
   *  token (#3082), so "token, no port" is a real and frequent state, and
   *  resolving it to `http://localhost:3001` would carry a freshly minted
   *  bearer token to whatever holds that port (Codex, #3078). Half a generation
   *  is not a generation. */
  const reread = (): Credentials | null => {
    const freshToken = readBridgeToken();
    const freshApiUrl = resolvePublishedApiUrl(opts.apiUrl);
    if (freshToken === null || freshApiUrl === null) return null;
    return { apiUrl: freshApiUrl, token: freshToken };
  };

  const open = (credentials: Credentials): Socket => {
    const socket = io(credentials.apiUrl, {
      path: CHAT_SOCKET_PATH,
      auth: buildAuth(opts.transportId, credentials.token, options),
      transports: ["websocket"],
    });
    installDefaultLogging(socket);
    socket.on("connect", () => {
      attempt = 0;
    });
    socket.on("connect_error", scheduleReresolve);
    attach(socket, subscriptions);
    return socket;
  };

  let socket = open(current);

  /** Replace the socket only when the pair actually moved — a server that is
   *  merely down must keep socket.io's own reconnection, not a worse copy. */
  function reresolve(): void {
    retry = null;
    if (closed) return;
    const fresh = reread();
    attempt += 1;
    if (!credentialsChanged(current, fresh) || fresh === null) return;
    console.error(`\nServer moved: reconnecting to ${fresh.apiUrl}.\n`);
    abandon(pending, "the server restarted before this was acknowledged — resend");
    socket.removeAllListeners();
    socket.close();
    current = fresh;
    attempt = 0;
    socket = open(current);
  }

  function scheduleReresolve(): void {
    if (closed || retry !== null) return;
    retry = setTimeout(reresolve, backoffMs(attempt));
    retry.unref?.();
  }

  return {
    send: (externalChatId, text, attachments) => sendMessage(socket, pending, externalChatId, text, attachments),
    onPush: (handler) => {
      subscriptions.push.push(handler);
      socket.on(CHAT_SOCKET_EVENTS.push, handler);
    },
    onTextChunk: (handler) => {
      subscriptions.textChunk.push(handler);
      socket.on(CHAT_SOCKET_EVENTS.textChunk, (event: { text: string }) => {
        handler(event.text);
      });
    },
    onConnect: (handler) => {
      subscriptions.connect.push(handler);
      socket.on("connect", handler);
    },
    onDisconnect: (handler) => {
      subscriptions.disconnect.push(handler);
      socket.on("disconnect", handler);
    },
    close: () => {
      closed = true;
      if (retry !== null) clearTimeout(retry);
      abandon(pending, "the bridge closed before this was acknowledged");
      socket.disconnect();
    },
    get socket() {
      return socket;
    },
  };
}

/** Resolvers for sends whose ack has not arrived, so a socket being replaced
 *  can settle them instead of leaving them to time out (see `abandon`). */
type Pending = Set<(ack: MessageAck) => void>;

function sendMessage(socket: Socket, pending: Pending, externalChatId: string, text: string, attachments?: Attachment[]): Promise<MessageAck> {
  const payload: Record<string, unknown> = { externalChatId, text };
  if (attachments && attachments.length > 0) payload.attachments = attachments;
  return new Promise((resolve) => {
    const settle = (ack: MessageAck): void => {
      if (!pending.delete(settle)) return;
      resolve(ack);
    };
    pending.add(settle);
    socket.timeout(REPLY_TIMEOUT_MS).emit(CHAT_SOCKET_EVENTS.message, payload, (err: Error | null, ack: MessageAck | undefined) => {
      settle(err ? { ok: false, error: `timeout: ${err.message}` } : (ack ?? { ok: false, error: "no ack from server" }));
    });
  });
}

/**
 * Fail every unacknowledged send, because the socket carrying them is going.
 *
 * socket.io settles an IN-FLIGHT ack immediately when its socket closes, but a
 * send issued while the socket was already disconnected is queued for a
 * reconnection that will never happen here — the socket is being replaced, not
 * reconnected — so its callback would sit for the full 6-minute ack timeout
 * (measured, Codex). The bridge's user would wait six minutes for a message the
 * client already knows it cannot deliver.
 */
function abandon(pending: Pending, reason: string): void {
  Array.from(pending).forEach((settle) => settle({ ok: false, error: reason }));
  pending.clear();
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
      // No longer "re-run the bridge": the client re-reads the sidecar pair
      // after every connect failure and rebuilds the socket when the server
      // comes back as a different generation (#3078 A-3). This says what is
      // happening so a run that never recovers is still diagnosable.
      console.error("\nConnect error: bearer token rejected — waiting for the server to publish a new one.\n");
      return;
    }
    console.error(`\nConnect error: ${msg}`);
  });
}
