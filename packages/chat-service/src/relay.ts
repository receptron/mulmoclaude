// @package-contract — see ./types.ts
//
// Shared core of the bridge chat flow. HTTP (router) and socket.io
// transports both call the `RelayFn` this factory returns. DI-pure:
// all host-app concerns (state store, command handler, agent entry
// point, session events, role lookup, logger) arrive through
// `createRelay(deps)` so the module has no direct imports from the
// host.

import { EVENT_TYPES, resolveReplyTimeoutMs } from "@mulmobridge/protocol";
import type { ChatStateStore } from "./chat-state.js";
import type { CommandHandler } from "./commands.js";
import { createKeyedSerializer } from "./keyed-serializer.js";
import type { Attachment, Logger, OnSessionEventFn, Role, StartChatFn } from "./types.js";

// ── Types ────────────────────────────────────────────────────

export interface RelayParams {
  transportId: string;
  externalChatId: string;
  text: string;
  attachments?: Attachment[] | undefined;
  /** Flat primitive bag captured at handshake time (string /
   *  number / boolean values only — see socket.ts sanitiser).
   *  Forwarded to the host app's startChat callback as
   *  `bridgeOptions`. Empty when the bridge didn't send any.
   *  See plans/done/feat-bridge-options-passthrough.md. */
  bridgeOptions?: Readonly<Record<string, string | number | boolean>> | undefined;
  /** Called for each text chunk as the agent generates it. Used by
   *  the socket transport to stream text to the bridge in real time
   *  (Phase C of #268). */
  onChunk?: ((text: string) => void) | undefined;
}

export type RelayResult = { kind: "ok"; reply: string } | { kind: "error"; status: number; message: string };

export type RelayFn = (params: RelayParams) => Promise<RelayResult>;

export interface RelayDeps {
  store: ChatStateStore;
  handleCommand: CommandHandler;
  startChat: StartChatFn;
  onSessionEvent: OnSessionEventFn;
  getRole: (roleId: string) => Role;
  defaultRoleId: string;
  logger: Logger;
}

// ── Factory ──────────────────────────────────────────────────

export function createRelay(deps: RelayDeps): RelayFn {
  const serialize = createKeyedSerializer();

  return function relayMessage(params: RelayParams): Promise<RelayResult> {
    // Serialize every turn for one external chat. Without this, two
    // concurrent first messages each read "no state", create separate
    // sessions, and split the conversation across them (#1878). The
    // JSON pair is an unambiguous composite key for the two ids.
    const key = JSON.stringify([params.transportId, params.externalChatId]);
    return serialize.run(key, () => processRelayMessage(deps, params));
  };
}

async function processRelayMessage(deps: RelayDeps, params: RelayParams): Promise<RelayResult> {
  const { store, handleCommand, startChat, onSessionEvent, getRole, defaultRoleId, logger } = deps;
  const { transportId, externalChatId, attachments, bridgeOptions } = params;
  let { text } = params;

  // Log attachment summary (count + mimeTypes) — NEVER log raw
  // base64 data (performance, log size, information leak risk).
  const attachmentSummary = attachments
    ? {
        count: attachments.length,
        mimeTypes: attachments.map((a) => a.mimeType),
      }
    : undefined;
  logger.info("chat-service", "message received", {
    transportId,
    externalChatId,
    textLength: text.length,
    ...(attachmentSummary ? { attachments: attachmentSummary } : {}),
  });

  let chatState = await store.getChatState(transportId, externalChatId);
  if (!chatState) {
    // Only on FIRST contact do we honour `bridgeOptions.defaultRole`
    // — once the session exists, whatever role the user / command
    // handler settled on is the source of truth. An unknown role
    // id silently falls back to the host-app default (we log it so
    // a typo in the bridge's env var is discoverable).
    const resolved = resolveDefaultRole(bridgeOptions, getRole, defaultRoleId, logger, transportId);
    chatState = await store.resetChatState(transportId, externalChatId, resolved);
  }

  const commandResult = await handleCommand(text, transportId, chatState);
  if (commandResult) {
    // `forwardAs` means "reset/mutate state AND continue into the
    // agent with rewritten text" (see //{skill} shortcut). Without
    // it, short-circuit with the canned reply.
    if (!commandResult.forwardAs) {
      return { kind: "ok", reply: commandResult.reply };
    }
    if (commandResult.nextState) chatState = commandResult.nextState;
    text = commandResult.forwardAs;
  }

  const result = await startChat({
    message: text,
    roleId: chatState.roleId,
    chatSessionId: chatState.sessionId,
    attachments,
    origin: "bridge",
    // Host app may use other keys (e.g. a future `defaultModel`);
    // we forward the whole bag untouched.
    bridgeOptions,
  });

  if (result.kind === "error") {
    const status = result.status ?? 500;
    if (status === 409) {
      // Session busy — tell the bridge to retry. Keep the HTTP
      // response shape the old handler returned (status 409 on
      // the HTTP side, "ok" reply text on the socket side — both
      // layers decide how to serialise).
      return {
        kind: "ok",
        reply: "A previous message is still being processed. Please wait.",
      };
    }
    logger.error("chat-service", "startChat failed", {
      transportId,
      externalChatId,
      error: result.error,
    });
    return {
      kind: "error",
      status,
      message: `Error: ${result.error}`,
    };
  }

  try {
    const replyTimeoutMs = resolveBridgeReplyTimeout(bridgeOptions, logger, transportId);
    const reply = await collectAgentReply(onSessionEvent, chatState.sessionId, replyTimeoutMs, params.onChunk);
    await store.setChatState(transportId, {
      ...chatState,
      updatedAt: new Date().toISOString(),
    });
    return { kind: "ok", reply };
  } catch (err) {
    logger.error("chat-service", "reply collection failed", {
      transportId,
      externalChatId,
      error: String(err),
    });
    return {
      kind: "error",
      status: 500,
      message: "Error: failed to collect agent reply",
    };
  }
}

