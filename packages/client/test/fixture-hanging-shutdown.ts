// Child-process fixture for the shutdown-deadline regression test.
//
// It mirrors what a bridge actually does: hold a referenced handle while
// running (a server, a socket — here an interval), release it when the signal
// arrives, and then take too long to finish. At that moment the deadline timer
// inside `installProcessGuards` is the ONLY thing left holding the event loop —
// exactly the case an `unref`ed timer got wrong, since Node then drains the loop
// and exits before the grace period elapses.
//
// The handle also has to exist BEFORE the signal: `process.on` does not keep
// Node alive, so without it this fixture exits on its own between printing
// `ready` and the parent's `kill`, and the test passes or fails by luck.
//
// Shutdown can also be asked for over stdin, because on Windows it cannot be
// asked for with a signal at all: `subprocess.kill()` there terminates the
// target unconditionally whichever name you pass, so the handler never runs and
// the child dies in ~14ms with an empty stderr. The line below reaches the SAME
// handler `process.on("SIGTERM")` registered, so what the test observes after
// the trigger is identical on every platform — only the door differs.
//
// `unref` is what keeps that door from changing the thing under test: this
// fixture exists to leave the deadline timer as the ONLY referenced handle, and
// a listened-to stdin would itself hold the loop open and hide a regression.

import { installProcessGuards } from "../src/processGuards.ts";

const graceMs = Number(process.argv[2]);
const HEARTBEAT_MS = 1_000;

const whileRunning = setInterval(() => {}, HEARTBEAT_MS);

process.stdin.on("data", () => process.emit("SIGTERM", "SIGTERM"));
process.stdin.unref();

installProcessGuards({
  name: "fixture",
  graceMs,
  onShutdown: () => {
    clearInterval(whileRunning);
    return new Promise<void>(() => {}); // never settles
  },
});

console.log("ready");
