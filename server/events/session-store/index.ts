// Server-side session state store. Replaces the lightweight
// `server/sessions.ts` SSE-send registry with a pub/sub-backed
// store that holds authoritative state per chat session. Multiple
// clients can subscribe to the same session channel and receive
// identical events.

import { appendFile } from "fs/promises";
import type { IPubSub } from "../pub-sub/index.js";
import { PUBSUB_CHANNELS, sessionChannel, type SessionsChannelPayload } from "../../../src/config/pubsubChannels.js";
import { log } from "../../system/logger/index.js";
import { env } from "../../system/env.js";
import { updateHasUnread } from "../../utils/files/session-io.js";
import { EVENT_TYPES, GENERATION_KINDS, type GenerationKind, type PendingGeneration, generationKey } from "../../../src/types/events.js";
import { ONE_HOUR_MS, ONE_MINUTE_MS } from "../../utils/time.js";
import { errorMessage } from "../../utils/errors.js";
import { hasStringProp, isRecord } from "../../utils/types.js";
import type { ToolResult } from "gui-chat-protocol";

// ── Types ──────────────────────────────────────────────────────

export interface ToolCallHistoryItem {
  toolUseId: string;
  toolName: string;
  args: unknown;
  timestamp: number;
  result?: string | undefined;
  error?: string | undefined;
}

export interface ServerSession {
  chatSessionId: string;
  roleId: string;
  isRunning: boolean;
  hasUnread: boolean;
  statusMessage: string;
  toolCallHistory: ToolCallHistoryItem[];
  resultsFilePath: string;
  startedAt: string;
  updatedAt: string;
  /** Kills the spawned Claude CLI process for this session. */
  abortRun?: (() => void) | undefined;
  /**
   * In-flight background generations keyed by `generationKey(kind, filePath, key)`.
   * The value carries the decomposed (kind, filePath, key) so consumers never
   * have to parse the opaque composite key back out. Non-empty means the
   * session has ongoing work even when `isRunning` (agent turn) is false —
   * used to keep the busy indicator lit across view navigation.
   */
  pendingGenerations: Record<string, PendingGeneration>;
  /**
   * Per-session FIFO chain for jsonl appends. `persistToolCallEvent`
   * (fire-and-forget from `applyEventToSession`) and `pushToolResult`
   * (awaited) both enqueue here so a `tool_result` can't race ahead of
   * its preceding `tool_call` to disk. Codex review on PR #1101.
   */
  jsonlWriteQueue: Promise<void>;
  /**
   * The most recent ToolResult per `toolName`, for plugins whose next call
   * has to edit what the previous one produced.
   *
   * In MulmoClaude a plugin's `execute()` never runs in the client — every
   * call arrives at `/api/*`, where the context used to be empty, so an
   * `add_node` had no map to add to (#2754). The push path below is the only
   * writer of tool results, which is why the cache lives on it.
   *
   * Bounded by the number of tools, not by session length: one entry each,
   * overwritten. Holds only results that carried `data` — the bridge pushes
   * nothing else — so "latest" means "latest RENDERED result".
   *
   * A Map rather than a plain object because the key is a tool name off the
   * wire: `obj["__proto__"] = x` reassigns the prototype instead of storing,
   * and `obj["constructor"]` reads back the `Object` function rather than
   * `undefined` — so a lookup could hand a plugin something that is not a
   * ToolResult at all.
   */
  latestToolResults: Map<string, ToolResult>;
}

// ── Constants ──────────────────────────────────────────────────

const IDLE_EVICTION_MS = ONE_HOUR_MS;
const EVICTION_CHECK_INTERVAL_MS = 5 * ONE_MINUTE_MS;

// ── Store ──────────────────────────────────────────────────────

const store = new Map<string, ServerSession>();
/**
 * Parallel pending-generation tracking for sessions that aren't in the
 * in-memory store. The MulmoScript view can be opened on a session
 * whose full ServerSession entry never existed or was evicted after
 * idle timeout — we still want to mark unread and fire
 * notifySessionsChanged when the work drains. Cleared on drain.
 */
const storelessPending = new Map<string, Set<string>>();
let pubsub: IPubSub | null = null;
let evictionTimer: ReturnType<typeof setInterval> | null = null;

export function initSessionStore(pubSubInstance: IPubSub): void {
  pubsub = pubSubInstance;
  if (evictionTimer) clearInterval(evictionTimer);
  evictionTimer = setInterval(evictIdleSessions, EVICTION_CHECK_INTERVAL_MS);
}

