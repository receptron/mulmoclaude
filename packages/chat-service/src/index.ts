// @package-contract — see ./types.ts
//
// Factory for the transport chat bridge. `createChatService(deps)`
// returns:
//   - an Express `Router` for the legacy HTTP transport
//   - an `attachSocket(httpServer)` helper that mounts the socket.io
//     transport at `/ws/chat` (Phase A of #268)
//   - the shared `relay` function both transports dispatch through
//   - `pushToBridge(transportId, chatId, message)` for server→bridge
//     async push (Phase B of #268). Before `attachSocket` is called
//     pushes go straight to the in-memory queue; once a bridge is
//     connected they emit live and the queue drains on join.
//
// All host-app dependencies arrive via `deps`; the module has no
// direct imports from `../routes/…`, `../roles.js`,
// `../session-store/…`, or `../logger/…` so it can be lifted into a
// standalone npm package without internal edits. See #269 / #305.

import type http from "http";
import { Router } from "express";
import type { Request, Response } from "express";
import { CHAT_SERVICE_ROUTES } from "@mulmobridge/protocol";
import { createChatStateStore, isSafeSessionId } from "./chat-state.js";
import { createCommandHandler } from "./commands.js";
import { createRelay } from "./relay.js";
import type { RelayFn } from "./relay.js";
import { createPushQueue } from "./push-queue.js";
import { attachChatSocket } from "./socket.js";
import type { PushFn } from "./socket.js";
import type { ChatServiceDeps } from "./types.js";

// ── Types ────────────────────────────────────────────────────

interface ChatRequestBody {
  text: string;
}

interface ChatRequestParams {
  transportId: string;
  externalChatId: string;
}

interface ConnectRequestBody {
  chatSessionId: string;
}

interface ConnectRequestParams {
  transportId: string;
  externalChatId: string;
}

export interface ChatService {
  router: Router;
  /** Relay used by the HTTP router. Exposed so alternate transports
   *  or tests can share the same flow without going through HTTP. */
  relay: RelayFn;
  /** Mount the socket.io transport at `/ws/chat` on the host HTTP server. */
  attachSocket(httpServer: http.Server): void;
  /** Server → bridge async push (Phase B of #268). Safe to call
   *  before `attachSocket`: the message is queued and flushes on
   *  the next bridge connection for that transport. */
  pushToBridge: PushFn;
  /** Subscribe an IN-PROCESS bridge to this transport's pushes (#3080).
   *  Returns the unsubscribe function. An in-process bridge is always live, so
   *  its pushes are never queued. */
  registerInProcessBridge(transportId: string, handler: (event: { chatId: string; message: string }) => void): () => void;
}

// Inlined (not imported from `../utils/httpError.js`) so the module
// has no outbound dependency on the host app's utility modules.
// See `@package-contract` in ./types.ts.
const badRequest = (res: Response, error: string) => res.status(400).json({ error });
const notFound = (res: Response, error: string) => res.status(404).json({ error });

// ── Factory ──────────────────────────────────────────────────

