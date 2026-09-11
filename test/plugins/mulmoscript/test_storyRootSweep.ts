import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/**
 * A `resolveStory` call NAMES a root, or is exempted with a reason.
 *
 * `stories/deck.json` exists in every registered stories root (#3014), so a call that resolves a
 * path alone reads the DEFAULT root's file of that name — silently, because that path is
 * perfectly well-formed in both. The root parameter is OPTIONAL on the ops, so omitting it
 * type-checks; that is the part a type cannot say, and it is all that is left here.
 *
 * WHAT USED TO BE HERE, and where it went (#3086):
 *
 * This file also enforced that a root handed to a story op had been through `parseSuppliedRoot`.
 * That was a textual rule, and a review spent five rounds on spellings it missed — a same-file
 * helper, a typed binding, `let root; root = raw;`. A textual rule has infinitely many blind
 * spellings, so enumerating them was a queue rather than a specification.
 *
 * The host's ops are now exposed through a type whose root parameters are `ParsedStoryRoot`, a
 * branded string only `parseSuppliedRoot` can mint, and the raw ops object is no longer exported
 * at all. Every one of those spellings is now a COMPILE error, including the ones this file could
 * not see. So the provenance rules are gone from here rather than rewritten a fourth time.
 *
 * Stated as what is PERMITTED, which is why a NEW call site is red by default rather than correct
 * by luck: the exceptions are a list someone has to justify, not a silence.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");
const SEARCHED = ["server", "src"] as const;

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

/** `resolveStory(` calls whose arguments never mention a root, as `<repo-relative path>:<line>`. */
function rootlessCalls(): string[] {
  const found: string[] = [];
  sourceFiles().forEach((file) => {
    readFileSync(file, "utf-8")
      .split("\n")
      .forEach((line) => {
        const call = /\bresolveStory\(([^;]*)/.exec(line);
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

  it("every exemption still exists — a stale one hides the next real call site", () => {
    const rootless = new Set(rootlessCalls());
    const gone = [...ROOTLESS_BY_DESIGN.keys()].filter((site) => !rootless.has(site));
    assert.deepEqual(gone, [], `these exemptions no longer match any call: ${gone.join(" | ")}`);
  });
});
