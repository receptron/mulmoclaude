// `.server-port` must never be readable in a half-written state (#2981).
//
// Codex raised this on the PR that made Vite's proxy follow the file: the
// original write was a plain `writeFile`, which opens with `O_TRUNC`. A reader
// arriving between the truncate and the write sees an EMPTY file and falls back
// to the port that was ASKED for — the occupied one, i.e. exactly the #2650
// mis-wiring the following was meant to end. A reader arriving mid-write can do
// worse: `3002` truncated to `300` parses as a valid port nothing is on.
//
// The property under test is therefore about what a CONCURRENT reader can
// observe, not about the final contents. It fails against a non-atomic write and
// passes against a rename.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { boundPortOf, formatServerPort, getBoundPort, publishServerPort, setBoundPort } from "../../server/workspace/serverPort.js";
import { parsePublishedPort } from "../../scripts/lib/devServerPort.js";

let workspace: string;
let portPath: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "server-port-test-"));
  portPath = path.join(workspace, ".server-port");
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Reads the file as fast as the event loop allows, recording every distinct
 *  state it manages to observe. `<missing>` stands for ENOENT, which is its own
 *  kind of half-written. */
function watchFile(watchedPath: string): { stop: () => Promise<Set<string>> } {
  const observed = new Set<string>();
  const state = { reading: true };
  const loop = (async () => {
    while (state.reading) {
      try {
        observed.add(readFileSync(watchedPath, "utf-8"));
      } catch {
        observed.add("<missing>");
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  return {
    stop: async () => {
      state.reading = false;
      await loop;
      return observed;
    },
  };
}

/** Every observation must be one of the ports that was really published — not a
 *  truncation of one, and not an empty file. */
function assertOnlyWholePorts(observed: Set<string>, ports: number[]): void {
  const allowed = new Set(ports.map(formatServerPort));
  const bad = [...observed].filter((value) => !allowed.has(value));
  assert.deepEqual(bad, [], `a concurrent reader saw a state that is neither port: ${JSON.stringify(bad)}`);
  [...observed].forEach((value) => {
    assert.ok(ports.includes(parsePublishedPort(value) ?? -1), `unusable observation ${JSON.stringify(value)}`);
  });
}

describe("publishServerPort", () => {
  it("writes the port the way a shell hook expects to read it", async () => {
    await publishServerPort(3002, portPath);
    assert.equal(readFileSync(portPath, "utf-8"), "3002\n");
    assert.equal(parsePublishedPort(readFileSync(portPath, "utf-8")), 3002);
  });

  it("replaces an earlier run's port rather than appending to it", async () => {
    writeFileSync(portPath, formatServerPort(3001));
    await publishServerPort(3002, portPath);
    assert.equal(parsePublishedPort(readFileSync(portPath, "utf-8")), 3002);
  });

  // The regression itself. Republish repeatedly while reading as fast as
  // possible; every observation must be a COMPLETE port, never an empty file
  // and never a prefix. `writeFile` fails this on the truncate window.
  it("is never observable half-written by a concurrent reader", async () => {
    const OLD_PORT = 3001;
    const NEW_PORT = 34567; // a different digit count, so a prefix is detectable
    const ROUNDS = 60;
    writeFileSync(portPath, formatServerPort(OLD_PORT));

    // `finally`, so a rejected publish cannot leave the reader looping on
    // `setImmediate` and keep this worker alive after the test has already
    // failed (CodeRabbit, #2981).
    const watcher = watchFile(portPath);
    let observed: Set<string>;
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        await publishServerPort(round % 2 === 0 ? NEW_PORT : OLD_PORT, portPath);
      }
    } finally {
      observed = await watcher.stop();
    }
    assertOnlyWholePorts(observed, [OLD_PORT, NEW_PORT]);
  });
});

// `PORT=0` means "any free port". `app.listen(0)` binds one the OS picks while
// the caller's variable stays `0`, so publishing the REQUEST would tell readers
// nothing — `0` is not a port anything can address, and the dev proxy would have
// no backend to follow (Codex, #2981).
describe("boundPortOf", () => {
  it("prefers the port the listener actually got", () => {
    assert.equal(boundPortOf({ address: "127.0.0.1", family: "IPv4", port: 51234 }, 0), 51234);
  });

  it("still prefers it when a real port was requested and honoured", () => {
    assert.equal(boundPortOf({ address: "127.0.0.1", family: "IPv4", port: 3001 }, 3001), 3001);
  });

  it("reports the walked-to port, not the one that was busy", () => {
    assert.equal(boundPortOf({ address: "127.0.0.1", family: "IPv4", port: 3002 }, 3001), 3002);
  });

  it("falls back to the request for an address that has no port", () => {
    // A pipe or UNIX socket: `address()` is a string there.
    assert.equal(boundPortOf("/tmp/some.sock", 3001), 3001);
    assert.equal(boundPortOf(null, 3001), 3001);
  });

  it("never publishes a value a reader would reject", async () => {
    // The end-to-end shape of the PORT=0 case: bind ephemeral, publish, parse.
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await publishServerPort(boundPortOf(server.address(), 0), portPath);
      const parsed = parsePublishedPort(readFileSync(portPath, "utf-8"));
      assert.ok(parsed !== null && parsed > 0, `PORT=0 must publish a usable port, got ${String(parsed)}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// #3055: the bound port has an IN-PROCESS reader too. The agent route hands it
// to the MCP broker as its `BASE_URL`, so a second instance that walked off a
// busy default used to send its broker to the FIRST instance — where the
// stateless plugin dispatch succeeds and the session-scoped tool-result push is
// dropped, leaving every plugin view blank with nothing in the log.
describe("bound port, in-process", () => {
  it("reports the port that was set, not the one that was requested", () => {
    setBoundPort(3002);
    assert.equal(getBoundPort(), 3002);
  });

  it("survives being set to an ephemeral port", () => {
    setBoundPort(54321);
    assert.equal(getBoundPort(), 54321);
  });
});
