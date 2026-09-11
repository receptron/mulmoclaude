// Pins the beat-endpoint guard + dispatch skeleton shared by the
// mulmoScript beat POST routes (#2368).
//
// `validBeatIndex` guards an ARRAY INDEX, so the matrix below is the
// contract, not documentation: widening it (accepting "1", 1.5, -1) lets a
// hostile body reach beat-indexed logic; narrowing it (rejecting 0) breaks
// the first beat of every script.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import { makeBeatOpHandler, sendOpFailure, validBeatIndex, type BeatOpArgs, type BeatOpBody } from "../../../server/api/routes/mulmoScriptBeatOp.ts";

// Derived from the helper's own signature so the test can build failures
// without importing the plugin package.
type OpFailure = Parameters<typeof sendOpFailure>[1];

const FAILURE_STATUSES: [OpFailure["code"], number][] = [
  ["bad_request", 400],
  ["not_found", 404],
  ["unavailable", 503],
  ["server_error", 500],
];

interface Recorded {
  status: number;
  body: unknown;
  jsonCalled: boolean;
}

interface MockResponse {
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
  recorded: Recorded;
}

function mockRes(): MockResponse {
  const recorded: Recorded = { status: 200, body: undefined, jsonCalled: false };
  return {
    recorded,
    status(code) {
      recorded.status = code;
      return this;
    },
    json(body) {
      recorded.body = body;
      recorded.jsonCalled = true;
      return this;
    },
  };
}

// Cast once at each test boundary (same pattern as test/utils/test_httpError.ts)
// so the production signatures keep Express's types; the handler only ever
// touches `req.body`, `res.status`, and `res.json`.
function asExpressRes(mock: MockResponse): Response {
  return mock as unknown as Response;
}

function asExpressReq(body: unknown): Request<object, unknown, BeatOpBody> {
  return { body } as unknown as Request<object, unknown, BeatOpBody>;
}

/** Fake op: records the args it was handed and returns a canned outcome. */
function fakeOp<TResult extends { ok: true }>(outcome: TResult | OpFailure) {
  const calls: BeatOpArgs[] = [];
  return {
    calls,
    op: async (args: BeatOpArgs): Promise<TResult | OpFailure> => {
      calls.push(args);
      return outcome;
    },
  };
}

const audioSuccess = { ok: true, audio: "data:audio/mpeg;base64,AAA" } as const;
const imageSuccess = { ok: true, image: "data:image/png;base64,BBB" } as const;

const VALID_BODY = { filePath: "stories/a.json", beatIndex: 0 };
const REQUIRED_MESSAGE = "filePath and beatIndex are required";

describe("validBeatIndex", () => {
  it("accepts zero — the first beat must not be rejected as falsy", () => {
    assert.equal(validBeatIndex(0), true);
  });

  it("accepts positive integers", () => {
    for (const value of [1, 2, 42, 1000]) {
      assert.equal(validBeatIndex(value), true, `${value} should be accepted`);
    }
  });

  it("accepts -0 (Number.isInteger(-0) is true and -0 >= 0)", () => {
    assert.equal(validBeatIndex(-0), true);
  });

  it("has NO upper bound — the beat count is the op's business, not the guard's", () => {
    assert.equal(validBeatIndex(1_000_000), true);
    assert.equal(validBeatIndex(Number.MAX_SAFE_INTEGER), true);
  });

  it("rejects negative integers", () => {
    for (const value of [-1, -2, -42, Number.MIN_SAFE_INTEGER]) {
      assert.equal(validBeatIndex(value), false, `${value} should be rejected`);
    }
  });

  it("rejects non-integers", () => {
    for (const value of [1.5, 0.1, -0.5, Number.EPSILON, 2.000001]) {
      assert.equal(validBeatIndex(value), false, `${value} should be rejected`);
    }
  });

  it("rejects NaN and both infinities", () => {
    assert.equal(validBeatIndex(Number.NaN), false);
    assert.equal(validBeatIndex(Number.POSITIVE_INFINITY), false);
    assert.equal(validBeatIndex(Number.NEGATIVE_INFINITY), false);
  });

  it('rejects numeric strings — a JSON body may send "0" and it must not index', () => {
    for (const value of ["0", "1", "42", "1.5", "-1", ""]) {
      assert.equal(validBeatIndex(value), false, `${JSON.stringify(value)} should be rejected`);
    }
  });

  it("rejects undefined and null", () => {
    assert.equal(validBeatIndex(undefined), false);
    assert.equal(validBeatIndex(null), false);
  });

  it("rejects other types that coerce to a number", () => {
    for (const value of [true, false, [], [0], {}, 0n, new Date(0)]) {
      assert.equal(validBeatIndex(value), false, `${String(value)} should be rejected`);
    }
  });
});

