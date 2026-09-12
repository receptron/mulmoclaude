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

const runUntilShutdown = async (): Promise<ChildResult> =>
  new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, String(GRACE_MS)], {
      cwd: path.join(HERE, "..", "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
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
        child.kill("SIGTERM");
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
