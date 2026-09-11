// Does a bridge actually reach the server on the port it published? (#3078)
//
// The unit tests in `packages/client/test/` pin the resolution RULE. This pins
// the consequence: `createBridgeClient()` driven end to end against two real
// socket.io servers, one of them a decoy on the port the client used to
// hardcode. Which one answers is the only evidence that matters, because the
// failure this fixes is a clean connection to the wrong server — a green rule
// test would look identical either way.
//
// Both servers bind port 0, so the test never races a fixed port and never
// depends on 3001 being free on the runner.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Server as IOServer } from "socket.io";
import { CHAT_SOCKET_PATH, CHAT_SOCKET_EVENTS } from "@mulmobridge/protocol";
import { createBridgeClient, resolveApiUrl, type BridgeClient } from "@mulmobridge/client";

const TOKEN = "published-port-test-token";
const CONNECT_TIMEOUT_MS = 15_000;

/** `address()` is a string for a pipe, which has no port — impossible for a
 *  TCP listener, but a guard beats a cast (and the repo bans `as`). */
const isAddressInfo = (value: AddressInfo | string | null): value is AddressInfo => value !== null && typeof value === "object";

const boundPort = (address: AddressInfo | string | null): number => {
  assert.ok(isAddressInfo(address), "the fake server did not bind a TCP port");
  return address.port;
};

interface FakeServer {
  port: number;
  close: () => Promise<void>;
}

const closeWsServer = (wsServer: IOServer): Promise<void> => new Promise<void>((resolve) => wsServer.close(() => resolve()));
const closeHttpServer = (httpServer: Server): Promise<void> => new Promise<void>((resolve) => httpServer.close(() => resolve()));

/** A server that echoes its own `label` back, so an ack names who answered. */
async function startFakeServer(label: string): Promise<FakeServer> {
  const httpServer = createServer();
  const wsServer = new IOServer(httpServer, { path: CHAT_SOCKET_PATH, transports: ["websocket"] });
  wsServer.use((socket, next) => {
    const { auth } = socket.handshake;
    next(auth.token === TOKEN ? undefined : new Error("invalid token"));
  });
  wsServer.on("connection", (socket) => {
    socket.on(CHAT_SOCKET_EVENTS.message, (_payload: unknown, ack?: (reply: unknown) => void) => {
      ack?.({ ok: true, reply: label });
    });
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const port = boundPort(httpServer.address());
  const close = async (): Promise<void> => {
    await closeWsServer(wsServer);
    await closeHttpServer(httpServer);
  };
  return { port, close };
}

/** Resolves false rather than hanging when the bridge reached nothing. */
function waitForConnect(client: BridgeClient): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CONNECT_TIMEOUT_MS);
    client.onConnect(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** The reply from whichever server the bridge reached, or a failure marker. */
async function askWhoAnswered(): Promise<string> {
  const client = createBridgeClient({ transportId: "cli", options: {} });
  try {
    const connected = await waitForConnect(client);
    if (!connected) return "nothing answered";
    const ack = await client.send("chat-1", "who are you?");
    return ack.reply ?? `no reply (${ack.error ?? "unknown"})`;
  } finally {
    client.close();
  }
}

const ENV_KEYS = ["MULMOCLAUDE_WORKSPACE_PATH", "MULMOCLAUDE_API_URL", "MULMOCLAUDE_AUTH_TOKEN"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

let workspace = "";
let real: FakeServer;
let decoy: FakeServer;
const saved: Partial<Record<EnvKey, string | undefined>> = {};

before(async () => {
  [real, decoy] = await Promise.all([startFakeServer("real"), startFakeServer("decoy")]);
  workspace = mkdtempSync(path.join(tmpdir(), "mulmo-published-port-"));
  writeFileSync(path.join(workspace, ".session-token"), `${TOKEN}\n`, "utf-8");
  ENV_KEYS.forEach((key) => {
    saved[key] = process.env[key];
  });
  process.env.MULMOCLAUDE_WORKSPACE_PATH = workspace;
  delete process.env.MULMOCLAUDE_API_URL;
  delete process.env.MULMOCLAUDE_AUTH_TOKEN;
});

after(async () => {
  await Promise.all([real.close(), decoy.close()]);
  rmSync(workspace, { recursive: true, force: true });
  ENV_KEYS.forEach((key) => {
    const value = saved[key];
    if (value === undefined) process.env[key] = undefined;
    else process.env[key] = value;
  });
});

const publishPort = (port: number): void => {
  writeFileSync(path.join(workspace, ".server-port"), `${port}\n`, "utf-8");
};

describe("a bridge reaches the server that published its port (#3078)", () => {
  it("connects to the published port, not to the one it used to hardcode", async () => {
    publishPort(real.port);
    assert.equal(await askWhoAnswered(), "real");
  });

  it("follows the file when the server moves — the same bridge code, a new port", async () => {
    publishPort(decoy.port);
    assert.equal(await askWhoAnswered(), "decoy", "a second read must follow the file, not a cached first answer");
  });

  it("an explicit MULMOCLAUDE_API_URL still overrides the published port", async () => {
    publishPort(real.port);
    process.env.MULMOCLAUDE_API_URL = `http://127.0.0.1:${decoy.port}`;
    try {
      assert.equal(await askWhoAnswered(), "decoy");
    } finally {
      delete process.env.MULMOCLAUDE_API_URL;
    }
  });

  it("an unusable published value is ignored rather than followed", () => {
    writeFileSync(path.join(workspace, ".server-port"), "not-a-port\n", "utf-8");
    assert.equal(resolveApiUrl(), "http://localhost:3001", "falls back rather than resolving to NaN");
  });

  it("the token comes from the same workspace the port does", async () => {
    publishPort(real.port);
    // No MULMOCLAUDE_AUTH_TOKEN: the only way to authenticate is the
    // `.session-token` beside `.server-port`, which the server writes as its pair.
    assert.equal(await askWhoAnswered(), "real");
  });
});
