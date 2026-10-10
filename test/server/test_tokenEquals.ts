import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { tokenEquals } from "../../server/api/auth/tokenEquals.js";

// Constant-time token compare shared by `bearerAuth` and the `/ws/pubsub`
// handshake guard. The cases that matter are the ones `timingSafeEqual`
// alone gets wrong: it throws on a buffer-length mismatch, so a candidate
// with the same character count but more bytes must come back `false`
// rather than crash the request.

const TOKEN_BYTES = 32;
const randomToken = (): string => randomBytes(TOKEN_BYTES).toString("hex");

describe("tokenEquals — accepts", () => {
  it("an identical token", () => {
    const token = randomToken();
    assert.equal(tokenEquals(token, token), true);
  });

  it("an identical token that is not ASCII", () => {
    assert.equal(tokenEquals("clé-ü-日本", "clé-ü-日本"), true);
  });
});

describe("tokenEquals — refuses", () => {
  it("a token that differs in one character", () => {
    const token = randomToken();
    const flipped = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    assert.equal(tokenEquals(flipped, token), false);
  });

  it("a shorter and a longer candidate", () => {
    const token = randomToken();
    assert.equal(tokenEquals(token.slice(1), token), false);
    assert.equal(tokenEquals(`${token}0`, token), false);
  });

  it("an empty candidate against a real token, and a real token against an empty one", () => {
    const token = randomToken();
    assert.equal(tokenEquals("", token), false);
    assert.equal(tokenEquals(token, ""), false);
  });

  it("a candidate with the same character count but more bytes, without throwing", () => {
    // "é" is one character and two UTF-8 bytes; comparing string lengths and
    // then calling `timingSafeEqual` threw a RangeError here.
    assert.equal(tokenEquals("é", "e"), false);
    assert.equal(tokenEquals("e", "é"), false);
  });

  it("a candidate with the same byte count but different characters", () => {
    // Two ASCII bytes against one two-byte character: equal buffers in
    // length, unequal in content.
    assert.equal(tokenEquals("ab", "é"), false);
  });

  it("is symmetric and refuses every single-character mutation of a random token", () => {
    const token = randomToken();
    const hexDigits = "0123456789abcdef";
    [...token].forEach((char, index) => {
      const replacement = hexDigits[(hexDigits.indexOf(char) + 1) % hexDigits.length];
      const mutated = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
      assert.equal(tokenEquals(mutated, token), false);
      assert.equal(tokenEquals(token, mutated), false);
    });
  });
});
