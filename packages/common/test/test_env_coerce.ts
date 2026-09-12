// Tests for the int/port coercion rule, moved here from `server/utils/` when
// #3084 needed it in the bridges too.
//
// The move was verified against a verbatim copy of the pre-move function over
// 620k generated (value, fallback, range) triples — 0 mismatches. That harness
// could not survive (half of it was the deleted copy), so what it taught is kept
// here instead: the GENERATOR (which inputs matter — `Number()`'s odd literals,
// whitespace, out-of-range, junk) and the PROPERTIES the callers depend on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { asInt, PORT_RANGE } from "../src/index.ts";

const FALLBACK = 3002;

describe("asInt — absent or empty", () => {
  it("undefined and empty string take the fallback", () => {
    assert.equal(asInt(undefined, FALLBACK), FALLBACK);
    assert.equal(asInt("", FALLBACK), FALLBACK);
  });

  it("whitespace-only coerces to 0, as `Number()` does", () => {
    // Deliberate, and load-bearing: callers that must not read blank as
    // "ephemeral port" reject whitespace BEFORE calling (see
    // `resolveWebhookPort` in @mulmobridge/webhook-runtime).
    assert.equal(asInt(" ", FALLBACK), 0);
    assert.equal(asInt("\t\n", FALLBACK), 0);
  });
});

describe("asInt — the literals `Number()` accepts", () => {
  it("plain integers pass through", () => {
    assert.equal(asInt("0", FALLBACK), 0);
    assert.equal(asInt("3100", FALLBACK), 3100);
    assert.equal(asInt("-1", FALLBACK), -1);
  });

  it("non-decimal and signed forms coerce the way the backend has always read them", () => {
    assert.equal(asInt("0x1f", FALLBACK), 31);
    assert.equal(asInt("0o17", FALLBACK), 15);
    assert.equal(asInt("0b101", FALLBACK), 5);
    assert.equal(asInt("1e3", FALLBACK), 1000);
    assert.equal(asInt("+3100", FALLBACK), 3100);
    assert.equal(asInt("3100.0", FALLBACK), 3100);
    assert.equal(asInt(" 3100 ", FALLBACK), 3100);
  });
});

describe("asInt — abnormal input falls back", () => {
  it("junk, partial numbers and non-integers fall back", () => {
    [
      "302a",
      "a302",
      "NaN",
      "Infinity",
      "-Infinity",
      "null",
      "undefined",
      "true",
      "1_000",
      "３００２",
      "3002.5",
      "1e-3",
      "1,2",
      "[]",
      "{}",
      "80@attacker.example",
    ].forEach((raw) => {
      assert.equal(asInt(raw, FALLBACK), FALLBACK, `expected fallback for ${JSON.stringify(raw)}`);
    });
  });

  it("out-of-range falls back at both ends, inclusive bounds pass", () => {
    assert.equal(asInt("-1", FALLBACK, PORT_RANGE), FALLBACK);
    assert.equal(asInt("65536", FALLBACK, PORT_RANGE), FALLBACK);
    assert.equal(asInt("99999", FALLBACK, PORT_RANGE), FALLBACK);
    assert.equal(asInt("0", FALLBACK, PORT_RANGE), 0);
    assert.equal(asInt("65535", FALLBACK, PORT_RANGE), 65535);
  });

  it("min and max apply independently", () => {
    assert.equal(asInt("5", FALLBACK, { min: 10 }), FALLBACK);
    assert.equal(asInt("50", FALLBACK, { max: 10 }), FALLBACK);
    assert.equal(asInt("50", FALLBACK, { min: 10 }), 50);
  });
});

describe("asInt — properties over generated input", () => {
  // Seeded, not `Math.random()`: a property that fails must fail again on the
  // next run, and the sonarjs/pseudo-random rule is right that an unseeded
  // generator has no place in a committed test.
  const SEED = 0x3084;
  let state = SEED;
  const nextUnit = (): number => {
    // xorshift32 — enough spread for input generation, and reproducible.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };

  const generated: string[] = [];
  for (let i = 0; i < 2000; i++) generated.push(String(Math.floor(nextUnit() * 200_000) - 100_000));
  for (let i = 0; i < 500; i++) generated.push((nextUnit() * 100_000).toFixed(1 + Math.floor(nextUnit() * 3)));
  for (let i = 0; i < 500; i++) generated.push(nextUnit().toString(36).slice(2, 8));

  it("the result is always an integer inside the range, or exactly the fallback", () => {
    generated.forEach((raw) => {
      const got = asInt(raw, FALLBACK, PORT_RANGE);
      if (got === FALLBACK) return;
      assert.ok(Number.isInteger(got), `seed ${SEED}: ${JSON.stringify(raw)} produced a non-integer: ${got}`);
      assert.ok(got >= 0 && got <= 65_535, `seed ${SEED}: ${JSON.stringify(raw)} produced out-of-range: ${got}`);
    });
  });

  it("the fallback is returned for exactly the same inputs whatever its value — the sentinel technique rests on this", () => {
    // `resolveWebhookPort` in @mulmobridge/webhook-runtime detects an unusable
    // value by passing -1 as the fallback and comparing. That is only sound if
    // "returned the fallback" means "the input was unusable" and never "the
    // input happened to equal the fallback".
    generated.forEach((raw) => {
      const viaMinusOne = asInt(raw, -1, PORT_RANGE) === -1;
      const viaMinusTwo = asInt(raw, -2, PORT_RANGE) === -2;
      assert.equal(viaMinusOne, viaMinusTwo, `seed ${SEED}: ${JSON.stringify(raw)} disagrees between two sentinels`);
      if (viaMinusOne)
        assert.equal(asInt(raw, FALLBACK, PORT_RANGE), FALLBACK, `seed ${SEED}: ${JSON.stringify(raw)} fell back for -1 but not for ${FALLBACK}`);
    });
  });

  it("a value the sentinel accepts is never negative, so -1 cannot be a real result", () => {
    generated.concat(["0", "65535", "-1", "-0"]).forEach((raw) => {
      const got = asInt(raw, -1, PORT_RANGE);
      if (got !== -1) assert.ok(got >= 0, `seed ${SEED}: ${JSON.stringify(raw)} produced a negative real result: ${got}`);
    });
  });
});

describe("PORT_RANGE", () => {
  it("admits 0 (ask the OS) through 65535, and is frozen", () => {
    assert.deepEqual({ ...PORT_RANGE }, { min: 0, max: 65_535 });
    assert.ok(Object.isFrozen(PORT_RANGE));
  });
});
