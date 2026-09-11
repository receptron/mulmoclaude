import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The one root rule a TYPE cannot state.
 *
 * `stories/deck.json` exists in every registered stories root (#3014), so a call that addresses a
 * path alone reads the DEFAULT root's file of that name — silently, because that path is
 * well-formed in both. Everything about which VALUE may be a root, and about naming one at all,
 * is now settled by `ParsedStoryRoot`: the brand can only be minted by `parseSuppliedRoot`, and
 * the parameter is REQUIRED, so an aliased or destructured call that omits it is a compile error
 * where the textual sweep this file used to be could not see it.
 *
 * What a type cannot say is that the host narrowed every member it should have. A root-taking op
 * left out of `RootedMulmoScriptOps` keeps its `string | undefined` parameter and silently
 * accepts a raw request value — which is what happened: the first draft narrowed seventeen of the
 * twenty-five (#3086 round 1, found by this check and by Codex independently).
 *
 * So this file is now one rule, derived from BOTH sources rather than listed in either.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");

/**
 * Every ops member that TAKES a root is narrowed to require a parsed one.
 *
 * `RootedMulmoScriptOps` in `server/plugins/mulmoscript-server.ts` re-declares the root-taking
 * members with `ParsedStoryRoot`. A member left OUT of that list keeps its `string | undefined`
 * parameter and silently accepts a raw request value again — which is exactly what happened: the
 * first draft narrowed seventeen of the twenty-four (#3086).
 *
 * Both sides are DERIVED and compared, rather than either being a list to keep in step: the
 * package's own source says which members take a root, the host's union says which are narrowed,
 * and a new root-taking op in the package turns this red the day it lands.
 */
describe("every root-taking op is narrowed to a parsed root", () => {
  const OPS_SOURCE = join(REPO_ROOT, "packages", "plugins", "mulmoscript-plugin", "src", "server", "ops.ts");
  const TYPES_SOURCE = join(REPO_ROOT, "packages", "plugins", "mulmoscript-plugin", "src", "server", "types.ts");
  const HOST_SOURCE = join(REPO_ROOT, "server", "plugins", "mulmoscript-server.ts");

  /**
   * The one ARGUMENT-OBJECT type in this package that carries a root.
   *
   * Three ops take their root inside it (`renderBeatOp(args: GenerateOpArgsWith<…>)`), so their
   * parameter list never spells `root` and a parameter-text scan alone calls them "not
   * root-taking". Named rather than resolved: resolving a mapped type textually is more machinery
   * than this is worth, and the test below asserts the name still exists AND still carries a
   * root, so a rename or a moved field turns this red instead of quietly widening the sweep.
   */
  const ROOT_CARRYING_ARGS = "GenerateOpArgs";

  /** Members the package returns that can be HANDED a root — positionally or in an object. */
  function opsTakingARoot(): string[] {
    const source = readFileSync(OPS_SOURCE, "utf-8");
    const returned = source.slice(source.lastIndexOf("  return {"));
    const members = [...returned.matchAll(/^ {4}(\w+),?$/gm)].map((match) => match[1] ?? "");
    return members
      .filter((member) => {
        const declaration = new RegExp(`(?:function|const)\\s+${member}\\s*[(=]`).exec(source);
        if (!declaration) return false;
        const from = source.indexOf("(", declaration.index);
        const params = source.slice(from, source.indexOf(")", from));
        return /\broot\b/.test(params) || params.includes(ROOT_CARRYING_ARGS);
      })
      .sort();
  }

  /** Members the host re-declares with `ParsedStoryRoot`. */
  function narrowedInHost(): string[] {
    const source = readFileSync(HOST_SOURCE, "utf-8");
    const union = source.slice(source.indexOf("type RootTakingOp ="), source.indexOf(";", source.indexOf("type RootTakingOp =")));
    return [...union.matchAll(/"(\w+)"/g)].map((match) => match[1] ?? "").sort();
  }

  it("finds both sides at all — a comparison of two empty sets proves nothing", () => {
    assert.ok(opsTakingARoot().length > 10, "the package declares root-taking ops");
    assert.ok(narrowedInHost().length > 10, "the host narrows some of them");
  });

  it(`${ROOT_CARRYING_ARGS} still exists and still carries a root — the one name this leans on`, () => {
    const types = readFileSync(TYPES_SOURCE, "utf-8");
    const declaration = new RegExp(`interface ${ROOT_CARRYING_ARGS} \\{([\\s\\S]*?)\\n\\}`).exec(types);
    assert.ok(declaration, `${ROOT_CARRYING_ARGS} is declared in the package's server types`);
    assert.match(declaration[1] ?? "", /\broot\?:/, `${ROOT_CARRYING_ARGS} still carries the root the object-argument ops pass`);
  });

  it("narrows exactly the members that take a root — no more, no fewer", () => {
    const taking = opsTakingARoot();
    const narrowed = narrowedInHost();
    const unnarrowed = taking.filter((member) => !narrowed.includes(member));
    const stale = narrowed.filter((member) => !taking.includes(member));
    assert.deepEqual(unnarrowed, [], `these take a root and still accept a raw string: ${unnarrowed.join(", ")}`);
    assert.deepEqual(stale, [], `these are narrowed but take no root — the list has drifted: ${stale.join(", ")}`);
  });
});
