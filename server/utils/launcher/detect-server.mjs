// "Is MulmoClaude already running on this port?"
//
// The icon launcher must never start a second server: clicking the icon
// while the app is open should just bring up the browser. A free/busy
// port probe is not enough — a busy port could be anything — so this
// asks `/api/health` and reads the answer.
//
// `/api/health` sits behind `bearerAuth` (server/index.ts), so an
// unauthenticated probe gets 401, not the `{status:"OK"}` body. That 401
// IS the signal: it is a MulmoClaude-shaped refusal, and it separates
// cleanly from a connection refusal (nobody there) and from another
// app's 404. Do not "fix" the 401 by exempting the route from auth.

import { get as httpGet } from "node:http";

import { MAX_PORT_PROBES } from "../port.mjs";

export const HEALTH_PATH = "/api/health";

// A loopback request that hasn't answered in this long is not going to.
const PROBE_TIMEOUT_MS = 2000;

// The TOTAL budget for one probe, which the above is not: Node's `timeout`
// option is an INACTIVITY timeout, so a response that dribbles a byte faster
// than `PROBE_TIMEOUT_MS` keeps the socket busy, never emits `end`, and leaves
// the probe pending forever. Harmless while only the icon launcher asked — it
// had already drawn its page — but `refuseSecondInstance` now asks on the
// startup path of every launch, where a pending probe is a `yarn dev` that
// hangs with nothing printed (CodeRabbit, #3079).
const PROBE_DEADLINE_MS = 5000;

export const SERVER_PRESENCE = {
  mulmoclaude: "mulmoclaude",
  foreign: "foreign",
  absent: "absent",
};

/**
 * Turn a raw probe outcome into a decision. Pure.
 * @param {{ status?: number, body?: string, errorCode?: string }} outcome
 * @returns {"mulmoclaude" | "foreign" | "absent"}
 */
export function classifyHealthProbe({ status, body, errorCode }) {
  if (errorCode !== undefined) return SERVER_PRESENCE.absent;
  if (status === 401) return SERVER_PRESENCE.mulmoclaude;
  if (status === 200 && looksLikeHealthBody(body)) return SERVER_PRESENCE.mulmoclaude;
  return SERVER_PRESENCE.foreign;
}

// Auth can be bypassed in some run modes, in which case the real health
// body comes back. Match on its shape rather than trusting a bare 200,
// which any web server on the port would also return.
function looksLikeHealthBody(body) {
  if (typeof body !== "string") return false;
  try {
    return JSON.parse(body).status === "OK";
  } catch {
    return false;
  }
}

/**
 * Probe `127.0.0.1:<port>/api/health` and classify what answered.
 * Never rejects — a launcher that throws while checking has no way to
 * tell the user anything.
 * @param {number} port
 * @param {{ get?: typeof httpGet }} [deps]
 * @returns {Promise<"mulmoclaude" | "foreign" | "absent">}
 */
export function detectRunningServer(port, { get = httpGet } = {}) {
  return new Promise((resolve) => {
    // One holder so `settle` can be written before the request and the timer it
    // tears down, both of which it needs and neither of which exists yet.
    // Repeat calls are harmless: `resolve` past the first is ignored, and
    // `destroy()` itself re-enters here through the request's `error`.
    const probe = { request: null, deadline: null };
    const settle = (outcome) => {
      clearTimeout(probe.deadline);
      probe.request?.destroy();
      resolve(classifyHealthProbe(outcome));
    };
    probe.deadline = setTimeout(() => settle({ errorCode: "ETIMEDOUT" }), PROBE_DEADLINE_MS);
    probe.request = get({ host: "127.0.0.1", port, path: HEALTH_PATH, timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.setEncoding("utf8");
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => settle({ status: res.statusCode, body: chunks.join("") }));
    });
    probe.request.on("error", (error) => settle({ errorCode: error.code ?? "UNKNOWN" }));
    probe.request.on("timeout", () => settle({ errorCode: "ETIMEDOUT" }));
  });
}

/**
 * The port an already-running MulmoClaude answers on, or null.
 *
 * Probing only the default port is not enough: when something else
 * holds it, the launcher starts on the next free one — and then every
 * later click would find the default still foreign and start yet
 * another server. The window scanned here therefore has to match the
 * one `findAvailablePort` can hand out (`[start, start + MAX_PORT_PROBES)`),
 * or the launcher can miss an instance it started itself.
 *
 * Probes run concurrently (a refused loopback connection is immediate)
 * and the lowest answering port wins, so the result does not depend on
 * which reply arrives first.
 *
 * @param {number} startPort
 * @param {{ probeCount?: number, probe?: (port: number) => Promise<string> }} [deps]
 * @returns {Promise<number | null>}
 */
export async function findRunningServerPort(startPort, { probeCount = MAX_PORT_PROBES, probe = detectRunningServer } = {}) {
  const ports = Array.from({ length: probeCount }, (_unused, offset) => startPort + offset);
  const presences = await Promise.all(ports.map((port) => probe(port)));
  const index = presences.indexOf(SERVER_PRESENCE.mulmoclaude);
  return index === -1 ? null : ports[index];
}
