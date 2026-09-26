// @mulmobridge/protocol — shared constants and interfaces for the
// MulmoBridge chat protocol.
//
// This package defines the wire-level contract between:
//   - The chat-service (server-side socket.io + REST)
//   - External bridges (CLI, Telegram, future platforms)
//
// No runtime dependencies. Types, constants, and small pure helpers.

export { EVENT_TYPES, type EventType, GENERATION_KINDS, type GenerationKind, type GenerationEvent, type PendingGeneration, generationKey } from "./events.js";
export { CHAT_SOCKET_PATH, CHAT_SOCKET_EVENTS, type ChatSocketEvent, type BridgeHandshakeAuth, type BridgeOptions } from "./socket.js";
export { type Attachment } from "./attachment.js";
export { CHAT_SERVICE_ROUTES } from "./routes.js";
export {
  DEFAULT_REPLY_TIMEOUT_MS,
  ACK_TIMEOUT_MARGIN_MS,
  MAX_REPLY_TIMEOUT_MS,
  type ReplyTimeoutResolution,
  resolveReplyTimeoutMs,
  ackTimeoutMsFor,
} from "./replyTimeout.js";
