#!/usr/bin/env tsx
// `yarn dev`'s client half waits here before starting Vite (#2975).
//
// Why this exists rather than a fixed sleep: see `scripts/lib/waitForPort.ts`.
// Why the port has to come from the backend rather than from `PORT`: see
// `scripts/lib/publishedPort.ts`. This file is the wiring — learn the port,
// wait for it, report — and holds no policy of its own.
import fs from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { wasRepublished, type FileSnapshot } from "./lib/publishedPort.js";
import { describeRejection, parsePublishedPort, resolveServerPort } from "./lib/devServerPort.js";
import { findLiveInstancePort, instanceGuardMessage, shouldStopForRunningInstance } from "../server/utils/instance-guard.mjs";
import { waitForPort } from "./lib/waitForPort.js";
import { resolveDevWorkspacePath } from "./lib/devWorkspace.js";
import { parseEnvFile } from "../server/utils/launch-env.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const POLL_INTERVAL_MS = 150;
const PROBE_TIMEOUT_MS = 1000;
const NOTICE_EVERY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 60_000;
// A `--reset` marker older than this cannot be describing the startup happening
// now — generous enough for the slowest cold boot, short enough that a marker
// orphaned by a crashed run does not mislead tomorrow's.
const RESET_MARKER_MAX_AGE_MS = 10 * 60 * 1000;

// Long enough for a cold `tsx` boot on a Windows machine with a virus
// scanner in the path — the case this was written for. Overridable because
// "long enough" is a property of the machine, not of the code.
function resolveTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(parsed) || parsed < 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

// Mirrors `WORKSPACE_PATHS.serverPort`. The workspace itself is resolved by the
// shared helper, so this and `vite.config.ts` cannot end up looking in different
// directories — they used to, because the config matched the assignment with its
// own regex while this used the launcher's parser (Codex, #2981).
function resolveServerPortPath(envFileValues: Record<string, string>): string {
  return path.join(resolveDevWorkspacePath({ processEnv: process.env, envFileValues }), ".server-port");
}

function snapshotFile(filePath: string): FileSnapshot {
  try {
    return { exists: true, mtimeMs: fs.statSync(filePath).mtimeMs };
  } catch {
    return { exists: false, mtimeMs: 0 };
  }
}

function readTextOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

// A bare TCP connect, not a request: readiness must not depend on the bearer
// token, whose absence is half of what this wait exists to prevent.
function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const settle = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false));
  });
}

const sleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