describe("sendOpFailure", () => {
  for (const [code, status] of FAILURE_STATUSES) {
    it(`maps ${code} onto ${status}`, () => {
      const res = mockRes();
      sendOpFailure(asExpressRes(res), { ok: false, code, error: `${code} happened` });
      assert.equal(res.recorded.status, status);
      assert.deepEqual(res.recorded.body, { error: `${code} happened` });
    });
  }
});

describe("makeBeatOpHandler — request validation", () => {
  async function runWith(body: unknown) {
    const { op, calls } = fakeOp(audioSuccess);
    const handler = makeBeatOpHandler(op, (result) => ({ audio: result.audio }));
    const res = mockRes();
    await handler(asExpressReq(body), asExpressRes(res));
    return { res, calls };
  }

  it("rejects an empty filePath without calling the op", async () => {
    const { res, calls } = await runWith({ filePath: "", beatIndex: 0 });
    assert.equal(res.recorded.status, 400);
    assert.deepEqual(res.recorded.body, { error: REQUIRED_MESSAGE });
    assert.equal(calls.length, 0);
  });

  it("rejects a missing filePath", async () => {
    const { res, calls } = await runWith({ beatIndex: 0 });
    assert.equal(res.recorded.status, 400);
    assert.deepEqual(res.recorded.body, { error: REQUIRED_MESSAGE });
    assert.equal(calls.length, 0);
  });

  it("rejects non-string filePath values (parameter tampering)", async () => {
    for (const filePath of [123, null, ["stories/a.json"], { path: "a" }, true]) {
      const { res, calls } = await runWith({ filePath, beatIndex: 0 });
      assert.equal(res.recorded.status, 400, `${JSON.stringify(filePath)} should be rejected`);
      assert.deepEqual(res.recorded.body, { error: REQUIRED_MESSAGE });
      assert.equal(calls.length, 0);
    }
  });

  it("rejects a missing beatIndex", async () => {
    const { res, calls } = await runWith({ filePath: "stories/a.json" });
    assert.equal(res.recorded.status, 400);
    assert.deepEqual(res.recorded.body, { error: REQUIRED_MESSAGE });
    assert.equal(calls.length, 0);
  });

  it("rejects out-of-domain beatIndex values", async () => {
    for (const beatIndex of [-1, 1.5, "0", null, Number.NaN, true]) {
      const { res, calls } = await runWith({ filePath: "stories/a.json", beatIndex });
      assert.equal(res.recorded.status, 400, `${JSON.stringify(beatIndex)} should be rejected`);
      assert.deepEqual(res.recorded.body, { error: REQUIRED_MESSAGE });
      assert.equal(calls.length, 0);
    }
  });

  it("rejects an empty body", async () => {
    const { res, calls } = await runWith({});
    assert.equal(res.recorded.status, 400);
    assert.deepEqual(res.recorded.body, { error: REQUIRED_MESSAGE });
    assert.equal(calls.length, 0);
  });

  it("accepts beatIndex 0 and forwards the validated pair to the op", async () => {
    const { res, calls } = await runWith(VALID_BODY);
    assert.equal(res.recorded.status, 200);
    assert.deepEqual(calls, [{ filePath: "stories/a.json", beatIndex: 0, force: undefined, chatSessionId: undefined, root: undefined }]);
  });
});

/**
 * The root reaches the op — the factory is the ONLY place it can (#3077).
 *
 * These handlers take the op as a VALUE, so the `resolveStory`-style sweep in
 * `test/plugins/mulmoscript/test_storyRootSweep.ts` cannot see an argument list at the call site
 * and exempts them. This is what makes that exemption safe rather than a hole: the same
 * `stories/…` spelling exists in every registered root, so a beat op that receives no root reads
 * the DEFAULT root's file of that name.
 */
