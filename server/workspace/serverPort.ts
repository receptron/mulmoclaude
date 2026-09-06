// Publishing the port the server actually bound (#2650 / #2981).
//
// `<workspace>/.server-port` is how everything outside this process learns where
// the server is: the PostToolUse hook dispatcher addresses it, and `yarn dev`'s
// client half reads it to point Vite's proxy at the port the server got rather
// than the one it was asked for.
//
// **Atomically**, which it did not used to be. The original write was a plain
// `writeFile` with a comment explaining that "the .tmp dance serves no purpose
// for a single-process write at boot" — true while nothing read the file during
// startup, and false the moment the dev client began reading it to decide where
// to proxy. `writeFile` opens with `O_TRUNC`, so a reader arriving between the
// truncate and the write sees an EMPTY file, and one arriving mid-write can see
// a PREFIX: `3002` truncated to `300` parses as a perfectly valid port that
// nothing is listening on. A rename cannot be observed half-done, so the reader
// sees either the old contents or the new ones and never a state in between.
import type { AddressInfo } from "node:net";
import { writeFileAtomic } from "../utils/files/index.js";
import { env } from "../system/env.js";
import { WORKSPACE_PATHS } from "./paths.js";

// The port the listener actually got, remembered in-process (#3055).
//
// `env.port` is what the server was ASKED for; it walks forward off a busy
// default (`Port 3001 busy → using 3002 instead`) and is `0` under `PORT=0`.
// Every in-process consumer that hands the port to a CHILD — the MCP broker
// gets it as `BASE_URL` — has to use the bound one, or the child addresses a
// different server. When two instances run against one workspace and share a
// `MULMOCLAUDE_AUTH_TOKEN`, that misdirection authenticates cleanly: the
// stateless plugin dispatch succeeds on the wrong server while the
// session-scoped `/api/internal/tool-result` push lands where the session does
// not exist and is dropped, so no plugin view ever renders on the second
// instance.
let boundPort: number | null = null;

/** Called once, from the listen callback, with `boundPortOf(...)`. */
export function setBoundPort(port: number): void {
  boundPort = port;
}

/** The bound port, falling back to the requested one before `listen` resolves
 *  (module-load-time readers, tests, and any non-serving entry point). */
export function getBoundPort(): number {
  return boundPort ?? env.port;
}

/** Trailing newline so `cat .server-port` reads cleanly in a shell hook. */
export function formatServerPort(port: number): string {
  return `${port}\n`;
}

/**
 * @param portPath Injected by tests; production callers take the default.
 */
export async function publishServerPort(port: number, portPath: string = WORKSPACE_PATHS.serverPort): Promise<void> {
  await writeFileAtomic(portPath, formatServerPort(port), { mode: 0o600 });
}

/**
 * The port the listener actually got, which is not the one it was asked for
 * whenever the request was `0`.
 *
 * `PORT=0` means "any free port": `app.listen(0)` binds one the OS picks, and
 * the requested value stays `0` in the caller's variable. Publishing that `0`
 * tells every reader nothing — it is not a port anything can address — so the
 * dev proxy could not follow a backend started that way (Codex, #2981).
 *
 * `address()` is a string for a pipe or UNIX socket, which has no port; the
 * requested value is the only answer left there.
 */
export function boundPortOf(address: AddressInfo | string | null, requested: number): number {
  if (address !== null && typeof address === "object") return address.port;
  return requested;
}
