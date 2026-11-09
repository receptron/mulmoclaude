// Prerequisite checks the icon launcher runs before spawning anything.
//
// The verdicts are pure so they can be unit tested without a machine
// that happens to have (or lack) the tools; the callers inject the
// commands. Every verdict names a message key from messages.mjs, so a
// failure can never reach the user as a bare boolean.

import { execFileSync } from "node:child_process";

// Mirrors `engines.node` in packages/mulmoclaude/package.json.
// test/utils/launcher/test_preflight.ts fails if the two drift.
// One floor per supported major; the last also admits every later major,
// and a major with no floor of its own (23, 25) is unsupported.
export const REQUIRED_NODE = [
  { major: 24, minor: 15, patch: 0 },
  { major: 26, minor: 0, patch: 0 },
];

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
 * @returns {import("./preflight.d.mts").NodeVersion | null}
 */
export function parseNodeVersion(raw) {
  if (typeof raw !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function floorFor(found, required) {
  const newest = required[required.length - 1];
  if (found.major > newest.major) return newest;
  return required.find((floor) => floor.major === found.major);
}

/**
 * @param {string} raw
 * @param {readonly import("./preflight.d.mts").NodeVersion[]} [required]
 * @returns {boolean}
 */
export function isNodeVersionSupported(raw, required = REQUIRED_NODE) {
  const found = parseNodeVersion(raw);
  if (found === null) return false;
  const floor = floorFor(found, required);
  return floor !== undefined && compareVersions(found, floor) >= 0;
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/** Human-readable form of a requirement, for the {required} placeholder. */
export function formatRequiredNode(required = REQUIRED_NODE) {
  return required.map(formatVersion).join(" / ");
}

/** The same requirement as an `engines.node` range. */
export function formatEnginesRange(required = REQUIRED_NODE) {
  const carets = required.slice(0, -1).map((floor) => `^${formatVersion(floor)}`);
  return [...carets, `>=${formatVersion(required[required.length - 1])}`].join(" || ");
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
