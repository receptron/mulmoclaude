// whisper.cpp warm-model sidecar. Spawns `whisper-server` once with the model
// preloaded and reuses it across transcriptions over its local HTTP API, so the
// weights stay resident (no per-request reload). State is encapsulated per
// instance via the factory closure.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { errorMessage, NOOP_LOGGER, ONE_MINUTE_MS, ONE_SECOND_MS, type WhisperLogger } from "./internal.ts";
import { modelFilePath, type WhisperModelName } from "./models.ts";
import { appendStderrTail, buildServerArgs, parseInferenceText } from "./sidecar-helpers.ts";

const HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 60 * ONE_SECOND_MS;
const READY_POLL_INTERVAL_MS = 500;
const INFERENCE_TIMEOUT_MS = 2 * ONE_MINUTE_MS;
const STDERR_TAIL_MAX_CHARS = 4_000;

export interface ActiveSidecar {
  readonly port: number;
  readonly proc: ChildProcess;
  readonly model: WhisperModelName;
}

export interface Sidecar {
  transcribeWav: (wavPath: string, language: string, model: WhisperModelName) => Promise<string>;
  warmup: (model: WhisperModelName) => Promise<void>;
  shutdown: () => void;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

/** Resolve once the server answers any HTTP request (any status = listener up),
 *  or throw after the ready timeout. */
async function waitUntilReady(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://${HOST}:${port}/`, { signal: AbortSignal.timeout(ONE_SECOND_MS) });
      return;
    } catch {
      await delay(READY_POLL_INTERVAL_MS);
    }
  }
  throw new Error("whisper-server did not become ready in time");
}

// whisper-server logs verbosely to stderr; left unread the OS pipe buffer fills
// and the child blocks on its next write. Drain into a small tail buffer.
function drainStderr(proc: ChildProcess, tail: { text: string }): void {
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    tail.text = appendStderrTail(tail.text, chunk, STDERR_TAIL_MAX_CHARS);
  });
}

