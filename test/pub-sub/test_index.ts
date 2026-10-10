import { describe, it, before, after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import { io as connect, type Socket } from "socket.io-client";
import { createPubSub, type IPubSub } from "../../server/events/pub-sub/index.js";
import { log } from "../../server/system/logger/index.js";
import { ONE_SECOND_MS } from "../../server/utils/time.js";

// Round-trip test for the socket.io-backed pub/sub transport.
// Boots a real HTTP server on an ephemeral port, attaches the
// pub/sub, connects a real socket.io-client, and asserts that a
// server-side `publish()` is fanned out to subscribed clients and
// NOT delivered to clients that haven't subscribed — and that the
// handshake is refused without the bearer token (#3433).

const VALID_TOKEN = "a".repeat(64);
const ROTATED_TOKEN = "b".repeat(64);
// Every wait below is a few ms on an idle machine; the cap turns a late room
// join under load into a red test instead of a hung `yarn test`.
const SUITE_TIMEOUT_MS = 30 * ONE_SECOND_MS;

interface Refusal {
  message: string;
  /** socket.io's "will retry" flag; the SPA reads `false` as "stop and tell the user". */
  active: boolean;
}

describe("pub-sub (socket.io round trip)", { timeout: SUITE_TIMEOUT_MS }, () => {
  let server: http.Server;
  let pubsub: IPubSub;
  let url: string;
  // What the server accepts right now; tests rotate it and `afterEach` restores it.
  let serverToken: string | null = VALID_TOKEN;

  before(async () => {
    server = http.createServer();
    pubsub = createPubSub(server, { tokenProvider: () => serverToken });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    serverToken = VALID_TOKEN;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function openSocket(auth: Record<string, unknown> | undefined): Socket {
    // `reconnection: false`: a refused handshake is never retried anyway, and a
    // transport error must fail the test rather than hang in a retry loop.
    return connect(url, { path: "/ws/pubsub", transports: ["websocket"], reconnection: false, ...(auth === undefined ? {} : { auth }) });
  }

  async function connected(auth: Record<string, unknown> = { token: VALID_TOKEN }): Promise<Socket> {
    const socket = openSocket(auth);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    return socket;
  }

  async function refused(auth: Record<string, unknown> | undefined): Promise<Refusal> {
    const socket = openSocket(auth);
    try {
      return await new Promise<Refusal>((resolve, reject) => {
        socket.once("connect", () => reject(new Error("handshake was accepted")));
        socket.once("connect_error", (err) => resolve({ message: err.message, active: socket.active }));
      });
    } finally {
      // Also on the accepted path: an open socket keeps `server.close()`
      // waiting, which turns a red test into a hung run.
      socket.disconnect();
    }
  }

  it("delivers publish() to a subscribed client", async () => {
    const socket = await connected();
    const received = new Promise<unknown>((resolve) => socket.once("data", (msg) => resolve(msg)));
    socket.emit("subscribe", "alpha");
    // Wait for the subscribe to register as a room join before
    // publishing — socket.io rooms join synchronously on the
    // server once the event handler runs, but the handler runs
    // on the next tick after the emit. One microtask yield is
    // plenty.
    await new Promise((resolve) => setTimeout(resolve, 20));
    pubsub.publish("alpha", { hello: "world" });
    const msg = await received;
    assert.deepEqual(msg, { channel: "alpha", data: { hello: "world" } });
    socket.disconnect();
  });

  it("does not deliver to non-subscribers", async () => {
    const sub = await connected();
    const other = await connected();
    sub.emit("subscribe", "beta");
    await new Promise((resolve) => setTimeout(resolve, 20));

    let otherGotData = false;
    other.on("data", () => {
      otherGotData = true;
    });

    const received = new Promise<unknown>((resolve) => sub.once("data", (msg) => resolve(msg)));
    pubsub.publish("beta", { n: 1 });
    await received;
    // Give the "other" client a tick to receive (and thus fail).
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(otherGotData, false);

    sub.disconnect();
    other.disconnect();
  });

  it("stops delivering after unsubscribe", async () => {
    const socket = await connected();
    socket.emit("subscribe", "gamma");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // First publish — should arrive.
    const first = new Promise<unknown>((resolve) => socket.once("data", (msg) => resolve(msg)));
    pubsub.publish("gamma", { seq: 1 });
    await first;

    // Now unsubscribe.
    socket.emit("unsubscribe", "gamma");
    await new Promise((resolve) => setTimeout(resolve, 20));

    let got = false;
    socket.on("data", () => {
      got = true;
    });
    pubsub.publish("gamma", { seq: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(got, false);
    socket.disconnect();
  });

  describe("handshake auth (#3433)", () => {
    it("refuses a handshake with no auth payload, and socket.io does not retry it", async () => {
      assert.deepEqual(await refused(undefined), { message: "unauthorized", active: false });
    });

    it("refuses a wrong token with the same generic message", async () => {
      assert.deepEqual(await refused({ token: ROTATED_TOKEN }), { message: "unauthorized", active: false });
    });

    it("refuses an auth payload that carries no token", async () => {
      assert.deepEqual(await refused({ transportId: "spa" }), { message: "unauthorized", active: false });
    });

    it("refuses every handshake while the server has no token yet", async () => {
      serverToken = null;
      assert.equal((await refused({ token: VALID_TOKEN })).message, "unauthorized");
    });

    it("keeps an established connection across a token rotation, and refuses the old token on a new handshake", async () => {
      const established = await connected();
      established.emit("subscribe", "delta");
      await new Promise((resolve) => setTimeout(resolve, 20));

      serverToken = ROTATED_TOKEN;
      const received = new Promise<unknown>((resolve) => established.once("data", (msg) => resolve(msg)));
      pubsub.publish("delta", { seq: 1 });
      assert.deepEqual(await received, { channel: "delta", data: { seq: 1 } });

      assert.equal((await refused({ token: VALID_TOKEN })).message, "unauthorized");
      const fresh = await connected({ token: ROTATED_TOKEN });
      assert.equal(fresh.connected, true);

      established.disconnect();
      fresh.disconnect();
    });

    // A refused handshake leaves the engine.io connection open, and socket.io
    // runs the middleware again for every further CONNECT packet on it. The
    // raw socket below sends three on one connection.
    it("logs one refusal per connection, however many CONNECT packets it sends", async () => {
      const warn = mock.method(log, "warn");
      const raw = new WebSocket(`${url.replace("http://", "ws://")}/ws/pubsub/?EIO=4&transport=websocket`);
      const wrongConnect = `40${JSON.stringify({ token: ROTATED_TOKEN })}`;
      const CONNECT_ATTEMPTS = 3;
      try {
        const refusals = await new Promise<number>((resolve, reject) => {
          let seen = 0;
          raw.on("error", reject);
          raw.on("message", (data) => {
            const text = String(data);
            if (text.startsWith("0")) {
              Array.from({ length: CONNECT_ATTEMPTS }).forEach(() => raw.send(wrongConnect));
              return;
            }
            if (text.startsWith("44")) {
              seen += 1;
              if (seen === CONNECT_ATTEMPTS) resolve(seen);
            }
          });
        });
        assert.equal(refusals, CONNECT_ATTEMPTS);
        assert.equal(warn.mock.calls.filter((call) => call.arguments[0] === "pubsub").length, 1);
      } finally {
        warn.mock.restore();
        raw.close();
      }
    });
  });
});
