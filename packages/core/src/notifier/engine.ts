// Notifier engine — single-process, two-file (active + history),
// single-channel. Host-agnostic: file paths, the atomic JSON writer,
// the pub-sub event sink, and the logger are all injected via
// `configureNotifier` + `setNotifierFilePaths` so MulmoClaude and
// MulmoTerminal share one notification engine over their own
// workspaces and pub-sub fabrics.
//
// API surface: publish / clear / cancel / get / listFor / listAll /
// listHistory (+ plugin-scoped variants). Mutations queue through a
// writing-flag + waiter-queue coordinator so concurrent callers can't
// race on the atomic write's rename. Reads bypass the queue (rename
// atomicity makes half-reads impossible) and trade strict
// linearisability for simpler code: the contract is "after
// `await publish(x)` resolves, subsequent reads see x" — which holds
// because `publish` awaits the persist before returning.
//
// `clear` / `cancel` push to history *before* removing from active.
// History persistence is best-effort: if it fails, the active write
// still wins and the failure is logged. Active is the source of
// truth; history is an audit aid.

import type { MinimalLogger } from "@mulmoclaude/common";
import { randomUUID } from "node:crypto";
import { loadActive, loadHistory, saveActive, saveHistory, type WriteJson } from "./store.js";
import { validatePublishInput } from "./validate.js";
import {
  HISTORY_CAP,
  type NotifierEntry,
  type NotifierEvent,
  type NotifierFile,
  type NotifierHistoryEntry,
  type NotifierSeverity,
  type PublishInput,
} from "./types.js";

export { NOTIFIER_LIMITS, validatePublishInput } from "./validate.js";

// ── Dependency injection ──────────────────────────────────────────

/** Minimal logger the engine needs. The host passes its structured
 *  logger; absent one, failures are swallowed (the engine never throws
 *  on a fan-out/persist-best-effort path). */
export type NotifierLogger = Pick<MinimalLogger, "warn" | "error">;

export interface NotifierConfig {
  /** Atomic JSON writer (the host's `writeJsonAtomic`). */
  writeJson: WriteJson;
  /** Fan-out sink — the host binds this to `pubsub.publish(channel, event)`. */
  publishEvent: (event: NotifierEvent) => void;
  /** Optional logger. */
  log?: NotifierLogger;
}

const NOOP_LOG: NotifierLogger = { warn: () => {}, error: () => {} };

let config: NotifierConfig | null = null;
let activeFilePath = "";
let historyFilePath = "";

function logger(): NotifierLogger {
  return config?.log ?? NOOP_LOG;
}

/** Wire the engine's I/O deps. Call once at startup, before the first
 *  mutation. Does NOT set file paths — those are set independently via
 *  `setNotifierFilePaths` so a host can bind production paths at module
 *  load and a test can override them without re-supplying the deps. */
export function configureNotifier(injected: NotifierConfig): void {
  config = injected;
}

// ── In-process event listeners ────────────────────────────────────
//
// Separate from the socket.io pubsub so server-side adapters (macOS
// push, future Encore) can react to state changes without going
// through a websocket round-trip. The host's pubsub is fan-out-only
// with no server-side subscribe, so this listener registry is the
// in-process equivalent. Listeners run synchronously inside `emit`,
// before the pubsub fan-out.

type NotifierEventListener = (event: NotifierEvent) => void;
const listeners: NotifierEventListener[] = [];

/** Register an in-process listener for engine events. Returns an
 *  unsubscribe function the caller can use during teardown. */
export function onEvent(listener: NotifierEventListener): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function emit(event: NotifierEvent): void {
  // In-process fan-out first. Each listener is wrapped: a throwing
  // listener must not poison the rest, and must not propagate out of
  // `processBatch` and strand the still-unsettled waiters (their
  // resolve/reject is called *after* this emit loop). Fan-out is
  // best-effort by contract — losing one subscriber must not lose
  // the write that already committed.
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      logger().error("in-process listener failed", { type: event.type, error: String(err) });
    }
  }
  if (!config) {
    logger().warn("emit before init", { type: event.type });
    return;
  }
  try {
    config.publishEvent(event);
  } catch (err) {
    logger().error("emit failed", { type: event.type, error: String(err) });
  }
}

