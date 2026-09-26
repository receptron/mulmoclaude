// How long a relayed turn may take, shared by both ends of the wire.
//
// The chat-service stops collecting the agent's reply after the reply
// timeout; the bridge client stops waiting for the ack a margin later. The
// margin is the whole contract: if the client gave up first, the server's
// partial reply would arrive at a socket that had already reported a timeout.
// Both ends read the SAME `bridgeOptions.replyTimeoutMs`, so the order holds
// whatever the user sets.

const ONE_MINUTE_MS = 60 * 1000;

export const DEFAULT_REPLY_TIMEOUT_MS = 5 * ONE_MINUTE_MS;

/** How much longer the bridge waits for the ack than the server waits for the reply. */
export const ACK_TIMEOUT_MARGIN_MS = ONE_MINUTE_MS;

// Node fires a timer longer than 2^31-1 ms after 1 ms instead, which would turn
// "wait longer" into "give up at once". The client adds the margin, so the
// reply limit stops short of the ceiling by exactly that much.
const SET_TIMEOUT_CEILING_MS = 2 ** 31 - 1;
export const MAX_REPLY_TIMEOUT_MS = SET_TIMEOUT_CEILING_MS - ACK_TIMEOUT_MARGIN_MS;

export interface ReplyTimeoutResolution {
  replyTimeoutMs: number;
  /** Set when the configured value was unusable and something else was used. */
  warning?: string;
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;

function parseConfigured(raw: string | number): number | null {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  return POSITIVE_INTEGER.test(raw) ? Number(raw) : null;
}

/**
 * Turn `bridgeOptions.replyTimeoutMs` into the limit to use.
 *
 * Absent or empty means the default with no warning. Anything that is not a
 * positive whole number of milliseconds falls back to the default, and a value
 * past the timer ceiling is clamped — both with a warning naming the value.
 */
export function resolveReplyTimeoutMs(raw: unknown): ReplyTimeoutResolution {
  if (raw === undefined || raw === null || raw === "") return { replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS };
  const configured = typeof raw === "string" || typeof raw === "number" ? parseConfigured(raw) : null;
  if (configured === null) {
    return {
      replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
      warning: `replyTimeoutMs=${JSON.stringify(raw)} is not a positive whole number of milliseconds; using ${DEFAULT_REPLY_TIMEOUT_MS}`,
    };
  }
  if (configured > MAX_REPLY_TIMEOUT_MS) {
    return { replyTimeoutMs: MAX_REPLY_TIMEOUT_MS, warning: `replyTimeoutMs=${configured} exceeds the maximum; using ${MAX_REPLY_TIMEOUT_MS}` };
  }
  return { replyTimeoutMs: configured };
}

/** The bridge client's ack limit for a given reply limit. */
export function ackTimeoutMsFor(replyTimeoutMs: number): number {
  return replyTimeoutMs + ACK_TIMEOUT_MARGIN_MS;
}