// ── Session lifecycle ──────────────────────────────────────────

export function getSession(chatSessionId: string): ServerSession | undefined {
  return store.get(chatSessionId);
}

export function getOrCreateSession(
  chatSessionId: string,
  opts: {
    roleId: string;
    resultsFilePath: string;
    startedAt: string;
    updatedAt: string;
    hasUnread?: boolean | undefined;
  },
): ServerSession {
  const existing = store.get(chatSessionId);
  if (existing) {
    existing.updatedAt = opts.updatedAt;
    return existing;
  }
  const session: ServerSession = {
    chatSessionId,
    roleId: opts.roleId,
    isRunning: false,
    hasUnread: opts.hasUnread ?? false,
    statusMessage: "",
    toolCallHistory: [],
    resultsFilePath: opts.resultsFilePath,
    startedAt: opts.startedAt,
    updatedAt: opts.updatedAt,
    pendingGenerations: {},
    jsonlWriteQueue: Promise.resolve(),
    latestToolResults: new Map(),
  };
  store.set(chatSessionId, session);
  return session;
}

/** Chain a jsonl append onto this session's write queue so concurrent
 *  callers see FIFO disk order. Returns the promise that resolves
 *  when THIS append completes. The queue's tail is updated even on
 *  rejection so a single failed append doesn't permanently poison
 *  ordering for the rest of the session.
 *
 *  Exported for unit tests; the run-time hot path uses it from
 *  `applyEventToSession` and `pushToolResult`. */
export function enqueueJsonlAppend(session: ServerSession, line: string): Promise<void> {
  const tail = session.jsonlWriteQueue.then(
    () => appendFile(session.resultsFilePath, line),
    () => appendFile(session.resultsFilePath, line),
  );
  session.jsonlWriteQueue = tail.then(
    () => undefined,
    () => undefined,
  );
  return tail;
}

function removeSession(chatSessionId: string, payload?: SessionsChannelPayload): void {
  store.delete(chatSessionId);
  notifySessionsChanged(payload);
}

// Public wrapper used by the sessions delete route — drops both the
// in-memory entry and any storeless pending-generation tracking, then
// publishes a `deletedIds` payload so subscribers can purge their
// local caches (cursor diffs don't carry deletions).
export function evictSession(chatSessionId: string): void {
  storelessPending.delete(chatSessionId);
  removeSession(chatSessionId, { deletedIds: [chatSessionId] });
}

/** Public wrapper around `notifySessionsChanged` — used by route
 *  handlers that mutate session meta directly (e.g. bookmark) so the
 *  sidebar refetches via the standard `sessions` channel. */
export function publishSessionsChanged(payload?: SessionsChannelPayload): void {
  notifySessionsChanged(payload);
}

// ── State mutations (publish to pub/sub) ───────────────────────

/** Mark a session as running. Rejects if already running (409). */
export function beginRun(chatSessionId: string, abortRun: () => void): boolean {
  const session = store.get(chatSessionId);
  if (!session) return false;
  if (session.isRunning) return false;
  session.isRunning = true;
  session.statusMessage = "";
  session.toolCallHistory = [];
  session.abortRun = abortRun;
  session.updatedAt = new Date().toISOString();
  notifySessionsChanged();
  return true;
}

/** Mark a session as finished. Sets hasUnread = true. */
export function endRun(chatSessionId: string): void {
  const session = store.get(chatSessionId);
  if (!session) return;
  session.isRunning = false;
  session.hasUnread = true;
  session.statusMessage = "";
  session.abortRun = undefined;
  session.updatedAt = new Date().toISOString();
  // Same fire-and-forget contract as the other unread writes: the in-memory
  // flag above is what the UI reads, so a failed persist must not break the
  // finish path.
  persistHasUnread(chatSessionId, true).catch(() => {});
  publishToSessionChannel(chatSessionId, {
    type: EVENT_TYPES.sessionFinished,
  });
  notifySessionsChanged();
}

/** Cancel a running session by killing the child process. */
export function cancelRun(chatSessionId: string): boolean {
  const session = store.get(chatSessionId);
  if (!session?.isRunning || !session.abortRun) return false;
  session.abortRun();
  return true;
}

/** Clear the unread flag (called when a client views the session).
 *  Awaits the disk write so the caller can respond only after the
 *  flag is actually persisted — avoids the race where the client
 *  refetches before the write lands and sees the stale value. */
