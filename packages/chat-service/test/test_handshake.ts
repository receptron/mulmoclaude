import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { UNAUTHORIZED_MESSAGE } from "@mulmoclaude/common/token-guard";
import { TRANSPORT_ID_REQUIRED_MESSAGE, validateHandshake, validateHandshakeWith } from "../src/handshake.js";

// The `/ws/chat` handshake rule in both directions. The property that
// matters most is the one a reader cannot see from the accepted cases:
// every refusal of the TOKEN — whatever its shape — is the same generic
// message, and nothing in the payload is read before the token passes.

const TOKEN_BYTES = 32;
const randomToken = (): string => randomBytes(TOKEN_BYTES).toString("hex");

const accepted = (auth: unknown, token: string | null) => {
  const result = validateHandshake(auth, token);
  assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`);
  return result.ok ? result : assert.fail("unreachable");
};

const refusedWith = (auth: unknown, token: string | null, error: string): void => {
  assert.deepEqual(validateHandshake(auth, token), { ok: false, error });
};

describe("validateHandshake — accepts", () => {
  const token = randomToken();

  it("a record carrying the server token and a transportId", () => {
    const result = accepted({ transportId: "cli", token }, token);
    assert.equal(result.transportId, "cli");
    assert.deepEqual(result.options, {});
  });

  it("trims the transportId", () => {
    assert.equal(accepted({ transportId: "  telegram  ", token }, token).transportId, "telegram");
  });

  it("a token that is not ASCII, when the server's is the same", () => {
    assert.equal(accepted({ transportId: "cli", token: "clé-ü-日本" }, "clé-ü-日本").ok, true);
  });

  it("sanitises options to the flat primitive bag", () => {
    const result = accepted({ transportId: "cli", token, options: { defaultRole: "slack", n: 1, nested: { x: 1 }, list: [1] } }, token);
    assert.deepEqual(result.options, { defaultRole: "slack", n: 1 });
  });

  it("treats absent and non-record options as empty", () => {
    [undefined, null, "x", 42, [1]].forEach((options) => {
      assert.deepEqual(accepted({ transportId: "cli", token, options }, token).options, {});
    });
  });
});

describe("validateHandshake — refuses with the generic message", () => {
  const token = randomToken();

  it("every auth payload that is not a record", () => {
    [undefined, null, "string", 42, true, [token], [{ transportId: "cli", token }]].forEach((auth) => {
      refusedWith(auth, token, UNAUTHORIZED_MESSAGE);
    });
  });

  it("a missing, empty, whitespace or non-string token", () => {
    [undefined, null, "", "   ", 42, true, [token], { token }].forEach((candidate) => {
      refusedWith({ transportId: "cli", token: candidate }, token, UNAUTHORIZED_MESSAGE);
    });
  });

  it("a wrong token, including one character off and a prefix or extension of the real one", () => {
    const flipped = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    [randomToken(), flipped, token.slice(1), `${token}0`].forEach((candidate) => {
      refusedWith({ transportId: "cli", token: candidate }, token, UNAUTHORIZED_MESSAGE);
    });
  });

  it("a candidate with the same character count but more bytes, without throwing", () => {
    refusedWith({ transportId: "cli", token: "é".repeat(token.length) }, token, UNAUTHORIZED_MESSAGE);
  });

  it("everything while the server has no token yet, or an empty one", () => {
    [null, "", "   "].forEach((expected) => {
      refusedWith({ transportId: "cli", token }, expected, UNAUTHORIZED_MESSAGE);
      refusedWith({ transportId: "cli", token: "" }, expected, UNAUTHORIZED_MESSAGE);
      refusedWith({ transportId: "cli" }, expected, UNAUTHORIZED_MESSAGE);
    });
  });

  it("never equates two empty strings", () => {
    refusedWith({ transportId: "cli", token: "" }, "", UNAUTHORIZED_MESSAGE);
  });

  it("before reading anything else: a bad token with no transportId is still only `unauthorized`", () => {
    refusedWith({ token: randomToken() }, token, UNAUTHORIZED_MESSAGE);
    refusedWith({}, token, UNAUTHORIZED_MESSAGE);
    refusedWith({ transportId: 42, token: "" }, token, UNAUTHORIZED_MESSAGE);
  });
});

describe("validateHandshake — refuses the transportId only once the token passed", () => {
  const token = randomToken();

  it("a missing, empty, whitespace or non-string transportId", () => {
    [undefined, null, "", "   ", 42, true, ["cli"], { id: "cli" }].forEach((transportId) => {
      refusedWith({ transportId, token }, token, TRANSPORT_ID_REQUIRED_MESSAGE);
    });
  });
});

describe("validateHandshakeWith — the host decides which tokens pass", () => {
  const issued = new Set([randomToken(), randomToken()]);
  const authorize = (provided: unknown): boolean => typeof provided === "string" && issued.has(provided);

  it("accepts every token the host accepts", () => {
    issued.forEach((token) => {
      assert.equal(validateHandshakeWith({ transportId: "cli", token }, authorize).ok, true);
    });
  });

  it("refuses any other token with the generic message, before the transportId", () => {
    [randomToken(), "", undefined, 42].forEach((token) => {
      assert.deepEqual(validateHandshakeWith({ token }, authorize), { ok: false, error: UNAUTHORIZED_MESSAGE });
    });
    assert.deepEqual(validateHandshakeWith(null, authorize), { ok: false, error: UNAUTHORIZED_MESSAGE });
  });

  it("hands the authorizer only the token field", () => {
    const seen: unknown[] = [];
    validateHandshakeWith({ transportId: "cli", token: "t", options: { a: 1 } }, (provided) => {
      seen.push(provided);
      return true;
    });
    assert.deepEqual(seen, ["t"]);
  });
});
