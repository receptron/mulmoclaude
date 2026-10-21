import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { apiFailureDescription, createTelegramApi } from "../src/api.ts";

/** `items[index]` is `T | undefined` under `noUncheckedIndexedAccess`. Asserting
 *  states the precondition each case already relies on — the length was just
 *  checked — and names the failure instead of throwing on a property of
 *  undefined. */
const elementAt = <T>(items: T[], index: number): T => {
  const item = items[index];
  assert.ok(item !== undefined, `expected an element at index ${index}, but the list holds ${items.length}`);
  return item;
};

interface FakeCall {
  url: string;
  init?: Parameters<typeof fetch>[1];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe("TelegramApi.getUpdates", () => {
  let calls: FakeCall[];
  beforeEach(() => {
    calls = [];
  });

  const fetchStub = (script: (call: FakeCall) => Response | Promise<Response>): typeof fetch =>
    (async (input, init) => {
      const call: FakeCall = {
        url: typeof input === "string" ? input : input.toString(),
        init,
      };
      calls.push(call);
      return script(call);
    }) as typeof fetch;

  it("hits /getUpdates with offset and timeout query params", async () => {
    const api = createTelegramApi({
      botToken: "TKN",
      fetchImpl: fetchStub(() => jsonResponse({ ok: true, result: [] })),
    });
    await api.getUpdates({ offset: 42, timeoutSec: 25 });
    assert.equal(calls.length, 1);
    assert.ok(elementAt(calls, 0).url.includes("/botTKN/getUpdates"));
    assert.ok(elementAt(calls, 0).url.includes("offset=42"));
    assert.ok(elementAt(calls, 0).url.includes("timeout=25"));
  });

  it("returns updates on success", async () => {
    const api = createTelegramApi({
      botToken: "TKN",
      fetchImpl: fetchStub(() =>
        jsonResponse({
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 1,
                chat: { id: 999, type: "private" },
                date: 0,
                text: "hi",
              },
            },
          ],
        }),
      ),
    });
    const updates = await api.getUpdates();
    assert.equal(updates.length, 1);
    assert.equal(elementAt(updates, 0).update_id, 1);
    assert.equal(elementAt(updates, 0).message?.text, "hi");
  });

  it("throws on non-2xx HTTP status", async () => {
    const api = createTelegramApi({
      botToken: "TKN",
      fetchImpl: fetchStub(() => textResponse("rate limited", 429)),
    });
    await assert.rejects(api.getUpdates(), /429/);
  });

  it("throws when the API response has ok=false", async () => {
    const api = createTelegramApi({
      botToken: "TKN",
      fetchImpl: fetchStub(() => jsonResponse({ ok: false, description: "Unauthorized" })),
    });
    await assert.rejects(api.getUpdates(), /Unauthorized/);
  });
});

describe("TelegramApi.sendMessage", () => {
  it("POSTs JSON with chat_id and text", async () => {
    const captured: { url?: string; body?: string } = {};
    const api = createTelegramApi({
      botToken: "TKN",
      fetchImpl: (async (input, init) => {
        captured.url = typeof input === "string" ? input : input.toString();
        captured.body = init?.body as string;
        return jsonResponse({ ok: true });
      }) as typeof fetch,
    });
    await api.sendMessage(123, "hello");
    assert.ok(captured.url?.endsWith("/sendMessage"));
    const parsed = JSON.parse(captured.body ?? "{}");
    assert.equal(parsed.chat_id, 123);
    assert.equal(parsed.text, "hello");
  });

  it("throws on API error", async () => {
    const api = createTelegramApi({
      botToken: "TKN",
      fetchImpl: (async () =>
        jsonResponse({
          ok: false,
          description: "chat not found",
        })) as typeof fetch,
    });
    await assert.rejects(api.sendMessage(1, "x"), /chat not found/);
  });
});

describe("TelegramApi.sendChatAction", () => {
  it("POSTs chat_id and the action", async () => {
    const captured: { url: string; body: string } = { url: "", body: "" };
    const fetchImpl: typeof fetch = async (input, init) => {
      captured.url = String(input);
      captured.body = String(init?.body);
      return jsonResponse({ ok: true, result: true });
    };
    const api = createTelegramApi({ botToken: "TKN", fetchImpl });
    await api.sendChatAction(123, "typing");
    assert.ok(captured.url.endsWith("/botTKN/sendChatAction"));
    assert.deepEqual(JSON.parse(captured.body), { chat_id: 123, action: "typing" });
  });

  it("throws with the status and body on a non-2xx answer", async () => {
    const fetchImpl: typeof fetch = async () => new Response('{"ok":false,"description":"Forbidden: bot was blocked by the user"}', { status: 403 });
    const api = createTelegramApi({ botToken: "TKN", fetchImpl });
    await assert.rejects(api.sendChatAction(1, "typing"), /sendChatAction failed: 403 .*blocked/);
  });
});

describe("TelegramApi.sendChatAction — 200 with ok:false", () => {
  it("throws with the API description", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ ok: false, description: "Bad Request: chat not found" });
    const api = createTelegramApi({ botToken: "TKN", fetchImpl });
    await assert.rejects(api.sendChatAction(1, "typing"), /sendChatAction API error: Bad Request: chat not found/);
  });

  it("does not throw on a body it cannot parse", async () => {
    const fetchImpl: typeof fetch = async () => new Response("not json", { status: 200 });
    const api = createTelegramApi({ botToken: "TKN", fetchImpl });
    await assert.doesNotReject(api.sendChatAction(1, "typing"));
  });
});

describe("apiFailureDescription", () => {
  it("returns the description of an ok:false body", () => {
    assert.equal(apiFailureDescription({ ok: false, description: "Forbidden" }), "Forbidden");
  });

  it("falls back to 'unknown' when ok:false carries no string description", () => {
    assert.equal(apiFailureDescription({ ok: false }), "unknown");
    assert.equal(apiFailureDescription({ ok: false, description: 42 }), "unknown");
  });

  it("returns null for a success or a non-object body", () => {
    assert.equal(apiFailureDescription({ ok: true, result: true }), null);
    assert.equal(apiFailureDescription({}), null);
    assert.equal(apiFailureDescription(null), null);
    assert.equal(apiFailureDescription("ok"), null);
    assert.equal(apiFailureDescription({ ok: "false" }), null);
  });
});
