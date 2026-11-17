import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseExtraServerArgs } from "../../src/whisper/extra-args.ts";

describe("parseExtraServerArgs — accepted", () => {
  it("returns no args when the variable is unset", () => {
    assert.deepEqual(parseExtraServerArgs(undefined), { ok: true, args: [] });
  });

  it("returns no args for an empty or whitespace-only value", () => {
    assert.deepEqual(parseExtraServerArgs(""), { ok: true, args: [] });
    assert.deepEqual(parseExtraServerArgs("  \t\n "), { ok: true, args: [] });
  });

  it("splits plain text on any run of whitespace", () => {
    assert.deepEqual(parseExtraServerArgs("  --vad   --vad-model\t/m/silero.bin\n"), {
      ok: true,
      args: ["--vad", "--vad-model", "/m/silero.bin"],
    });
  });

  it("keeps a path with spaces intact when given as a JSON array", () => {
    assert.deepEqual(parseExtraServerArgs('["--vad", "--vad-model", "/Users/a b/silero.bin"]'), {
      ok: true,
      args: ["--vad", "--vad-model", "/Users/a b/silero.bin"],
    });
  });

  it("accepts an empty JSON array", () => {
    assert.deepEqual(parseExtraServerArgs("[]"), { ok: true, args: [] });
  });

  it("accepts flags that only look like reserved ones", () => {
    assert.deepEqual(parseExtraServerArgs("--model-path x --no-speech-thold 0.4"), {
      ok: true,
      args: ["--model-path", "x", "--no-speech-thold", "0.4"],
    });
  });
});

describe("parseExtraServerArgs — rejected", () => {
  for (const flag of ["-m", "--model", "--host", "--port"]) {
    it(`rejects ${flag} in plain text`, () => {
      const result = parseExtraServerArgs(`--vad ${flag} x`);
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.reason.includes(flag));
    });

    it(`rejects ${flag} in a JSON array`, () => {
      assert.equal(parseExtraServerArgs(JSON.stringify(["--vad", flag, "x"])).ok, false);
    });
  }

  it("rejects malformed JSON", () => {
    assert.equal(parseExtraServerArgs('["--vad", ').ok, false);
  });

  it("rejects a JSON array holding non-strings", () => {
    assert.equal(parseExtraServerArgs('["--vad-threshold", 0.6]').ok, false);
    assert.equal(parseExtraServerArgs("[null]").ok, false);
    assert.equal(parseExtraServerArgs('[["--vad"]]').ok, false);
  });
});
