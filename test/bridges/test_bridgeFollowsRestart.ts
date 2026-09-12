// Does a bridge survive a server restart on its own? (#3078 A-3)
//
// Before this, it did not: the socket's URL is fixed when the socket is built
// and the token was read once, so a restart left the bridge either rejected
// (`invalid token`) or addressing a port nobody was on. The client printed
// "re-run the bridge" and stopped — which is where "I restart the server and
// then restart every bridge by hand" came from.
//
// The port case is the one worth the machinery. When the port changes the bridge
// never REACHES the new server, so no auth error ever arrives; a supervisor
// watching only for `invalid token` would sit on the dead port indefinitely.
//
// Servers bind port 0, so nothing here races a fixed port.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Server as IOServer } from "socket.io";
import { CHAT_SOCKET_PATH, CHAT_SOCKET_EVENTS } from "@mulmobridge/protocol";
import { createBridgeClient, resolveApiUrl, resolvePublishedApiUrl, type BridgeClient } from "@mulmobridge/client";

const RECONNECT_BUDGET_MS = 25_000;
const POLL_MS = 100;

const isAddressInfo = (value: AddressInfo | string | null): value is AddressInfo => value !== null && typeof value === "object";

interface Generation {
  label: string;
  port: number;
  token: string;
  stop: () => Promise<void>;
}

const closeIo = (server: IOServer): Promise<void> => new Promise((resolve) => server.close(() => resolve()));
const closeHttp = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

/** One server generation: its own token, its own name, and by default a port
 *  the OS picks — `port` is only passed by the case that must sit on 3001. */
async function startGeneration(label: string, token: string, port = 0): Promise<Generation> {
  const httpServer = createServer();
  const wsServer = new IOServer(httpServer, { path: CHAT_SOCKET_PATH, transports: ["websocket"] });
  wsServer.use((socket, next) => {
    const { auth } = socket.handshake;
    next(auth.token === token ? undefined : new Error("invalid token"));
  });
  wsServer.on("connection", (socket) => {
    socket.on(CHAT_SOCKET_EVENTS.message, (_payload: unknown, ack?: (reply: unknown) => void) => {
      ack?.({ ok: true, reply: label });
    });
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(port, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  assert.ok(isAddressInfo(address), "the fake server did not bind a TCP port");
  // A realistic death: the transport drops and the client is left to notice.
  // NOT `disconnectSockets()` — a server-initiated disconnect is a different
  // event (`io server disconnect`) and socket.io deliberately does not
  // auto-reconnect from it, so using it here would test a path the real server
  // never takes while hiding the one it does.
  const stop = async (): Promise<void> => {
    httpServer.closeAllConnections();
    await closeIo(wsServer);
    await closeHttp(httpServer);
  };
  return { label, port: address.port, token, stop };
}

let workspace = "";
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["MULMOCLAUDE_WORKSPACE_PATH", "MULMOCLAUDE_API_URL", "MULMOCLAUDE_AUTH_TOKEN"] as const;

before(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "mulmo-restart-"));
  ENV_KEYS.forEach((key) => {
    saved[key] = process.env[key];
  });
  process.env.MULMOCLAUDE_WORKSPACE_PATH = workspace;
  delete process.env.MULMOCLAUDE_API_URL;
  delete process.env.MULMOCLAUDE_AUTH_TOKEN;
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
  ENV_KEYS.forEach((key) => {
    const value = saved[key];
    if (value === undefined) process.env[key] = undefined;
    else process.env[key] = value;
  });
});

/** What the server publishes on startup. */
function publish(generation: Generation): void {
  writeFileSync(path.join(workspace, ".server-port"), `${generation.port}\n`, "utf-8");
  writeFileSync(path.join(workspace, ".session-token"), `${generation.token}\n`, "utf-8");
}

/** What the server leaves behind when it shuts down cleanly (#3082). */
function unpublish(): void {
  [".server-port", ".session-token"].forEach((name) => {
    const target = path.join(workspace, name);
    if (existsSync(target)) unlinkSync(target);
  });
}

// Every case shares one workspace, so each starts from "nothing published".
// Without this a case that wants an EMPTY workspace inherits the port a previous
// case published — which is how the pinned-token case passed alone and failed in
// the combined run, reaching a dead port instead of the default.
beforeEach(unpublish);

const sleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

/**
 * Fail loudly rather than let the 6-minute ack timeout decide the test.
 *
 * The timer MUST be cleared when `work` wins. `Promise.race` settles, but the
 * losing promise stays alive — so an uncleared timer rejects later with nobody
 * listening, and node:test ends the file with "Promise resolution is still
 * pending but the event loop has already resolved". `unref()` hid that when
 * this file ran alone (the process exited first) and not when it ran beside
 * another (Codex, found by running the combined command).
 */
