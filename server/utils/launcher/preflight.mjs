// Prerequisite checks the icon launcher runs before spawning anything.
//
// The verdicts are pure so they can be unit tested without a machine
// that happens to have (or lack) the tools; the callers inject the
// commands. Every verdict names a message key from messages.mjs, so a
// failure can never reach the user as a bare boolean.

import { execFileSync } from "node:child_process";

// Mirrors `engines.node` in packages/mulmoclaude/package.json.
// test/utils/launcher/test_preflight.ts fails if the two drift.
export const REQUIRED_NODE = { major: 22, minor: 19 };

// These probes run a local binary that reads its own package metadata;
// anything past a few seconds means it is wedged, not slow.
// (server/utils/time.ts is TypeScript, which the launcher cannot import
// — it runs before tsx exists.)
const COMMAND_PROBE_TIMEOUT_MS = 5000;

/**
 * Parse `process.version`-shaped input into comparable numbers.
 * Returns null for anything unparseable rather than guessing — an
 * unknown version must not silently pass the requirement.
 * @param {string} raw
 * @returns {{ major: number, minor: number } | null}
 */
export function parseNodeVersion(raw) {
  if (typeof raw !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\./.exec(raw.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * @param {string} raw
 * @param {{ major: number, minor: number }} [required]
 * @returns {boolean}
 */
export function isNodeVersionSupported(raw, required = REQUIRED_NODE) {
  const found = parseNodeVersion(raw);
  if (found === null) return false;
  if (found.major !== required.major) return found.major > required.major;
  return found.minor >= required.minor;
}

/** Human-readable form of a requirement, for the {required} placeholder. */
export function formatRequiredNode(required = REQUIRED_NODE) {
  return `${required.major}.${required.minor}`;
}

/**
 * True when `<command> --version` works on the PATH handed in. The PATH
 * matters more than the check itself — see macos/resolve-path.sh.
 * @param {string} command
 * @param {{ env?: NodeJS.ProcessEnv, run?: (file: string, args: string[], options: object) => unknown }} [deps]
 * @returns {boolean}
 */
export function isCommandAvailable(command, { env = process.env, run = execFileSync } = {}) {
  try {
    run(command, ["--version"], { stdio: "pipe", env, timeout: COMMAND_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run every prerequisite check and return the first failure, or null
 * when the machine is ready.
 *
 * `npx` is checked even though it ships with every Node installer: the
 * launcher's whole job is `npx mulmoclaude@latest`, and a spawn failure
 * there is invisible — the launcher detaches the child, so nothing is
 * left to notice it died. Better to say so up front than to leave the
 * progress page spinning for two minutes.
 *
 * @param {import("./preflight.d.mts").PreflightOptions} [deps]
 * @returns {import("./preflight.d.mts").PreflightFailure | null}
 */
export function runPreflight({ nodeVersion = process.version, env = process.env, commandAvailable } = {}) {
  const hasCommand = commandAvailable ?? ((command) => isCommandAvailable(command, { env }));
  if (!isNodeVersionSupported(nodeVersion)) {
    return { key: "nodeTooOld", values: { required: formatRequiredNode(), found: nodeVersion } };
  }
  if (!hasCommand("npx")) return { key: "npxMissing", values: {} };
  if (!hasCommand("claude")) return { key: "claudeMissing", values: {} };
  return null;
}