// ── Internals ────────────────────────────────────────────────

// Resolve the role id to seed a NEW bridge chat state with. Prefers
// `bridgeOptions.defaultRole` when the bridge sent one and it names
// a role the host app actually has. Falls back to the host-app
// default on absence / unknown id (with a warn log so an env-var
// typo is traceable). Exported for direct unit testing.
export function resolveDefaultRole(
  bridgeOptions: Readonly<Record<string, string | number | boolean>> | undefined,
  getRole: (roleId: string) => Role,
  fallbackRoleId: string,
  logger: Logger,
  transportId: string,
): string {
  const requested = bridgeOptions?.defaultRole;
  if (typeof requested !== "string" || requested.length === 0) return fallbackRoleId;
  // `getRole` on an unknown id silently returns the first built-in
  // role — compare ids to catch that before we commit to it.
  const resolved = getRole(requested);
  if (resolved.id !== requested) {
    logger.warn("chat-service", "bridge requested unknown default role; falling back", {
      transportId,
      requested,
      fallback: fallbackRoleId,
    });
    return fallbackRoleId;
  }
  return resolved.id;
}

// The bridge client reads the same option for its ack timer, so a bad value
// is warned about on both ends and both fall back to the same default.
function resolveBridgeReplyTimeout(bridgeOptions: RelayParams["bridgeOptions"], logger: Logger, transportId: string): number {
  const { replyTimeoutMs, warning } = resolveReplyTimeoutMs(bridgeOptions?.replyTimeoutMs);
  if (warning) logger.warn("chat-service", "bridge reply timeout option ignored", { transportId, warning });
  return replyTimeoutMs;
}

// Kept out of the factory closure so future packaging doesn't need
// to re-capture anything; `onSessionEvent` arrives as a plain param.
function collectAgentReply(onSessionEvent: OnSessionEventFn, chatSessionId: string, replyTimeoutMs: number, onChunk?: (text: string) => void): Promise<string> {
  return new Promise((resolve) => {
    const textChunks: string[] = [];

    const timer = setTimeout(() => {
      unsubscribe();
      resolve(textChunks.join("") || "The request timed out before a reply was generated.");
    }, replyTimeoutMs);

    const unsubscribe = onSessionEvent(chatSessionId, (event) => {
      const type = event.type as string;

      if (type === EVENT_TYPES.text) {
        const chunk = event.message as string;
        textChunks.push(chunk);
        onChunk?.(chunk);
      }

      if (type === EVENT_TYPES.error) {
        clearTimeout(timer);
        unsubscribe();
        resolve(`Error: ${event.message as string}`);
      }

      if (type === EVENT_TYPES.sessionFinished) {
        clearTimeout(timer);
        unsubscribe();
        resolve(textChunks.join("") || "The assistant completed the request but produced no text reply.");
      }
    });
  });
}