// ── Write coordinator ─────────────────────────────────────────────

/** A mutation function applied to the in-memory state object during
 *  drain. Returns either:
 *
 *    - `null` — no state change (e.g., `clear` on an unknown id).
 *      The drainer skips the disk write and the emit if every
 *      mutation in a batch returned `null`.
 *    - `{ event, historyEntry? }` — state changed. The drainer emits
 *      the event after the active write succeeds, and prepends
 *      `historyEntry` to history (best-effort) when present.
 *
 *  Mutations MUST NOT modify state when returning `null`. Violating
 *  this invariant produces a write skip with stale on-disk state. */
type MutationOutcome = { event: NotifierEvent; historyEntry?: NotifierHistoryEntry } | null;
type Mutation = (state: NotifierFile) => MutationOutcome;

interface Waiter {
  mutate: Mutation;
  resolve: () => void;
  reject: (err: unknown) => void;
}

type MutationResult = { ok: true; outcome: MutationOutcome } | { ok: false; error: unknown };

let writing = false;
let waiters: Waiter[] = [];

/** Point the engine at its active/history files. Resets the write
 *  queue, so callers must not have in-flight mutations. The host calls
 *  this once with the workspace paths; tests call it per-case with temp
 *  files. */
export function setNotifierFilePaths(paths: { active: string; history: string }): void {
  activeFilePath = paths.active;
  historyFilePath = paths.history;
  writing = false;
  waiters = [];
}

/** Test-only: clear config + queue so each suite starts clean. */
export function resetNotifier(): void {
  config = null;
  activeFilePath = "";
  historyFilePath = "";
  writing = false;
  waiters = [];
  listeners.length = 0;
}

function requireWriteJson(): WriteJson {
  if (!config) throw new Error("notifier: configureNotifier() not called");
  return config.writeJson;
}

/** A waiter carried alongside the outcome of its own mutation, so settling can
 *  never pair a result with the wrong caller's promise. */
interface SettledMutation {
  waiter: Waiter;
  result: MutationResult;
}

function applyBatchMutations(batch: Waiter[], state: NotifierFile): SettledMutation[] {
  return batch.map((waiter) => {
    try {
      return { waiter, result: { ok: true, outcome: waiter.mutate(state) } };
    } catch (err) {
      return { waiter, result: { ok: false, error: err } };
    }
  });
}

function collectEvents(settled: SettledMutation[]): NotifierEvent[] {
  const events: NotifierEvent[] = [];
  for (const { result } of settled) {
    if (result.ok && result.outcome !== null) events.push(result.outcome.event);
  }
  return events;
}

function collectHistoryEntries(settled: SettledMutation[]): NotifierHistoryEntry[] {
  const entries: NotifierHistoryEntry[] = [];
  for (const { result } of settled) {
    if (result.ok && result.outcome !== null && result.outcome.historyEntry) {
      entries.push(result.outcome.historyEntry);
    }
  }
  return entries;
}

function settleBatch(settled: SettledMutation[]): void {
  // Resolves come AFTER any emits so subscribers see the event
  // before the caller's `await` returns.
  for (const { waiter, result } of settled) {
    if (result.ok) waiter.resolve();
    else waiter.reject(result.error);
  }
}

function rejectBatch(batch: Waiter[], err: unknown): void {
  for (const waiter of batch) waiter.reject(err);
}

async function persistHistory(newEntries: NotifierHistoryEntry[]): Promise<void> {
  const existing = await loadHistory(historyFilePath);
  // Newest-first ordering: a batch contains terminations in arrival
  // order; we want the last one to land at index 0 of history.
  const merged = [...newEntries.slice().reverse(), ...existing.entries].slice(0, HISTORY_CAP);
  await saveHistory(requireWriteJson(), historyFilePath, { entries: merged });
}

