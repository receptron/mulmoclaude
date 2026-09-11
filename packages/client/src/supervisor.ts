// Following the server across a restart (#3078 A-3).
//
// Both sidecars are rewritten when the server restarts, and the socket's URL is
// fixed when the socket is constructed — so a bridge that reads them once is
// pinned to the generation it started against. Before this, the client detected
// the resulting `invalid token` and told the user to re-run the bridge, which is
// where "I restart the server and then restart every bridge by hand" came from.
//
// `invalid token` is not a sufficient trigger. It only arrives when the bridge
// still REACHES the server, i.e. when the port happened not to change. When the
// port did change, nothing answers and the error is a refused connection, so a
// supervisor watching only for auth failures would sit on a dead port forever.
// Every connect failure therefore re-resolves.
//
// What it deliberately does NOT do is rebuild on every failure. A server that is
// simply down produces an unbroken stream of refusals, and tearing the socket
// down for each one would replace socket.io's own reconnection with a worse copy
// of it. The pair changing is the signal; everything else is left alone.
//
// That leaning on socket.io has one edge: a server-initiated disconnect
// (`io server disconnect`) is the one reason socket.io does NOT retry, so no
// connect failure follows it and nothing here would fire. It is not handled
// because the chat-service never issues one — it only logs disconnects — and a
// recovery path for an event nothing produces is a path nothing tests. If that
// changes, this is where it would go.

/** The pair a socket was built from. */
export interface Credentials {
  apiUrl: string;
  token: string;
}

/** Did the server come back as a different generation? */
export function credentialsChanged(current: Credentials, fresh: Credentials | null): boolean {
  if (fresh === null) return false;
  return fresh.apiUrl !== current.apiUrl || fresh.token !== current.token;
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

/**
 * Exponential backoff, capped.
 *
 * A restart takes seconds, so the first few re-reads should be quick; a server
 * that is down for the afternoon should not have its workspace stat-ed twice a
 * second until someone notices. Pure, so the schedule is testable without a
 * clock — `attempt` is 0-based and anything below 0 is treated as the first try.
 */
export function backoffMs(attempt: number): number {
  const step = attempt > 0 ? attempt : 0;
  return Math.min(FIRST_RETRY_MS * 2 ** step, MAX_RETRY_MS);
}
