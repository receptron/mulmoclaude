// Records client-token uses in memory and writes them out in batches (#3637):
// at most once per flush delay, and on shutdown. A write failure is logged and
// left for a later flush; it never reaches the request that caused it.

import { log } from "../../system/logger/index.js";
import { errorMessage } from "../../utils/errors.js";
import { ONE_SECOND_MS } from "../../utils/time.js";
import { noteClientTokenUse, pruneClientTokenUsage, serializeClientTokenUsage, type ClientTokenUsage } from "./clientTokenUsageRule.js";
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
  /** The ids still in the store, so a flush drops revoked ones; null when the
   *  store cannot be read, which drops nothing. */
  liveIds: () => readonly string[] | null;
  now?: () => number;
  flushDelayMs?: number;
}

/** The pruned map once written; null when anything failed, which leaves the
 *  in-memory map and its changes to the next flush. */
function writeUsage(filePath: string, usage: ClientTokenUsage, liveIds: () => readonly string[] | null): ClientTokenUsage | null {
  try {
    const pruned = pruneClientTokenUsage(usage, liveIds());
    writeClientTokenUsageFile(filePath, serializeClientTokenUsage(pruned));
    return pruned;
  } catch (err) {
    log.warn("auth", "could not write client-token usage", { path: filePath, error: errorMessage(err) });
    return null;
  }
}

class UsageTracker implements ClientTokenUsageTracker {
  private loaded: ClientTokenUsage | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: Required<ClientTokenUsageTrackerOptions>) {}

  note = (tokenId: string): void => {
    if (!noteClientTokenUse(this.usage(), tokenId, this.options.now())) return;
    this.dirty = true;
    this.schedule();
  };

  snapshot = (): ReadonlyMap<string, string> => new Map(this.usage());

  // A failed write stays dirty and tries again later, so an idle client's last
  // use is not left to a graceful shutdown that may never come.
  flush = (): void => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    const written = writeUsage(this.options.filePath, this.usage(), this.options.liveIds);
    if (written === null) {
      this.schedule();
      return;
    }
    // Revoked ids leave memory too, not only the file.
    this.loaded = written;
    this.dirty = false;
  };

  private usage(): ClientTokenUsage {
    this.loaded ??= readClientTokenUsageFile(this.options.filePath);
    return this.loaded;
  }

  private schedule(): void {
    this.timer ??= setTimeout(this.flush, this.options.flushDelayMs).unref();
  }
}

export function createClientTokenUsageTracker(options: ClientTokenUsageTrackerOptions): ClientTokenUsageTracker {
  return new UsageTracker({ now: Date.now, flushDelayMs: USAGE_FLUSH_DELAY_MS, ...options });
}
