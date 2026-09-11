// First tests for the mulmoscript plugin, which shipped with none. These cover
// the pure helpers the View leans on to decide what to render, what to
// re-fetch, and whether the deck editor mounts at all — the decisions that go
// wrong silently (a beat that never renders, a movie probe that never fires)
// rather than throwing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  beatMayHaveMovie,
  beatTooltip,
  characterPrompt,
  downloadFilename,
  effectiveBeat,
  getMissingCharacterKeys,
  hasEditableBeats,
  isBeatImageReference,
  isSameScript,
  isValidBeat,
  scriptSourceText,
  shouldAutoRenderBeat,
  staleSince,
  validateBeatJSON,
  type Beat,
  type SafeParseSchema,
} from "../../../packages/plugins/mulmoscript-plugin/src/vue/helpers.ts";

const AUTO_RENDER_TYPES = ["slide", "chart", "html_tailwind"] as const;

describe("shouldAutoRenderBeat", () => {
  // Characters must be rendered first so character-using beats can reference
  // them — auto-rendering ahead of that produces beats missing their cast.
  it("refuses every beat when the script has characters", () => {
    assert.equal(shouldAutoRenderBeat({ image: { type: "slide" } }, true, AUTO_RENDER_TYPES), false);
  });

  it("accepts an auto-render type when there are no characters", () => {
    assert.equal(shouldAutoRenderBeat({ image: { type: "slide" } }, false, AUTO_RENDER_TYPES), true);
  });

  it("refuses a type outside the auto-render list", () => {
    assert.equal(shouldAutoRenderBeat({ image: { type: "imagePrompt" } }, false, AUTO_RENDER_TYPES), false);
  });

  it("refuses a beat with no image, no type, or a non-string type", () => {
    assert.equal(shouldAutoRenderBeat({}, false, AUTO_RENDER_TYPES), false);
    assert.equal(shouldAutoRenderBeat({ image: {} }, false, AUTO_RENDER_TYPES), false);
    assert.equal(shouldAutoRenderBeat({ image: { type: undefined } }, false, AUTO_RENDER_TYPES), false);
  });

  it("refuses everything when the auto-render list is empty", () => {
    assert.equal(shouldAutoRenderBeat({ image: { type: "slide" } }, false, []), false);
  });
});

describe("getMissingCharacterKeys", () => {
  it("returns keys with neither an image nor an in-flight render", () => {
    assert.deepEqual(getMissingCharacterKeys(["alice", "bob"], {}, {}), ["alice", "bob"]);
  });

  it("drops keys whose image is already loaded", () => {
    assert.deepEqual(getMissingCharacterKeys(["alice", "bob"], { alice: "data:image/png;base64,AAA" }, {}), ["bob"]);
  });

  // Re-fetching a key that is mid-render would race the render that is already
  // running and overwrite the newer result with the older one.
  it("drops keys currently rendering", () => {
    assert.deepEqual(getMissingCharacterKeys(["alice", "bob"], {}, { alice: "rendering" }), ["bob"]);
  });

  it("keeps a key whose render state is a non-rendering status", () => {
    assert.deepEqual(getMissingCharacterKeys(["alice"], {}, { alice: "failed" }), ["alice"]);
  });

  // A falsy-but-present image (empty string) means "no image yet", so the key
  // still needs fetching.
  it("treats an empty-string image as missing", () => {
    assert.deepEqual(getMissingCharacterKeys(["alice"], { alice: "" }, {}), ["alice"]);
  });

  it("returns an empty array for no keys", () => {
    assert.deepEqual(getMissingCharacterKeys([], { alice: "x" }, {}), []);
  });
});

describe("validateBeatJSON", () => {
  const acceptAll: SafeParseSchema = { safeParse: () => ({ success: true }) };
  const rejectAll: SafeParseSchema = { safeParse: () => ({ success: false }) };

  it("accepts parseable JSON the schema approves", () => {
    assert.equal(validateBeatJSON('{"text":"hi"}', acceptAll), true);
  });

  it("rejects parseable JSON the schema refuses", () => {
    assert.equal(validateBeatJSON('{"text":"hi"}', rejectAll), false);
  });

  // A parse failure must not reach the schema at all — an editor mid-keystroke
  // produces malformed JSON constantly.
  it("rejects malformed JSON without consulting the schema", () => {
    let consulted = false;
    const spy: SafeParseSchema = {
      safeParse: () => {
        consulted = true;
        return { success: true };
      },
    };
    assert.equal(validateBeatJSON("{ not json", spy), false);
    assert.equal(consulted, false);
  });

  it("rejects an empty string", () => {
    assert.equal(validateBeatJSON("", acceptAll), false);
  });

  // `JSON.parse("null")` succeeds, so the schema — not the parse — is what
  // must reject it.
  it("passes a bare null through to the schema", () => {
    assert.equal(validateBeatJSON("null", acceptAll), true);
    assert.equal(validateBeatJSON("null", rejectAll), false);
  });
});