async function processBatch(batch: Waiter[]): Promise<void> {
  let state: NotifierFile;
  try {
    state = await loadActive(activeFilePath);
  } catch (err) {
    logger().error("load failed", { error: String(err) });
    rejectBatch(batch, err);
    return;
  }
  const settled = applyBatchMutations(batch, state);
  const events = collectEvents(settled);
  const historyEntries = collectHistoryEntries(settled);

  if (events.length > 0) {
    try {
      await saveActive(requireWriteJson(), activeFilePath, state);
    } catch (err) {
      logger().error("active write failed", { error: String(err) });
      rejectBatch(batch, err);
      return;
    }
    if (historyEntries.length > 0) {
      // Best-effort: active is the source of truth, history is an
      // audit aid. A failed history write is logged but doesn't
      // unwind the active commit.
      try {
        await persistHistory(historyEntries);
      } catch (err) {
        logger().error("history write failed", { error: String(err) });
      }
    }
    for (const event of events) emit(event);
  }
  settleBatch(settled);
}

async function drain(): Promise<void> {
  writing = true;
  try {
    while (waiters.length > 0) {
      const batch = waiters;
      waiters = [];
      await processBatch(batch);
    }
  } finally {
    writing = false;
  }
}

function enqueue(mutate: Mutation): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    waiters.push({ mutate, resolve, reject });
    if (!writing) void drain();
  });
}

function removeEntry(state: NotifierFile, entryId: string): NotifierFile["entries"] {
  // Object-rest excludes the key without invoking `delete`.
  const { [entryId]: __removed, ...remaining } = state.entries;
  return remaining;
}

function buildHistoryEntry(entry: NotifierEntry, terminalType: "cleared" | "cancelled"): NotifierHistoryEntry {
  return { ...entry, terminalType, terminalAt: new Date().toISOString() };
}

// ── Public API ────────────────────────────────────────────────────

/** The optional half of a publish input, with unset keys left OUT rather than
 *  written as `undefined` — an entry is persisted and re-read through JSON,
 *  where an unset field carries no key at all. */
function optionalPublishFields<TPluginData>(input: PublishInput<TPluginData>): Partial<NotifierEntry<TPluginData>> {
  return {
    ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.navigateTarget !== undefined ? { navigateTarget: input.navigateTarget } : {}),
    ...(input.pluginData !== undefined ? { pluginData: input.pluginData } : {}),
  };
}

export async function publish<TPluginData = unknown>(input: PublishInput<TPluginData>): Promise<{ id: string }> {
  // Validate at the engine boundary, so every caller shares one wall —
  // plugin runtime, legacy wrapper, host module. Publish has no HTTP
  // surface to validate separately (`server/api/routes/notifier.ts`).
  const validationError = validatePublishInput(input);
  if (validationError) {
    throw new Error(`notifier.publish: ${validationError}`);
  }
  const entryId = randomUUID();
  const entry: NotifierEntry<TPluginData> = {
    id: entryId,
    pluginPkg: input.pluginPkg,
    severity: input.severity,
    title: input.title,
    createdAt: new Date().toISOString(),
    ...optionalPublishFields(input),
  };
  await enqueue((state) => {
    state.entries[entryId] = entry;
    return { event: { type: "published", entry } };
  });
  return { id: entryId };
}

/** Remove an active entry and record its terminal history. `clear`
 *  (user dismissed) and `cancel` (producer withdrew) differ only in the
 *  emitted event / history reason. No-op when the id is unknown. */
async function terminateEntry(entryId: string, reason: "cleared" | "cancelled"): Promise<void> {
  await enqueue((state) => {
    const entry = state.entries[entryId];
    if (!entry) return null;
    state.entries = removeEntry(state, entryId);
    return {
      event: reason === "cleared" ? { type: "cleared", id: entryId } : { type: "cancelled", id: entryId },
      historyEntry: buildHistoryEntry(entry, reason),
    };
  });
}

