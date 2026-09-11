import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  beatMayHaveMovie,
  clearReactiveRecords,
  getMissingCharacterKeys,
  hasEditableBeats,
  isSameScript,
  resolveSilentAdvanceSeconds,
  shouldAutoRenderBeat,
  staleSince,
  validateBeatJSON,
  type SafeParseSchema,
} from "../src/vue/helpers";
import { errorMessage } from "@mulmoclaude/common";

// Ported from the host's test/plugins/presentMulmoScript/test_helpers.ts
// when the View moved into this package (phase 2). The SSE-stream helper
// suites did not move — per-beat generation progress now arrives on the
// plugin pubsub channel, so those helpers were deleted with the port.

describe("shouldAutoRenderBeat", () => {
  const autoTypes = ["textSlide", "markdown", "chart"] as const;

  it("returns false when the script has characters, regardless of type", () => {
    assert.equal(shouldAutoRenderBeat({ image: { type: "textSlide" } }, true, autoTypes), false);
  });

  it("returns true for an auto-render type when no characters", () => {
    assert.equal(shouldAutoRenderBeat({ image: { type: "markdown" } }, false, autoTypes), true);
  });

  it("returns false for a type outside the whitelist", () => {
    assert.equal(shouldAutoRenderBeat({ image: { type: "imagePrompt" } }, false, autoTypes), false);
  });

  it("returns false when beat has no image", () => {
    assert.equal(shouldAutoRenderBeat({}, false, autoTypes), false);
  });

  it("returns false when image is present but has no type", () => {
    assert.equal(shouldAutoRenderBeat({ image: {} }, false, autoTypes), false);
  });
});

describe("getMissingCharacterKeys", () => {
  it("returns keys with no image and no 'rendering' state", () => {
    const result = getMissingCharacterKeys(["alice", "bob", "carol"], { alice: "data:..." }, { bob: "rendering" });
    assert.deepEqual(result, ["carol"]);
  });

  it("returns empty array when all keys have images", () => {
    const result = getMissingCharacterKeys(["a", "b"], { a: "x", b: "y" }, {});
    assert.deepEqual(result, []);
  });

  it("returns all keys when nothing is loaded or rendering", () => {
    const result = getMissingCharacterKeys(["a", "b"], {}, {});
    assert.deepEqual(result, ["a", "b"]);
  });

  it("returns empty array when keys is empty", () => {
    assert.deepEqual(getMissingCharacterKeys([], {}, {}), []);
  });

  it("treats 'error' state as missing (not rendering, no image)", () => {
    // After a failed render, the image is absent and state is 'error'
    // — the helper should include that key so a retry can happen.
    const result = getMissingCharacterKeys(["alice"], {}, { alice: "error" });
    assert.deepEqual(result, ["alice"]);
  });
});

describe("validateBeatJSON", () => {
  const passSchema: SafeParseSchema = { safeParse: () => ({ success: true }) };
  const failSchema: SafeParseSchema = { safeParse: () => ({ success: false }) };

  it("returns true for parseable JSON that passes the schema", () => {
    assert.equal(validateBeatJSON('{"speaker":"X"}', passSchema), true);
  });

  it("returns false for parseable JSON that fails the schema", () => {
    assert.equal(validateBeatJSON('{"bad":true}', failSchema), false);
  });

  it("returns false for malformed JSON", () => {
    assert.equal(validateBeatJSON("{not json", passSchema), false);
  });

  it("returns false for an empty string", () => {
    assert.equal(validateBeatJSON("", passSchema), false);
  });

  it("passes the parsed object (not the raw string) to the schema", () => {
    let received: unknown;
    const spy: SafeParseSchema = {
      safeParse(value) {
        received = value;
        return { success: true };
      },
    };
    validateBeatJSON('{"x":1}', spy);
    assert.deepEqual(received, { x: 1 });
  });
});

