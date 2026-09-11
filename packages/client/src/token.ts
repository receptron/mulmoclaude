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

/** Resolved once at module load, so the error message a bridge prints names a
 *  stable path. `MULMOCLAUDE_WORKSPACE_PATH` is read here (#3078) — it was
 *  hardcoded to `<homedir>/mulmoclaude` before, so anyone who had moved their
 *  workspace was told to look in a directory the server never writes. */
export const TOKEN_FILE_PATH = sidecarPath(SIDECAR_FILES.token);

export function readBridgeToken(): string | null {
  const fromEnv = process.env.MULMOCLAUDE_AUTH_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return readSidecarFile(SIDECAR_FILES.token);
}
