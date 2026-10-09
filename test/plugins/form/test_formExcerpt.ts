// The `excerpt` field of `presentForm` (#3426): a passage shown next to the
// questions about it, with the phrases under discussion marked.
//
// Two halves. `splitExcerpt` decides which characters are marked — checked
// against an independent per-character oracle over generated inputs, so overlap,
// repetition and adjacency are covered without enumerating them by hand. The
// validator decides which definitions reach the view — each refusal has an
// accepted neighbour, so a validator that refuses everything still fails.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitExcerpt, isInputField } from "../../../packages/plugins/form-plugin/src/core/excerpt.ts";
import { executeForm } from "../../../packages/plugins/form-plugin/src/core/plugin.ts";
import type { FormArgs, FormField } from "../../../packages/plugins/form-plugin/src/core/types.ts";

const context = {} as never;

const run = async (fields: unknown[]): Promise<string> => {
  const args = { title: "T", fields } as unknown as FormArgs;
  return (await executeForm(context, args)).message;
};

const accepts = async (fields: unknown[]): Promise<boolean> => !(await run(fields)).startsWith("Form error");

const question = { id: "q", type: "radio", label: "Fix?", choices: ["A", "B"] };
const excerpt = (extra: Record<string, unknown>): Record<string, unknown> => ({
  id: "e",
  type: "excerpt",
  label: "Comment 1",
  text: "alpha beta gamma",
  ...extra,
});

/** Which characters an independent scan says are marked: index `charIndex` is marked
 *  when some non-empty needle occurs at a start that covers it. */
const coversIndex = (text: string, needle: string, charIndex: number): boolean =>
  needle.length > 0 && Array.from(needle).some((_char, offset) => charIndex - offset >= 0 && text.startsWith(needle, charIndex - offset));

const markedByOracle = (text: string, needles: string[]): boolean[] =>
  Array.from(text, (_char, charIndex) => needles.some((needle) => coversIndex(text, needle, charIndex)));

const markedBySplit = (text: string, needles: string[]): boolean[] =>
  splitExcerpt(text, needles).flatMap((segment) => Array.from(segment.text, () => segment.highlighted));

/** Deterministic PRNG so a failure names a reproducible seed. */
const lcg = (seed: number): (() => number) => {
  const state = { value: seed };
  return () => {
    state.value = (state.value * 1103515245 + 12345) % 2147483648;
    return state.value / 2147483648;
  };
};

const randomString = (next: () => number, alphabet: string, maxLength: number): string =>
  Array.from({ length: Math.floor(next() * (maxLength + 1)) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");

const GENERATED_CASES = 2000;
const ALPHABET = "ab.*";
const MAX_TEXT_LENGTH = 24;
const MAX_NEEDLE_LENGTH = 4;
const MAX_NEEDLES = 4;

describe("splitExcerpt — which characters are marked", () => {
  it("matches a per-character oracle on generated text and highlights", () => {
    const seed = 3426;
    const next = lcg(seed);
    Array.from({ length: GENERATED_CASES }).forEach((_, caseIndex) => {
      const text = randomString(next, ALPHABET, MAX_TEXT_LENGTH);
      const needles = Array.from({ length: Math.floor(next() * (MAX_NEEDLES + 1)) }, () => randomString(next, ALPHABET, MAX_NEEDLE_LENGTH));
      const label = `seed ${seed} case ${caseIndex}: ${JSON.stringify({ text, needles })}`;
      const segments = splitExcerpt(text, needles);
      assert.equal(segments.map((segment) => segment.text).join(""), text, `text is not preserved — ${label}`);
      assert.deepEqual(markedBySplit(text, needles), markedByOracle(text, needles), label);
      assert.ok(
        segments.every((segment) => segment.text.length > 0),
        `empty segment — ${label}`,
      );
      assert.ok(
        segments.every((segment, index) => index === 0 || segments[index - 1]?.highlighted !== segment.highlighted),
        `two neighbouring segments share a state — ${label}`,
      );
    });
  });

  it("returns the whole text unmarked when there is nothing to highlight", () => {
    assert.deepEqual(splitExcerpt("plain"), [{ text: "plain", highlighted: false }]);
    assert.deepEqual(splitExcerpt("plain", [""]), [{ text: "plain", highlighted: false }]);
  });

  it("marks a phrase containing regex metacharacters literally", () => {
    assert.deepEqual(splitExcerpt("cost (a+b)*2", ["(a+b)*"]), [
      { text: "cost ", highlighted: false },
      { text: "(a+b)*", highlighted: true },
      { text: "2", highlighted: false },
    ]);
  });

  it("keeps line breaks inside the segments", () => {
    assert.deepEqual(splitExcerpt("one\ntwo", ["two"]), [
      { text: "one\n", highlighted: false },
      { text: "two", highlighted: true },
    ]);
  });

  it("returns no segments for empty text", () => {
    assert.deepEqual(splitExcerpt("", ["a"]), []);
  });
});

describe("isInputField", () => {
  it("is false only for an excerpt", () => {
    const fields = [question, excerpt({})] as unknown as FormField[];
    assert.deepEqual(fields.map(isInputField), [true, false]);
  });
});

describe("presentForm — an excerpt field", () => {
  it("accepts an excerpt with highlights that appear in its text", async () => {
    assert.equal(await accepts([excerpt({ highlights: ["beta", "gam"] }), question]), true);
  });

  it("accepts an excerpt with no highlights", async () => {
    assert.equal(await accepts([excerpt({}), question]), true);
  });

  it("refuses a highlight that does not appear in the text", async () => {
    assert.match(await run([excerpt({ highlights: ["delta"] }), question]), /highlight 'delta' does not appear in text/);
  });

  it("refuses an empty highlight", async () => {
    assert.match(await run([excerpt({ highlights: [""] }), question]), /each highlight must be a non-empty string/);
  });

  it("refuses highlights that are not an array", async () => {
    assert.match(await run([excerpt({ highlights: "beta" }), question]), /highlights must be an array/);
  });

  it("refuses an empty or missing text", async () => {
    assert.match(await run([excerpt({ text: "  " }), question]), /non-empty 'text'/);
    assert.match(await run([excerpt({ text: undefined }), question]), /non-empty 'text'/);
  });

  it("refuses a form made only of excerpts, and accepts it once a question is added", async () => {
    assert.match(await run([excerpt({})]), /At least one field must ask for input/);
    assert.equal(await accepts([excerpt({}), question]), true);
  });

  it("still refuses an excerpt whose id another field already uses", async () => {
    assert.match(await run([excerpt({ id: "q" }), question]), /Duplicate field ID: 'q'/);
  });
});