export async function markRead(chatSessionId: string): Promise<void> {
  const session = store.get(chatSessionId);
  if (!session) {
    // No in-memory session — still persist to disk so the flag is
    // cleared for the next server restart / session listing.
    await persistHasUnread(chatSessionId, false);
    return;
  }
  if (!session.hasUnread) return;
  session.hasUnread = false;
  await persistHasUnread(chatSessionId, false);
  notifySessionsChanged();
}

// ── Event publishing ───────────────────────────────────────────

/** Publish an agent event to the session's channel + update store. */
export function pushSessionEvent(chatSessionId: string, event: Record<string, unknown>): void {
  const type = hasStringProp(event, "type") ? event.type : undefined;
  const isGenerationEvent = type === EVENT_TYPES.generationStarted || type === EVENT_TYPES.generationFinished;

  // Non-generation events keep the pre-existing "store or drop"
  // behavior: toolCall / toolCallResult / status fire only during a
  // live agent turn (which always has a store entry), and
  // rolesUpdated / sessionFinished are equally tied to in-store
  // sessions. Publishing them for evicted sessions would broaden the
  // wire contract without a concrete need.
  //
  // Generation events are the exception — a plugin view (e.g.
  // MulmoScript) can kick off work on a session whose store entry
  // never existed or was evicted after idle timeout, and the client
  // subscription lives on the channel, not on any server-side
  // session object. We always deliver those so the UI can update.
  const session = store.get(chatSessionId);
  if (!session && !isGenerationEvent) return;
  publishToSessionChannel(chatSessionId, event);

  const generationDelta = resolveGenerationDelta(chatSessionId, type, event);
  if (generationDelta === "same") return;
  if (generationDelta === "started") {
    notifySessionsChanged();
    return;
  }

  // Drained: flag hasUnread, same semantics as endRun(). Clients
  // viewing the session clear it via markRead.
  if (session) {
    session.hasUnread = true;
    // Store is the source of truth, so the refetch already sees the
    // flag via `live.hasUnread` — the disk write is just a backstop
    // across server restarts and can stay fire-and-forget.
    persistHasUnread(chatSessionId, true).catch(() => {});
    notifySessionsChanged();
    return;
  }

  // Storeless: meta.hasUnread on disk is the ONLY place the flag lives.
  // If we notified before the write completed, the client's refetch
  // would read the stale pre-drain value. Sequence: persist, then
  // notify.
  persistHasUnread(chatSessionId, true)
    .catch(() => {})
    .then(() => notifySessionsChanged())
    // Terminal handler: the `.catch` above only covers the persist, so a throw
    // out of `notifySessionsChanged` would still escape. Same trade as the
    // agent route (see its BEHAVIOUR NOTE) — this used to bounce the whole
    // server through the process-level `unhandledRejection` handler; now an
    // unread-badge glitch stays a glitch. Rethrow here to go back to fail-fast.
    .catch((err: unknown) => log.warn("session-store", "unread notify failed", { error: String(err) }));
}

/**
 * Dispatch the event to whichever pending tracker the session has.
 * Returns the empty↔non-empty transition so the caller can decide
 * whether to flip hasUnread and notify.
 */
function resolveGenerationDelta(chatSessionId: string, type: string | undefined, event: Record<string, unknown>): GenerationDelta {
  const session = store.get(chatSessionId);
  if (session) return applyEventToSession(session, type, event);
  if (type === EVENT_TYPES.generationStarted || type === EVENT_TYPES.generationFinished) {
    return updateStorelessPending(chatSessionId, type, event);
  }
  return "same";
}

function updateStorelessPending(chatSessionId: string, type: string, event: Record<string, unknown>): GenerationDelta {
  const payload = parseGenerationPayload(event);
  if (!payload) {
    log.warn("session-store", "malformed generation event", {
      chatSessionId,
      type,
    });
    return "same";
  }
  const mapKey = generationKey(payload.kind, payload.filePath, payload.key);
  const existing = storelessPending.get(chatSessionId);
  const wasEmpty = !existing || existing.size === 0;

  if (type === EVENT_TYPES.generationStarted) {
    const set = existing ?? new Set<string>();
    set.add(mapKey);
    if (!existing) storelessPending.set(chatSessionId, set);
  } else if (existing) {
    existing.delete(mapKey);
    if (existing.size === 0) storelessPending.delete(chatSessionId);
  }

  const isEmpty = (storelessPending.get(chatSessionId)?.size ?? 0) === 0;
  if (wasEmpty === isEmpty) return "same";
  return isEmpty ? "drained" : "started";
}

