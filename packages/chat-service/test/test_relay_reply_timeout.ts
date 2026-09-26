// The relay's reply limit comes from `bridgeOptions.replyTimeoutMs` (#3305).
// The agent here never finishes: it streams one chunk and goes quiet, so the
// only thing that can settle the turn is the limit.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES } from "@mulmobridge/protocol";
import { createRelay } from "../src/relay.ts";
import type { RelayDeps, RelayParams, RelayResult } from "../src/relay.ts";
import type { ChatStateStore, TransportChatState } from "../src/chat-state.ts";
import type { Logger, OnSessionEventFn } from "../src/types.ts";

const SHORT_LIMIT_MS = 30;
const STILL_WAITING_AFTER_MS = 150;
const PARTIAL_TEXT = "partial answer";

function makeStore(): ChatStateStore {
  const state: TransportChatState = {
    externalChatId: "chat-1",
    sessionId: "sess-1",
    roleId: "general",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    getChatState: async () => state,
    setChatState: async () => {},
    resetChatState: async () => state,
    connectSession: async () => null,
    generateSessionId: () => "sess-gen",
  };
}

interface Harness {
  relay: (params: Omit<RelayParams, "transportId" | "externalChatId" | "text">) => Promise<RelayResult>;
  warnings: string[];
  unsubscribed: () => boolean;
  /** Ends the agent turn, so a turn still inside a long limit settles and clears its timer. */
  finish: () => void;
}

function makeHarness(): Harness {
  const warnings: string[] = [];
  const logger: Logger = { error: () => {}, info: () => {}, debug: () => {}, warn: (_prefix, msg) => warnings.push(msg) };
  const subscription: { live: boolean; listener?: Parameters<OnSessionEventFn>[1] } = { live: false };
  const onSessionEvent: OnSessionEventFn = (_sessionId, listener) => {
    subscription.live = true;
    subscription.listener = listener;
    setTimeout(() => listener({ type: EVENT_TYPES.text, message: PARTIAL_TEXT }), 1);
    return () => {
      subscription.live = false;
    };
  };
  const deps: RelayDeps = {
    store: makeStore(),
    handleCommand: async () => null,
    startChat: async () => ({ kind: "started", chatSessionId: "sess-1" }),
    onSessionEvent,
    getRole: (id) => ({ id, name: id }),
    defaultRoleId: "general",
    logger,
  };
  const relayMessage = createRelay(deps);
  return {
    relay: (params) => relayMessage({ transportId: "test", externalChatId: "chat-1", text: "hi", ...params }),
    warnings,
    unsubscribed: () => !subscription.live,
    finish: () => subscription.listener?.({ type: EVENT_TYPES.sessionFinished }),
  };
}

/** Resolves with the relay's result, or `null` if it is still pending after `ms`. */
function settledWithin(turn: Promise<RelayResult>, ms: number): Promise<RelayResult | null> {
  return Promise.race([turn, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

describe("relay reply limit from bridgeOptions.replyTimeoutMs", () => {
  it("gives up at the configured limit and returns what streamed so far", async () => {
    const harness = makeHarness();
    const result = await settledWithin(harness.relay({ bridgeOptions: { replyTimeoutMs: String(SHORT_LIMIT_MS) } }), STILL_WAITING_AFTER_MS);
    assert.deepEqual(result, { kind: "ok", reply: PARTIAL_TEXT });
    assert.ok(harness.unsubscribed(), "the session listener is removed at the limit");
    assert.deepEqual(harness.warnings, []);
  });

  it("accepts a number as well as the env-var string", async () => {
    const harness = makeHarness();
    const result = await settledWithin(harness.relay({ bridgeOptions: { replyTimeoutMs: SHORT_LIMIT_MS } }), STILL_WAITING_AFTER_MS);
    assert.deepEqual(result, { kind: "ok", reply: PARTIAL_TEXT });
  });

  it("keeps the 5-minute default when the option is absent — still waiting well past a short limit", async () => {
    const harness = makeHarness();
    const turn = harness.relay({ bridgeOptions: {} });
    const result = await settledWithin(turn, STILL_WAITING_AFTER_MS);
    harness.finish();
    await turn;
    assert.equal(result, null);
    assert.deepEqual(harness.warnings, []);
  });

  it("warns and keeps the default when the option is unusable", async () => {
    const harness = makeHarness();
    const turn = harness.relay({ bridgeOptions: { replyTimeoutMs: "30m" } });
    const result = await settledWithin(turn, STILL_WAITING_AFTER_MS);
    harness.finish();
    await turn;
    assert.equal(result, null);
    assert.deepEqual(harness.warnings, ["bridge reply timeout option ignored"]);
  });
});