describe("errorMessage", () => {
  it("returns the message from an Error instance", () => {
    assert.equal(errorMessage(new Error("boom")), "boom");
  });

  it("returns a subclass Error message", () => {
    class CustomError extends Error {}
    assert.equal(errorMessage(new CustomError("nope")), "nope");
  });

  it("coerces a string", () => {
    assert.equal(errorMessage("plain string"), "plain string");
  });

  it("coerces a number", () => {
    assert.equal(errorMessage(404), "404");
  });

  it("coerces null and undefined", () => {
    assert.equal(errorMessage(null), "null");
    assert.equal(errorMessage(undefined), "undefined");
  });

  it("coerces an object without message/details fields", () => {
    assert.equal(errorMessage({ foo: "bar" }), "[object Object]");
  });

  it("surfaces object message / gRPC details fields", () => {
    assert.equal(errorMessage({ message: "from message" }), "from message");
    assert.equal(errorMessage({ details: "from details", code: 3 }), "from details");
  });
});

describe("isSameScript (#1074)", () => {
  it("returns true when two scripts serialise identically", () => {
    const left = { title: "x", beats: [{ text: "" }] };
    const right = { title: "x", beats: [{ text: "" }] };
    assert.equal(isSameScript(left, right), true);
  });

  it("returns false when a single field differs", () => {
    const left = { title: "x", beats: [{ text: "" }] };
    const right = { title: "x", beats: [{ text: "edited" }] };
    assert.equal(isSameScript(left, right), false);
  });

  it("treats different key insertion order as different — false negatives are cheap, false positives are not", () => {
    // We intentionally rely on JSON.stringify's insertion-order
    // semantics here. If two scripts have the same fields but
    // different key order this returns false, which costs us one
    // wasted `emit("updateResult", ...)` — strictly safer than
    // dropping a real edit on the floor.
    const left = { title: "x", lang: "en" };
    const right = { lang: "en", title: "x" };
    assert.equal(isSameScript(left, right), false);
  });

  it("returns true for two empty objects", () => {
    assert.equal(isSameScript({}, {}), true);
  });
});

describe("hasEditableBeats", () => {
  // The gate is "is there a beat to edit", not "is this a deck". `@mulmocast/beat-editor`
  // handles all eight types; the all-slide test this replaces was a limit of the OLD iframe
  // deck editor and kept a markdown script read-only for no reason.
  it("is true for an all-slide deck", () => {
    const script = {
      beats: [{ image: { type: "slide", slide: { layout: "title", title: "A" } } }, { image: { type: "slide", slide: { layout: "bigQuote", quote: "hi" } } }],
    };
    assert.equal(hasEditableBeats(script), true);
  });

  it("is true for a markdown script — the case that used to fall through to a read-only list", () => {
    assert.equal(hasEditableBeats({ beats: [{ image: { type: "markdown", markdown: "# hi" } }] }), true);
  });

  it("is true for a mixed script", () => {
    const mixed = {
      beats: [{ image: { type: "slide", slide: { layout: "title", title: "A" } } }, { image: { type: "movie", source: { kind: "path", path: "x.mp4" } } }],
    };
    assert.equal(hasEditableBeats(mixed), true);
  });

  it("is true for a beat with no image at all — the editor can still give it one", () => {
    assert.equal(hasEditableBeats({ beats: [{ text: "narration only" }] }), true);
  });

  it("is false when there is nothing to edit", () => {
    // The per-beat list already renders an empty state for these.
    assert.equal(hasEditableBeats({ beats: [] }), false);
    assert.equal(hasEditableBeats({}), false);
    assert.equal(hasEditableBeats(null), false);
    assert.equal(hasEditableBeats("nope"), false);
    assert.equal(hasEditableBeats({ beats: "not an array" }), false);
  });
});

describe("beatMayHaveMovie", () => {
  it("returns true for moviePrompt beats", () => {
    assert.equal(beatMayHaveMovie({ moviePrompt: "a hand draws the sketch" }), true);
  });

  it("returns true for animated html_tailwind beats (boolean and options-object forms)", () => {
    assert.equal(beatMayHaveMovie({ image: { type: "html_tailwind", animation: true } }), true);
    assert.equal(beatMayHaveMovie({ image: { type: "html_tailwind", animation: { fps: 30 } } }), true);
  });

  it("returns false for html_tailwind without animation", () => {
    assert.equal(beatMayHaveMovie({ image: { type: "html_tailwind" } }), false);
  });

  it("returns false for animation on a non-html_tailwind type", () => {
    assert.equal(beatMayHaveMovie({ image: { type: "markdown", animation: true } }), false);
  });

  it("returns false for image-only, text-only, and empty beats", () => {
    assert.equal(beatMayHaveMovie({ image: { type: "textSlide" } }), false);
    assert.equal(beatMayHaveMovie({ moviePrompt: "" }), false);
    assert.equal(beatMayHaveMovie({}), false);
  });
});

