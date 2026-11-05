import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express from "express";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { Server as SocketServer } from "socket.io";
import { UNAUTHORIZED_MESSAGE } from "@mulmoclaude/common/token-guard";
import { attachChatSocket, CHAT_SOCKET_EVENTS, CHAT_SOCKET_PATH, parseAttachments, parseOneAttachment } from "../src/socket.js";
import { createPushQueue } from "../src/push-queue.js";
import type { RelayParams, RelayResult } from "../src/relay.js";
import type { Logger } from "../src/types.js";

/** `items[index]` is `T | undefined` under `noUncheckedIndexedAccess`. Asserting
 *  states the precondition each case already relies on — the length was just
 *  checked, or the collector was asked for exactly this many — and names the
 *  failure instead of throwing on a property of undefined. */
const elementAt = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  assert.ok(item !== undefined, `expected an element at index ${index}, but the list holds ${items.length}`);
  return item;
};

const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

/** The token every harness expects unless a case supplies its own provider:
 *  `tokenProvider` is required, so there is no longer an open mode to test. */
const HARNESS_TOKEN = "harness-token-xyz";

interface HarnessOpts {
  tokenProvider?: () => string | null;
  authorizeToken?: (token: unknown) => boolean;
  revalidateIntervalMs?: number;
}

interface Harness {
  httpServer: http.Server;
  io: SocketServer;
  url: string;
  relayCalls: RelayParams[];
  setRelayResult: (result: RelayResult) => void;
}

async function startHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const app = express();
  const httpServer = http.createServer(app);
  const relayCalls: RelayParams[] = [];
  let nextResult: RelayResult = { kind: "ok", reply: "default" };

  const { io } = attachChatSocket(httpServer, {
    relay: async (params) => {
      relayCalls.push(params);
      return nextResult;
    },
    queue: createPushQueue(),
    logger: silentLogger,
    tokenProvider: opts.tokenProvider ?? (() => HARNESS_TOKEN),
    authorizeToken: opts.authorizeToken,
    revalidateIntervalMs: opts.revalidateIntervalMs,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get server address");
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    httpServer,
    io,
    url,
    relayCalls,
    setRelayResult: (r) => {
      nextResult = r;
    },
  };
}

async function stopHarness(h: Harness): Promise<void> {
  await h.io.close();
  await new Promise<void>((resolve) => h.httpServer.close(() => resolve()));
}

/** A client carrying the harness token plus `auth`; a case that wants a
 *  different token (or none) sets `token` in `auth` explicitly. */
function connectClient(url: string, auth: Record<string, unknown>): ClientSocket {
  return ioClient(url, {
    path: CHAT_SOCKET_PATH,
    auth: { token: HARNESS_TOKEN, ...auth },
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000,
  });
}

function waitConnect(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", (err) => reject(err));
  });
}

function emitMessage(client: ClientSocket, payload: unknown): Promise<{ ok: boolean; reply?: string; error?: string; status?: number }> {
  return new Promise((resolve) => {
    client.emit(CHAT_SOCKET_EVENTS.message, payload, resolve);
  });
}

/** Like `emitMessage`, but resolves to null instead of hanging when the
 *  ack never arrives — a frame that closes the socket must fail the test
 *  in seconds, not stall the CI job. */
function emitMessageWithTimeout(client: ClientSocket, payload: unknown, timeoutMs: number): Promise<{ ok: boolean; reply?: string } | null> {
  return new Promise((resolve) => {
    client.timeout(timeoutMs).emit(CHAT_SOCKET_EVENTS.message, payload, (err: Error | null, ack: { ok: boolean; reply?: string } | undefined) => {
      resolve(err ? null : (ack ?? null));
    });
  });
}

