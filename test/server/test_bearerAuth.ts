// Unit tests for the bearer-token middleware (#272). Structure
// mirrors test_csrfGuard.ts: lightweight FakeReq / FakeRes records
// with only the fields the middleware touches, bridged to Express
// types at the call boundary.
//
// The test suite covers:
//   - correct Bearer → next()
//   - missing Authorization → 401, `next` not called
//   - wrong prefix (Basic / Token) → 401
//   - mismatched token → 401
//   - empty Bearer → 401
//   - bootstrap not yet run (currentToken === null) → 401

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import path from "path";

import type { Request, Response, NextFunction } from "express";
import { bearerAuth } from "../../server/api/auth/bearerAuth.js";
import { __resetForTests, generateAndWriteToken } from "../../server/api/auth/token.js";
import { makeTempDir } from "../helpers/tempDir.js";

interface FakeReq {
  headers: { authorization?: string };
}
interface FakeRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => FakeRes;
  json: (payload: unknown) => FakeRes;
}

function makeReq(authorization?: string): FakeReq {
  return {
    headers: authorization === undefined ? {} : { authorization },
  };
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function run(req: FakeReq, res: FakeRes): { nextCalled: boolean; statusCode: number; body: unknown } {
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  // The fakes only satisfy the subset of Request/Response the
  // middleware reads (headers / status / json). The double cast
  // through `unknown` is the minimum-violence bridge to Express's
  // strict types — test-only pattern, mirrored from test_csrfGuard.ts.
  bearerAuth(req as unknown as Request, res as unknown as Response, next);
  return {
    nextCalled,
    statusCode: res.statusCode,
    body: res.body,
  };
}

let tmpDir = "";
let tokenPath = "";
let validToken = "";

beforeEach(async () => {
  tmpDir = makeTempDir("mulmo-auth-test-");
  tokenPath = path.join(tmpDir, ".session-token");
  __resetForTests();
  validToken = await generateAndWriteToken(tokenPath);
});

describe("bearerAuth — accepts matching Bearer token", () => {
  it("calls next() when Authorization is exact match", () => {
    const { nextCalled, statusCode } = run(makeReq(`Bearer ${validToken}`), makeRes());
    assert.equal(nextCalled, true);
    assert.equal(statusCode, 200);
  });
});

describe("bearerAuth — rejects missing header", () => {
  it("returns 401 when Authorization is absent", () => {
    const { nextCalled, statusCode, body } = run(makeReq(), makeRes());
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
    assert.deepEqual(body, { error: "unauthorized" });
  });

  it("returns 401 when Authorization is an empty string", () => {
    const { nextCalled, statusCode } = run(makeReq(""), makeRes());
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });
});

describe("bearerAuth — rejects wrong scheme / prefix", () => {
  it("returns 401 for Basic auth even if token looks like ours", () => {
    const { nextCalled, statusCode } = run(makeReq(`Basic ${validToken}`), makeRes());
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });

  it("returns 401 for a bare token (no Bearer prefix)", () => {
    const { nextCalled, statusCode } = run(makeReq(validToken), makeRes());
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });

  it("returns 401 for lowercase 'bearer ' (prefix is case-sensitive)", () => {
    const { nextCalled, statusCode } = run(makeReq(`bearer ${validToken}`), makeRes());
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });
});

describe("bearerAuth — rejects mismatched token", () => {
  it("returns 401 when the token is wrong", () => {
    const { nextCalled, statusCode } = run(makeReq("Bearer not-the-right-token"), makeRes());
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });

  it("returns 401 when the header has an empty token after Bearer", () => {
    const { nextCalled, statusCode } = run(makeReq("Bearer "), makeRes());
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });

  it("returns 401, not a throw, when the token has the same character count but more bytes", () => {
    // "é" is one character and two UTF-8 bytes. A string-length compare let
    // `timingSafeEqual` throw here, and Express answered 500 instead of 401.
    const { nextCalled, statusCode } = run(makeReq(`Bearer ${"é".repeat(validToken.length)}`), makeRes());
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });
});

describe("bearerAuth — defends against pre-bootstrap calls", () => {
  it("returns 401 if no token has been generated yet", () => {
    __resetForTests();
    const { nextCalled, statusCode } = run(makeReq(`Bearer ${validToken}`), makeRes());
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  });
});