describe("resolveSilentAdvanceSeconds", () => {
  const DEFAULT_SEC = 3;

  it("returns a valid positive number unchanged", () => {
    assert.equal(resolveSilentAdvanceSeconds(5, DEFAULT_SEC), 5);
    assert.equal(resolveSilentAdvanceSeconds(0.5, DEFAULT_SEC), 0.5);
  });

  it("falls back to the default for zero and negatives — they would fire the timer immediately and race the Play loop", () => {
    assert.equal(resolveSilentAdvanceSeconds(0, DEFAULT_SEC), DEFAULT_SEC);
    assert.equal(resolveSilentAdvanceSeconds(-1, DEFAULT_SEC), DEFAULT_SEC);
  });

  it("falls back to the default for NaN and Infinity", () => {
    assert.equal(resolveSilentAdvanceSeconds(NaN, DEFAULT_SEC), DEFAULT_SEC);
    assert.equal(resolveSilentAdvanceSeconds(Infinity, DEFAULT_SEC), DEFAULT_SEC);
  });

  it("falls back to the default for non-number and missing durations", () => {
    assert.equal(resolveSilentAdvanceSeconds("3", DEFAULT_SEC), DEFAULT_SEC);
    assert.equal(resolveSilentAdvanceSeconds(undefined, DEFAULT_SEC), DEFAULT_SEC);
    assert.equal(resolveSilentAdvanceSeconds(null, DEFAULT_SEC), DEFAULT_SEC);
  });
});

describe("clearReactiveRecords", () => {
  it("deletes every own key of a single record in place", () => {
    const record: Record<string, number> = { a: 1, b: 2, c: 3 };
    clearReactiveRecords(record);
    assert.deepEqual(record, {});
  });

  it("clears every record passed", () => {
    const first: Record<string, number> = { a: 1 };
    const second: Record<number, string> = { 0: "x", 1: "y" };
    clearReactiveRecords(first, second);
    assert.deepEqual(first, {});
    assert.deepEqual(second, {});
  });

  it("mutates in place — same object reference, now empty", () => {
    const record: Record<string, boolean> = { on: true };
    const before = record;
    clearReactiveRecords(record);
    assert.equal(record, before);
    assert.deepEqual(Object.keys(record), []);
  });

  it("is a no-op on an already-empty record and on zero arguments", () => {
    const record: Record<string, number> = {};
    clearReactiveRecords(record);
    assert.deepEqual(record, {});
    assert.doesNotThrow(() => clearReactiveRecords());
  });
});

/**
 * The stale-response guard's identity is the PAIR `(root, filePath)`.
 *
 * `stories/deck.json` exists in every registered root (#3014), so a guard that compares paths
 * alone lets one repository's deck accept another's late response while both are open under the
 * same name — the class this issue's table calls out, which sending `root` does not close on its
 * own.
 */
describe("staleSince", () => {
  const DECK = "stories/deck.json";

  it("is not stale for the same path in the same root", () => {
    assert.equal(staleSince({ filePath: DECK, root: "acme" }, { filePath: DECK, root: "acme" }), false);
    assert.equal(staleSince({ filePath: DECK }, { filePath: DECK }), false);
  });

  it("is stale for a different path, as it always was", () => {
    assert.equal(staleSince({ filePath: "stories/other.json" }, { filePath: DECK }), true);
  });

  it("is stale for the SAME path in a DIFFERENT root — the case the path alone cannot see", () => {
    assert.equal(staleSince({ filePath: DECK, root: "acme" }, { filePath: DECK, root: "widgets" }), true);
    assert.equal(staleSince({ filePath: DECK, root: "widgets" }, { filePath: DECK, root: "acme" }), true);
  });

  it("reads an absent root as the host's default, not as a third value", () => {
    assert.equal(staleSince({ filePath: DECK }, { filePath: DECK, root: undefined }), false);
    assert.equal(staleSince({ filePath: DECK, root: "" }, { filePath: DECK }), false);
    assert.equal(staleSince({ filePath: DECK }, { filePath: DECK, root: "acme" }), true);
  });
});