describe("chat-service socket — messages", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await stopHarness(harness);
  });

  it("accepts a message and invokes the ack with the reply", async () => {
    harness.setRelayResult({ kind: "ok", reply: "hello back" });
    const client = connectClient(harness.url, { transportId: "cli" });
    await waitConnect(client);

    const ack = await emitMessage(client, {
      externalChatId: "terminal",
      text: "hi",
    });

    assert.deepEqual(ack, { ok: true, reply: "hello back" });
    assert.equal(harness.relayCalls.length, 1);
    assert.equal(elementAt(harness.relayCalls, 0).transportId, "cli");
    assert.equal(elementAt(harness.relayCalls, 0).externalChatId, "terminal");
    assert.equal(elementAt(harness.relayCalls, 0).text, "hi");

    client.disconnect();
  });

  it("relays an attachment past Socket.IO's default 1 MB frame", async () => {
    // Without an explicit `maxHttpBufferSize`, Socket.IO closes the
    // connection at 1 MB — below the 20 MB `parseAttachments` budget, so
    // a bridge shipping a ~900 KB screenshot got a dropped socket instead
    // of a reply. Measured before the fix: 700 KB relayed, 900 KB killed
    // the connection.
    const client = connectClient(harness.url, { transportId: "cli" });
    await waitConnect(client);
    let disconnected = false;
    client.on("disconnect", () => {
      disconnected = true;
    });

    const data = Buffer.alloc(2 * 1024 * 1024, 7).toString("base64"); // ~2.7 MB of base64
    const ack = await emitMessageWithTimeout(
      client,
      {
        externalChatId: "terminal",
        text: "look",
        attachments: [{ mimeType: "image/png", data }],
      },
      5000,
    );

    assert.notEqual(ack, null, "no ack — the frame closed the socket");
    assert.equal(disconnected, false, "the frame must not close the socket");
    assert.equal(ack?.ok, true);
    assert.equal(harness.relayCalls.at(-1)?.attachments?.length, 1);
    assert.equal(harness.relayCalls.at(-1)?.attachments?.at(0)?.data?.length, data.length);

    client.disconnect();
  });

  it("forwards a path-only attachment to relay unchanged (#1099)", async () => {
    // Regression for #1050: the socket parser was inline-only and
    // silently dropped `{ path }` payloads. Pin the wire shape so a
    // future refactor can't reintroduce the drop.
    const client = connectClient(harness.url, { transportId: "cli" });
    await waitConnect(client);
    const ack = await emitMessage(client, {
      externalChatId: "terminal",
      text: "look at this",
      attachments: [{ path: "data/attachments/2026/05/x.png", mimeType: "image/png" }],
    });
    assert.equal(ack.ok, true);
    assert.equal(harness.relayCalls.length, 1);
    assert.deepEqual(elementAt(harness.relayCalls, 0).attachments, [{ path: "data/attachments/2026/05/x.png", mimeType: "image/png" }]);
    client.disconnect();
  });

  it("forwards only the valid entries when the array mixes valid + invalid items", async () => {
    const client = connectClient(harness.url, { transportId: "cli" });
    await waitConnect(client);
    const ack = await emitMessage(client, {
      externalChatId: "terminal",
      text: "mixed bag",
      attachments: [
        { path: "data/attachments/2026/05/a.png" },
        { somethingElse: "wrong shape" },
        { mimeType: "image/png" /* missing data + path */ },
        { mimeType: "image/png", data: "AAAA" },
      ],
    });
    assert.equal(ack.ok, true);
    const forwarded = elementAt(harness.relayCalls, 0).attachments ?? [];
    assert.equal(forwarded.length, 2);
    assert.equal(elementAt(forwarded, 0).path, "data/attachments/2026/05/a.png");
    assert.equal(elementAt(forwarded, 1).data, "AAAA");
    client.disconnect();
  });

  it("caps attachments at MAX_ATTACHMENT_COUNT regardless of shape (#1099 iter-2)", async () => {
    // Send 12 items mixing both shapes. The internal cap is 10;
    // entries past that point must be dropped on the floor — and the
    // path-only items must count toward the cap exactly like inline
    // ones (the count gate runs before the data-byte gate).
    const client = connectClient(harness.url, { transportId: "cli" });
    await waitConnect(client);
    const items: unknown[] = [];
    for (let i = 0; i < 6; i += 1) {
      items.push({ path: `data/attachments/2026/05/p${i}.png` });
      items.push({ mimeType: "image/png", data: `D${i}` });
    }
    const ack = await emitMessage(client, { externalChatId: "terminal", text: "cap", attachments: items });
    assert.equal(ack.ok, true);
    const forwarded = elementAt(harness.relayCalls, 0).attachments ?? [];
    assert.equal(forwarded.length, 10, "MAX_ATTACHMENT_COUNT must cap at 10");
    client.disconnect();
  });
});