export function createChatService(deps: ChatServiceDeps): ChatService {
  const { startChat, onSessionEvent, loadAllRoles, getRole, defaultRoleId, tokenProvider, authorizeToken } = deps;
  const logger = deps.logger;
  const store = createChatStateStore({
    transportsDir: deps.transportsDir,
    logger,
  });
  const handleCommand = createCommandHandler({
    loadAllRoles,
    getRole,
    resetChatState: store.resetChatState,
    connectSession: store.connectSession,
    listSessions: deps.listSessions,
    getSessionHistory: deps.getSessionHistory,
    listRegisteredSkills: deps.listRegisteredSkills,
  });
  const relay = createRelay({
    store,
    handleCommand,
    startChat,
    onSessionEvent,
    getRole,
    defaultRoleId,
    logger,
  });
  const queue = createPushQueue();

  // Until `attachSocket` runs, `livePush` is null and pushes go
  // straight to the queue. After attach, this reference flips to
  // the real emitter so live bridges get the message immediately.
  // The queue is shared with the socket layer so any pushes
  // enqueued during the pre-attach window flush on first connect.
  let livePush: PushFn | null = null;

  // In-process bridges (#3080). Keyed by transportId, at most one each: two
  // bridges claiming one transportId is what #3079 exists to stop, and the
  // registry refuses the second rather than silently fanning a reply out twice.
  const inProcessBridges = new Map<string, (event: { chatId: string; message: string }) => void>();

  const registerInProcessBridge = (transportId: string, handler: (event: { chatId: string; message: string }) => void): (() => void) => {
    if (inProcessBridges.has(transportId)) {
      throw new Error(`an in-process bridge is already registered for transport "${transportId}"`);
    }
    inProcessBridges.set(transportId, handler);
    return () => {
      if (inProcessBridges.get(transportId) === handler) inProcessBridges.delete(transportId);
    };
  };

  const pushToBridge: PushFn = (transportId, chatId, message) => {
    // An in-process bridge is in this very process, so it is live by
    // construction — deliver and return rather than consulting the socket
    // layer, whose miss path would queue a message that has been delivered.
    const inProcess = inProcessBridges.get(transportId);
    if (inProcess) {
      try {
        // Runs on WHATEVER stack called `pushToBridge` — a route handler, a
        // scheduler tick. A socket bridge cannot reach us here because its
        // handler runs in its own process; an in-process one can, so the
        // isolation has to be written rather than assumed.
        inProcess({ chatId, message });
      } catch (err) {
        logger.error("chat-service", "in-process bridge push handler threw", {
          transportId,
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (livePush) {
      livePush(transportId, chatId, message);
      return;
    }
    queue.enqueue(transportId, { chatId, message, enqueuedAt: Date.now() });
    logger.info("chat-service", "push queued (socket not attached yet)", {
      transportId,
      chatId,
      queueSize: queue.sizeFor(transportId),
    });
  };

  const router = Router();

  // POST /api/transports/:transportId/chats/:externalChatId — send text, get a reply.
  router.post(CHAT_SERVICE_ROUTES.message, async (req: Request<ChatRequestParams, unknown, ChatRequestBody>, res: Response) => {
    const { transportId, externalChatId } = req.params;
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";

    if (!text) {
      badRequest(res, "text is required");
      return;
    }

    const result = await relay({ transportId, externalChatId, text });

    if (result.kind === "ok") {
      res.json({ reply: result.reply });
      return;
    }
    res.status(result.status).json({ reply: result.message });
  });

  // POST /api/transports/:transportId/chats/:externalChatId/connect —
  // reassign the active session pointer for a transport chat.
  router.post(CHAT_SERVICE_ROUTES.connect, async (req: Request<ConnectRequestParams, unknown, ConnectRequestBody>, res: Response) => {
    const { transportId, externalChatId } = req.params;
    const chatSessionId = typeof req.body?.chatSessionId === "string" ? req.body.chatSessionId.trim() : "";

    if (!chatSessionId) {
      badRequest(res, "chatSessionId is required");
      return;
    }
    // Reject hostile / malformed sessionIds at the entry so they can't be
    // persisted into transport state. Without this gate a caller could POST
    // `{"chatSessionId": "../../etc/x"}`, the value would land in the state
    // file, and a later `/history` command would read it back and hand it to
    // `readSessionJsonl` — whose backing reader is documented as "internal
    // fixed paths only, no `..` traversal guard". Also defended inside
    // `connectSession` for defense-in-depth (issue #1896 follow-up to #1895).
    if (!isSafeSessionId(chatSessionId)) {
      badRequest(res, "chatSessionId has an unsafe format");
      return;
    }

    // Resolve the target session's role BEFORE calling connectSession so the
    // persisted state's `roleId` tracks the new session's role — otherwise the
    // next relay's `startChat` would resume the new session under the previous
    // role (#1888 / #1894). Three fallback paths all treated as "preserve
    // existing role":
    //   1. No `getSessionRole` wired at all (backward compat for older hosts).
    //   2. Resolver returns null (unknown / corrupt session metadata).
    //   3. Resolver throws (host bug / timeout / IO error) — catch here so
    //      the route can never bubble the failure as a 500 to the API caller
    //      (codex review on #1895; the MulmoClaude host's resolver is
    //      hardened but the DI contract doesn't require hosts to be).
    let resolvedRole: string | null = null;
    if (deps.getSessionRole) {
      try {
        resolvedRole = await deps.getSessionRole(chatSessionId);
      } catch (err) {
        logger.warn("chat-service", "getSessionRole threw; falling back to preserving existing role", {
          chatSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        resolvedRole = null;
      }
    }
    const updated = await store.connectSession(transportId, externalChatId, chatSessionId, resolvedRole ?? undefined);
    if (!updated) {
      notFound(res, "No chat state found for this transport");
      return;
    }

    res.json({ ok: true });
  });

  return {
    router,
    relay,
    attachSocket: (httpServer) => {
      const handle = attachChatSocket(httpServer, {
        relay,
        queue,
        logger,
        tokenProvider,
        authorizeToken,
      });
      livePush = handle.pushToBridge;
    },
    pushToBridge,
    registerInProcessBridge,
  };
}

export type { Attachment, ChatServiceDeps, StartChatFn, StartChatParams, OnSessionEventFn } from "./types.js";

export { writeFileAtomic } from "./atomic-write.js";
