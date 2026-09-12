// Where the workspace lives, resolved the way the server resolves it.
//
// Kept as plain `.mjs` for the same reason as `port.mjs` / `cli-flags.mjs`:
// the npm launcher (`packages/mulmoclaude/bin/mulmoclaude.js`) boots BEFORE
// tsx is wired up, so it cannot import the `.ts` that owns this rule
// (`server/workspace/paths.ts` — `workspacePath`). It needs the rule to find
// the same `.server-port` the server will look at. Sibling `workspace-path.d.mts`
// carries the type declarations.
//
// `scripts/lib/devWorkspace.ts` delegates here rather than restating the rule:
// a second opinion about what `.env` says is exactly the failure that file was
// written to prevent (#2981), and the launcher's arrival makes a third copy the
// alternative.
import path from "node:path";
import { homedir } from "node:os";

const nonEmpty = (value) => typeof value === "string" && value.length > 0;

/**
 * `process.env` wins over the `.env` file, empty counting as unset on both
 * sides — the same precedence the server's own `MULMOCLAUDE_WORKSPACE_PATH ||`
 * default applies.
 *
 * @param {{ processEnv?: Record<string, string | undefined>, envFileValues?: Record<string, string> | null }} [sources]
 * @returns {string}
 */
export function resolveWorkspacePath(sources = {}) {
  const fromProcess = sources.processEnv?.MULMOCLAUDE_WORKSPACE_PATH;
  if (nonEmpty(fromProcess)) return fromProcess;
  const fromFile = sources.envFileValues?.MULMOCLAUDE_WORKSPACE_PATH;
  if (nonEmpty(fromFile)) return fromFile;
  return path.join(homedir(), "mulmoclaude");
}
