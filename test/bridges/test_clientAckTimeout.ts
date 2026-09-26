// `send()` waits for the ack as long as the bridge's reply limit says, plus the
// margin (#3305). Driven through `createBridgeClient()` against a real socket.io
// server that never acks, so the test fails if the option stops reaching the
// timer — the resolver's own tests would stay green in that case.
//
// The clock is mocked only AFTER the socket is up: socket.io captures the real
// timer functions when it builds its connection, so the handshake and heartbeat
// keep running on real time while `send()`'s ack timer runs on the mock.

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as IOServer } from "socket.io";
import { ACK_TIMEOUT_MARGIN_MS, CHAT_SOCKET_EVENTS, CHAT_SOCKET_PATH, DEFAULT_REPLY_TIMEOUT_MS, type BridgeOptions } from "@mulmobridge/protocol";
import { createBridgeClient, type BridgeClient, type MessageAck } from "@mulmobridge/client";

const TOKEN = "ack-timeout-test-token";
const CONNECT_TIMEOUT_MS = 15_000;
const CONFIGURED_REPLY_TIMEOUT_MS = 1_000;

const isAddressInfo = (value: AddressInfo | string | null): value is AddressInfo => value !== null && typeof value === "object";

interface SilentServer {
  httpServer: Server;
  wsServer: IOServer;
  url: string;
  handshakeOptions: unknown[];
  messagesReceived: () => number;
}

/** A chat-service stand-in that accepts every message and acks none of them. */
async function startSilentServer(): Promise<SilentServer> {
  const httpServer = createServer();
  const wsServer = new IOServer(httpServer, { path: CHAT_SOCKET_PATH, transports: ["websocket"] });
  const handshakeOptions: unknown[] = [];
  const received = { count: 0 };
  wsServer.on("connection", (socket) => {
    const { auth }: { auth: unknown } = socket.handshake;
    handshakeOptions.push(typeof auth === "object" && auth !== null && "options" in auth ? auth.options : undefined);
    socket.on(CHAT_SOCKET_EVENTS.message, () => {
      received.count += 1;
    });
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  assert.ok(isAddressInfo(address), "the fake server did not bind a TCP port");
  return { httpServer, wsServer, url: `http://127.0.0.1:${address.port}`, handshakeOptions, messagesReceived: () => received.count };
}

async function stopSilentServer(server: SilentServer): Promise<void> {
  await server.wsServer.close();
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
}

async function connectedClient(url: string, options: BridgeOptions): Promise<BridgeClient> {
  const client = createBridgeClient({ transportId: "cli", apiUrl: url, options });
  try {
    await waitFor(() => client.socket.connected, "the client to connect to the fake server");
  } catch (err) {
    // A client left open keeps reconnecting and holds the test process alive.
    client.close();
    throw err;
  }
  return client;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Send one message and report how the ack wait ends against the mocked clock. */
async function observeAckTimeout(server: SilentServer, client: BridgeClient, expectedAckTimeoutMs: number): Promise<void> {
  const sentBefore = server.messagesReceived();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const outcome: { ack?: MessageAck } = {};
    const pendingAck = client.send("chat-1", "hello").then((ack) => {
      outcome.ack = ack;
    });
    await waitFor(() => server.messagesReceived() > sentBefore, "the server to receive the message");

    mock.timers.tick(expectedAckTimeoutMs - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcome.ack, undefined, "send() gave up before its ack limit");

    mock.timers.tick(1);
    await waitFor(() => outcome.ack !== undefined, "send() to give up at its ack limit");
    await pendingAck;
    assert.deepEqual(outcome.ack, { ok: false, error: `timeout: no ack within ${expectedAckTimeoutMs}ms` });
  } finally {
    mock.timers.reset();
  }
}

describe("createBridgeClient — ack limit follows replyTimeoutMs", () => {
  const savedToken = process.env.MULMOCLAUDE_AUTH_TOKEN;
  let server: SilentServer;

  before(async () => {
    process.env.MULMOCLAUDE_AUTH_TOKEN = TOKEN;
    server = await startSilentServer();
  });

  after(async () => {
    await stopSilentServer(server);
    if (savedToken === undefined) delete process.env.MULMOCLAUDE_AUTH_TOKEN;
    else process.env.MULMOCLAUDE_AUTH_TOKEN = savedToken;
  });

  it("waits the configured reply limit plus the margin, and sends that limit to the server", async () => {
    const client = await connectedClient(server.url, { replyTimeoutMs: String(CONFIGURED_REPLY_TIMEOUT_MS) });
    try {
      assert.deepEqual(server.handshakeOptions.at(-1), { replyTimeoutMs: String(CONFIGURED_REPLY_TIMEOUT_MS) });
      await observeAckTimeout(server, client, CONFIGURED_REPLY_TIMEOUT_MS + ACK_TIMEOUT_MARGIN_MS);
    } finally {
      client.close();
    }
  });

  it("keeps the 6-minute wait when nothing is configured", async () => {
    const client = await connectedClient(server.url, {});
    try {
      await observeAckTimeout(server, client, DEFAULT_REPLY_TIMEOUT_MS + ACK_TIMEOUT_MARGIN_MS);
    } finally {
      client.close();
    }
  });
});
