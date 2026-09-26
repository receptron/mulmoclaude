import { ackTimeoutMsFor, resolveReplyTimeoutMs, type BridgeOptions } from "@mulmobridge/protocol";

/** How long `send()` waits for the ack. Read from the same option the handshake
 *  sends the server, so it always outlasts the server's reply limit and the
 *  server's timeout surfaces as a reply, not a client-side cancellation. */
export function resolveAckTimeoutMs(options: BridgeOptions, warn: (message: string) => void): number {
  const { replyTimeoutMs, warning } = resolveReplyTimeoutMs(options.replyTimeoutMs);
  if (warning) warn(`[bridge] ${warning}`);
  return ackTimeoutMsFor(replyTimeoutMs);
}