describe("makeBeatOpHandler — the root it hands the op", () => {
  async function argsFor(body: unknown): Promise<BeatOpArgs | undefined> {
    const { op, calls } = fakeOp(audioSuccess);
    const handler = makeBeatOpHandler(op, (result) => ({ audio: result.audio }));
    await handler(asExpressReq(body), asExpressRes(mockRes()));
    return calls[0];
  }

  it("forwards the root the request named", async () => {
    const args = await argsFor({ filePath: "stories/a.json", beatIndex: 0, root: "acme-docs" });
    assert.equal(args?.root, "acme-docs");
  });

  it("reads an absent root as the default, exactly as the dispatch transport does", async () => {
    const args = await argsFor({ filePath: "stories/a.json", beatIndex: 0 });
    assert.equal(args?.root, undefined);
  });

  it('reads an empty root as the default too — `str()` in the package treats "" that way', async () => {
    const args = await argsFor({ filePath: "stories/a.json", beatIndex: 0, root: "" });
    assert.equal(args?.root, undefined);
  });

  it("degrades a wrong-TYPE root to the default rather than passing it on", async () => {
    // A non-string root must not reach the op as a non-string: the ops compare it against
    // registered ids, and an object or array there is parameter tampering, not a root.
    for (const root of [123, null, ["acme"], { id: "acme" }, true]) {
      const args = await argsFor({ filePath: "stories/a.json", beatIndex: 0, root });
      assert.equal(args?.root, undefined, `a ${typeof root} root must read as the default`);
    }
  });
});

describe("makeBeatOpHandler — op failures", () => {
  it("routes a failing op through sendOpFailure instead of a 200", async () => {
    const failure: OpFailure = { ok: false, code: "not_found", error: "script not found" };
    const { op } = fakeOp<typeof audioSuccess>(failure);
    const handler = makeBeatOpHandler(op, (result) => ({ audio: result.audio }));
    const res = mockRes();
    await handler(asExpressReq(VALID_BODY), asExpressRes(res));
    assert.equal(res.recorded.status, 404);
    assert.deepEqual(res.recorded.body, { error: "script not found" });
  });

  for (const [code, status] of FAILURE_STATUSES) {
    it(`answers ${status} when the op fails with ${code}`, async () => {
      const { op } = fakeOp<typeof imageSuccess>({ ok: false, code, error: "nope" });
      const handler = makeBeatOpHandler(op, (result) => ({ image: result.image }));
      const res = mockRes();
      await handler(asExpressReq(VALID_BODY), asExpressRes(res));
      assert.equal(res.recorded.status, status);
      assert.deepEqual(res.recorded.body, { error: "nope" });
    });
  }
});

describe("makeBeatOpHandler — success responses", () => {
  it("returns the audio key for the audio op", async () => {
    const { op } = fakeOp(audioSuccess);
    const handler = makeBeatOpHandler(op, (result) => ({ audio: result.audio }));
    const res = mockRes();
    await handler(asExpressReq(VALID_BODY), asExpressRes(res));
    assert.equal(res.recorded.jsonCalled, true);
    assert.equal(res.recorded.status, 200);
    // deepEqual is strict: an extra key (e.g. a leaked `ok`) fails here.
    assert.deepEqual(res.recorded.body, { audio: audioSuccess.audio });
  });

  it("returns the image key for the render op", async () => {
    const { op } = fakeOp(imageSuccess);
    const handler = makeBeatOpHandler(op, (result) => ({ image: result.image }));
    const res = mockRes();
    await handler(asExpressReq(VALID_BODY), asExpressRes(res));
    assert.deepEqual(res.recorded.body, { image: imageSuccess.image });
  });

  it("forwards force and chatSessionId to the op", async () => {
    const { op, calls } = fakeOp(imageSuccess);
    const handler = makeBeatOpHandler(op, (result) => ({ image: result.image }));
    await handler(asExpressReq({ ...VALID_BODY, beatIndex: 3, force: true, chatSessionId: "sess-1" }), asExpressRes(mockRes()));
    assert.deepEqual(calls, [{ filePath: "stories/a.json", beatIndex: 3, force: true, chatSessionId: "sess-1", root: undefined }]);
  });
});
