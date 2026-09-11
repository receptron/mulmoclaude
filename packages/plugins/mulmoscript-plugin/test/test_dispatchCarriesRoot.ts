import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
const VUE_DIR = join(here, "..", "src", "vue");

/**
 * Every browser-side file that dispatches, DISCOVERED rather than listed.
 *
 * A hardcoded list only guards the files someone remembered to add to it, and a new composable
 * is exactly the thing that would be written root-blind (Codex, round 1). Walking the tree means
 * a new file is covered the moment it makes its first `api.call`.
 */
function dispatchingSources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.(ts|vue)$/.test(entry.name) && readFileSync(full, "utf-8").includes("api.call(") ? [full] : [];
    });
  return walk(VUE_DIR).sort();
}

const VUE_SOURCES = dispatchingSources();
/** Shown in test names — the path from `src/vue` down, not the absolute one. */
const label = (absolute: string): string => absolute.slice(absolute.indexOf(join("src", "vue")));

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
  assert.ok(VUE_SOURCES.length >= 5, "the walk found the dispatching files");
  VUE_SOURCES.forEach((absolute) => {
    it(`${label(absolute)} names a root on every api.call`, () => {
      const source = readFileSync(absolute, "utf-8");
      const calls = dispatchArguments(source);
      assert.ok(calls.length > 0, `${label(absolute)} has at least one dispatch to check`);
      const rootless = calls.filter((call) => !carriesRoot(call.args)).map((call) => call.kind);
      assert.deepEqual(rootless, [], `these dispatches send no root: ${rootless.join(", ")}`);
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

/**
 * Every AWAITED dispatch that then mutates View state re-checks the pair first.
 *
 * Sending the root fixes which file a call addresses; it does not fix which card the ANSWER is
 * applied to. `selectedResult` can change during the await, and the same `stories/deck.json`
 * exists in every root — so a response from one deck could seed the source editor with another
 * deck's text, or commit it into the card now on screen (Codex P2, round 1). Two of the three
 * unguarded sites were exactly that.
 *
 * Stated as what is PERMITTED: after the await, a call site either re-checks the pair
 * (`staleSince` / `isStale()`) or is one of the named exceptions below, each with its reason.
 * A new awaited dispatch is then red by default.
 */
describe("an awaited dispatch re-checks the pair before it applies the answer", () => {
  /** Guarded by `editRevision`, not `staleSince`: `resetForScriptChange()` advances it on a
   *  result switch, so a stale answer is dropped by the revision check instead. */
  const GUARDED_BY_REVISION = new Set(["useDeckEditor.ts:updateScript"]);

  VUE_SOURCES.forEach((absolute) => {
    it(`${label(absolute)} guards every awaited dispatch`, () => {
      const source = readFileSync(absolute, "utf-8");
      const file = absolute.split("/").pop() ?? absolute;
      const unguarded: string[] = [];
      const awaited = /await api\.call\(\s*"(\w+)"/g;
      let match = awaited.exec(source);
      while (match) {
        const kind = match[1] ?? "";
        // The guard has to be close: past ~400 characters the answer has already been applied.
        const following = source.slice(match.index, match.index + 400);
        const guarded = /staleSince\(|isStale\(\)|revision !== editRevision/.test(following);
        if (!guarded && !GUARDED_BY_REVISION.has(`${file}:${kind}`)) unguarded.push(kind);
        match = awaited.exec(source);
      }
      assert.deepEqual(unguarded, [], `these awaited dispatches apply their answer unguarded: ${unguarded.join(", ")}`);
    });
  });
});

/**
 * The media-byte download carries the root too.
 *
 * `toStoryRef` relativizes an artifact against ITS OWN root's directory, so a `moviePath` /
 * `pdfPath` does not carry the root — and the same `stories/…/__movies__/x.mov` exists in every
 * registered one. The issue predicted this exact consumer: "a consumer that stores the ref
 * alone breaks". `fetchMediaBlob` is that consumer (Codex P2, round 1).
 */
describe("media-byte downloads carry the root", () => {
  it("the host adapter's query declares it", () => {
    const adapter = readFileSync(join(here, "..", "src", "vue", "hostAdapter.ts"), "utf-8");
    assert.match(adapter, /fetchMediaBlob\?: \(query: \{[^}]*root\?: string \| undefined[^}]*\}\)/);
  });

  it("both call sites pass it", () => {
    const beatMovie = readFileSync(join(here, "..", "src", "vue", "composables", "useBeatMovie.ts"), "utf-8");
    const mediaExport = readFileSync(join(here, "..", "src", "vue", "composables", "useMediaExport.ts"), "utf-8");
    const calls = [...beatMovie.matchAll(/fetchMediaBlob\(([^)]*)\)/g), ...mediaExport.matchAll(/fetchMediaBlob\(([^)]*)\)/g)]
      .map((m) => m[1] ?? "")
      .filter((args) => args.includes("Path"));
    assert.ok(calls.length >= 2, "both download call sites are found");
    calls.forEach((args) => assert.match(args, /root: root\.value/, `this fetchMediaBlob call sends no root: ${args}`));
  });
});