/**
 * How a generation event affected the session's pendingGenerations set:
 *
 * - `started`: empty → non-empty (first generation in a quiet session)
 * - `drained`: non-empty → empty (last pending generation finished)
 * - `same`: no transition (parallel starts/finishes within a burst,
 *   or a non-generation event type)
 *
 * Callers use this to decide whether to fire `notifySessionsChanged()`
 * and whether to flip hasUnread on drain.
 */
type GenerationDelta = "started" | "drained" | "same";

/** Fields pulled off a validated generation event. */
interface GenerationPayload {
  kind: GenerationKind;
  filePath: string;
  key: string;
}

const GENERATION_KIND_VALUES: ReadonlySet<string> = new Set(Object.values(GENERATION_KINDS));

function isGenerationKind(value: unknown): value is GenerationKind {
  return typeof value === "string" && GENERATION_KIND_VALUES.has(value);
}

/**
 * Narrow an event's generation fields at runtime. The event arrives
 * as `Record<string, unknown>` so we can't trust its shape — validate
 * every field before handing back a typed struct. Unknown kinds or
 * missing fields return null; the caller should log + no-op.
 */
function parseGenerationPayload(event: Record<string, unknown>): GenerationPayload | null {
  const { kind, filePath, key } = event;
  if (!isGenerationKind(kind)) return null;
  if (typeof filePath !== "string" || typeof key !== "string") return null;
  return { kind, filePath, key };
}

// Persist a single `tool_call` event to the session jsonl. Mirrors
// the `tool_result` shape that `pushToolResult` already writes, so
// downstream parsers (and humans grepping the file for debugging)
// see a familiar event row. Opt-in via `PERSIST_TOOL_CALLS=1` —
// see plans/done/feat-persist-tool-calls.md for the rationale.
//
// Exported for unit tests; the run-time hot path stays inside
// `applyEventToSession` and goes through the per-session
// `jsonlWriteQueue` so a `tool_result` cannot race ahead of its
// preceding `tool_call` to disk (Codex review on #1101).
export function buildToolCallLine(event: Record<string, unknown>): string {
  return `${JSON.stringify({
    source: "agent",
    type: EVENT_TYPES.toolCall,
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    args: event.args,
    timestamp: Date.now(),
  })}\n`;
}

export async function persistToolCallEvent(resultsFilePath: string, event: Record<string, unknown>): Promise<void> {
  await appendFile(resultsFilePath, buildToolCallLine(event));
}

function applyEventToSession(session: ServerSession, type: string | undefined, event: Record<string, unknown>): GenerationDelta {
  if (type === EVENT_TYPES.toolCall) {
    recordToolCall(session, event);
  } else if (type === EVENT_TYPES.toolCallResult) {
    applyToolCallResult(session, event);
  } else if (type === EVENT_TYPES.status) {
    // Empty string is the same "no status" value `beginRun` / `endRun` write,
    // so a message-less event can't leave a non-string in a `string` field.
    session.statusMessage = hasStringProp(event, "message") ? event.message : "";
    // No notifySessionsChanged() here — status updates are high-frequency
    // and flow to subscribed clients via the session.<id> channel directly.
  } else if (type === EVENT_TYPES.generationStarted || type === EVENT_TYPES.generationFinished) {
    return updatePendingGenerations(session, type, event);
  }
  return "same";
}

/**
 * Append one validated `tool_call` to the session history. `toolUseId`
 * and `toolName` identify the call for every later `tool_call_result`
 * lookup, so an event missing either is logged and dropped rather than
 * stored as a history row that nothing can ever match.
 */
function recordToolCall(session: ServerSession, event: Record<string, unknown>): void {
  if (!hasStringProp(event, "toolUseId") || !hasStringProp(event, "toolName")) {
    log.warn("session-store", "malformed tool_call event", { chatSessionId: session.chatSessionId });
    return;
  }
  session.toolCallHistory.push({
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    args: event.args,
    timestamp: Date.now(),
  });
  if (!env.persistToolCalls) return;
  // Fire-and-forget: a write failure shouldn't block the live
  // SSE flow. The in-memory `toolCallHistory` is the
  // authoritative copy during the run; the jsonl line is a
  // debug aid that survives refresh.
  //
  // Goes through `enqueueJsonlAppend` so this append precedes
  // any `tool_result` for the same toolUseId — `pushToolResult`
  // also enqueues, and the queue is FIFO. Without the queue, the
  // awaited `tool_result` could hit disk before the unawaited
  // `tool_call`, and a downstream reader assuming call-before-
  // result ordering would mis-associate events.
  enqueueJsonlAppend(session, buildToolCallLine(event)).catch((err: unknown) => {
    log.warn("session-store", "persist tool_call failed (non-fatal)", {
      chatSessionId: session.chatSessionId,
      error: errorMessage(err),
    });
  });
}

