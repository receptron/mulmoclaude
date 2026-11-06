// "Has the server we just spawned started answering yet?"
//
// There is no deadline on purpose. A fixed window used to give up without a
// word (#3623), and the server legitimately spends a long time before
// `listen()` — a first sandbox image build, a slow synced workspace. The
// launcher exits when the server does, so waiting while it lives cannot hang.
//
// Plain `.mjs` for the same reason as `port.mjs`: the npm launcher boots before
// tsx. Sibling `wait-ready.d.mts` carries the type declarations.
import { detectRunningServer, SERVER_PRESENCE } from "./launcher/detect-server.mjs";

export const READY_POLL_INTERVAL_MS = 300;
export const SLOW_START_NOTICE_AFTER_MS = 15_000;

const MS_PER_SECOND = 1000;

/**
 * @param {{ elapsedMs: number, announced: boolean }} state
 * @returns {boolean}
 */
export function shouldAnnounceSlowStart({ elapsedMs, announced }) {
  return !announced && elapsedMs >= SLOW_START_NOTICE_AFTER_MS;
}

/**
 * @param {string} url
 * @param {{ willOpenBrowser: boolean }} options
 */
export function slowStartMessage(url, { willOpenBrowser }) {
  const seconds = Math.round(SLOW_START_NOTICE_AFTER_MS / MS_PER_SECOND);
  const prefix = `Still starting after ${seconds}s`;
  if (!willOpenBrowser) return `${prefix} — open ${url} once the server answers.`;
  return `${prefix} — the browser opens once the server answers. To open it yourself: ${url}`;
}

/** @param {number} port */
async function isMulmoClaudeAnswering(port) {
  return (await detectRunningServer(port)) === SERVER_PRESENCE.mulmoclaude;
}

/** @param {number} delayMs */
function sleepMs(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Resolve true once the server answers, false if it dies first.
 * @param {import("./wait-ready.d.mts").WaitUntilReadyOptions} options
 * @returns {Promise<boolean>}
 */
export async function waitUntilReady({ port, isServerAlive, onSlowStart, probe = isMulmoClaudeAnswering, sleep = sleepMs, now = Date.now }) {
  const startedAt = now();
  const state = { announced: false };
  while (isServerAlive()) {
    // A server that died mid-probe is not ready, whatever the probe saw.
    if (await probe(port)) return isServerAlive();
    if (shouldAnnounceSlowStart({ elapsedMs: now() - startedAt, announced: state.announced })) {
      state.announced = true;
      onSlowStart();
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
  return false;
}
