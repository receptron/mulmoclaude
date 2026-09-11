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

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Server as IOServer } from "socket.io";
import { CHAT_SOCKET_PATH, CHAT_SOCKET_EVENTS } from "@mulmobridge/protocol";
import { createBridgeClient, type BridgeClient } from "@mulmobridge/client";

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

/** One server generation: its own token, its own port, and it says its own name. */
async function startGeneration(label: string, token: string): Promise<Generation> {
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
    httpServer.listen(0, "127.0.0.1", resolve);
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

const sleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

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
