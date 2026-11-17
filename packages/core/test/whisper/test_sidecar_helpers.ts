import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { appendStderrTail, buildServerArgs, parseInferenceText } from "../../src/whisper/sidecar-helpers.ts";

describe("buildServerArgs", () => {
  it("builds the whisper-server argv with the port stringified", () => {
    assert.deepEqual(buildServerArgs("/models/ggml-small.bin", "127.0.0.1", 8080), [
      "--model",
      "/models/ggml-small.bin",
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
    ]);
  });

  it("appends extra args after the ones it owns", () => {
    assert.deepEqual(buildServerArgs("/m.bin", "127.0.0.1", 8080, ["--vad", "--vad-model", "/v.bin"]), [
      "--model",
      "/m.bin",
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
      "--vad",
      "--vad-model",
      "/v.bin",
    ]);
  });
});

describe("appendStderrTail", () => {
  it("appends when under the limit", () => {
    assert.equal(appendStderrTail("abc", "def", 100), "abcdef");
  });

  it("keeps only the last maxChars once over the limit", () => {
    assert.equal(appendStderrTail("12345", "6789", 4), "6789");
  });

  it("handles an empty previous tail", () => {
    assert.equal(appendStderrTail("", "hello", 3), "llo");
  });

  it("is a no-op for an empty chunk", () => {
    assert.equal(appendStderrTail("abc", "", 10), "abc");
  });

  it("returns the whole string when maxChars is 0 (slice(-0) === slice(0))", () => {
    assert.equal(appendStderrTail("abc", "d", 0), "abcd");
  });
});

describe("parseInferenceText", () => {
  it("returns the transcript from a valid response", () => {
    assert.equal(parseInferenceText({ text: "hello world" }), "hello world");
  });

  it("returns an empty transcript verbatim", () => {
    assert.equal(parseInferenceText({ text: "" }), "");
  });

  it("returns '' when text is missing", () => {
    assert.equal(parseInferenceText({}), "");
  });

  it("returns '' when text is not a string", () => {
    assert.equal(parseInferenceText({ text: 123 }), "");
  });

  it("returns '' for null / non-object / undefined inputs", () => {
    assert.equal(parseInferenceText(null), "");
    assert.equal(parseInferenceText("hi"), "");
    assert.equal(parseInferenceText(undefined), "");
    assert.equal(parseInferenceText([]), "");
  });
});