describe("isSameScript", () => {
  it("treats structurally identical scripts as the same", () => {
    assert.equal(isSameScript({ beats: [{ text: "a" }] }, { beats: [{ text: "a" }] }), true);
  });

  it("treats a changed value as different", () => {
    assert.equal(isSameScript({ beats: [{ text: "a" }] }, { beats: [{ text: "b" }] }), false);
  });

  it("treats an added key as different", () => {
    assert.equal(isSameScript({ beats: [] }, { beats: [], title: "x" }), false);
  });

  it("treats both undefined as the same, and one undefined as different", () => {
    assert.equal(isSameScript(undefined, undefined), true);
    assert.equal(isSameScript(undefined, {}), false);
  });

  // Documented limitation: the comparison is JSON re-serialisation, so key
  // ORDER counts. A false "differ" only costs a redundant emit, which is a
  // no-op downstream — but the behaviour should be pinned, not discovered.
  it("reports reordered keys as different (serialisation-order sensitivity)", () => {
    assert.equal(isSameScript({ a: 1, b: 2 }, { b: 2, a: 1 }), false);
  });
});

describe("beatMayHaveMovie", () => {
  it("accepts a beat carrying a moviePrompt", () => {
    assert.equal(beatMayHaveMovie({ moviePrompt: "pan across the city" }), true);
  });

  it("accepts an html_tailwind beat with animation enabled", () => {
    assert.equal(beatMayHaveMovie({ image: { type: "html_tailwind", animation: true } }), true);
  });

  it("accepts an html_tailwind beat whose animation is an options object", () => {
    assert.equal(beatMayHaveMovie({ image: { type: "html_tailwind", animation: { duration: 3 } } }), true);
  });

  it("refuses html_tailwind without animation", () => {
    assert.equal(beatMayHaveMovie({ image: { type: "html_tailwind" } }), false);
    assert.equal(beatMayHaveMovie({ image: { type: "html_tailwind", animation: false } }), false);
  });

  it("refuses a non-html_tailwind beat even with animation set", () => {
    assert.equal(beatMayHaveMovie({ image: { type: "slide", animation: true } }), false);
  });

  it("refuses an empty beat and an empty moviePrompt", () => {
    assert.equal(beatMayHaveMovie({}), false);
    assert.equal(beatMayHaveMovie({ moviePrompt: "" }), false);
  });
});

describe("isBeatImageReference", () => {
  it("accepts a beat whose image references another beat", () => {
    assert.equal(isBeatImageReference({ image: { type: "beat", id: "intro" } }), true);
  });

  it("refuses beats that own their image", () => {
    assert.equal(isBeatImageReference({ image: { type: "slide" } }), false);
    assert.equal(isBeatImageReference({ image: { type: "imagePrompt" } }), false);
  });

  it("refuses a beat with no image", () => {
    assert.equal(isBeatImageReference({}), false);
  });
});

describe("hasEditableBeats", () => {
  const slide = { image: { type: "slide" } };

  // The gate is "is there a beat to edit", not "is this a deck": the editor handles all eight
  // beat types. The all-slide test this replaces belonged to the old iframe deck editor.
  it("accepts a script whose beats are all slides", () => {
    assert.equal(hasEditableBeats({ beats: [slide, slide] }), true);
  });

  it("accepts a mixed script — the non-slide beats are editable too", () => {
    assert.equal(hasEditableBeats({ beats: [slide, { image: { type: "markdown" } }] }), true);
  });

  it("refuses an empty or missing beats array", () => {
    // Nothing to edit; the per-beat list already renders an empty state.
    assert.equal(hasEditableBeats({ beats: [] }), false);
    assert.equal(hasEditableBeats({}), false);
    assert.equal(hasEditableBeats({ beats: "not an array" }), false);
  });
});

describe("effectiveBeat", () => {
  const beats: Beat[] = [{ text: "original 0" }, { text: "original 1" }];

  it("returns the on-disk beat when there is no override", () => {
    assert.deepEqual(effectiveBeat({}, beats, 1), { text: "original 1" });
  });

  // The user's in-place edit must win over the on-disk beat, otherwise a
  // just-saved edit would flash back to its pre-edit content.
  it("prefers a local override over the on-disk beat", () => {
    assert.deepEqual(effectiveBeat({ 1: { text: "edited 1" } }, beats, 1), { text: "edited 1" });
  });

  // Callers read `.text` / `.image` off the result unconditionally, so an
  // out-of-range index must yield an object, never undefined.
  it("returns an empty beat for an out-of-range index", () => {
    assert.deepEqual(effectiveBeat({}, beats, 9), {});
    assert.deepEqual(effectiveBeat({}, [], 0), {});
  });
});

