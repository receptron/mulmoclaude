import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import typescript from "typescript";

/**
 * The one root rule a TYPE cannot state.
 *
 * `stories/deck.json` exists in every registered stories root (#3014), so a call that addresses a
 * path alone reads the DEFAULT root's file of that name — silently, because that path is
 * well-formed in both. Everything about which VALUE may be a root, and about naming one at all,
 * is settled by `ParsedStoryRoot`: the brand can only be minted by `parseSuppliedRoot`, and the
 * parameter is REQUIRED, so an aliased or destructured call that omits it is a compile error
 * where the textual sweep this file used to be could not see it.
 *
 * What a type cannot say is that the host narrowed every member it should have. A root-taking op
 * left out of `RootedMulmoScriptOps` keeps its `string | undefined` parameter and silently
 * accepts a raw request value again.
 *
 * So this reads the package with TYPESCRIPT'S OWN PARSER rather than with regexes. That is not
 * fastidiousness: three review rounds in a row found a declaration shape the regexes read wrongly
 * — a hand-written list of 17 members, a generic `async function f<T>(`, and a generic arrow whose
 * type argument contains a nested `>`. Each fix was a new spelling, which is the queue this whole
 * PR exists to end. An AST has no spellings.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");
const PACKAGE_SERVER = join(REPO_ROOT, "packages", "plugins", "mulmoscript-plugin", "src", "server");
const HOST_SOURCE = join(REPO_ROOT, "server", "plugins", "mulmoscript-server.ts");
const FACTORY = "createMulmoScriptServerOps";
const HOST_UNION = "RootTakingOp";
const ROOT = "root";

const parse = (file: string) => typescript.createSourceFile(file, readFileSync(file, "utf-8"), typescript.ScriptTarget.Latest, true);
const OPS = parse(join(PACKAGE_SERVER, "ops.ts"));

/** Type declarations the package owns, by name. A type it does NOT own cannot carry a root — a
 *  stories root is this package's own concept — so "not ours" is an answer, not a gap. */
const PACKAGE_TYPES = new Map<string, typescript.Node>(
  [OPS, parse(join(PACKAGE_SERVER, "types.ts"))].flatMap((source) =>
    source.statements
      .filter((statement) => typescript.isInterfaceDeclaration(statement) || typescript.isTypeAliasDeclaration(statement))
      .flatMap((statement) =>
        typescript.isInterfaceDeclaration(statement) || typescript.isTypeAliasDeclaration(statement) ? [[statement.name.text, statement] as const] : [],
      ),
  ),
);

const named = (node: typescript.Node, name: string) =>
  (typescript.isPropertySignature(node) || typescript.isParameter(node)) && typescript.isIdentifier(node.name) && node.name.text === name;

/** Does this type declare a `root` anywhere inside it — a field, or a parameter of a function it
 *  holds? `RunStoryOpDeps` carries one that way, inside `resolveStory`'s signature. */
const declaresARoot = (node: typescript.Node): boolean =>
  named(node, ROOT) || typescript.forEachChild(node, (child) => (declaresARoot(child) ? true : undefined)) === true;

function referencedTypeNames(node: typescript.Node): string[] {
  const names: string[] = [];
  const visit = (current: typescript.Node) => {
    if (typescript.isTypeReferenceNode(current) && typescript.isIdentifier(current.typeName)) names.push(current.typeName.text);
    typescript.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

/** A type hands its holder a root when it declares one, or refers to something that does —
 *  `GenerateOpArgsWith<…>` names no root itself and resolves to an interface that does. */
function carriesARoot(name: string, seen: Set<string>): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const declaration = PACKAGE_TYPES.get(name);
  if (declaration === undefined) return false;
  return declaresARoot(declaration) || referencedTypeNames(declaration).some((referenced) => carriesARoot(referenced, seen));
}

/** Every way an op can be handed a root: named in a position, or carried by a parameter's type. */
const takesARoot = (parameters: readonly typescript.ParameterDeclaration[]) =>
  parameters.some(
    (parameter) =>
      named(parameter, ROOT) ||
      (parameter.type !== undefined && (declaresARoot(parameter.type) || referencedTypeNames(parameter.type).some((name) => carriesARoot(name, new Set())))),
  );

const factory = OPS.statements.find(
  (statement): statement is typescript.FunctionDeclaration => typescript.isFunctionDeclaration(statement) && statement.name?.text === FACTORY,
);

/** Everything the factory declares, by name, so a returned shorthand can be resolved to it. */
function localDeclarations(scope: typescript.Node): Map<string, typescript.Node> {
  const byName = new Map<string, typescript.Node>();
  const visit = (node: typescript.Node) => {
    const declaration = typescript.isFunctionDeclaration(node) || typescript.isVariableDeclaration(node);
    if (declaration && node.name !== undefined && typescript.isIdentifier(node.name) && !byName.has(node.name.text)) byName.set(node.name.text, node);
    typescript.forEachChild(node, visit);
  };
  typescript.forEachChild(scope, visit);
  return byName;
}

type Classified = { kind: "function"; parameters: readonly typescript.ParameterDeclaration[] } | { kind: "host-supplied" } | { kind: "value" };

const parametersOf = (node: typescript.Node): Classified =>
  typescript.isFunctionDeclaration(node) || typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)
    ? { kind: "function", parameters: node.parameters }
    : { kind: "value" };

