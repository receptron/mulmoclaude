// Process-level guards for a bridge (#3084).
//
// A bridge is a long-lived process a user starts in a terminal and leaves
// running, and none of the 25 had any of these:
//
//   - `unhandledRejection` — Node 15+ terminates the process, so ONE missed
//     `await` anywhere took the bot down leaving a bare stack trace that names
//     no bridge. From the outside that is "the bot just stopped answering".
//   - `uncaughtException` — the same, for a throw off the call stack.
//   - `SIGINT` / `SIGTERM` — Ctrl-C killed the process mid-flight, dropping a
//     webhook that was being handled or updates already fetched and unprocessed.
//
// Installing a handler for the first two SUPPRESSES Node's own exit, so both
// re-exit explicitly: the aim is a legible message, not a survivable error. No
// restart logic lives here — a supervisor belongs to whatever started the
// bridge (#3080), and two of them would fight.

import { errorMessage } from "@mulmoclaude/common";

/** Release resources and stop accepting work. May be async. */
export type ShutdownTask = () => void | Promise<void>;

export interface ProcessGuardOptions {
  /** Transport id, used as the log prefix so the line says WHICH bridge died. */
  name: string;
  /** Runs once, on the first signal, before the process exits. */
  onShutdown?: ShutdownTask;
  /** Test seam; production ends the process. */
  exit?: (code: number) => void;
  /** How long a shutdown task may take before the process leaves anyway.
   *  Defaults to `SHUTDOWN_GRACE_MS`; tests shorten it. */
  graceMs?: number;
}

/** A shutdown task that hangs must not hold the terminal hostage. */
export const SHUTDOWN_GRACE_MS = 5_000;

export function installProcessGuards(opts: ProcessGuardOptions): void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  installCrashGuards(opts.name, exit);
  installSignalGuards(opts, exit);
}

function installCrashGuards(name: string, exit: (code: number) => void): void {
  process.on("unhandledRejection", (reason: unknown) => {
    console.error(`[${name}] unhandled rejection — exiting: ${errorMessage(reason)}`);
    if (reason instanceof Error && reason.stack !== undefined) console.error(reason.stack);
    exit(1);
  });
  process.on("uncaughtException", (err: unknown) => {
    console.error(`[${name}] uncaught exception — exiting: ${errorMessage(err)}`);
    if (err instanceof Error && err.stack !== undefined) console.error(err.stack);
    exit(1);
  });
}

function installSignalGuards(opts: ProcessGuardOptions, exit: (code: number) => void): void {
  let shuttingDown = false;
  const handle = (signal: string): void => {
    if (shuttingDown) {
      // Someone pressed Ctrl-C twice because the first one looked stuck. Honour
      // the impatience rather than waiting out the grace period.
      console.error(`[${opts.name}] ${signal} again — exiting now`);
      exit(1);
      return;
    }
    shuttingDown = true;
    console.log(`[${opts.name}] ${signal} — shutting down`);
    void runShutdown(opts.name, opts.onShutdown, opts.graceMs ?? SHUTDOWN_GRACE_MS).then(() => exit(0));
  };
  (["SIGINT", "SIGTERM"] as const).forEach((signal) => process.on(signal, () => handle(signal)));
}

async function runShutdown(name: string, task: ShutdownTask | undefined, graceMs: number): Promise<void> {
  if (task === undefined) return;
  // The deadline timer stays REFERENCED, and is cleared once the race settles.
  // An `unref`ed one looks tidier and silently breaks the guarantee: a shutdown
  // task that hangs after the last other handle closed lets Node empty its loop
  // and exit before the timer fires, so neither the message below nor the
  // `exit(0)` that follows this call ever runs. Keeping it referenced is what
  // holds the process open for exactly as long as the grace period.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(task()),
      new Promise<void>((resolve) => {
        deadline = setTimeout(() => {
          console.error(`[${name}] shutdown did not finish within ${graceMs}ms — exiting anyway`);
          resolve();
        }, graceMs);
      }),
    ]);
  } catch (err) {
    console.error(`[${name}] shutdown task failed: ${errorMessage(err)}`);
  } finally {
    // A fast shutdown must not wait out the rest of the grace period.
    if (deadline !== undefined) clearTimeout(deadline);
  }
}
