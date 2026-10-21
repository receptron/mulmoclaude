import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LINE_LOADING_REFRESH_MS, LINE_LOADING_SECONDS, isOneOnOneSource, loadingSenderFor, startLineLoading, type FetchFn } from "../src/loading.ts";

const SECOND_MS = 1_000;
const LOADING_SECONDS_STEP = 5;
const MAX_LOADING_SECONDS = 60;

type FetchInit = Parameters<FetchFn>[1];

interface RecordedCall {
  url: string;
  init: FetchInit;
}

function recordingFetch(response: Response): { fetchFn: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchFn, calls };
}

function onlyCall(calls: RecordedCall[]): RecordedCall {
  const [call] = calls;
  assert.equal(calls.length, 1);
  if (!call) assert.fail("no request was made");
  return call;
}

function headerOf(init: FetchInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe("startLineLoading", () => {
  it("POSTs the chat id and loading seconds with the channel token", async () => {
    const { fetchFn, calls } = recordingFetch(new Response(null, { status: 202 }));
    await startLineLoading(fetchFn, "token-abc", "U123");

    const call = onlyCall(calls);
    assert.equal(call.url, "https://api.line.me/v2/bot/chat/loading/start");
    assert.equal(call.init.method, "POST");
    assert.equal(headerOf(call.init, "Authorization"), "Bearer token-abc");
    assert.equal(headerOf(call.init, "Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(call.init.body)), { chatId: "U123", loadingSeconds: LINE_LOADING_SECONDS });
    assert.ok(call.init.signal instanceof AbortSignal);
  });

  it("throws with the status and body on a non-2xx answer", async () => {
    const { fetchFn } = recordingFetch(new Response('{"message":"The chat is not a one-on-one chat"}', { status: 400 }));
    await assert.rejects(startLineLoading(fetchFn, "t", "C999"), /loading\/start 400 .*one-on-one/);
  });

  it("propagates a network error", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    await assert.rejects(startLineLoading(fetchFn, "t", "U1"), /fetch failed/);
  });
});

describe("LINE loading timing", () => {
  it("uses a loadingSeconds value LINE accepts", () => {
    assert.equal(LINE_LOADING_SECONDS % LOADING_SECONDS_STEP, 0);
    assert.ok(LINE_LOADING_SECONDS >= LOADING_SECONDS_STEP && LINE_LOADING_SECONDS <= MAX_LOADING_SECONDS);
  });

  it("refreshes before the animation lapses", () => {
    assert.ok(LINE_LOADING_REFRESH_MS < LINE_LOADING_SECONDS * SECOND_MS);
  });
});

describe("isOneOnOneSource", () => {
  it("accepts a one-on-one chat", () => {
    assert.equal(isOneOnOneSource({ type: "user" }), true);
  });

  it("rejects groups, rooms, an unknown type and a missing source", () => {
    assert.equal(isOneOnOneSource({ type: "group" }), false);
    assert.equal(isOneOnOneSource({ type: "room" }), false);
    assert.equal(isOneOnOneSource({ type: "USER" }), false);
    assert.equal(isOneOnOneSource({}), false);
    assert.equal(isOneOnOneSource(undefined), false);
  });
});

describe("loadingSenderFor", () => {
  it("sends the loading request in a one-on-one chat", async () => {
    const started: string[] = [];
    await loadingSenderFor({ type: "user" }, async () => {
      started.push("loading");
    })();
    assert.deepEqual(started, ["loading"]);
  });

  it("sends nothing in a group, a room, or without a source", async () => {
    const started: string[] = [];
    const startLoading = async (): Promise<void> => {
      started.push("loading");
    };
    await loadingSenderFor({ type: "group" }, startLoading)();
    await loadingSenderFor({ type: "room" }, startLoading)();
    await loadingSenderFor(undefined, startLoading)();
    assert.deepEqual(started, []);
  });
});
