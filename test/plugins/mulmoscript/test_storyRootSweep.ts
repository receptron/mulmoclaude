import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/**
 * A story is addressed by the PAIR `(root, filePath)`, everywhere in the host.
 *
 * `stories/deck.json` exists in EVERY registered stories root (#3014), so a host call that
 * resolves a path alone reads the DEFAULT root's file of that name. This rule was patched three
 * times before it was written down — the media-byte download, the session rehydration, and the
 * movie/PDF generation body — so it is stated here as a rule instead of a fourth fix. #3077 then
 * used it to find and close the whole REST surface at once, which is what the rule is for.
 *
 * It is deliberately phrased as what is PERMITTED: a `resolveStory` call names a root, OR it is
 * in `ROOTLESS_BY_DESIGN` below with the reason it cannot have one. Everything else is reported.
 * That direction is the point — a new call site is red by default rather than correct by luck,
 * and the exceptions are a list someone has to justify rather than a silence.
 *
 * It over-reports by construction: a call whose root genuinely does not exist has to be added to
 * the list with a sentence. That is the trade, and it is the right one here, because the failure
 * this guards against is silent — the wrong deck is read and nothing errors.
 *
 * WHAT THIS DOES NOT COVER, said out loud rather than left to be discovered:
 *
 * - It is a TEXTUAL rule over host code under `server/` and `src/`. An aliased or computed call
 *   (`const rs = ops.resolveStory; rs(p)`) would slip past the argument check, so a second test
 *   below forbids naming these ops in any form other than a direct call. An AST rule would be
 *   stronger; this is the version that pays for itself today.
 * - It says nothing about the PACKAGE's own internals — `resolveStory` is defined there, and the
 *   package has its own root contract tests.
 * - A future helper that wraps one of these ops and takes `filePath` without `root` would be
 *   reported where it is WRITTEN, but its callers would not be. Exemptions are therefore kept at
 *   call granularity, never file granularity.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");
const SEARCHED = ["server", "src"] as const;

/**
 * Every ops entry point that resolves a story, and therefore takes a root.
 *
 * `resolveStory` was the one the first three findings landed on, but it is not the only door:
 * the beat / status / generation ops resolve internally through `runStoryOp`, and reach the same
 * wrong file when the host calls them with a path alone (Codex, round 3 step C-bis).
 */
const ROOT_TAKING_OPS = [
  "resolveStory",
  "beatImageOp",
  "beatAudioOp",
  "beatMovieOp",
  "characterImageOp",
  "movieStatusOp",
  "pdfStatusOp",
  "renderBeatOp",
  "generateBeatAudioOp",
  "renderCharacterOp",
  "uploadBeatImageOp",
  "uploadCharacterImageOp",
] as const;

/**
 * Call sites that may address a story by path alone, and why.
 *
 * Keyed by `<path-from-repo-root>:<the call's own line text, trimmed>` so moving a file or
 * changing the call breaks the exemption rather than silently carrying it.
 */
const ROOTLESS_BY_DESIGN = new Map<string, string>([
  [
    "server/api/routes/mulmo-script.ts:const resolved = mulmoScriptOps.resolveStory(outcome.filePath);",
    "The AGENT's tool path: this route's body IS `SaveMulmoScriptArgs`, and `root` is deliberately not in the tool schema, so a model cannot name one (#3015). Every save reaching here is in the default root by construction.",
  ],
]);

/**
 * Ops handed to a factory as a VALUE rather than called directly.
 *
 * `makeBeatOpHandler(op, …)` invokes them with a `BeatOpArgs` that carries `root` since #3077, so
 * the root reaches these ops through the factory rather than through an argument list this
 * textual rule can read.
 *
 * What makes that safe rather than a hole is a BEHAVIOURAL test, not this sentence:
 * `test/server/api/test_mulmoScriptBeatOp.ts` → "makeBeatOpHandler — the root it hands the op"
 * asserts the factory forwards a named root and degrades an absent, empty or wrong-typed one to
 * the default. Delete that suite and these two entries become unchecked.
 */
const OP_VALUES_BY_DESIGN = new Set<string>([
  "server/api/routes/mulmo-script.ts:makeBeatOpHandler(mulmoScriptOps.generateBeatAudioOp, (result) => ({ audio: result.audio })),",
  "server/api/routes/mulmo-script.ts:makeBeatOpHandler(mulmoScriptOps.renderBeatOp, (result) => ({ image: result.image })),",
]);

/** Every `.ts` file under the searched directories. */
function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  return SEARCHED.flatMap((dir) => walk(join(REPO_ROOT, dir)));
}

/**
 * Calls to a root-taking op whose arguments never mention a root.
 *
 * The test is "does the argument text name `root`", NOT "is there a second argument": these ops
 * have different arities (`resolveStory(p, root)` but `beatImageOp(p, beatIndex, root)`), and a
 * positional count passed `beatImageOp(filePath, beatIndex)` as though it were rooted — a FALSE
 * NEGATIVE, which is the direction that matters. Naming the token is arity-independent.
 */
function rootlessCalls(): string[] {
  const found: string[] = [];
  sourceFiles().forEach((file) => {
    readFileSync(file, "utf-8")
      .split("\n")
      .forEach((line) => {
        const call = new RegExp(`\\b(?:${ROOT_TAKING_OPS.join("|")})\\(([^;]*)`).exec(line);
        if (!call) return;
        if (!/\broot\b/.test(call[1] ?? "")) found.push(`${relative(REPO_ROOT, file)}:${line.trim()}`);
      });
  });
  return found;
}

describe("a story is addressed by the pair, not the path", () => {
  it("finds the resolveStory call sites at all — a sweep that matches nothing proves nothing", () => {
    const total = sourceFiles().filter((file) => readFileSync(file, "utf-8").includes("resolveStory(")).length;
    assert.ok(total > 0, "at least one file calls resolveStory");
  });

  it("every resolveStory call names a root, or is exempted with a reason", () => {
    const unexplained = rootlessCalls().filter((site) => !ROOTLESS_BY_DESIGN.has(site));
    assert.deepEqual(unexplained, [], `these resolve a story by path alone: ${unexplained.join(" | ")}`);
  });

  it("names these ops only as a direct call — an alias would walk straight past the argument check", () => {
    // `const rs = ops.resolveStory; rs(p)` resolves a story with no root and matches no
    // `resolveStory(` line. Rather than enumerate the spellings, this forbids every mention that
    // is not immediately a call (Codex, round 3 step C-bis).
    const evasions: string[] = [];
    sourceFiles().forEach((file) => {
      readFileSync(file, "utf-8")
        .split("\n")
        .forEach((line) => {
          ROOT_TAKING_OPS.forEach((opName) => {
            if (!new RegExp(`\\b${opName}\\b`).test(line)) return;
            const asDirectCall = new RegExp(`\\b${opName}\\(`).test(line);
            const asImportOrType = /^\s*(import|export)\b/.test(line) || line.includes("//");
            const site = `${relative(REPO_ROOT, file)}:${line.trim()}`;
            if (!asDirectCall && !asImportOrType && !OP_VALUES_BY_DESIGN.has(site)) evasions.push(site);
          });
        });
    });
    assert.deepEqual(evasions, [], `these name a story op without calling it directly: ${evasions.join(" | ")}`);
  });

  it("every exemption still exists — a stale one hides the next real call site", () => {
    const rootless = new Set(rootlessCalls());
    const gone = [...ROOTLESS_BY_DESIGN.keys()].filter((site) => !rootless.has(site));
    assert.deepEqual(gone, [], `these exemptions no longer match any call: ${gone.join(" | ")}`);
  });
});
