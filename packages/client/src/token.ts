// Resolve the bearer token the CLI bridge sends to /api/*. Used by
// @mulmobridge/cli at startup (#272 Phase 2).
//
// Resolution order:
//   1. `MULMOCLAUDE_AUTH_TOKEN` env var (useful for parallel shells,
//      CI, or when the user runs the bridge against a different
//      workspace than the server's)
//   2. `<workspace>/.session-token` — the file the server writes at
//      startup. Same path the Vite dev plugin reads from, and the
//      pair of `.server-port` (see `workspace.ts`).
//
// Returns null if neither source yields a non-empty string — the
// caller decides how to react (exit with a helpful message, in the
// bridge's case).

import { readSidecarFile, SIDECAR_FILES, sidecarPath } from "./workspace.js";

/** Public since #272, kept as a module-load constant for callers that print it.
 *  It now honours `MULMOCLAUDE_WORKSPACE_PATH` (#3078) instead of hardcoding
 *  `<homedir>/mulmoclaude` — but a constant freezes the root at import time, so
 *  code that needs the answer AFTER `dotenv/config` has run should call
 *  `sidecarPath(SIDECAR_FILES.token)` instead, as `requireBearerToken` does. */
export const TOKEN_FILE_PATH = sidecarPath(SIDECAR_FILES.token);

export function readBridgeToken(): string | null {
  const fromEnv = process.env.MULMOCLAUDE_AUTH_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return readSidecarFile(SIDECAR_FILES.token);
}
