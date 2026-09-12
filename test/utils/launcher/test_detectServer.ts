// Tests for `server/utils/launcher/detect-server.mjs` — telling "our
// server is already up" apart from "someone else has the port" and
// "nobody is there". Getting this wrong either starts a second server
// or hands the user a stranger's web page.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { classifyHealthProbe, detectRunningServer, findRunningServerPort } from "../../../server/utils/launcher/detect-server.mjs";
import type { ServerPresence } from "../../../server/utils/launcher/detect-server.d.mts";
import { MAX_PORT_PROBES } from "../../../server/utils/port.mjs";

// Longer than the probe's own total deadline (5s), so a failure here means
// the probe really never settled rather than that the test was impatient.
const STREAM_GIVE_UP_MS = 15_000;

describe("classifyHealthProbe", () => {
  it("reads a 401 as MulmoClaude — /api/health sits behind bearerAuth, so that IS our answer", () => {
    assert.equal(classifyHealthProbe({ status: 401, body: '{"error":"unauthorized"}' }), "mulmoclaude");
  });

  it("reads the real health body when auth is bypassed", () => {
    assert.equal(classifyHealthProbe({ status: 200, body: '{"status":"OK","version":"1.7.1"}' }), "mulmoclaude");
  });

  it("does not take a bare 200 as ours — any web server returns that", () => {
    assert.equal(classifyHealthProbe({ status: 200, body: "<html>someone else</html>" }), "foreign");
    assert.equal(classifyHealthProbe({ status: 200, body: '{"status":"different"}' }), "foreign");
    assert.equal(classifyHealthProbe({ status: 200 }), "foreign");
  });

  it("reads another app's 404 as foreign", () => {
    assert.equal(classifyHealthProbe({ status: 404, body: "not found" }), "foreign");
  });

  it("reads a connection error as nobody being there", () => {
    assert.equal(classifyHealthProbe({ errorCode: "ECONNREFUSED" }), "absent");
    assert.equal(classifyHealthProbe({ errorCode: "ETIMEDOUT" }), "absent");
  });
});

const listen = async (handler: Parameters<typeof createServer>[1]): Promise<Server> => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
};

const portOf = (server: Server) => (server.address() as AddressInfo).port;

describe("detectRunningServer", () => {
  it("detects a bearer-protected MulmoClaude", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(401);
      res.end('{"error":"unauthorized"}');
    });
    try {
      assert.equal(await detectRunningServer(portOf(server)), "mulmoclaude");
    } finally {
      server.close();
    }
  });

  it("detects an unrelated server on the port", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(404);
      res.end("nope");
    });
    try {
      assert.equal(await detectRunningServer(portOf(server)), "foreign");
    } finally {
      server.close();
    }
  });

  it("resolves 'absent' instead of rejecting when nothing is listening", async () => {
    const server = await listen((_req, res) => res.end());
    const port = portOf(server);
    server.close();
    await once(server, "close");
    assert.equal(await detectRunningServer(port), "absent");
  });

  // The socket `timeout` option is an INACTIVITY timeout, so a response that
  // keeps dribbling never trips it and never emits `end`. The probe used to
  // stay pending forever on one, which since #3079 means a launch that hangs
  // with nothing printed — `refuseSecondInstance` awaits this on the startup
  // path of every `yarn dev` (CodeRabbit review, PR #3107).
  it("gives up on a foreign server that streams forever instead of answering", async () => {
    const dribblers: ReturnType<typeof setInterval>[] = [];
    const server = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
      // Comfortably under the inactivity timeout, so only a TOTAL deadline ends this.
      dribblers.push(setInterval(() => res.write(" "), 250));
    });
    try {
      const settled = await Promise.race([
        detectRunningServer(portOf(server)),
        new Promise<"__pending__">((resolve) => setTimeout(() => resolve("__pending__"), STREAM_GIVE_UP_MS)),
      ]);
      assert.notEqual(settled, "__pending__", "the probe never settled — a launch awaiting it would hang");
      assert.equal(settled, "absent");
    } finally {
      dribblers.forEach(clearInterval);
      server.close();
    }
  });
});

describe("findRunningServerPort", () => {
  // A stub presence map keeps these deterministic: the real probe would
  // depend on whatever happens to be listening on the test machine.
  const probeFrom =
    (byPort: Record<number, ServerPresence>) =>
    (port: number): Promise<ServerPresence> =>
      Promise.resolve(byPort[port] ?? "absent");

  it("finds MulmoClaude on the default port", async () => {
    assert.equal(await findRunningServerPort(3001, { probe: probeFrom({ 3001: "mulmoclaude" }) }), 3001);
  });

  it("finds it on a fallback port — the case that used to start a second server", async () => {
    // 3001 taken by something else, MulmoClaude pushed to 3002 by an
    // earlier launch. Probing only 3001 would report "foreign" and
    // launch yet another instance on 3003, and again on every click.
    const presence = probeFrom({ 3001: "foreign", 3002: "mulmoclaude" });
    assert.equal(await findRunningServerPort(3001, { probe: presence }), 3002);
  });

  it("returns null when nothing in the window is ours", async () => {
    assert.equal(await findRunningServerPort(3001, { probe: probeFrom({ 3001: "foreign", 3005: "foreign" }) }), null);
  });

  it("prefers the lowest port when several answer", async () => {
    const presence = probeFrom({ 3002: "mulmoclaude", 3004: "mulmoclaude" });
    assert.equal(await findRunningServerPort(3001, { probe: presence }), 3002);
  });

  it("scans exactly the window findAvailablePort can hand out", async () => {
    const probed: number[] = [];
    await findRunningServerPort(3001, {
      probe: (port) => {
        probed.push(port);
        return Promise.resolve("absent");
      },
    });
    assert.equal(probed.length, MAX_PORT_PROBES);
    assert.equal(Math.min(...probed), 3001);
    assert.equal(Math.max(...probed), 3001 + MAX_PORT_PROBES - 1);
  });

  it("still finds the instance sitting on the last port of the window", async () => {
    const lastPort = 3001 + MAX_PORT_PROBES - 1;
    assert.equal(await findRunningServerPort(3001, { probe: probeFrom({ [lastPort]: "mulmoclaude" }) }), lastPort);
  });
});