function withDeadline<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still unsettled after ${budgetMs}ms`)), budgetMs);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/** Poll `send` until the answer names the generation we are waiting for. */
async function waitForGeneration(client: BridgeClient, label: string): Promise<string> {
  const deadline = Date.now() + RECONNECT_BUDGET_MS;
  let last = "never answered";
  while (Date.now() < deadline) {
    if (client.socket.connected) {
      const ack = await client.send("chat-1", "who are you?");
      last = ack.reply ?? `no reply (${ack.error ?? "unknown"})`;
      if (last === label) return last;
    }
    await sleep(POLL_MS);
  }
  return last;
}

describe("a bridge follows the server across a restart (#3078 A-3)", () => {
  it("follows a restart that changes the PORT — the case no auth error announces", async () => {
    const first = await startGeneration("gen-1", "token-1");
    publish(first);
    const client = createBridgeClient({ transportId: "cli", options: {} });
    try {
      assert.equal(await waitForGeneration(client, "gen-1"), "gen-1", "precondition: reached the first generation");

      await first.stop();
      unpublish();
      const second = await startGeneration("gen-2", "token-1"); // same token, new port
      publish(second);
      try {
        assert.equal(await waitForGeneration(client, "gen-2"), "gen-2", "the bridge must follow the new port on its own");
      } finally {
        await second.stop();
      }
    } finally {
      client.close();
    }
  });

  it("follows a restart that changes the TOKEN", async () => {
    const first = await startGeneration("gen-a", "token-a");
    publish(first);
    const client = createBridgeClient({ transportId: "cli", options: {} });
    try {
      assert.equal(await waitForGeneration(client, "gen-a"), "gen-a", "precondition: reached the first generation");

      await first.stop();
      unpublish();
      const second = await startGeneration("gen-b", "token-b");
      publish(second);
      try {
        assert.equal(await waitForGeneration(client, "gen-b"), "gen-b", "the bridge must pick up the new token on its own");
      } finally {
        await second.stop();
      }
    } finally {
      client.close();
    }
  });

  it("survives the window where the restarting server has published nothing", async () => {
    const first = await startGeneration("gen-x", "token-x");
    publish(first);
    const client = createBridgeClient({ transportId: "cli", options: {} });
    try {
      assert.equal(await waitForGeneration(client, "gen-x"), "gen-x", "precondition: reached the first generation");

      await first.stop();
      unpublish();
      // Long enough for several re-reads to find no token at all. The process
      // must not exit here — `requireBearerToken()`'s exit is a STARTUP path.
      await sleep(2000);
      const second = await startGeneration("gen-y", "token-y");
      publish(second);
      try {
        assert.equal(await waitForGeneration(client, "gen-y"), "gen-y", "an absent sidecar must not be fatal mid-life");
      } finally {
        await second.stop();
      }
    } finally {
      client.close();
    }
  });

  // The window #3082's startup clear deliberately creates: the new token is
  // written BEFORE the new port is published, so "token, no port" is a real and
  // frequent state. Resolving it through the startup default would take a
  // freshly minted bearer token to whatever holds 3001 (Codex).
  it("will not rebuild against the default while only the token half is published", async () => {
    const first = await startGeneration("gen-only-token", "token-before");
    publish(first);
    const client = createBridgeClient({ transportId: "cli", options: {} });
    try {
      assert.equal(await waitForGeneration(client, "gen-only-token"), "gen-only-token");
      const original = client.socket;

      await first.stop();
      unpublish();
      // Exactly the gap: a new token on disk, no port yet.
      writeFileSync(path.join(workspace, ".session-token"), "token-after\n", "utf-8");
      await sleep(3000);

      assert.equal(client.socket, original, "half a generation must not trigger a rebuild");
      assert.equal(resolvePublishedApiUrl(undefined), null, "the runtime resolver must report the absent port rather than the default");
      assert.equal(resolveApiUrl(undefined), "http://localhost:3001", "the STARTUP resolver still has its default");
    } finally {
      client.close();
    }
  });

  // The same window at STARTUP, which is the wider one: `setupSandbox()` runs
  // between the server writing the token and binding its port, and on a cold
  // start that can build a Docker image — minutes, not milliseconds. A bridge
  // launched in there must not hand its fresh token to whatever holds 3001
  // (Codex).
  it("waits rather than connecting to the default when started with a token but no port", async () => {
    writeFileSync(path.join(workspace, ".session-token"), "token-early\n", "utf-8");
    const client = createBridgeClient({ transportId: "cli", options: {} });
    try {
      await sleep(1500);
      assert.equal(client.socket.connected, false, "nothing may be connected while no port is published");
      assert.equal(client.socket.active, false, "and it must not be attempting a connection either");

      // Once the server finishes starting, the wait ends on its own.
      const late = await startGeneration("gen-late", "token-early");
      publish(late);
      try {
        assert.equal(await waitForGeneration(client, "gen-late"), "gen-late", "the wait must end when the port appears");
      } finally {
        await late.stop();
      }
    } finally {
      client.close();
    }
  });

  // The other half of that rule (Codex, round-5 checkpoint): a caller who pinned
  // MULMOCLAUDE_AUTH_TOKEN is pointing this bridge somewhere deliberately — a
  // container without the workspace mounted, say — so there is no fresh secret
  // to strand and refusing the documented default would break a setup that
  // worked. They keep it.
  it("still uses the default when the CALLER pinned the token", async () => {
    // No `.session-token` on disk at all: the only credential is the env one.
    const onDefaultPort = await startGeneration("gen-default", "pinned-token", 3001);
    process.env.MULMOCLAUDE_AUTH_TOKEN = "pinned-token";
    const client = createBridgeClient({ transportId: "cli", options: {} });
    try {
      assert.equal(await waitForGeneration(client, "gen-default"), "gen-default", "a pinned token keeps the documented fallback");
    } finally {
      client.close();
      delete process.env.MULMOCLAUDE_AUTH_TOKEN;
      await onDefaultPort.stop();
    }
  });

  // The wait has to hold the PROCESS open, and only a real process can show it:
  // inside node:test the runner keeps the loop alive, so a client that gives the
  // loop nothing to wait on still looks like it is waiting. Spawned as a child,
  // with a workspace token and no port, an earlier version printed "waiting for
  // it" and exited immediately (Codex).
  it("keeps a bridge process alive while it waits for the port", async () => {
    writeFileSync(path.join(workspace, ".session-token"), "token-alive\n", "utf-8");
    const fixture = fileURLToPath(new URL("./fixtures/minimal-bridge.mjs", import.meta.url));
    const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const child = spawn("node", ["--import", `file://${loader}`, fixture], {
      env: { ...process.env, MULMOCLAUDE_WORKSPACE_PATH: workspace, MULMOCLAUDE_API_URL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    try {
      const verdict = await Promise.race([exited, sleep(5000).then(() => "still running" as const)]);
      assert.equal(verdict, "still running", "the bridge exited instead of waiting for the port");
    } finally {
      child.kill("SIGKILL");
    }
  });

  // A send issued while the socket is already disconnected is QUEUED by
  // socket.io for a reconnection that will never happen — the socket is being
  // replaced, not reconnected — so its callback would sit for the full
  // 6-minute ack timeout. The bridge's user would wait six minutes for a
  // message the client already knows it cannot deliver (Codex).
  it("fails a send the replaced socket can never acknowledge, instead of timing out", async () => {
    const first = await startGeneration("gen-p", "token-p");
    publish(first);
    const client = createBridgeClient({ transportId: "cli", options: {} });
    try {
      assert.equal(await waitForGeneration(client, "gen-p"), "gen-p");

      await first.stop();
      // Wait for the socket to notice, so the send is QUEUED rather than in flight.
      while (client.socket.connected) await sleep(50);
      const queued = client.send("chat-1", "sent into the outage");

      unpublish();
      const second = await startGeneration("gen-q", "token-q");
      publish(second);
      try {
        const ack = await withDeadline(queued, 20_000);
        assert.equal(ack.ok, false, "the abandoned send must report failure");
        assert.match(ack.error ?? "", /restarted/, `expected a restart error, got ${JSON.stringify(ack)}`);
        // And the client itself is healthy on the new generation.
        assert.equal(await waitForGeneration(client, "gen-q"), "gen-q");
      } finally {
        await second.stop();
      }
    } finally {
      client.close();
    }
  });

  // Resource safety: one replaced socket per restart is fine, a manager that
  // keeps hammering the dead port after being replaced is a leak that grows.
  it("stops the socket it replaced", async () => {
    const first = await startGeneration("gen-old", "token-old");
    publish(first);
    const client = createBridgeClient({ transportId: "cli", options: {} });
    try {
      assert.equal(await waitForGeneration(client, "gen-old"), "gen-old");
      const replaced = client.socket;

      await first.stop();
      unpublish();
      const second = await startGeneration("gen-new", "token-new");
      publish(second);
      try {
        assert.equal(await waitForGeneration(client, "gen-new"), "gen-new");
        assert.notEqual(client.socket, replaced, "precondition: the socket was actually replaced");
        await sleep(2000);
        assert.equal(replaced.connected, false, "the replaced socket must not be connected");
        assert.equal(replaced.active, false, "the replaced socket must not still be reconnecting");
      } finally {
        await second.stop();
      }
    } finally {
      client.close();
    }
  });

  it("does not replace the socket while the pair is unchanged", async () => {
    const only = await startGeneration("gen-solo", "token-solo");
    publish(only);
    const client = createBridgeClient({ transportId: "cli", options: {} });
    try {
      assert.equal(await waitForGeneration(client, "gen-solo"), "gen-solo");
      const original = client.socket;
      // A server that is merely unreachable must keep socket.io's own
      // reconnection rather than a worse copy of it built out of new sockets.
      await only.stop();
      await sleep(2500);
      assert.equal(client.socket, original, "the socket must survive a failure the sidecars do not explain");
    } finally {
      client.close();
    }
  });
});
