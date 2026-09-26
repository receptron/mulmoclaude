import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACK_TIMEOUT_MARGIN_MS, DEFAULT_REPLY_TIMEOUT_MS, MAX_REPLY_TIMEOUT_MS, ackTimeoutMsFor, resolveReplyTimeoutMs } from "../src/index.js";

const SET_TIMEOUT_CEILING_MS = 2 ** 31 - 1;

describe("resolveReplyTimeoutMs — unset", () => {
  it("keeps today's 5 minutes, silently, when nothing is configured", () => {
    [undefined, null, ""].forEach((raw) => {
      assert.deepEqual(resolveReplyTimeoutMs(raw), { replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    });
    assert.equal(DEFAULT_REPLY_TIMEOUT_MS, 5 * 60 * 1000);
  });
});

describe("resolveReplyTimeoutMs — usable values", () => {
  it("takes a digit string as milliseconds (the env-var shape)", () => {
    assert.deepEqual(resolveReplyTimeoutMs("1800000"), { replyTimeoutMs: 1_800_000 });
    assert.deepEqual(resolveReplyTimeoutMs("1"), { replyTimeoutMs: 1 });
  });

  it("takes a positive integer number (a bridge passing options programmatically)", () => {
    assert.deepEqual(resolveReplyTimeoutMs(90_000), { replyTimeoutMs: 90_000 });
  });

  it("accepts shorter-than-default values too", () => {
    assert.deepEqual(resolveReplyTimeoutMs("30000"), { replyTimeoutMs: 30_000 });
  });

  it("accepts exactly the maximum without a warning", () => {
    assert.deepEqual(resolveReplyTimeoutMs(String(MAX_REPLY_TIMEOUT_MS)), { replyTimeoutMs: MAX_REPLY_TIMEOUT_MS });
  });
});

describe("resolveReplyTimeoutMs — unusable values fall back with a warning", () => {
  const unusable: unknown[] = [
    "0",
    "-1",
    "abc",
    "30m",
    "1e6",
    "1.5",
    " 1000",
    "1000 ",
    "0100",
    "+100",
    "0x10",
    0,
    -5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    {},
    [],
  ];
  unusable.forEach((raw) => {
    it(`rejects ${JSON.stringify(raw) ?? String(raw)}`, () => {
      const out = resolveReplyTimeoutMs(raw);
      assert.equal(out.replyTimeoutMs, DEFAULT_REPLY_TIMEOUT_MS);
      assert.match(out.warning ?? "", /not a positive whole number/);
    });
  });
});

describe("resolveReplyTimeoutMs — past the timer ceiling", () => {
  it("clamps with a warning rather than letting Node fire the timer after 1 ms", () => {
    [String(MAX_REPLY_TIMEOUT_MS + 1), String(SET_TIMEOUT_CEILING_MS), "99999999999999999999", Number.MAX_SAFE_INTEGER].forEach((raw) => {
      const out = resolveReplyTimeoutMs(raw);
      assert.equal(out.replyTimeoutMs, MAX_REPLY_TIMEOUT_MS);
      assert.match(out.warning ?? "", /exceeds the maximum/);
    });
  });
});

describe("ackTimeoutMsFor", () => {
  it("keeps today's 6-minute client limit for the default", () => {
    assert.equal(ackTimeoutMsFor(DEFAULT_REPLY_TIMEOUT_MS), 6 * 60 * 1000);
  });

  it("always outlasts the server, and never passes the timer ceiling", () => {
    ["1", "60000", "1800000", String(MAX_REPLY_TIMEOUT_MS), "99999999999999999999"].forEach((raw) => {
      const { replyTimeoutMs } = resolveReplyTimeoutMs(raw);
      const ackTimeoutMs = ackTimeoutMsFor(replyTimeoutMs);
      assert.equal(ackTimeoutMs - replyTimeoutMs, ACK_TIMEOUT_MARGIN_MS);
      assert.ok(ackTimeoutMs <= SET_TIMEOUT_CEILING_MS);
    });
  });
});
