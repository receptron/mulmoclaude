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
 * accepts a raw request value again — which is what happened twice: the first draft narrowed
 * seventeen of them, and `runStoryOp` was missed by this very check because its declaration is
 * generic and the shape went unrecognised rather than reported (#3086 rounds 1-2).
 *
 * So this file is one rule, derived from BOTH sources rather than listed in either — and it
 * REFUSES to guess. A member whose declaration it cannot read is a failure, not a "takes no
 * root": those two answers are indistinguishable from the outside, and only one of them is safe.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");
const PACKAGE_SERVER = join(REPO_ROOT, "packages", "plugins", "mulmoscript-plugin", "src", "server");
const HOST_SOURCE = join(REPO_ROOT, "server", "plugins", "mulmoscript-server.ts");

/** Comments name roots constantly, so a rule read out of them answers about prose, not code. */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const read = (file: string) => withoutComments(readFileSync(file, "utf-8"));
const OPS = read(join(PACKAGE_SERVER, "ops.ts"));
const PACKAGE_TYPES = [join(PACKAGE_SERVER, "ops.ts"), join(PACKAGE_SERVER, "types.ts")].map(read).join("\n");

/** A root DECLARED — as a parameter or as a field. `root` in a position is the whole subject. */
const ROOT_FIELD = /\broot[\s?]*:/;
const OPENERS = "{([";
const CLOSERS = "})]";

interface Scan {
  depth: number;
  end: number | null;
}
const NOTHING_FOUND: Scan = { depth: 0, end: null };

/**
 * The text between the bracket at `open` and its MATCH.
 *
 * `indexOf(")")` stops at the first nested one, which truncates
 * `(path, onDone: () => void, root?: string)` to just before the root — a blind spot that reads
 * exactly like an op that takes no root.
 */
function inside(source: string, open: number, closer: string): string | null {
  const opener = source[open] ?? "";
  const { end } = [...source.slice(open)].reduce<Scan>((state, char, offset) => {
    if (state.end !== null) return state;
    const depth = state.depth + (char === opener ? 1 : char === closer ? -1 : 0);
    return { depth, end: depth === 0 ? open + offset : null };
  }, NOTHING_FOUND);
  return end === null ? null : source.slice(open + 1, end);
}

/** A `type X = …` body: up to the `;` ending the statement, not one nested in an object type. */
function aliasBody(source: string, equals: number): string {
  const rest = source.slice(equals + 1);
  const { end } = [...rest].reduce<Scan>((state, char, offset) => {
    if (state.end !== null) return state;
    const depth = state.depth + (OPENERS.includes(char) ? 1 : CLOSERS.includes(char) ? -1 : 0);
    return { depth, end: char === ";" && depth === 0 ? offset : null };
  }, NOTHING_FOUND);
  return end === null ? rest : rest.slice(0, end);
}

/** The declared body of a type this package owns — an imported one cannot carry a root, which is
 *  this package's own concept, so "not ours" is an answer rather than a gap. */
function typeBody(name: string): string | null {
  const declaration = new RegExp(`\\b(?:interface|type)\\s+${name}\\b[^={]*[={]`).exec(PACKAGE_TYPES);
  if (!declaration) return null;
  const [matched] = declaration;
  const opensAt = declaration.index + matched.length - 1;
  return matched.endsWith("{") ? inside(PACKAGE_TYPES, opensAt, "}") : aliasBody(PACKAGE_TYPES, opensAt);
}

const referencedTypes = (body: string) => [...body.matchAll(/\b([A-Z]\w*)\b/g)].map((match) => match[1] ?? "");

/** A type hands its holder a root when it declares one, or refers to something that does —
 *  `GenerateOpArgsWith<…>` names no root itself and resolves to an interface that does. */
function carriesARoot(name: string, seen: Set<string>): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const body = typeBody(name);
  if (body === null) return false;
  return ROOT_FIELD.test(body) || referencedTypes(body).some((referenced) => carriesARoot(referenced, seen));
}

/** Every way an op can be handed a root: spelled in the parameter list, or inside a parameter's type. */
const takesARoot = (params: string) => ROOT_FIELD.test(params) || referencedTypes(params).some((name) => carriesARoot(name, new Set()));

type Declaration = { kind: "function"; params: string } | { kind: "host-supplied" } | { kind: "value" };

/** Parameters the factory itself is handed and passes straight back out. The host built those
 *  objects, so there is no signature here for it to hand an unparsed root to. */