// Resolve when the server answers, or reject on spawn failure (e.g. ENOENT) /
// early exit. Listeners are one-shot and removed once the race settles.
function waitForReadyOrFailure(proc: ChildProcess, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let onError: (err: Error) => void = () => undefined;
    let onExit: (code: number | null) => void = () => undefined;
    const cleanup = () => {
      proc.removeListener("error", onError);
      proc.removeListener("exit", onExit);
    };
    onError = (err: Error) => {
      cleanup();
      reject(new Error(`spawn failed: ${errorMessage(err)}`));
    };
    onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`exited early (code ${code})`));
    };
    proc.once("error", onError);
    proc.once("exit", onExit);
    waitUntilReady(port)
      .then(() => {
        cleanup();
        resolve();
      })
      .catch((err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

// POST the wav to whisper-server's `/inference` and return the transcript.
// Isolated from the lifecycle so the HTTP contract is unit-testable without a
// live child (stub `fetch`, hand it a real wav path).
export async function postInference(port: number, wavPath: string, language: string): Promise<string> {
  const buf = await readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");
  form.append("language", language || "auto");
  let res: Response;
  try {
    res = await fetch(`http://${HOST}:${port}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`whisper-server request failed: ${errorMessage(err)}`);
  }
  if (!res.ok) throw new Error(`whisper-server returned HTTP ${res.status}`);
  return parseInferenceText(await res.json());
}

// The impure primitives the start lifecycle depends on, injected so the
// cancellation / single-flight / model-switch logic can be driven with fakes.
export interface StartLifecycleDeps {
  /** Reserve a free TCP port for the next child — the sole async step of a start. */
  allocatePort: () => Promise<number>;
  /** Spawn the whisper-server child on `port`. MUST be synchronous so the spawn
   *  and the `startingProc` handoff stay in one tick: `shutdown()` has to be able
   *  to kill an in-flight child immediately, with no await gap after it exists. */
  spawnServer: (model: WhisperModelName, port: number) => ChildProcess;
  /** Resolve once the child answers HTTP, or reject on spawn failure / early exit. */
  waitReady: (proc: ChildProcess, port: number) => Promise<void>;
  logger: WhisperLogger;
}

export interface StartLifecycle {
  ensureSidecar: (model: WhisperModelName) => Promise<ActiveSidecar>;
  shutdown: () => void;
}

export function defaultSpawnServer(
  modelsDir: string,
  serverBinary: string,
  logger: WhisperLogger,
  extraArgs: readonly string[] = [],
): StartLifecycleDeps["spawnServer"] {
  return (model: WhisperModelName, port: number): ChildProcess => {
    const args = buildServerArgs(modelFilePath(modelsDir, model), HOST, port, extraArgs);
    logger.info("sidecar: spawning", { model, port });
    return spawn(serverBinary, args, { stdio: ["ignore", "ignore", "pipe"] });
  };
}

// Wires the three listeners every whisper-server child needs: stderr drain,
// permanent `error` handler (an unhandled 'error' from ENOENT etc. would crash
// the host), and `exit` handler that both logs and lets the caller decide
// whether this proc is still the active one (identity check via `onExit` — a
// stale process must not evict a newer live sidecar).
function instrumentChildProcess(proc: ChildProcess, model: WhisperModelName, logger: WhisperLogger, onExit: (exited: ChildProcess) => void): { text: string } {
  const stderrTail = { text: "" };
  drainStderr(proc, stderrTail);
  proc.on("error", (err) => logger.warn("sidecar: process error", { model, error: errorMessage(err) }));
  proc.on("exit", (code) => {
    logger.warn("sidecar: exited", { model, code, stderrTail: stderrTail.text.slice(-500) });
    onExit(proc);
  });
  return stderrTail;
}

// Await server readiness; on failure, kill the child and surface both the
// underlying error and the tail of stderr (whisper-server usually explains its
// crash there). Kept at module scope so `startSidecar` stays under the
// per-function line cap.
async function awaitReadyOrThrow(proc: ChildProcess, port: number, stderrTail: { text: string }, waitReady: StartLifecycleDeps["waitReady"]): Promise<void> {
  try {
    await waitReady(proc, port);
  } catch (err) {
    proc.kill();
    throw new Error(`whisper-server failed to start: ${errorMessage(err)} — stderr: ${stderrTail.text.slice(-500)}`);
  }
}

// Abort a start that was raced by `shutdown()` (or a newer start). Compares
// the token captured at start entry against the current token; if they differ,
// kill the freshly-booted child rather than publish it after shutdown returned.
function throwIfStartCancelled(startedToken: number, currentToken: number, proc: ChildProcess): void {
  if (startedToken !== currentToken) {
    proc.kill();
    throw new Error("whisper-server start cancelled");
  }
}

// Owns the single warm child's lifecycle: which model is live, the in-flight
// start, and the cancellation token. Kept as a factory closure so the mutable
// state is encapsulated rather than threaded through parameters.
export function createStartLifecycle(deps: StartLifecycleDeps): StartLifecycle {
  const { allocatePort, spawnServer, waitReady, logger } = deps;
  let sidecar: ActiveSidecar | null = null;
  let starting: { model: WhisperModelName; promise: Promise<ActiveSidecar> } | null = null;
  // The child of an in-flight start (before it's published as `sidecar`), plus a
  // token that `shutdown()` bumps to cancel a start that's still booting — so
  // shutdown can't return with a child that then publishes itself afterwards.
  let startingProc: ChildProcess | null = null;
  let startToken = 0;

  function shutdown(): void {
    startToken += 1;
    startingProc?.kill();
    startingProc = null;
    sidecar?.proc.kill();
    sidecar = null;
  }

  async function startSidecar(model: WhisperModelName): Promise<ActiveSidecar> {
    const token = ++startToken;
    const port = await allocatePort();
    const proc = spawnServer(model, port);
    startingProc = proc;
    // onExit fires when THIS proc exits: only null out `sidecar` if it's still the live one.
    const stderrTail = instrumentChildProcess(proc, model, logger, (exited) => sidecar?.proc === exited && (sidecar = null));
    try {
      await awaitReadyOrThrow(proc, port, stderrTail, waitReady);
    } finally {
      if (startingProc === proc) startingProc = null;
    }
    throwIfStartCancelled(token, startToken, proc);
    sidecar = { port, proc, model };
    logger.info("sidecar: ready", { model, port });
    return sidecar;
  }

  // Own function so it isn't a loop closure (no-loop-func). Only ever one start
  // is in flight at a time, so clearing `starting` on settle is safe.
  function beginStart(model: WhisperModelName): Promise<ActiveSidecar> {
    const promise = startSidecar(model).finally(() => (starting = null));
    starting = { model, promise };
    return promise;
  }

  async function ensureSidecar(model: WhisperModelName): Promise<ActiveSidecar> {
    // Loop so that after awaiting an in-flight start for a DIFFERENT model we
    // re-evaluate; the decision-to-spawn path (beginStart) has no await, so the
    // first waiter sets `starting` synchronously and siblings then reuse it.
    for (;;) {
      if (sidecar && sidecar.model === model && !sidecar.proc.killed) return sidecar;
      if (starting && starting.model === model) return starting.promise;
      if (starting) {
        await starting.promise.catch(() => undefined);
        continue;
      }
      if (sidecar && sidecar.model !== model) shutdown();
      return beginStart(model);
    }
  }

  return { ensureSidecar, shutdown };
}

export function createSidecar(
  modelsDir: string,
  serverBinary = "whisper-server",
  logger: WhisperLogger = NOOP_LOGGER,
  extraArgs: readonly string[] = [],
): Sidecar {
  const lifecycle = createStartLifecycle({
    allocatePort: findFreePort,
    spawnServer: defaultSpawnServer(modelsDir, serverBinary, logger, extraArgs),
    waitReady: waitForReadyOrFailure,
    logger,
  });

  async function warmup(model: WhisperModelName): Promise<void> {
    try {
      await lifecycle.ensureSidecar(model);
    } catch (err) {
      logger.warn("sidecar: warmup failed", { model, error: errorMessage(err) });
    }
  }

  async function transcribeWav(wavPath: string, language: string, model: WhisperModelName): Promise<string> {
    const active = await lifecycle.ensureSidecar(model);
    return postInference(active.port, wavPath, language);
  }

  return { transcribeWav, warmup, shutdown: lifecycle.shutdown };
}
