// Records client-token uses in memory and writes them out in batches (#3637):
// at most once per flush delay, and on shutdown. A write failure is logged and
// left for a later flush; it never reaches the request that caused it.

import { log } from "../../system/logger/index.js";
import { errorMessage } from "../../utils/errors.js";
import { ONE_SECOND_MS } from "../../utils/time.js";
import { noteClientTokenUse, serializeClientTokenUsage, type ClientTokenUsage } from "./clientTokenUsageRule.js";
import { readClientTokenUsageFile, writeClientTokenUsageFile } from "./clientTokenStore.js";

export const USAGE_FLUSH_DELAY_MS = 30 * ONE_SECOND_MS;

export interface ClientTokenUsageTracker {
  note: (tokenId: string) => void;
  snapshot: () => ReadonlyMap<string, string>;
  /** Writes now if anything changed since the last write. */
  flush: () => void;
}

export interface ClientTokenUsageTrackerOptions {
  filePath: string;
  /** The ids still in the store, so a flush drops revoked ones. */
  liveIds: () => readonly string[];
  now?: () => number;
  flushDelayMs?: number;
}

/** True when written; a failure is logged and leaves the changes to the next flush. */
function writeUsage(filePath: string, usage: ClientTokenUsage, liveIds: readonly string[]): boolean {
  try {
    writeClientTokenUsageFile(filePath, serializeClientTokenUsage(usage, liveIds));
    return true;
  } catch (err) {
    log.warn("auth", "could not write client-token usage", { path: filePath, error: errorMessage(err) });
    return false;
  }
}

export function createClientTokenUsageTracker(options: ClientTokenUsageTrackerOptions): ClientTokenUsageTracker {
  const { filePath, liveIds, now = Date.now, flushDelayMs = USAGE_FLUSH_DELAY_MS } = options;
  const state: { usage: ClientTokenUsage | null; dirty: boolean; timer: ReturnType<typeof setTimeout> | null } = { usage: null, dirty: false, timer: null };
  const usage = (): ClientTokenUsage => {
    state.usage ??= readClientTokenUsageFile(filePath);
    return state.usage;
  };
  const flush = (): void => {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    if (state.dirty && writeUsage(filePath, usage(), liveIds())) state.dirty = false;
  };
  const note = (tokenId: string): void => {
    if (!noteClientTokenUse(usage(), tokenId, now())) return;
    state.dirty = true;
    state.timer ??= setTimeout(flush, flushDelayMs).unref();
  };
  return { note, snapshot: () => new Map(usage()), flush };
}