function log(msg: string): void {
  console.log(`[wait-for-backend] ${msg}`);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Poll until our backend has published the port it bound, or the budget runs out. */
async function awaitRepublish(portFile: string, before: FileSnapshot, deadlineAt: number): Promise<boolean> {
  while (Date.now() < deadlineAt) {
    if (wasRepublished(before, snapshotFile(portFile))) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * The port this run's backend actually bound, once it has said so.
 *
 * `attributable` means `--reset` cleared the file before either pane started, so
 * whatever is there now was written by this startup even if it landed before the
 * snapshot. The shortcut applies only when the file is ALREADY there: in the
 * ordinary case `--reset` has just removed it and the publish is still seconds
 * away, so shortcutting then would read an absent file (Codex, #2975).
 */
async function awaitPublishedPort(portFile: string, before: FileSnapshot, deadlineAt: number, attributable: boolean): Promise<number | null> {
  const alreadyPublished = attributable && snapshotFile(portFile).exists;
  const attributed = alreadyPublished || (await awaitRepublish(portFile, before, deadlineAt));
  return attributed ? parsePublishedPort(readTextOrNull(portFile)) : null;
}

/**
 * Refuse the whole `yarn dev` chain when this workspace already has a server (#3079).
 *
 * Here, and not only in `server/index.ts`, because `reset()` below DELETES the
 * evidence: it clears `.server-port` before either pane starts, so by the time
 * the backend's own guard looks there is nothing left to find and the second
 * instance starts in silence — which is the exact case #3079 is about. The
 * rationale `reset()` gives for being safe to delete ("two instances sharing a
 * workspace already overwrite each other's `.session-token`") is precisely the
 * outcome now being refused.
 *
 * Exiting here aborts the `&&` chain, so `concurrently` never starts and the
 * backend supervisor never sees a child to restart.
 */
async function refuseSecondInstance(portFile: string): Promise<void> {
  const allowMultiple = process.env.MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES === "1" || process.argv.includes("--allow-multiple-instances");
  const livePort = allowMultiple ? null : await findLiveInstancePort(portFile);
  if (livePort === null || !shouldStopForRunningInstance({ livePort, allowMultiple })) return;
  log(instanceGuardMessage(livePort));
  process.exit(1);
}

/**
 * `--reset`: clear `.server-port` BEFORE either dev pane starts.
 *
 * This is what makes the rest of the check decidable, and it is why the loop of
 * "is this file from our run?" special cases ended here. `.server-port` is not
 * deleted on shutdown, and the two dev panes start concurrently with no ordering
 * guarantee — so a file already on disk when the waiter snapshots it might be a
 * leftover from a dead run OR this run's own publish, and those two demand
 * opposite verdicts. No amount of mtime reasoning separates them.
 *
 * Clearing it first removes the ambiguity at the source: afterwards, a
 * `.server-port` that exists was written by this startup, full stop.
 *
 * Safe to delete: it only ever addresses a live server, so it is meaningless
 * once that server is gone — and an instance still running in THIS workspace no
 * longer reaches here at all, because `refuseSecondInstance` above stops the
 * launch first (#3079). That used to be the one case this deletion could hurt:
 * the live instance lost its hook's address, waved away on the grounds that two
 * instances sharing a workspace were already broken. They still are; the
 * difference is that the launch making it so is now refused rather than
 * accommodated. Instances in different workspaces have different files.
 */
function reset(portFile: string): void {
  try {
    fs.rmSync(portFile, { force: true });
    const marker = resetMarkerPath(portFile);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, String(Date.now()));
  } catch (err) {
    log(`could not clear ${portFile}: ${String(err)} — the readiness check may report an older run's port.`);
  }
}

// The reset happens in its own process, before either pane exists, so the fact
// that it happened has to survive to the waiter somehow.
//
// Under `node_modules/.cache`, NOT the temp dir. The path is derived from the
// workspace, so it is fully predictable — and a predictable name in a
// world-writable directory is a symlink waiting to happen: anyone with an
// account on the machine can pre-create `/tmp/<that name>` pointing at a file
// of yours, and this write would follow it and clobber that file (CodeRabbit,
// #2975; /tmp's sticky bit stops deletions, not plants). A directory only you
// can write removes the opening rather than racing it.
//
// Not the workspace either: this is coordination between two processes of one
// `yarn dev`, not user data, and `.server-port`'s own contract (a live server's
// address, read by the wiki-write hook) stays untouched. Keyed by the port file
// so two workspaces driven from one checkout cannot borrow each other's.
function resetMarkerPath(portFile: string): string {
  const digest = createHash("sha256").update(portFile).digest("hex").slice(0, 16);
  return path.join(REPO_ROOT, "node_modules", ".cache", "mulmoclaude", `dev-reset-${digest}`);
}

/**
 * Read and remove the marker: did THIS startup clear the port file?
 *
 * Consumed rather than merely read, so a marker left behind by a `yarn dev`
 * that died between the reset and the waiter cannot make some later standalone
 * invocation trust a stale file. The age check is the second half of that —
 * a marker older than a startup could plausibly take never speaks for now.
 */
function consumeResetMarker(portFile: string): boolean {
  const marker = resetMarkerPath(portFile);
  const raw = readTextOrNull(marker);
  fs.rmSync(marker, { force: true });
  if (raw === null) return false;
  const stampedAt = Number(raw.trim());
  if (!Number.isFinite(stampedAt)) return false;
  const age = Date.now() - stampedAt;
  return age >= 0 && age <= RESET_MARKER_MAX_AGE_MS;
}

/** Block until something accepts on `port`, narrating a slow boot. */
function awaitListener(port: number, timeoutMs: number): Promise<{ ready: boolean; waitedMs: number; probes: number }> {
  return waitForPort({
    port,
    timeoutMs,
    pollIntervalMs: POLL_INTERVAL_MS,
    probe: probeTcp,
    now: () => Date.now(),
    sleep,
    noticeEveryMs: NOTICE_EVERY_MS,
    onWaiting: (elapsedMs) => log(`still waiting for the backend on :${port} (${seconds(elapsedMs)})`),
  });
}

/**
 * Starting Vite after the wait times out is deliberate: that is what shipped
 * before this wait existed, so the worst case is the old behaviour plus a line
 * saying what to expect.
 */
function reportTimeout(port: number, waitedMs: number): void {
  log(
    `backend still not listening on :${port} after ${seconds(waitedMs)} — starting Vite anyway. ` +
      `Expect "Can't reach the backend" in the UI until it comes up; reload once it does so the page picks up the auth token. ` +
      `Set MULMOCLAUDE_DEV_WAIT_MS to wait longer.`,
  );
}

/**
 * `PORT=0` leaves the backend on an OS-assigned port that nothing here can
 * name. Vite's own `assertProxyablePort` refuses to start for it with the
 * reason spelled out — waiting first would just delay that message by a minute
 * of silence.
 */
function refuseUnknowablePort(resolution: ReturnType<typeof resolveServerPort>): boolean {
  const unknowable = resolution.problems.find((problem) => problem.reason === "ephemeral");
  if (!unknowable) return false;
  log(`not waiting — ${unknowable.source}="${unknowable.raw}": ${describeRejection(unknowable.reason)}`);
  return true;
}

async function main(): Promise<void> {
  // The same resolution Vite's proxy target uses, from the same inputs. A
  // second opinion about `PORT` here would be #2650 one level down: the
  // wait would watch one port while the proxy addressed another.
  const envFileValues = parseEnvFile(path.join(process.cwd(), ".env")).parsed;
  const portFile = resolveServerPortPath(envFileValues ?? {});

  if (process.argv.includes("--reset")) {
    await refuseSecondInstance(portFile);
    reset(portFile);
    return;
  }

  const resolution = resolveServerPort({ processEnv: process.env, envFileValues });
  const timeoutMs = resolveTimeoutMs(process.env.MULMOCLAUDE_DEV_WAIT_MS);
  const startedAt = Date.now();
  const attributable = consumeResetMarker(portFile);
  const before = snapshotFile(portFile);

  // Wait for the backend to say which port it bound, THEN wait for that port.
  // Not the other way round: what `PORT` asked for and what the backend got are
  // the same only when the request could be honoured, and the whole of #2650 is
  // the case where it could not.
  //
  // The publish gets the WHOLE budget, not a slice of it. It is no longer a
  // secondary check that a separate wait could cover for — under `PORT=0` it is
  // the only way the port can be known at all, and cutting it short would fall
  // back to `:3001`, where the backend certainly is not (Codex, #2981). Nothing
  // is lost by being generous: the backend publishes right AFTER it listens, so
  // by the time this returns the accept below is immediate.
  const published = await awaitPublishedPort(portFile, before, startedAt + timeoutMs, attributable);

  if (published === null) {
    // Nothing published: fall back to what `PORT` implies, which is also what
    // Vite will fall back to, so the two still agree.
    if (refuseUnknowablePort(resolution)) return;
    await waitOn(resolution.port, timeoutMs - (Date.now() - startedAt), false);
    return;
  }
  await waitOn(published, timeoutMs - (Date.now() - startedAt), true);
}

/** Wait for `port` to accept, and say which way we learned about it. */
async function waitOn(port: number, budgetMs: number, verified: boolean): Promise<void> {
  const result = await awaitListener(port, Math.max(budgetMs, 0));
  if (!result.ready) {
    reportTimeout(port, result.waitedMs);
    return;
  }
  if (verified) {
    log(`backend ready on :${port} (published by this backend)`);
    return;
  }
  // Something answered, but nothing said it was ours. Saying "ready" here would
  // be the claim this whole file exists to stop making: with the default port
  // busy, the thing that answered is the OTHER instance, and the backend we
  // started is still coming up somewhere else (Codex, #2981).
  //
  // Not a dead end any more, though: Vite keeps watching `.server-port` and
  // re-aims itself when this run's backend finally publishes (#2995), so this
  // is a "not yet", not a "restart to fix it".
  log(
    `:${port} is answering, but this startup never published a port, so nothing confirms that is the backend it started. ` +
      `Vite will proxy here for now and switch as soon as the backend publishes its own port. ` +
      `If it never does, set PORT to give it a port of its own.`,
  );
}

// Always exit 0 — `yarn dev` chains this with `&& vite`, and taking the client
// pane down over a wait is worse than starting it late. There is nothing left to
// refuse over: the proxy follows the port the backend published, so the client
// and the backend cannot end up addressing different ones (#2981).
main().catch((err: unknown) => {
  log(`wait failed, starting Vite anyway: ${String(err)}`);
});
