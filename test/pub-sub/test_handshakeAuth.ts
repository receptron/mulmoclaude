import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedPubSubHandshake } from "../../server/events/pub-sub/handshakeAuth.js";

// The pure rule behind the `/ws/pubsub` socket.io middleware (#3433). `auth`
// is whatever the client put in `io({ auth })`, so every shape a client could
// send is exercised, in both directions.

const TOKEN = "f".repeat(64);

describe("isAuthorizedPubSubHandshake — accepts", () => {
  it("a record whose token equals the server token", () => {
    assert.equal(isAuthorizedPubSubHandshake({ token: TOKEN }, TOKEN), true);
  });

  it("extra fields alongside the token", () => {
    assert.equal(isAuthorizedPubSubHandshake({ token: TOKEN, transportId: "spa", options: {} }, TOKEN), true);
  });

  it("a short pinned token (the env override is used verbatim)", () => {
    assert.equal(isAuthorizedPubSubHandshake({ token: "e2e-test-token" }, "e2e-test-token"), true);
  });
});

describe("isAuthorizedPubSubHandshake — refuses", () => {
  const shapes: [string, unknown][] = [
    ["no auth at all", undefined],
    ["null", null],
    ["a bare string equal to the token", TOKEN],
    ["a number", 42],
    ["a boolean", true],
    ["an empty array", []],
    ["an array holding the token", [TOKEN]],
    ["an empty record", {}],
    ["token: undefined", { token: undefined }],
    ["token: null", { token: null }],
    ["a numeric token", { token: 42 }],
    ["an empty token", { token: "" }],
    ["a token one character short", { token: TOKEN.slice(1) }],
    ["a token one character long", { token: `${TOKEN}0` }],
    ["a token in the wrong case", { token: TOKEN.toUpperCase() }],
    ["the token under a capitalised key", { Token: TOKEN }],
    ["the token nested one level down", { auth: { token: TOKEN } }],
    ["the token with surrounding whitespace", { token: ` ${TOKEN} ` }],
  ];
  shapes.forEach(([label, auth]) => {
    it(label, () => {
      assert.equal(isAuthorizedPubSubHandshake(auth, TOKEN), false);
    });
  });

  it("every handshake while the server has no token yet", () => {
    assert.equal(isAuthorizedPubSubHandshake({ token: TOKEN }, null), false);
    assert.equal(isAuthorizedPubSubHandshake({ token: "" }, null), false);
  });

  it("every handshake while the server token is empty, including an empty candidate", () => {
    assert.equal(isAuthorizedPubSubHandshake({ token: "" }, ""), false);
    assert.equal(isAuthorizedPubSubHandshake({ token: TOKEN }, ""), false);
  });

  it("a candidate with the same character count but more bytes, without throwing", () => {
    assert.equal(isAuthorizedPubSubHandshake({ token: "é".repeat(64) }, TOKEN), false);
  });
});
