// @package-contract
//
// This module is designed to be extractable as a standalone npm
// package (e.g. `@mulmoclaude/chat-service`) at any time. To keep
// that path open, the rules are:
//
//  1. NO raw imports from `../` outside this directory — all host
//     dependencies MUST be passed through `ChatServiceDeps`.
//  2. Types declared here are STRUCTURAL duplicates of what the
//     host app uses. They look like the real `Role` / `Logger` /
//     `StartChatParams` types so the same functions plug in, but
//     they are defined here so the package has no compile-time
//     link back to the host. Importing from a declared package
//     dependency is fine — `Attachment` comes from
//     `@mulmobridge/protocol` (already a runtime dep) rather than
//     being redeclared here (#2488).
//  3. When you add a new dependency, extend `ChatServiceDeps` and
//     thread it through the factory functions — do NOT reach out
//     to a module import. See #269 / #305 for the rationale.

import type { Attachment } from "@mulmobridge/protocol";

export type { Attachment };

export interface Role {
  id: string;
  name: string;
}

/** Structurally identical to `StructuredLogger` in `@mulmoclaude/common`, where
 *  the rest of that family was folded (#2486). Common is now a declared
 *  dependency (the token guard), so rule 2 would allow aliasing it; the
 *  declaration stays local so the public `Logger` type does not move as a side
 *  effect of an auth change. */
export interface Logger {
  error(prefix: string, message: string, data?: Record<string, unknown>): void;
  warn(prefix: string, message: string, data?: Record<string, unknown>): void;
  info(prefix: string, message: string, data?: Record<string, unknown>): void;
  debug(prefix: string, message: string, data?: Record<string, unknown>): void;
}

export interface StartChatParams {
  message: string;
  roleId: string;
  chatSessionId: string;
  /** Bridge-only legacy carrier for "the user picked this image".
   *  No in-tree bridge populates this today; the field stays on the
   *  type so external bridge clients on older protocol versions still
   *  type-check. Only workspace paths are accepted — `data:` URLs
   *  are no longer supported and the host app drops them with a
   *  warn. Bridges that need to ship raw bytes should use the
   *  modern `attachments[]` field with `{ mimeType, data }` entries;
   *  the host app persists those to `data/attachments/YYYY/MM/`
   *  server-side and rewrites them as path-bearing attachments
   *  before any other processing. */
  selectedImageData?: string;
  attachments?: Attachment[] | undefined;
  /** Session origin — application-defined (e.g. "human", "bridge") */
  origin?: string;
  /** Flat primitive bag forwarded from the bridge handshake. Chat-
   *  service sanitises to string / number / boolean values only
   *  before this point — nested objects are dropped at the socket
   *  boundary so a downstream merge can't reintroduce prototype-
   *  pollution. The host app is free to look up its own keys
   *  (e.g. `defaultRole`). Empty object when the bridge didn't
   *  send any. */
  bridgeOptions?: Readonly<Record<string, string | number | boolean>> | undefined;
}

export type StartChatResult = { kind: "started"; chatSessionId: string } | { kind: "error"; error: string; status?: number };

export type StartChatFn = (params: StartChatParams) => Promise<StartChatResult>;

export type SessionEventListener = (event: Record<string, unknown>) => void;

export type OnSessionEventFn = (sessionId: string, listener: SessionEventListener) => () => void;

/** Summary of a chat session — returned by listSessions. */
export interface SessionSummary {
  id: string;
  roleId: string;
  preview: string;
  updatedAt: string;
}

/** List recent sessions (paged). Backs the `/sessions` bridge command. */
export type ListSessionsFn = (opts: { limit: number; offset: number }) => Promise<{ sessions: SessionSummary[]; total: number }>;

/** Recent messages in a session (paged, newest-first). Backs `/history`. */
export type GetSessionHistoryFn = (
  sessionId: string,
  opts: { limit: number; offset: number },
) => Promise<{ messages: Array<{ source: string; text: string }>; total: number }>;

export interface ChatServiceDeps {
  /** Relay a user turn into the agent loop. */
  startChat: StartChatFn;
  /** Subscribe to a session's event stream; returns an unsubscribe function. */
  onSessionEvent: OnSessionEventFn;
  /** All roles (built-in + custom). */
  loadAllRoles: () => Role[];
  /** Look up a single role by id; MUST fall back to default if unknown. */
  getRole: (roleId: string) => Role;
  /** Id used when a fresh transport chat has no role selected yet. */
  defaultRoleId: string;
  /** Absolute path to the transports workspace dir (one subdir per transportId). */
  transportsDir: string;
  logger: Logger;
  /**
   * Returns the current bearer token the `/ws/chat` handshake must carry, or
   * null while auth is not bootstrapped yet — every handshake is refused until
   * it returns one. Required: a chat socket cannot be opened without the
   * check. See `attachChatSocket` in ./socket.ts.
   */
  tokenProvider: () => string | null;
  /**
   * Optional: decides which `/ws/chat` handshake tokens pass, replacing the
   * `tokenProvider` comparison — for a host that accepts more than one token.
   * It must refuse everything while the host has no token of its own.
   */
  authorizeToken?: ((token: unknown) => boolean) | undefined;
  /**
   * List recent sessions from the server. Used by /sessions command.
   * Omit if session listing is not available (command will reply
   * "not available").
   */
  listSessions?: ListSessionsFn | undefined;
  /**
   * Get recent messages from a session. Used by /history command.
   * Returns newest-first array of {source, text} pairs.
   */
  getSessionHistory?: GetSessionHistoryFn | undefined;
  /**
   * Resolve the roleId a given session was started with. Used by the HTTP
   * `/connect` route so the persisted bridge state's role tracks the target
   * session's role after a repoint — same drift-fix as bridge `/switch`
   * (issue #1888 / #1894), but for API callers that only supply a session ID.
   * Returns null when the session isn't found OR when its role isn't known;
   * on null the route falls back to the previous "preserve current role"
   * behaviour (safe default). Omit this dep entirely to keep the old
   * session-id-only semantics.
   */
  getSessionRole?: (sessionId: string) => Promise<string | null>;
  /**
   * Return the skills the bridge command handler should expose. The
   * handler uses the result for two things:
   *   (1) Decide whether an unknown bridge slash command (e.g. `/foo`
   *       from Telegram) names a registered skill — only matching
   *       names are forwarded to the agent so the Claude CLI's
   *       slash-command resolver runs the skill. Non-matches stay a
   *       transport-level "Unknown command" reply.
   *   (2) Render a "Skills:" section in the bridge `/help` text and
   *       in the "Unknown command" fallback so a bridge user can
   *       discover what skills exist without leaving the chat.
   * When omitted, every unknown slash is rejected and `/help` shows
   * only the built-in commands.
   */
  listRegisteredSkills?: () => Promise<BridgeSkillSummary[]>;
}

/** Minimal skill info the bridge command handler needs to render the
 *  `/help` text and decide whether a slash command should be forwarded
 *  to the agent. Sourced from SKILL.md frontmatter on the host side. */
export interface BridgeSkillSummary {
  name: string;
  description: string;
}
