// Which server a bridge talks to (#3078).
//
// The server is not pinned to 3001. `server/index.ts` walks forward off a
// busy default (`Port 3001 busy → using 3002 instead`) and honours `PORT`,
// then publishes whatever it actually bound to `<workspace>/.server-port`.
// A client that does not read that file either connects to nothing (case A:
// `PORT=3099` and nobody on 3001) or — worse — connects cleanly to a
// DIFFERENT instance that happens to hold 3001 (case B), which with a shared
// `MULMOCLAUDE_AUTH_TOKEN` authenticates without a single error.
//
// This is the same class as #2650 (Vite's proxy target) and #2981
// (`wait-for-backend`); both were fixed by reading the published port.
//
// A leftover `.server-port` cannot mislead here the way it can mislead
// `yarn dev`: the server REWRITES it on every startup, so a running server's
// entry is always current — and with no server running, the old hardcoded 3001
// was just as dead. Since #3082 a graceful shutdown removes it too, so the
// leftover case is now a crash rather than the ordinary stop.

import { readSidecarFile, SIDECAR_FILES } from "./workspace.js";

/** Used only when nothing has been published and nothing was configured. */
export const DEFAULT_API_URL = "http://localhost:3001";

const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * The published port, or `null` for anything that is not one.
 *
 * Decimal digits only. The writer is `formatServerPort()`, which emits
 * `${port}\n` and nothing else, so there is no lenient shape worth
 * accepting — while `Number.parseInt` would read `3002abc` as 3002 and send
 * the bridge to a port a corrupted file never meant.
 */
export function parsePublishedPort(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number.parseInt(trimmed, 10);
  return port >= MIN_PORT && port <= MAX_PORT ? port : null;
}

/**
 * The origin the running server published, or `null` if it published none.
 *
 * `127.0.0.1` rather than `localhost`: the server binds the IPv4 loopback
 * explicitly (`app.listen(port, "127.0.0.1")`), while `localhost` resolves
 * to `::1` first on a dual-stack host. Usually that still works — nothing
 * holds `::1`, the connection is refused and Node falls back to IPv4 — but
 * when something IS there the client reaches it and never falls back, which
 * is the silent misdirection this module exists to remove (#2981).
 */
export function readPublishedApiUrl(): string | null {
  const port = parsePublishedPort(readSidecarFile(SIDECAR_FILES.port));
  return port === null ? null : `http://127.0.0.1:${port}`;
}

/**
 * Resolution order: explicit argument → `MULMOCLAUDE_API_URL` → the port the
 * server published → `DEFAULT_API_URL`.
 *
 * An explicit value still wins, so nothing that already sets one changes.
 * An EMPTY value falls through instead of being used verbatim, matching how
 * `readBridgeToken` treats an empty `MULMOCLAUDE_AUTH_TOKEN` — an empty
 * string reached `io("")` before this.
 */
export function resolveApiUrl(explicit?: string): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const fromEnv = process.env.MULMOCLAUDE_API_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return readPublishedApiUrl() ?? DEFAULT_API_URL;
}