// Unit-level coverage for the bytes / count caps. Going through the
// socket harness for the bytes case is impractical — socket.io's
// default `maxHttpBufferSize` is 1MB, so a 20+MB payload trips the
// transport cap before reaching our parser. Calling `parseAttachments`
// directly pins the same contract without that bottleneck.
describe("chat-service socket — parseAttachments cap behavior", () => {
  it("caps at MAX_ATTACHMENT_COUNT (10) regardless of shape", () => {
    const items: unknown[] = [];
    for (let i = 0; i < 6; i += 1) {
      items.push({ path: `data/attachments/2026/05/p${i}.png` });
      items.push({ mimeType: "image/png", data: `D${i}` });
    }
    const out = parseAttachments(items) ?? [];
    assert.equal(out.length, 10);
  });

  it("caps inline `data` byte total at MAX_ATTACHMENT_TOTAL_BYTES; path-only entries don't add to that budget (#1099 iter-2)", () => {
    // First inline (11MB) accepted. A path-only entry between the
    // two inlines is also accepted (its data size is 0). The second
    // inline (11MB) would push the running total to 22MB and break
    // the loop, so the trailing entries never get through.
    const elevenMB = "A".repeat(11 * 1024 * 1024);
    const out =
      parseAttachments([
        { mimeType: "image/png", data: elevenMB },
        { path: "data/attachments/2026/05/path-only.png" },
        { mimeType: "image/png", data: elevenMB },
        { path: "data/attachments/2026/05/after-trip.png" },
      ]) ?? [];
    assert.equal(out.length, 2);
    assert.equal(elementAt(out, 0).data?.length, elevenMB.length);
    assert.equal(elementAt(out, 1).path, "data/attachments/2026/05/path-only.png");
  });

  it("returns undefined when given a non-array", () => {
    assert.equal(parseAttachments(undefined), undefined);
    assert.equal(parseAttachments(null), undefined);
    assert.equal(parseAttachments({}), undefined);
  });

  it("returns undefined when every entry is invalid (no valid items left)", () => {
    assert.equal(parseAttachments([{ wrongShape: true }, { path: "/etc/passwd" }, "string"]), undefined);
  });
});

