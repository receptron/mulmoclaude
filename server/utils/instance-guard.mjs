// "Is another MulmoClaude already running against THIS workspace?"
//
// Only the icon launcher used to ask. `yarn dev`, `yarn server` and
// `npx mulmoclaude` all walked forward off a busy port and started a SECOND
// server, saying so in one `log.info` line nobody reads (#3079). Two instances
// over one workspace overwrite each other's `.session-token`, after which a
// stateless plugin dispatch authenticates against the wrong server while the
// session-scoped `/api/internal/tool-result` push lands where the session does
// not exist and is dropped — so no plugin view renders and nothing errors
// (`server/workspace/serverPort.ts`). The setup is not broken so much as
// silently wrong, which is why it has to be refused rather than warned about.
//
// The question is asked of `<workspace>/.server-port`, not of the port: the
// harm is a SHARED WORKSPACE, so a second instance pointed at its own
// `MULMOCLAUDE_WORKSPACE_PATH` is fine on any port, and a second one sharing
// this workspace is not, even on a port nobody wanted. A port probe answers a
// different question and gets both of those backwards.
//
// Plain `.mjs` for the same reason as `port.mjs`: the npm launcher boots before
// tsx. Sibling `instance-guard.d.mts` carries the type declarations.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { detectRunningServer, SERVER_PRESENCE } from "./launcher/detect-server.mjs";

// Mirrors `WORKSPACE_FILES.serverPort` in `src/config/workspacePaths.ts`, which
// is TypeScript and so out of the launcher's reach. Same mirror, same reason, as
// the one in `scripts/wait-for-backend.ts`.
export const SERVER_PORT_FILENAME = ".server-port";

const MIN_PORT = 1;
const MAX_PORT = 65_535;

/** @param {string} workspacePath */
export function serverPortPathIn(workspacePath) {
  return path.join(workspacePath, SERVER_PORT_FILENAME);
}

/**
 * The port `.server-port` names, or null when it names nothing usable.
 *
 * `0` is rejected along with the garbage: the file is written with the port the
 * listener actually GOT (`boundPortOf`), so a 0 in it is a value no probe can
 * ask about rather than the "pick one for me" that `PORT=0` means.
 *
 * @param {unknown} text
 * @returns {number | null}
 */
export function parsePublishedPort(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) return null;
  return parsed;
}

/**
 * Whether this launch has to stop. Pure, so the rule has one name and one
 * exhaustive test rather than living twice inside two callers.
 *
 * @param {{ livePort: number | null, allowMultiple: boolean }} state
 * @returns {boolean}
 */
export function shouldStopForRunningInstance({ livePort, allowMultiple }) {
  return livePort !== null && !allowMultiple;
}

/**
 * What to tell someone whose launch just stopped: where the instance they
 * already have is, and how to insist if a second one is really wanted.
 *
 * The env var, not the flag, is the headline: `yarn dev` is a COMPOUND script and
 * yarn appends extra args to its last command only, so `yarn dev
 * --allow-multiple-instances` lands the flag on `concurrently`, which silently
 * swallows it — the reset guard that printed this message never sees it. Measured,
 * not assumed (Codex review, PR #3107). The flag does reach the single-command
 * `yarn server` and the npm launcher, which is why it is still named here.
 *
 * @param {number} port
 * @returns {string}
 */
export function instanceGuardMessage(port) {
  return [
    `MulmoClaude is already running against this workspace at http://localhost:${port}`,
    "  Two instances over one workspace overwrite each other's session token, and plugin views stop rendering on one of them.",
    "  To run a second one against its OWN workspace: MULMOCLAUDE_WORKSPACE_PATH=<dir> PORT=<n>",
    "  To share this workspace anyway: MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES=1",
    "  (--allow-multiple-instances is the same switch on `npx mulmoclaude` and `yarn server`, but NOT `yarn dev`)",
  ].join("\n");
}

/**
 * The port a LIVE MulmoClaude is answering on for this workspace, or null.
 *
 * A stale `.server-port` is not a running instance: the file is removed on a
 * graceful shutdown (#3082) but survives a kill -9, so the number it names is a
 * claim and the probe is what settles it. `detectRunningServer` reads the 401
 * from `/api/health` as the MulmoClaude-shaped refusal it is, which separates a
 * running instance from a connection refusal and from another app's 404.
 *
 * Never throws: a guard that dies while checking has stopped a launch for a
 * reason it cannot explain.
 *
 * @param {string} serverPortPath
 * @param {{ read?: (p: string) => Promise<string>, probe?: (port: number) => Promise<string> }} [deps]
 * @returns {Promise<number | null>}
 */
export async function findLiveInstancePort(serverPortPath, deps = {}) {
  const { read = (filePath) => readFile(filePath, "utf-8"), probe = detectRunningServer } = deps;
  const published = parsePublishedPort(await read(serverPortPath).catch(() => null));
  if (published === null) return null;
  const presence = await probe(published).catch(() => SERVER_PRESENCE.absent);
  return presence === SERVER_PRESENCE.mulmoclaude ? published : null;
}