function applyToolCallResult(session: ServerSession, event: Record<string, unknown>): void {
  const entry = session.toolCallHistory.find((historyEntry) => historyEntry.toolUseId === event.toolUseId);
  if (!entry) return;
  entry.result = hasStringProp(event, "content") ? event.content : undefined;
}

function updatePendingGenerations(session: ServerSession, type: string, event: Record<string, unknown>): GenerationDelta {
  const payload = parseGenerationPayload(event);
  if (!payload) {
    log.warn("session-store", "malformed generation event", {
      chatSessionId: session.chatSessionId,
      type,
    });
    return "same";
  }
  const mapKey = generationKey(payload.kind, payload.filePath, payload.key);
  const wasEmpty = Object.keys(session.pendingGenerations).length === 0;

  if (type === EVENT_TYPES.generationStarted) {
    session.pendingGenerations[mapKey] = payload;
  } else {
    Reflect.deleteProperty(session.pendingGenerations, mapKey);
  }

  const isEmpty = Object.keys(session.pendingGenerations).length === 0;
  if (wasEmpty === isEmpty) return "same";
  return isEmpty ? "drained" : "started";
}

/**
 * Convenience wrapper for plugin routes that run long async jobs.
 * Publishes a generationStarted or generationFinished event on the
 * session channel. Safely no-ops when chatSessionId is missing — lets
 * callers that aren't inside a session context use the same routes.
 */
export function publishGeneration(
  chatSessionId: string | undefined,
  kind: GenerationKind,
  filePath: string,
  key: string,
  finished: boolean,
  error?: string,
): void {
  if (!chatSessionId) return;
  const event: Record<string, unknown> = {
    type: finished ? EVENT_TYPES.generationFinished : EVENT_TYPES.generationStarted,
    kind,
    filePath,
    key,
  };
  if (error) event.error = error;
  pushSessionEvent(chatSessionId, event);
}

export type PushToolResultOutcome = { kind: "skipped"; reason: string } | { kind: "processed" };

/** Persist a tool_result to JSONL, then publish to the session channel.
 *  Routes through the session's FIFO `jsonlWriteQueue` so a result
 *  can't beat its preceding `tool_call` to disk under
 *  `PERSIST_TOOL_CALLS=1` (Codex review on #1101). */
const TOOL_RESULT_STRING_FIELDS = ["toolName", "uuid", "title", "action", "instructions"] as const;
const TOOL_RESULT_BOOLEAN_FIELDS = ["instructionsRequired", "updating", "cancelled"] as const;

/** Rebuild a `ToolResult` from a pushed payload, field by field.
 *
 *  Reconstructed rather than asserted: what arrives is a JSON body, and casting
 *  it into the type would let `{ message: 42 }` through as a string. Every field
 *  the interface declares is covered, so a consumer reading this back loses
 *  nothing it could legitimately expect.
 *
 *  `message` is the one required field, so a payload without a usable one gets
 *  `""` rather than being dropped — the caller wants the `data`, and a missing
 *  narration is no reason to withhold it. */
function toToolResult(value: Record<string, unknown>): ToolResult {
  const result: ToolResult = { message: typeof value.message === "string" ? value.message : "" };
  for (const field of TOOL_RESULT_STRING_FIELDS) {
    const found = value[field];
    if (typeof found === "string") result[field] = found;
  }
  for (const field of TOOL_RESULT_BOOLEAN_FIELDS) {
    const found = value[field];
    if (typeof found === "boolean") result[field] = found;
  }
  if (value.data !== undefined) result.data = value.data;
  if (value.jsonData !== undefined) result.jsonData = value.jsonData;
  if (isRecord(value.viewState)) result.viewState = value.viewState;
  return result;
}

/** Remember this result as the latest for its tool, when it names one.
 *
 *  The bridge stamps `toolName` itself and overrides whatever a handler put
 *  there, so it can be trusted. A result without one is still persisted and
 *  published — it just cannot be looked up by tool, which is better than
 *  filing it under a key the next edit might read. */
function rememberLatestToolResult(session: ServerSession, result: unknown): void {
  if (!hasStringProp(result, "toolName")) return;
  session.latestToolResults.set(result.toolName, toToolResult(result));
}