describe("chat-service socket — parseOneAttachment", () => {
  it("accepts the inline `{ data, mimeType }` shape", () => {
    assert.deepEqual(parseOneAttachment({ mimeType: "image/png", data: "AAAA" }), { mimeType: "image/png", data: "AAAA" });
  });

  it("accepts the path-only `{ path }` shape", () => {
    assert.deepEqual(parseOneAttachment({ path: "data/attachments/2026/05/x.png" }), { path: "data/attachments/2026/05/x.png" });
  });

  it("preserves optional `filename` and `mimeType` on path-only entries", () => {
    assert.deepEqual(parseOneAttachment({ path: "data/attachments/2026/05/x.png", mimeType: "image/png", filename: "x.png" }), {
      path: "data/attachments/2026/05/x.png",
      mimeType: "image/png",
      filename: "x.png",
    });
  });

  it("rejects absolute paths (wire-boundary defence-in-depth, #1099)", () => {
    assert.equal(parseOneAttachment({ path: "/etc/passwd" }), null);
    assert.equal(parseOneAttachment({ path: "\\\\Windows\\\\System32\\\\config" }), null);
  });

  it("rejects Windows-style drive-letter absolute paths (#1099 iter-2)", () => {
    assert.equal(parseOneAttachment({ path: "C:\\\\Windows\\\\System32\\\\config" }), null);
    assert.equal(parseOneAttachment({ path: "C:/Windows/System32/config" }), null);
    assert.equal(parseOneAttachment({ path: "z:/data" }), null);
  });

  it("rejects any traversal segment", () => {
    assert.equal(parseOneAttachment({ path: "../../etc/passwd" }), null);
    assert.equal(parseOneAttachment({ path: "data/attachments/../../etc/shadow" }), null);
    assert.equal(parseOneAttachment({ path: "data/attachments\\..\\..\\etc\\hosts" }), null);
  });

  it("rejects empty / non-string payload", () => {
    assert.equal(parseOneAttachment(null), null);
    assert.equal(parseOneAttachment("not-an-object"), null);
    assert.equal(parseOneAttachment({ path: "" }), null);
    assert.equal(parseOneAttachment({}), null);
  });
});

describe("chat-service socket — messages (cont)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await stopHarness(harness);
  });

  it("rejects the handshake when transportId is missing", async () => {
    const client = connectClient(harness.url, {});
    await assert.rejects(waitConnect(client), /transportId is required/);
    client.disconnect();
  });

  it("returns a 400 ack when externalChatId is missing", async () => {
    const client = connectClient(harness.url, { transportId: "cli" });
    await waitConnect(client);

    const ack = await emitMessage(client, { text: "hi" });

    assert.equal(ack.ok, false);
    assert.equal(ack.status, 400);
    assert.match(ack.error ?? "", /externalChatId/);
    assert.equal(harness.relayCalls.length, 0);

    client.disconnect();
  });

  it("returns a 400 ack when text is empty", async () => {
    const client = connectClient(harness.url, { transportId: "cli" });
    await waitConnect(client);

    const ack = await emitMessage(client, {
      externalChatId: "terminal",
      text: "   ",
    });

    assert.equal(ack.ok, false);
    assert.match(ack.error ?? "", /text is required/);
    assert.equal(harness.relayCalls.length, 0);

    client.disconnect();
  });

  it("propagates relay errors back as ack with status", async () => {
    harness.setRelayResult({
      kind: "error",
      status: 500,
      message: "Error: boom",
    });
    const client = connectClient(harness.url, { transportId: "cli" });
    await waitConnect(client);

    const ack = await emitMessage(client, {
      externalChatId: "terminal",
      text: "hi",
    });

    assert.deepEqual(ack, { ok: false, error: "Error: boom", status: 500 });
    client.disconnect();
  });
});