export async function clear(entryId: string): Promise<void> {
  await terminateEntry(entryId, "cleared");
}

export async function cancel(entryId: string): Promise<void> {
  await terminateEntry(entryId, "cancelled");
}

/** In-place update for an active entry. Only the fields present on
 *  `patch` are rewritten; `id`, `pluginPkg`, `lifecycle`, and
 *  `createdAt` stay fixed. Emits a single `"updated"` event with the
 *  post-mutation entry — no history record is written because the
 *  entry is still active, just with refreshed content.
 *
 *  No-ops (no throw) when the id is unknown, the entry belongs to a
 *  different plugin, or the merged shape would violate
 *  `validatePublishInput`. The silent skip matches `clearForPlugin`'s
 *  isolation semantics; validation failures are logged for diagnosis. */
export async function updateForPlugin<TPluginData = unknown>(
  pluginPkg: string,
  entryId: string,
  patch: {
    severity?: NotifierSeverity;
    title?: string;
    body?: string;
    navigateTarget?: string;
    pluginData?: TPluginData;
  },
): Promise<void> {
  await enqueue((state) => {
    const entry = state.entries[entryId];
    if (!entry) return null;
    if (entry.pluginPkg !== pluginPkg) return null;
    const next: NotifierEntry = {
      ...entry,
      ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.navigateTarget !== undefined ? { navigateTarget: patch.navigateTarget } : {}),
      ...(patch.pluginData !== undefined ? { pluginData: patch.pluginData } : {}),
    };
    // Re-validate the merged shape so an update can't degrade the
    // entry below publish-time invariants.
    const validationError = validatePublishInput({
      pluginPkg: next.pluginPkg,
      severity: next.severity,
      title: next.title,
      body: next.body,
      lifecycle: next.lifecycle,
      navigateTarget: next.navigateTarget,
      pluginData: next.pluginData,
    });
    if (validationError) {
      logger().warn("update rejected by validation", { entryId, pluginPkg, error: validationError });
      return null;
    }
    state.entries[entryId] = next;
    return { event: { type: "updated", entry: next } };
  });
}

/** Plugin-scoped point lookup. Returns the entry by id, but only if it
 *  belongs to the caller's plugin; otherwise undefined. Cross-plugin
 *  reads return undefined for isolation — same property as
 *  `clearForPlugin` / `updateForPlugin`. */
export async function getForPlugin(pluginPkg: string, entryId: string): Promise<NotifierEntry | undefined> {
  const state = await loadActive(activeFilePath);
  const entry = state.entries[entryId];
  if (!entry) return undefined;
  if (entry.pluginPkg !== pluginPkg) return undefined;
  return entry;
}

/** Plugin-scoped clear. Same as `clear` but no-ops if the entry's
 *  `pluginPkg` doesn't match the caller's, so a plugin can't dismiss
 *  another plugin's notification by guessing or scraping its id. */
export async function clearForPlugin(pluginPkg: string, entryId: string): Promise<void> {
  await enqueue((state) => {
    const entry = state.entries[entryId];
    if (!entry) return null;
    if (entry.pluginPkg !== pluginPkg) return null;
    state.entries = removeEntry(state, entryId);
    return {
      event: { type: "cleared", id: entryId },
      historyEntry: buildHistoryEntry(entry, "cleared"),
    };
  });
}

export async function get(entryId: string): Promise<NotifierEntry | undefined> {
  const state = await loadActive(activeFilePath);
  return state.entries[entryId];
}

export async function listFor(pluginPkg: string): Promise<NotifierEntry[]> {
  const state = await loadActive(activeFilePath);
  return Object.values(state.entries).filter((entry) => entry.pluginPkg === pluginPkg);
}

export async function listAll(): Promise<NotifierEntry[]> {
  const state = await loadActive(activeFilePath);
  return Object.values(state.entries);
}

export async function listHistory(): Promise<NotifierHistoryEntry[]> {
  const state = await loadHistory(historyFilePath);
  return state.entries;
}
