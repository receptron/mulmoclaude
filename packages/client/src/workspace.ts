// Where a bridge looks for the sidecar files the server writes on every
// startup (#3078).
//
// The server publishes two files into its workspace root at boot:
// `.session-token` (the bearer token the bridge presents) and
// `.server-port` (the port it actually bound, which is NOT always the
// one it was asked for — see `server/workspace/serverPort.ts`). They
// are a PAIR, rewritten together on every restart, so both are
// resolved from one root here rather than each growing its own idea of
// where the workspace is. Reading only one of them is how the bridges
// ended up following the token across restarts while still addressing
// a hardcoded `localhost:3001`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_WORKSPACE_DIR = "mulmoclaude";

/** Sidecar files the server rewrites on every startup. */
export const SIDECAR_FILES = {
  token: ".session-token",
  port: ".server-port",
} as const;

/**
 * The workspace root the server is using.
 *
 * Same rule as the server's own `workspacePath`
 * (`server/workspace/paths.ts`): `MULMOCLAUDE_WORKSPACE_PATH` wins,
 * otherwise `<homedir>/mulmoclaude`. The server's extra test-env
 * branch is deliberately not mirrored — it isolates the server's own
 * integration runs and means nothing to a bridge process.
 */
export function workspaceRoot(): string {
  const configured = process.env.MULMOCLAUDE_WORKSPACE_PATH;
  if (typeof configured === "string" && configured.length > 0) return configured;
  return path.join(os.homedir(), DEFAULT_WORKSPACE_DIR);
}

/** Absolute path of one sidecar file inside the workspace. */
export function sidecarPath(fileName: string): string {
  return path.join(workspaceRoot(), fileName);
}

/**
 * Sidecar contents, trimmed. `null` when the file is absent,
 * unreadable, or holds nothing but whitespace — all of which mean the
 * same thing to a caller: the server has not told us this yet.
 */
export function readSidecarFile(fileName: string): string | null {
  try {
    const raw = fs.readFileSync(sidecarPath(fileName), "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}