describe("chat-service socket — bearer token", () => {
  const EXPECTED = "test-token-xyz";
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness({ tokenProvider: () => EXPECTED });
  });

  afterEach(async () => {
    await stopHarness(harness);
  });

  it("accepts a handshake with matching token", async () => {
    const client = connectClient(harness.url, {
      transportId: "cli",
      token: EXPECTED,
    });
    await waitConnect(client);

    const ack = await emitMessage(client, {
      externalChatId: "terminal",
      text: "hi",
    });
    assert.equal(ack.ok, true);
    client.disconnect();
  });

  const refusedGenerically = async (client: ClientSocket): Promise<void> => {
    await assert.rejects(waitConnect(client), (err: unknown) => err instanceof Error && err.message === UNAUTHORIZED_MESSAGE);
    // socket.io destroys the client socket on a middleware refusal, so a
    // bridge sees one `connect_error` and no retry with the same token.
    assert.equal(client.active, false);
    client.disconnect();
  };

  it("refuses a missing token with the generic message", async () => {
    await refusedGenerically(connectClient(harness.url, { transportId: "cli", token: undefined }));
  });

  it("refuses an empty token with the generic message", async () => {
    await refusedGenerically(connectClient(harness.url, { transportId: "cli", token: "" }));
  });

  it("refuses a wrong token with the same generic message", async () => {
    await refusedGenerically(connectClient(harness.url, { transportId: "cli", token: "not-the-right-one" }));
  });

  it("refuses a same-length multi-byte token with the same generic message, without crashing the server", async () => {
    await refusedGenerically(connectClient(harness.url, { transportId: "cli", token: "é".repeat(EXPECTED.length) }));
    // The server is still up: the right token connects afterwards.
    const client = connectClient(harness.url, { transportId: "cli", token: EXPECTED });
    await waitConnect(client);
    client.disconnect();
  });

  it("refuses everything with the same generic message while the server has no token", async () => {
    await stopHarness(harness);
    harness = await startHarness({ tokenProvider: () => null });
    await refusedGenerically(connectClient(harness.url, { transportId: "cli", token: EXPECTED }));
  });

  it("checks the token before the transportId", async () => {
    await refusedGenerically(connectClient(harness.url, { token: "not-the-right-one" }));
  });

  it("lets a host-supplied authorizeToken decide instead of tokenProvider", async () => {
    await stopHarness(harness);
    const accepted = new Set(["client-a", "client-b"]);
    harness = await startHarness({ tokenProvider: () => EXPECTED, authorizeToken: (token) => typeof token === "string" && accepted.has(token) });
    const client = connectClient(harness.url, { transportId: "cli", token: "client-b" });
    await waitConnect(client);
    client.disconnect();
    accepted.delete("client-b");
    await refusedGenerically(connectClient(harness.url, { transportId: "cli", token: "client-b" }));
    await refusedGenerically(connectClient(harness.url, { transportId: "cli", token: EXPECTED }));
  });

  it("refuses a message on an open socket once its token is revoked, and drops the socket", async () => {
    await stopHarness(harness);
    const accepted = new Set(["client-a"]);
    // A sweep far slower than the test, so the per-message check is what is measured.
    harness = await startHarness({ authorizeToken: (token) => typeof token === "string" && accepted.has(token), revalidateIntervalMs: 60_000 });
    const client = connectClient(harness.url, { transportId: "cli", token: "client-a" });
    await waitConnect(client);
    assert.equal((await emitMessage(client, { externalChatId: "terminal", text: "hi" })).ok, true);
    const dropped = new Promise<string>((resolve, reject) => {
      client.once("disconnect", (reason) => resolve(reason));
      setTimeout(() => reject(new Error("the revoked socket was not dropped")), 2000);
    });
    accepted.delete("client-a");
    assert.deepEqual(await emitMessage(client, { externalChatId: "terminal", text: "again" }), { ok: false, error: UNAUTHORIZED_MESSAGE, status: 401 });
    assert.equal(await dropped, "io server disconnect");
  });

  it("drops an open, idle socket on the sweep after its token is revoked", async () => {
    await stopHarness(harness);
    const accepted = new Set(["client-a", "client-b"]);
    harness = await startHarness({ authorizeToken: (token) => typeof token === "string" && accepted.has(token), revalidateIntervalMs: 50 });
    const revoked = connectClient(harness.url, { transportId: "cli", token: "client-a" });
    const kept = connectClient(harness.url, { transportId: "cli2", token: "client-b" });
    await waitConnect(revoked);
    await waitConnect(kept);
    const dropped = new Promise<string>((resolve, reject) => {
      revoked.once("disconnect", (reason) => resolve(reason));
      setTimeout(() => reject(new Error("the revoked socket was not dropped")), 2000);
    });
    accepted.delete("client-a");
    assert.equal(await dropped, "io server disconnect");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(kept.connected, true);
    kept.disconnect();
  });
});
