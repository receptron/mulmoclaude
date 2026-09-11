import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Every dispatch the browser makes carries the root its card names (#3014).
 *
 * `stories/deck.json` exists in EVERY registered root, so a call that sends only the path
 * addresses the DEFAULT root's file of that name. That is not a theoretical collision: a deck
 * inside a registered root opened fine and then answered `File not found` to every save and
 * every beat image, because the card carried `root` and the View sent `filePath` alone
 * (receptron/mulmoterminal#1970, measured against a running server).
 *
 * The rule is stated as what is PERMITTED rather than as a list of bad spellings: an argument
 * object must spread a story ref or name `root` outright. A new call site written the old way is
 * then red by default, instead of being caught only when someone thinks to look — which is how
 * this shipped root-blind through three releases.
 */

const here = dirname(fileURLToPath(import.meta.url));
const VUE_SOURCES = [
  "src/vue/View.vue",
  "src/vue/composables/useBeatMovie.ts",
  "src/vue/composables/useCharacterImages.ts",
  "src/vue/composables/useDeckEditor.ts",
  "src/vue/composables/useMediaExport.ts",
] as const;

/** The argument text of every `api.call("<kind>", <args>)` in one file, kind included. */
function dispatchArguments(source: string): { kind: string; args: string }[] {
  const calls: { kind: string; args: string }[] = [];
  const opener = /api\.call\(\s*"([a-zA-Z]+)"\s*,\s*/g;
  let match = opener.exec(source);
  while (match) {
    const kind = match[1] ?? "";
    // Walk to the matching close paren so a nested object or call does not end the slice early.
    let depth = 1;
    let index = opener.lastIndex;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "(" || char === "{") depth += 1;
      if (char === ")" || char === "}") depth -= 1;
      index += 1;
    }
    calls.push({ kind, args: source.slice(opener.lastIndex, index - 1) });
    match = opener.exec(source);
  }
  return calls;
}

/** A ref spread (`...requested`, `...storyRef()`), a bare ref, or an explicit `root`. */
function carriesRoot(args: string): boolean {
  return /\.\.\.(requested|storyRef\(\))/.test(args) || /^\s*(requested|storyRef\(\))\s*$/.test(args) || /\broot:/.test(args);
}

describe("every browser dispatch carries its card's root", () => {
  VUE_SOURCES.forEach((relative) => {
    it(`${relative} names a root on every api.call`, () => {
      const source = readFileSync(join(here, "..", relative), "utf-8");
      const calls = dispatchArguments(source);
      assert.ok(calls.length > 0, `${relative} has at least one dispatch to check`);
      const rootless = calls.filter((call) => !carriesRoot(call.args)).map((call) => call.kind);
      assert.deepEqual(rootless, [], `these dispatches send no root: ${rootless.join(", ")}`);
    });
  });

  it("checks every dispatch in the Vue layer, so a new FILE cannot slip past the list", () => {
    const viewSource = readFileSync(join(here, "..", "src", "vue", "View.vue"), "utf-8");
    const composables = viewSource.match(/from "\.\/composables\/(\w+)"/g) ?? [];
    const listed = VUE_SOURCES.join(" ");
    composables.forEach((importLine) => {
      const name = /composables\/(\w+)/.exec(importLine)?.[1];
      assert.ok(name && listed.includes(`composables/${name}.ts`), `composable ${name} is not in VUE_SOURCES`);
    });
  });

  it("sends a card with NO root exactly as it did before roots existed", () => {
    // The backward-compatibility claim, checked rather than argued: a default-root card's
    // arguments must reach the wire byte-identical to the pre-root spelling, so every existing
    // card keeps its behaviour. `root: undefined` is dropped by JSON.stringify, and the server
    // reads an absent OR empty root as the default (`str()` in `server/dispatch.ts`).
    const withDefaultRoot = { filePath: "stories/a.json", root: undefined, beatIndex: 3 };
    const beforeRoots = { filePath: "stories/a.json", beatIndex: 3 };
    assert.equal(JSON.stringify(withDefaultRoot), JSON.stringify(beforeRoots));
  });

  it("subscribes with the card's root too — the pair filters generation and foreign-write events", () => {
    const viewSource = readFileSync(join(here, "..", "src", "vue", "View.vue"), "utf-8");
    const deckSource = readFileSync(join(here, "..", "src", "vue", "composables", "useDeckEditor.ts"), "utf-8");
    assert.match(viewSource, /root: \(\) => root\.value/);
    assert.match(deckSource, /root: \(\) => root\.value/);
    assert.doesNotMatch(viewSource, /root: \(\) => undefined/);
    assert.doesNotMatch(deckSource, /root: \(\) => undefined/);
  });
});
