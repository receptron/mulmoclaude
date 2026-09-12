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

import { installProcessGuards } from "../src/processGuards.ts";

const graceMs = Number(process.argv[2]);
const HEARTBEAT_MS = 1_000;

const whileRunning = setInterval(() => {}, HEARTBEAT_MS);

installProcessGuards({
  name: "fixture",
  graceMs,
  onShutdown: () => {
    clearInterval(whileRunning);
    return new Promise<void>(() => {}); // never settles
  },
});

console.log("ready");