/** The most recent RENDERED result for one tool in one session, or null.
 *
 *  "Rendered" because the bridge only pushes results that carried `data`;
 *  a narrate-only call never reaches this cache. Lives in memory only —
 *  a restart loses it, which is the cost of not re-reading the JSONL. */
export function latestToolResult(chatSessionId: string, toolName: string): ToolResult | null {
  return store.get(chatSessionId)?.latestToolResults.get(toolName) ?? null;
}

export async function pushToolResult(chatSessionId: string, result: unknown): Promise<PushToolResultOutcome> {
  const session = store.get(chatSessionId);
  if (!session) {
    // The MCP bridge does not read the `ok` flag we return, so a dropped push
    // is otherwise invisible: the tool call still reports success to the LLM
    // and the user simply sees no view (#3055). The realistic cause is a
    // result arriving at a DIFFERENT server than the one running the session —
    // two instances against one workspace, the second one walked off a busy
    // port — so name the session rather than just counting the drop.
    log.warn("session-store", "tool result dropped — no such session in this server's store (is a second instance running?)", {
      chatSessionId,
      toolName: hasStringProp(result, "toolName") ? result.toolName : "unknown",
    });
    return { kind: "skipped", reason: "unknown session" };
  }

  rememberLatestToolResult(session, result);
  await enqueueJsonlAppend(
    session,
    `${JSON.stringify({
      source: "tool",
      type: EVENT_TYPES.toolResult,
      result,
    })}\n`,
  );
  publishToSessionChannel(chatSessionId, {
    type: EVENT_TYPES.toolResult,
    result,
  });
  return { kind: "processed" };
}

// ── Query helpers ──────────────────────────────────────────────

export function getActiveSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const [chatSessionId, session] of store) {
    if (session.isRunning) ids.add(chatSessionId);
  }
  return ids;
}

// ── In-process session event listeners ────────────────────────

type SessionEventListener = (event: Record<string, unknown>) => void;
const sessionListeners = new Map<string, Set<SessionEventListener>>();

/**
 * Subscribe to session events in-process (no WebSocket needed).
 * Returns an unsubscribe function.
 */
export function onSessionEvent(chatSessionId: string, listener: SessionEventListener): () => void {
  let listeners = sessionListeners.get(chatSessionId);
  if (!listeners) {
    listeners = new Set();
    sessionListeners.set(chatSessionId, listeners);
  }
  listeners.add(listener);
  const captured = listeners;
  return () => {
    captured.delete(listener);
    if (captured.size === 0) sessionListeners.delete(chatSessionId);
  };
}

// ── Internal helpers ───────────────────────────────────────────

async function persistHasUnread(chatSessionId: string, hasUnread: boolean): Promise<void> {
  try {
    await updateHasUnread(chatSessionId, hasUnread);
  } catch (err) {
    // updateHasUnread already no-ops when meta is missing (ENOENT is
    // handled internally). Any error reaching here is unexpected.
    log.warn("session-store", "persistHasUnread failed", {
      chatSessionId,
      hasUnread,
      error: String(err),
    });
  }
}

function publishToSessionChannel(chatSessionId: string, data: Record<string, unknown>): void {
  pubsub?.publish(sessionChannel(chatSessionId), data);
  const listeners = sessionListeners.get(chatSessionId);
  if (listeners) {
    for (const listener of listeners) {
      listener(data);
    }
  }
}

/** Notify all clients that session state has changed. Empty payload
 *  is a "refetch" hint; `deletedIds` lets subscribers prune their
 *  local caches without a full refetch (cursor diffs don't carry
 *  deletions). */
function notifySessionsChanged(payload: SessionsChannelPayload = {}): void {
  pubsub?.publish(PUBSUB_CHANNELS.sessions, payload);
}

function evictIdleSessions(): void {
  const now = Date.now();
  for (const [chatSessionId, session] of store) {
    if (session.isRunning) continue;
    const age = now - new Date(session.updatedAt).getTime();
    if (age > IDLE_EVICTION_MS) {
      log.info("session-store", "evicting idle session", {
        chatSessionId,
      });
      removeSession(chatSessionId);
    }
  }
}

/**
 * Test-only: clear all in-memory state so a test suite can start
 * fresh without reloading the module.
 */
export function __resetForTests(): void {
  store.clear();
  storelessPending.clear();
  pubsub = null;
  if (evictionTimer) {
    clearInterval(evictionTimer);
    evictionTimer = null;
  }
}
