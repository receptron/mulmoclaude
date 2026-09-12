// Regression: the shutdown deadline must survive an empty event loop.
//
// `runShutdown` races the bridge's shutdown task against a timer. The timer was
// `unref`ed at first, which reads as harmless tidiness and is not: with nothing
// else referenced, Node empties its loop and exits BEFORE the timer fires, so
// neither the "did not finish" line nor the `exit(0)` after it ever runs. An
// in-process test cannot see that — the test runner itself keeps the loop alive
// — so this one spawns a child whose only remaining handle is that timer.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixture-hanging-shutdown.ts");
const GRACE_MS = 200;
const TEST_TIMEOUT_MS = 30_000;

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

// Windows has no catchable SIGTERM: `subprocess.kill()` terminates the target
// unconditionally whatever name it is given, so the child dies before its
// handler runs and the deadline this test exists to measure never starts. The
// fixture therefore also accepts the request on stdin, which lands in the same
// `process.on("SIGTERM")` handler — so only the door changes, not what is
// observed. POSIX keeps the real signal: nothing else in the repo proves an
// actual OS signal reaches a bridge's handler (the sibling suite synthesises it
// with `process.emit`), and that coverage is worth keeping where it is possible.
const requestShutdown = (child: ReturnType<typeof spawn>): void => {
  if (process.platform === "win32") child.stdin?.write("shutdown\n");
  else child.kill("SIGTERM");
};

const runUntilShutdown = async (): Promise<ChildResult> =>
  new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, String(GRACE_MS)], {
      cwd: path.join(HERE, "..", "..", ".."),
      // stdin is piped on every platform so the two trigger paths differ in one
      // line rather than in the spawn shape; the fixture unrefs it, so it does
      // not become a second referenced handle and mask what this test measures.
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let startedAt = 0;
    const fail = (err: Error): void => {
      child.kill("SIGKILL");
      reject(err);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Signal only once the guards are installed, or the child would die
      // before it had a handler at all.
      if (startedAt === 0 && stdout.includes("ready")) {
        startedAt = Date.now();
        requestShutdown(child);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", fail);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt }));
  });

describe("installProcessGuards — the shutdown deadline with no other handles", () => {
  it("still reports the timeout and exits 0, rather than the loop draining first", { timeout: TEST_TIMEOUT_MS }, async () => {
    const result = await runUntilShutdown();
    const detail = `code=${String(result.code)} signal=${String(result.signal)} elapsed=${result.elapsedMs}ms stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`;
    assert.match(result.stderr, /\[fixture\] shutdown did not finish within 200ms — exiting anyway/, detail);
    assert.equal(result.signal, null, `the child must exit on its own, not die from the signal — ${detail}`);
    assert.equal(result.code, 0, detail);
    assert.match(result.stdout, /\[fixture\] SIGTERM — shutting down/);
    assert.ok(result.elapsedMs >= GRACE_MS, detail);
  });
});
