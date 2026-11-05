// The launcher's wait for a freshly spawned server (#3623).
//
// The defect was a SILENT give-up: a slow boot past a fixed window opened no
// browser and said nothing. So the cases that matter are the long ones — the
// wait must outlast any window, announce itself exactly once, and stop only
// when the server is gone.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  READY_POLL_INTERVAL_MS,
  SLOW_START_NOTICE_AFTER_MS,
  shouldAnnounceSlowStart,
  slowStartMessage,
  waitUntilReady,
} from "../../server/utils/wait-ready.mjs";

describe("shouldAnnounceSlowStart", () => {
  it("stays quiet before the notice threshold", () => {
    assert.equal(shouldAnnounceSlowStart({ elapsedMs: 0, announced: false }), false);
    assert.equal(shouldAnnounceSlowStart({ elapsedMs: SLOW_START_NOTICE_AFTER_MS - 1, announced: false }), false);
  });

  it("announces at and past the threshold", () => {
    assert.equal(shouldAnnounceSlowStart({ elapsedMs: SLOW_START_NOTICE_AFTER_MS, announced: false }), true);
    assert.equal(shouldAnnounceSlowStart({ elapsedMs: SLOW_START_NOTICE_AFTER_MS * 10, announced: false }), true);
  });

  it("never announces twice", () => {
    assert.equal(shouldAnnounceSlowStart({ elapsedMs: SLOW_START_NOTICE_AFTER_MS, announced: true }), false);
    assert.equal(shouldAnnounceSlowStart({ elapsedMs: SLOW_START_NOTICE_AFTER_MS * 10, announced: true }), false);
  });

  it("stays quiet for a clock that went backwards or is not a number", () => {
    assert.equal(shouldAnnounceSlowStart({ elapsedMs: -1, announced: false }), false);
    assert.equal(shouldAnnounceSlowStart({ elapsedMs: Number.NaN, announced: false }), false);
  });
});

describe("slowStartMessage", () => {
  const url = "http://localhost:3001";

  it("names the URL to open by hand and says the browser is coming", () => {
    const message = slowStartMessage(url, { willOpenBrowser: true });
    assert.ok(message.includes(url));
    assert.match(message, /browser opens/);
  });

  it("does not promise a browser under --no-open", () => {
    const message = slowStartMessage(url, { willOpenBrowser: false });
    assert.ok(message.includes(url));
    assert.doesNotMatch(message, /browser opens/);
  });
});

interface FakeRun {
  answerAfterProbes: number;
  dieAfterProbes?: number;
}

// A virtual clock advanced only by `sleep`, so a boot of many minutes runs instantly.
async function runWait({ answerAfterProbes, dieAfterProbes }: FakeRun) {
  const clock = { nowMs: 0, probes: 0, notices: 0 };
  const ready = await waitUntilReady({
    port: 3001,
    isServerAlive: () => dieAfterProbes === undefined || clock.probes < dieAfterProbes,
    onSlowStart: () => {
      clock.notices += 1;
    },
    probe: async () => {
      clock.probes += 1;
      return clock.probes > answerAfterProbes;
    },
    sleep: async (waitMs) => {
      clock.nowMs += waitMs;
    },
    now: () => clock.nowMs,
  });
  return { ready, ...clock };
}

const PROBES_PER_NOTICE_WINDOW = Math.ceil(SLOW_START_NOTICE_AFTER_MS / READY_POLL_INTERVAL_MS);

describe("waitUntilReady", () => {
  it("is ready on the first probe without a notice", async () => {
    const run = await runWait({ answerAfterProbes: 0 });
    assert.deepEqual([run.ready, run.probes, run.notices], [true, 1, 0]);
  });

  it("is ready before the threshold without a notice", async () => {
    const run = await runWait({ answerAfterProbes: PROBES_PER_NOTICE_WINDOW - 1 });
    assert.deepEqual([run.ready, run.notices], [true, 0]);
  });

  it("keeps waiting far past the old fixed window and announces exactly once", async () => {
    const run = await runWait({ answerAfterProbes: PROBES_PER_NOTICE_WINDOW * 40 });
    assert.equal(run.ready, true);
    assert.equal(run.notices, 1);
    assert.ok(run.nowMs > SLOW_START_NOTICE_AFTER_MS * 30);
  });

  it("stops when the server dies before answering", async () => {
    const run = await runWait({ answerAfterProbes: Number.POSITIVE_INFINITY, dieAfterProbes: 5 });
    assert.deepEqual([run.ready, run.probes], [false, 5]);
  });

  it("is not ready when the server dies while a successful probe is in flight", async () => {
    const run = await runWait({ answerAfterProbes: 0, dieAfterProbes: 1 });
    assert.deepEqual([run.ready, run.probes], [false, 1]);
  });

  it("does not probe a server that is already gone", async () => {
    const run = await runWait({ answerAfterProbes: 0, dieAfterProbes: 0 });
    assert.deepEqual([run.ready, run.probes], [false, 0]);
  });
});
