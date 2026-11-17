import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseExtraServerArgs, resolveExtraServerArgs } from "../../src/whisper/extra-args.ts";

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
  const reservedFlags = ["-m", "--model", "-h", "--help", "--host", "--port", "--public", "--request-path", "--inference-path", "--convert", "--tmp-dir"];
  for (const flag of reservedFlags) {
    it(`rejects ${flag} in plain text`, () => {
      const result = parseExtraServerArgs(`--vad ${flag} x`);
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.reason.includes(flag));
    });

    it(`rejects ${flag} in a JSON array`, () => {
      assert.equal(parseExtraServerArgs(JSON.stringify(["--vad", flag, "x"])).ok, false);
    });
  }

  for (const attached of ["--port=1", "--host=0.0.0.0", "--model=/x.bin", "--inference-path=/x"]) {
    it(`rejects the attached form ${attached}`, () => {
      const result = parseExtraServerArgs(`--vad ${attached}`);
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.reason.includes(attached.split("=")[0] ?? ""));
    });
  }

  it("rejects a NUL character, which spawn() would throw on", () => {
    const result = parseExtraServerArgs(JSON.stringify(["--vad-model", "/a\u0000b"]));
    assert.equal(result.ok, false);
  });

  it("rejects malformed JSON", () => {
    assert.equal(parseExtraServerArgs('["--vad", ').ok, false);
  });

  it("rejects a JSON array holding non-strings", () => {
    assert.equal(parseExtraServerArgs('["--vad-threshold", 0.6]').ok, false);
    assert.equal(parseExtraServerArgs("[null]").ok, false);
    assert.equal(parseExtraServerArgs('[["--vad"]]').ok, false);
  });
});

interface LoggedLine {
  readonly level: "info" | "warn";
  readonly message: string;
  readonly data: unknown;
}

function recordingLogger(): { lines: LoggedLine[]; logger: Parameters<typeof resolveExtraServerArgs>[1] } {
  const lines: LoggedLine[] = [];
  const push = (level: LoggedLine["level"]) => (message: string, data?: unknown) => lines.push({ level, message, data });
  return { lines, logger: { info: push("info"), warn: push("warn"), error: () => undefined } };
}

describe("resolveExtraServerArgs", () => {
  it("is silent and adds nothing when unset", () => {
    const { lines, logger } = recordingLogger();
    assert.deepEqual(resolveExtraServerArgs(undefined, logger), []);
    assert.deepEqual(lines, []);
  });

  it("returns the args and logs only their count, never a value", () => {
    const { lines, logger } = recordingLogger();
    assert.deepEqual(resolveExtraServerArgs("--vad --vad-model -private/model.bin", logger), ["--vad", "--vad-model", "-private/model.bin"]);
    assert.deepEqual(lines, [{ level: "info", message: "WHISPER_SERVER_EXTRA_ARGS applied", data: { count: 3 } }]);
  });

  it("falls back to no extras with a warning on a rejected value", () => {
    const { lines, logger } = recordingLogger();
    assert.deepEqual(resolveExtraServerArgs("--vad --port 1", logger), []);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.level, "warn");
  });
});