function factoryParameters(): string[] {
  const factory = /\bexport function createMulmoScriptServerOps\s*\(([^)]*)\)/.exec(OPS);
  return (factory?.[1] ?? "").split(",").map((parameter) => parameter.split(":")[0]?.trim() ?? "");
}

/** What follows `=`, with an arrow function's `async` and type parameters stepped over. Written as
 *  slices rather than one regex: three adjacent optional groups is the shape a backtracker chokes
 *  on, and each result here stays a SUFFIX of `source`, which is what makes its index recoverable. */
function pastArrowPreamble(source: string, from: number): string {
  const start = source.slice(from).trimStart();
  const named = start.startsWith("async") ? start.slice("async".length).trimStart() : start;
  return named.startsWith("<") ? named.slice(named.indexOf(">") + 1).trimStart() : named;
}

/** What the ops factory declares `member` as, or null when this check CANNOT TELL. */
function declarationOf(member: string): Declaration | null {
  if (factoryParameters().includes(member)) return { kind: "host-supplied" };
  const declaration = new RegExp(`\\b(?:function|const)\\s+${member}\\b[^(=]*[(=]`).exec(OPS);
  if (!declaration) return null;
  const [matched] = declaration;
  const fromParen = (opensAt: number) => {
    const params = inside(OPS, opensAt, ")");
    return params === null ? null : { kind: "function" as const, params };
  };
  if (matched.endsWith("(")) return fromParen(declaration.index + matched.length - 1);
  const after = pastArrowPreamble(OPS, declaration.index + matched.length);
  return after.startsWith("(") ? fromParen(OPS.length - after.length) : { kind: "value" };
}

interface Members {
  takingARoot: string[];
  unreadable: string[];
}

/** Everything the factory returns, sorted into what takes a root and what could not be read. */
function returnedMembers(): Members {
  const open = OPS.indexOf("{", OPS.lastIndexOf("  return {"));
  const block = inside(OPS, open, "}") ?? "";
  const named = block
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({ line, member: /^ {4}(\w+),?$/.exec(line)?.[1] }));
  const declared = named.map(({ line, member }) => ({ line, member, declaration: member === undefined ? null : declarationOf(member) }));
  return {
    takingARoot: declared
      .filter(({ declaration }) => declaration?.kind === "function" && takesARoot(declaration.params))
      .map(({ member }) => member ?? "")
      .sort(),
    unreadable: declared.filter(({ declaration }) => declaration === null).map(({ line, member }) => member ?? line.trim()),
  };
}

/** Members the host re-declares with `ParsedStoryRoot`. */
function narrowedInHost(): string[] {
  const source = readFileSync(HOST_SOURCE, "utf-8");
  const union = source.slice(source.indexOf("type RootTakingOp ="), source.indexOf(";", source.indexOf("type RootTakingOp =")));
  return [...union.matchAll(/"(\w+)"/g)].map((match) => match[1] ?? "").sort();
}

describe("every root-taking op is narrowed to a parsed root", () => {
  it("finds both sides at all — a comparison of two empty sets proves nothing", () => {
    assert.ok(returnedMembers().takingARoot.length > 10, "the package declares root-taking ops");
    assert.ok(narrowedInHost().length > 10, "the host narrows some of them");
  });

  it("can read every member it returns — an unreadable one would count as taking no root", () => {
    const { unreadable } = returnedMembers();
    assert.deepEqual(unreadable, [], `this check cannot read these, so it cannot tell whether they take a root: ${unreadable.join(", ")}`);
  });

  it("sees a root that arrives inside a TYPE, not only one spelled in the parameter list", () => {
    const throughAType = ["renderBeatOp", "runStoryOp"];
    throughAType.forEach((member) => {
      const declaration = declarationOf(member);
      assert.equal(declaration?.kind, "function", `${member} is a function this check can read`);
      const params = declaration?.kind === "function" ? declaration.params : "";
      assert.equal(ROOT_FIELD.test(params), false, `${member} names no root of its own — it takes one in an options object`);
      assert.ok(takesARoot(params), `${member}'s options type resolves to one that carries a root`);
    });
  });

  it("narrows exactly the members that take a root — no more, no fewer", () => {
    const taking = returnedMembers().takingARoot;
    const narrowed = narrowedInHost();
    const unnarrowed = taking.filter((member) => !narrowed.includes(member));
    const stale = narrowed.filter((member) => !taking.includes(member));
    assert.deepEqual(unnarrowed, [], `these take a root and still accept a raw string: ${unnarrowed.join(", ")}`);
    assert.deepEqual(stale, [], `these are narrowed but take no root — the list has drifted: ${stale.join(", ")}`);
  });
});