/**
 * What the factory declares `name` as, or null when this cannot tell.
 *
 * Null is a FAILURE, never a quiet "takes no root": from outside, an op whose declaration went
 * unrecognised and an op that genuinely takes no root give the same answer, and only one of them
 * is safe. `runStoryOp` spent a round on exactly that.
 */
function classify(scope: typescript.FunctionDeclaration, locals: Map<string, typescript.Node>, name: string): Classified | null {
  if (scope.parameters.some((parameter) => named(parameter, name))) return { kind: "host-supplied" };
  const declaration = locals.get(name);
  if (declaration === undefined) return null;
  if (!typescript.isVariableDeclaration(declaration)) return parametersOf(declaration);
  return declaration.initializer === undefined ? { kind: "value" } : parametersOf(declaration.initializer);
}

interface Members {
  takingARoot: string[];
  unreadable: string[];
}

/** Everything the factory returns, sorted into what takes a root and what could not be read. */
function returnedMembers(): Members {
  if (factory === undefined) return { takingARoot: [], unreadable: [FACTORY] };
  const returned = factory.body?.statements.filter(typescript.isReturnStatement).at(-1)?.expression;
  if (returned === undefined || !typescript.isObjectLiteralExpression(returned))
    return { takingARoot: [], unreadable: ["the factory's return value is not an object literal"] };
  const locals = localDeclarations(factory);
  const classified = returned.properties.map((property) => ({ property, classified: classifyProperty(factory, locals, property) }));
  return {
    takingARoot: classified
      .filter(({ classified: shape }) => shape?.kind === "function" && takesARoot(shape.parameters))
      .map(({ property }) => property.name?.getText() ?? "")
      .sort(),
    unreadable: classified.filter(({ classified: shape }) => shape === null).map(({ property }) => property.getText().split("\n")[0] ?? ""),
  };
}

/** A returned property is either a shorthand naming a local, a name bound to one, or a function
 *  written inline. Anything else this cannot read, and says so. */
function classifyProperty(
  scope: typescript.FunctionDeclaration,
  locals: Map<string, typescript.Node>,
  property: typescript.ObjectLiteralElementLike,
): Classified | null {
  if (typescript.isShorthandPropertyAssignment(property)) return classify(scope, locals, property.name.text);
  if (!typescript.isPropertyAssignment(property)) return null;
  const { initializer } = property;
  if (typescript.isIdentifier(initializer)) return classify(scope, locals, initializer.text);
  return typescript.isArrowFunction(initializer) || typescript.isFunctionExpression(initializer) ? parametersOf(initializer) : null;
}

/** Members the host re-declares with `ParsedStoryRoot`. */
function narrowedInHost(): string[] {
  const alias = parse(HOST_SOURCE).statements.find(
    (statement): statement is typescript.TypeAliasDeclaration => typescript.isTypeAliasDeclaration(statement) && statement.name.text === HOST_UNION,
  );
  if (alias === undefined || !typescript.isUnionTypeNode(alias.type)) return [];
  return alias.type.types
    .flatMap((member) => (typescript.isLiteralTypeNode(member) && typescript.isStringLiteral(member.literal) ? [member.literal.text] : []))
    .sort();
}

describe("every root-taking op is narrowed to a parsed root", () => {
  it("finds both sides at all — a comparison of two empty sets proves nothing", () => {
    assert.ok(returnedMembers().takingARoot.length > 10, "the package declares root-taking ops");
    assert.ok(narrowedInHost().length > 10, "the host narrows some of them");
  });

  it("can read every member it returns — an unreadable one would count as taking no root", () => {
    const { unreadable } = returnedMembers();
    assert.deepEqual(unreadable, [], `this cannot read these, so it cannot tell whether they take a root: ${unreadable.join(", ")}`);
  });

  it("sees a root that arrives inside a TYPE, not only one named in a position", () => {
    const locals = factory === undefined ? new Map<string, typescript.Node>() : localDeclarations(factory);
    ["renderBeatOp", "runStoryOp"].forEach((member) => {
      const shape = factory === undefined ? null : classify(factory, locals, member);
      assert.equal(shape?.kind, "function", `${member} is a function this can read`);
      const parameters = shape?.kind === "function" ? shape.parameters : [];
      assert.equal(
        parameters.some((parameter) => named(parameter, ROOT)),
        false,
        `${member} names no root of its own — it takes one in an options object`,
      );
      assert.ok(takesARoot(parameters), `${member}'s options type resolves to one that carries a root`);
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