describe("beatTooltip", () => {
  it("returns an empty string for missing text", () => {
    assert.equal(beatTooltip(undefined), "");
    assert.equal(beatTooltip(""), "");
  });

  it("returns short text unchanged", () => {
    assert.equal(beatTooltip("hello"), "hello");
  });

  // Boundary: 80 chars is returned whole, 81 is the first cut. Off-by-one
  // here would either clip a legal-length tooltip or leak an over-long one.
  it("returns text of exactly the cap length unchanged", () => {
    const exactly80 = "a".repeat(80);
    assert.equal(beatTooltip(exactly80), exactly80);
  });

  it("truncates past the cap and appends an ellipsis", () => {
    const over = "a".repeat(81);
    assert.equal(beatTooltip(over), `${"a".repeat(80)}…`);
    assert.equal(beatTooltip(over).length, 81);
  });
});

describe("characterPrompt", () => {
  const images: Record<string, { type: string; prompt?: string }> = {
    alice: { type: "imagePrompt", prompt: "a knight" },
    bob: { type: "imagePrompt" },
  };

  it("returns the prompt for a known key", () => {
    assert.equal(characterPrompt(images, "alice"), "a knight");
  });

  it("returns an empty string when the key is absent", () => {
    assert.equal(characterPrompt(images, "carol"), "");
  });

  it("returns an empty string when the entry has no prompt", () => {
    assert.equal(characterPrompt(images, "bob"), "");
  });

  it("returns an empty string when there are no images", () => {
    assert.equal(characterPrompt(undefined, "alice"), "");
    assert.equal(characterPrompt({}, "alice"), "");
  });
});

describe("isValidBeat", () => {
  const acceptAll: SafeParseSchema = { safeParse: () => ({ success: true }) };
  const rejectAll: SafeParseSchema = { safeParse: () => ({ success: false }) };

  it("validates parseable source the schema approves", () => {
    assert.equal(isValidBeat('{"text":"hi"}', acceptAll), true);
    assert.equal(isValidBeat('{"text":"hi"}', rejectAll), false);
  });

  // A never-opened source editor has no entry; the empty-string default is
  // not parseable JSON, so it must report invalid rather than throw.
  it("treats a missing or empty source as invalid", () => {
    assert.equal(isValidBeat(undefined, acceptAll), false);
    assert.equal(isValidBeat("", acceptAll), false);
  });
});

describe("staleSince", () => {
  // The guard drops a late response once the View navigated elsewhere. The
  // direction is load-bearing — an inverted check would let one script's
  // responses write into another's per-beat state.
  //
  // The identity is the PAIR `(root, filePath)`: `stories/deck.json` exists in every
  // registered root (#3014), so the path alone lets one repository's deck accept another's
  // late response. The full set of root cases lives with the plugin, in
  // `packages/plugins/mulmoscript-plugin/test/test_helpers.ts` — this file predates the
  // plugin's own suite and duplicates it.
  it("is stale only when the current path differs from the requested one", () => {
    assert.equal(staleSince({ filePath: "stories/b.json" }, { filePath: "stories/a.json" }), true);
    assert.equal(staleSince({ filePath: "stories/a.json" }, { filePath: "stories/a.json" }), false);
  });

  it("treats two empty paths as not stale", () => {
    assert.equal(staleSince({ filePath: "" }, { filePath: "" }), false);
  });

  it("is stale for the same path in a different root", () => {
    assert.equal(staleSince({ filePath: "stories/a.json", root: "acme" }, { filePath: "stories/a.json", root: "widgets" }), true);
  });
});

describe("scriptSourceText", () => {
  it("pretty-prints with a two-space indent", () => {
    assert.equal(scriptSourceText({ a: 1 }), '{\n  "a": 1\n}');
  });

  it("round-trips through JSON.parse", () => {
    const value = { title: "x", beats: [{ text: "a" }] };
    assert.deepEqual(JSON.parse(scriptSourceText(value)), value);
  });
});

describe("downloadFilename", () => {
  it("takes the basename of a path", () => {
    assert.equal(downloadFilename("stories/deck/movie.mp4", "movie.mp4"), "movie.mp4");
  });

  it("returns the whole string when there is no separator", () => {
    assert.equal(downloadFilename("clip.mp4", "movie.mp4"), "clip.mp4");
  });

  // Pinned limitation: `.pop()` returns "" (not undefined) for a trailing
  // slash or empty path, and `?? fallback` does not replace "", so the
  // fallback is effectively unreachable for any string input. Server paths
  // always carry a basename, so this never surfaces — the test exists so a
  // later reader doesn't "simplify" `??` to `||` and silently change it.
  it("yields an empty name (NOT the fallback) for a trailing slash or empty path", () => {
    assert.equal(downloadFilename("stories/deck/", "movie.mp4"), "");
    assert.equal(downloadFilename("", "movie.mp4"), "");
  });
});
