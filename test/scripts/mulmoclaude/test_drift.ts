// Unit tests for scripts/mulmoclaude/drift.mjs — the publish-drift gate.
//
// The shape under test changed in #3116: the gate used to compare the local
// `src/index.ts` against the published dist and count LINES, over the four
// `@mulmobridge/*` packages the launcher depends on. Each of those three choices
// was wrong in a way that let real drift through, so the tests below pin the new
// ones: local BUILT dist vs published dist, counted as NAMES, over every
// publishable workspace another workspace declares.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as drift from "../../../scripts/mulmoclaude/drift.mjs";

describe("parseExportedNames", () => {
  it("reads a brace re-export, including renames", () => {
    const { names, opaque } = drift.parseExportedNames(`export { a, b as c } from "./x.js";\n`);
    assert.deepEqual([...names].sort(), ["a", "c"]);
    assert.equal(opaque, false);
  });

  it("reads declarations", () => {
    const source = "export function f() {}\nexport const g = 1;\nexport class H {}\nexport async function i() {}\nexport let j;\n";
    assert.deepEqual([...drift.parseExportedNames(source).names].sort(), ["f", "g", "H", "i", "j"].sort());
  });

  it("counts every name on ONE line — the case line counting cannot see", () => {
    // `@mulmoclaude/x-plugin`'s entire published surface is this single line, so
    // a seventh name added here does not move a line count at all.
    const source = "export { extractTweetId, formatTweet, readUrlArg, readXPost, searchX, tweetBody };\n";
    assert.equal(drift.parseExportedNames(source).names.size, 6);
  });

  it("ignores type-only exports", () => {
    const source = "export type Foo = string;\nexport interface Bar {}\nexport { type Baz } from './b.js';\n";
    assert.deepEqual([...drift.parseExportedNames(source).names], []);
  });

  // `default` is a runtime export: a default-import consumer breaks the same way
  // when the published tarball lacks it. Raised by Codex as a P1.
  it("counts `default` in every shape that exports it", () => {
    const shapes = ["export default thing;\n", "export default function f() {}\n", "export { a as default };\n", 'export { default } from "./x.js";\n'];
    shapes.forEach((source) => {
      assert.deepEqual([...drift.parseExportedNames(source).names], ["default"], source);
    });
  });

  it("`default as thing` exports `thing`, not `default`", () => {
    assert.deepEqual([...drift.parseExportedNames('export { default as thing } from "./x.js";\n').names], ["thing"]);
  });

  // A barrel is COUNTED, not lumped into `opaque`: a caller that can read the
  // re-exported file resolves it exactly (`collectEntryNames`), and one that
  // cannot must treat it as opaque (`compareEntry`). Sharing one flag kept a
  // fully-resolved barrel permanently coarse.
  it("counts `export * from` as a barrel rather than as an unmodelled shape", () => {
    const parsed = drift.parseExportedNames(`export * from "./chunk.js";\nexport const visible = 1;\n`);
    assert.equal(parsed.stars, 1);
    assert.equal(parsed.opaque, false);
    assert.deepEqual([...parsed.names], ["visible"]);
  });

  it("`export * as ns from` exports ONE name and is not a barrel", () => {
    const parsed = drift.parseExportedNames(`export * as ns from "./x.js";\n`);
    assert.deepEqual([...parsed.names], ["ns"]);
    assert.equal(parsed.stars, 0);
    assert.deepEqual(drift.starTargets(`export * as ns from "./x.js";\n`), []);
  });

  it("a multi-declarator statement is opaque rather than half-named", () => {
    const parsed = drift.parseExportedNames("export const a = 1, b = 2;\n");
    assert.equal(parsed.opaque, true);
    assert.deepEqual([...parsed.names], []);
  });

  it("a comma inside an initialiser is not a second declarator", () => {
    assert.deepEqual([...drift.parseExportedNames("export const f = fn(1, 2);\n").names], ["f"]);
    assert.deepEqual([...drift.parseExportedNames("export const xs = [1, 2];\n").names], ["xs"]);
    assert.deepEqual([...drift.parseExportedNames('export const s = "a,b";\n').names], ["s"]);
  });

  it("ignores indented exports (only module-level counts)", () => {
    assert.equal(drift.parseExportedNames("  export const inner = 1;\n").names.size, 0);
  });

  // Parsing per LINE returned zero names for both shapes below, and zero names
  // reads as "nothing exported" — so a package whose build emits either one
  // would have reported clean no matter what it exported. Found by Claude while
  // reviewing this PR, not flagged by Codex.
  it("reads a brace list wrapped across lines", () => {
    const source = 'export {\n  mimeFromExtension,\n  isImageMime,\n} from "./mime.js";\n';
    assert.deepEqual([...drift.parseExportedNames(source).names].sort(), ["isImageMime", "mimeFromExtension"]);
  });

  it("reads several statements sharing one line, as a minified bundle emits them", () => {
    assert.deepEqual([...drift.parseExportedNames("export{a,b};export{c};\n").names].sort(), ["a", "b", "c"]);
  });

  // The rule is inverted: the four shapes above are what the parser claims to
  // model, and EVERYTHING else is opaque. Three findings in one review were each
  // "it silently drops one more shape", so the ban-list became a permit-list. The
  // cases below are the near-misses — each one must come back opaque rather than
  // as an empty name set, because empty reads as "nothing exported" = "no drift".
  it("treats every unmodelled export statement as opaque, not as empty", () => {
    const nearMisses = [
      "export/*c*/{a};\n", // a comment where the brace should start
      "export {\n  a, // keep\n  b\n};\n", // a line comment inside the brace
      "export { a, /* x */ b };\n", // a block comment inside the brace
      "export { a,\n", // a brace that never closes
      "export enum Colour { Red }\n", // a form this parser does not model
    ];
    nearMisses.forEach((source) => {
      const { names, opaque } = drift.parseExportedNames(source);
      assert.equal(opaque, true, `expected opaque for ${JSON.stringify(source)}`);
      assert.deepEqual([...names], [], `expected no invented names for ${JSON.stringify(source)}`);
    });
  });

  // The remaining hole class after the inversion is "a WRONG name set while opaque
  // stays false". Both shapes below did exactly that: the first exports the name
  // `string name` (ES2022 arbitrary module namespace names) and the parser reported
  // `a`; the second exports `café` and an ASCII-only identifier pattern reported
  // `caf`. A name the package does not export is worse than a coarse comparison.
  it("goes opaque rather than guessing when it cannot name the export exactly", () => {
    const unnameable = [
      'export { a as "string name" };\n',
      'export { "string name" as a } from "./x.js";\n',
      "export { café };\n",
      "export const café = 1;\n",
      "export function café() {}\n",
    ];
    unnameable.forEach((source) => {
      const { names, opaque } = drift.parseExportedNames(source);
      assert.equal(opaque, true, `expected opaque for ${JSON.stringify(source)}`);
      assert.deepEqual([...names], [], `expected no guessed name for ${JSON.stringify(source)}`);
    });
  });

  it("still names every ASCII declaration shape exactly", () => {
    const shapes: [string, string][] = [
      ["export const a = 1;\n", "a"],
      ["export let x;\n", "x"],
      ["export var v = 1;\n", "v"],
      ["export function f() {}\n", "f"],
      ["export class C {}\n", "C"],
      ["export const $d = 1;\n", "$d"],
      ["export const _u = 1;\n", "_u"],
      ["export async function g() {}\n", "g"],
    ];
    shapes.forEach(([source, name]) => {
      assert.deepEqual([...drift.parseExportedNames(source).names], [name], source);
    });
  });

  it("still does not treat an identifier starting with `export` as an export", () => {
    const { names, opaque } = drift.parseExportedNames("exported = 1;\nexportable();\n");
    assert.deepEqual([...names], []);
    assert.equal(opaque, false, "a lookalike must not push the whole entry into the coarse comparison");
  });

  it("marks an export form it does not model opaque — fails CLOSED, never silently empty", () => {
    const { names, opaque } = drift.parseExportedNames("export enum Colour { Red }\n");
    assert.equal(opaque, true);
    assert.deepEqual([...names], []);
  });

  it("marks a brace that never closes opaque rather than guessing", () => {
    assert.equal(drift.parseExportedNames("export { a,\n").opaque, true);
  });
});

describe("exportStatements", () => {
  it("flattens a brace group so a wrapped statement stays one statement", () => {
    const statements = drift.exportStatements("export {\n a,\n b\n}\n");
    assert.equal(statements.length, 1);
    assert.match(statements[0] ?? "", /^export \{\s+a,\s+b\s*\}$/);
  });

  it("keeps ignoring an indented export — it is text, not a module-level export", () => {
    assert.deepEqual(drift.exportStatements("  export const inner = 1;\n"), []);
  });

  it("splits statements that share a line", () => {
    assert.deepEqual(drift.exportStatements("export{a};export{b}"), ["export{a}", "export{b}"]);
  });

  it("keeps out identifiers that merely start with `export`", () => {
    assert.deepEqual(drift.exportStatements("exported = 1\nexportable()\n"), []);
  });
});

describe("entryTargets", () => {
  it("maps every exports subpath to its file", () => {
    const pkg = { exports: { ".": { import: "./dist/index.js" }, "./server": "./dist/server.js" } };
    assert.deepEqual(
      [...drift.entryTargets(pkg)],
      [
        [".", "dist/index.js"],
        ["./server", "dist/server.js"],
      ],
    );
  });

  it("marks a subpath with no runtime target as null instead of borrowing `main`", () => {
    const pkg = { exports: { ".": { import: "./dist/index.js" }, "./types": { types: "./dist/t.d.ts" } }, main: "./dist/index.js" };
    assert.deepEqual(
      [...drift.entryTargets(pkg)],
      [
        [".", "dist/index.js"],
        ["./types", null],
      ],
    );
  });

  it("falls back to module / main when there is no exports map", () => {
    assert.deepEqual([...drift.entryTargets({ main: "./dist/entry.js" })], [[".", "dist/entry.js"]]);
    assert.deepEqual([...drift.entryTargets({})], [[".", "dist/index.js"]]);
  });
});

describe("resolveConditionTarget", () => {
  it("descends through a condition block the way a bundler would", () => {
    assert.equal(drift.resolveConditionTarget({ node: { import: "./dist/node.js" } }), "dist/node.js");
    assert.equal(drift.resolveConditionTarget({ types: "./d.ts", import: "./dist/index.js" }), "dist/index.js");
    assert.equal(drift.resolveConditionTarget("./dist/plain.js"), "dist/plain.js");
  });

  // Raised by Codex as a P2: a nested condition object bypassed the old
  // string-only check, and the per-subpath `main` fallback then compared
  // `dist/index.js` — a DIFFERENT file's export surface — for a types-only entry.
  it("returns null rather than guessing when no runtime target exists", () => {
    assert.equal(drift.resolveConditionTarget({ types: "./dist/index.d.ts" }), null);
    assert.equal(drift.resolveConditionTarget(null), null);
    assert.equal(drift.resolveConditionTarget(42), null);
  });

  it("stops descending instead of recursing forever", () => {
    let deep: unknown = "./dist/x.js";
    for (let i = 0; i < 12; i++) deep = { import: deep };
    assert.equal(drift.resolveConditionTarget(deep), null);
  });
});

describe("compareEntry", () => {
  it("reports the names the local build adds", () => {
    const result = drift.compareEntry("export { a, b };\n", "export { a };\n");
    assert.deepEqual(result.added, ["b"]);
    assert.equal(result.drifted, true);
  });

  it("is clean when the same names are spelled differently", () => {
    const result = drift.compareEntry("export const a = 1;\nexport const b = 2;\n", "export { a, b };\n");
    assert.deepEqual(result.added, []);
    assert.equal(result.drifted, false);
  });

  it("does not call a REMOVED export drift — that is a different problem", () => {
    const result = drift.compareEntry("export { a };\n", "export { a, b };\n");
    assert.deepEqual(result.added, []);
    assert.equal(result.drifted, false);
  });

  it("falls back to line counting when either side is opaque", () => {
    const result = drift.compareEntry(`export * from "./x.js";\nexport { a };\n`, `export * from "./x.js";\n`);
    assert.equal(result.opaque, true);
    assert.equal(result.drifted, true);
  });

  // Raised by Codex as a P1: the opaque branch used to REPLACE the name
  // comparison with a line count, so a name added on the same line as the
  // `export *` was discarded and both sides counted one line.
  it("still compares the names it could read inside an opaque entry", () => {
    const result = drift.compareEntry(`export * from "./x.js";export { newThing };\n`, `export * from "./x.js";\n`);
    assert.deepEqual(result.added, ["newThing"]);
    assert.equal(result.drifted, true);
  });
});

describe("isLocalVersionAhead", () => {
  it("compares numerically, not lexically", () => {
    assert.equal(drift.isLocalVersionAhead("1.10.0", "1.9.0"), true);
    assert.equal(drift.isLocalVersionAhead("1.9.0", "1.10.0"), false);
    assert.equal(drift.isLocalVersionAhead("1.2.3", "1.2.3"), false);
  });

  it("errs strict on malformed input", () => {
    assert.equal(drift.isLocalVersionAhead("next", "1.0.0"), false);
    assert.equal(drift.isLocalVersionAhead(null, "1.0.0"), false);
    assert.equal(drift.isLocalVersionAhead("1.0.0", undefined), false);
  });
});

describe("checkPackageDrift — against a fake workspace and a stubbed registry", () => {
  let root = "";

  const writeWorkspace = (name: string, dir: string, version: string, distByPath: Record<string, string>, exportsMap?: unknown): void => {
    mkdirSync(path.join(root, dir, "dist"), { recursive: true });
    writeFileSync(
      path.join(root, dir, "package.json"),
      JSON.stringify({ name, version, ...(exportsMap === undefined ? { main: "./dist/index.js" } : { exports: exportsMap }) }),
    );
    for (const [rel, source] of Object.entries(distByPath)) {
      mkdirSync(path.join(root, dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(root, dir, rel), source);
    }
  };

  const published = (version: string, byPath: Record<string, string>) => ({
    fetchPublishedVersion: async () => ({ version, reason: null }),
    fetchPublishedEntry: async ({ entryPath }: { entryPath: string }) => {
      const source = byPath[entryPath];
      return source === undefined ? { source: null, reason: "unpkg 404" } : { source, reason: null };
    },
  });

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "drift-"));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("flags a new export at an unchanged version", async () => {
    writeWorkspace("@scope/a", "packages/a", "1.0.0", { "dist/index.js": "export { one, two };\n" });
    const result = await drift.checkPackageDrift({
      root,
      name: "@scope/a",
      dir: "packages/a",
      ...published("1.0.0", { "dist/index.js": "export { one };\n" }),
    });
    assert.equal(result.status, "drifted");
    assert.deepEqual(result.added, [".:two"]);
  });

  it("downgrades to pending-publish once the version is bumped", async () => {
    writeWorkspace("@scope/b", "packages/b", "1.1.0", { "dist/index.js": "export { one, two };\n" });
    const result = await drift.checkPackageDrift({
      root,
      name: "@scope/b",
      dir: "packages/b",
      ...published("1.0.0", { "dist/index.js": "export { one };\n" }),
    });
    assert.equal(result.status, "pending-publish");
  });

  it("is clean when the built surfaces match, whatever the source looked like", async () => {
    // The bundled case: one line locally, one line published, same six names.
    const bundled = "export { a, b, c, d, e, f };\n";
    writeWorkspace("@scope/c", "packages/c", "1.0.0", { "dist/index.js": bundled });
    const result = await drift.checkPackageDrift({ root, name: "@scope/c", dir: "packages/c", ...published("1.0.0", { "dist/index.js": bundled }) });
    assert.equal(result.status, "ok");
    assert.equal(result.localCount, 6);
  });

  it("checks EVERY exports subpath, not just the root one", async () => {
    writeWorkspace(
      "@scope/d",
      "packages/d",
      "1.0.0",
      { "dist/index.js": "export { root };\n", "dist/server.js": "export { server, extra };\n" },
      { ".": "./dist/index.js", "./server": "./dist/server.js" },
    );
    const result = await drift.checkPackageDrift({
      root,
      name: "@scope/d",
      dir: "packages/d",
      ...published("1.0.0", { "dist/index.js": "export { root };\n", "dist/server.js": "export { server };\n" }),
    });
    assert.equal(result.status, "drifted");
    assert.deepEqual(result.added, ["./server:extra"]);
    assert.equal(result.entriesCompared, 2);
  });

  it("skips — never passes — when the local dist is missing", async () => {
    writeWorkspace("@scope/e", "packages/e", "1.0.0", {});
    const result = await drift.checkPackageDrift({
      root,
      name: "@scope/e",
      dir: "packages/e",
      ...published("1.0.0", { "dist/index.js": "export { one };\n" }),
    });
    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /build first/);
  });

  it("skips a wildcard subpath with a reason rather than calling it a missing build", async () => {
    writeWorkspace("@scope/f", "packages/f", "1.0.0", { "dist/index.js": "export { one };\n" }, { ".": "./dist/index.js", "./*": "./dist/*.js" });
    const result = await drift.checkPackageDrift({
      root,
      name: "@scope/f",
      dir: "packages/f",
      ...published("1.0.0", { "dist/index.js": "export { one };\n" }),
    });
    assert.equal(result.status, "ok");
    assert.match(result.partialReason ?? "", /wildcard subpath/);
  });

  // Raised by Codex as a P1: adding `{ "./new": "./dist/new.js" }` at an unchanged
  // version is a consumer-visible addition — `import "pkg/new"` fails after a plain
  // install — and the published file 404s, so treating that as a skip let the whole
  // package report `ok` as long as `.` compared cleanly.
  it("counts a concrete subpath the published package does not serve as DRIFT", async () => {
    writeWorkspace(
      "@scope/h",
      "packages/h",
      "1.0.0",
      { "dist/index.js": "export { root };\n", "dist/new.js": "export { fresh };\n" },
      { ".": "./dist/index.js", "./new": "./dist/new.js" },
    );
    const result = await drift.checkPackageDrift({
      root,
      name: "@scope/h",
      dir: "packages/h",
      ...published("1.0.0", { "dist/index.js": "export { root };\n" }),
    });
    assert.equal(result.status, "drifted");
    assert.match(result.added?.join(" ") ?? "", /ENTIRE SUBPATH absent/);
  });

  it("still SKIPS a transport failure — a 500 says nothing about the package", async () => {
    writeWorkspace("@scope/i", "packages/i", "1.0.0", { "dist/index.js": "export { root };\n" });
    const result = await drift.checkPackageDrift({
      root,
      name: "@scope/i",
      dir: "packages/i",
      fetchPublishedVersion: async () => ({ version: "1.0.0", reason: null }),
      fetchPublishedEntry: async () => ({ source: null, reason: "unpkg 500" }),
    });
    assert.equal(result.status, "skipped");
  });

  // Raised by Codex as a P2: eight of the twenty scanned packages export a
  // `./style.css`, so a non-JS entry counting as a successful comparison meant an
  // unbuilt package could report `ok` — its JS entry skipped, its stylesheet
  // "compared", and the verdict clean.
  it("does not let a non-JS entry stand in for a missing JS build", async () => {
    writeWorkspace(
      "@scope/j",
      "packages/j",
      "1.0.0",
      { "dist/style.css": ".a { color: red }\n" }, // note: no dist/index.js
      { ".": "./dist/index.js", "./style.css": "./dist/style.css" },
    );
    const result = await drift.checkPackageDrift({
      root,
      name: "@scope/j",
      dir: "packages/j",
      ...published("1.0.0", { "dist/index.js": "export { one };\n", "dist/style.css": ".a { color: red }\n" }),
    });
    assert.equal(result.status, "skipped", `expected skipped, got ${result.status}`);
    assert.match(result.reason ?? "", /not a JS module|build first/);
  });

  it("skips when the package is not on the registry", async () => {
    writeWorkspace("@scope/g", "packages/g", "1.0.0", { "dist/index.js": "export { one };\n" });
    const result = await drift.checkPackageDrift({
      root,
      name: "@scope/g",
      dir: "packages/g",
      fetchPublishedVersion: async () => ({ version: null, reason: "registry 404" }),
    });
    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /registry 404/);
  });

  it("throws when the name is missing", async () => {
    await assert.rejects(() => drift.checkPackageDrift({ root, dir: "packages/a" }), /name` is required/);
  });
});

describe("discoverWorkspaceLibraries", () => {
  let root = "";

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "drift-discover-"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "root", private: true, workspaces: ["packages/*", "packages/nested/*"] }));
    const write = (dir: string, pkg: unknown): void => {
      mkdirSync(path.join(root, dir), { recursive: true });
      writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(pkg));
    };
    write("packages/lib", { name: "@scope/lib", version: "1.0.0" });
    write("packages/nested/deep", { name: "@scope/deep", version: "1.0.0", dependencies: { "@scope/lib": "^1.0.0" } });
    write("packages/host", { name: "host", version: "1.0.0", devDependencies: { "@scope/deep": "^1.0.0" } });
    write("packages/lonely", { name: "@scope/lonely", version: "1.0.0" });
    write("packages/secret", { name: "@scope/secret", version: "1.0.0", private: true, dependencies: { "@scope/lonely": "^1.0.0" } });
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds packages another workspace declares, wherever they sit in the tree", async () => {
    const found = await drift.discoverWorkspaceLibraries({ root });
    const names = found.map((entry) => entry.name);
    // `@scope/deep` lives under packages/nested/ — a `packages/<name>` path guess
    // would miss it, which is how the bridges and plugins escaped the old gate.
    assert.ok(names.includes("@scope/lib"), names.join(", "));
    assert.ok(names.includes("@scope/deep"), names.join(", "));
  });

  it("leaves out a package nothing imports", async () => {
    // `@scope/lonely` IS declared — but only by a private workspace, which ships
    // nothing, so no consumer can break on its exports.
    const names = (await drift.discoverWorkspaceLibraries({ root })).map((entry) => entry.name);
    assert.ok(!names.includes("@scope/lonely"), names.join(", "));
  });

  it("leaves out private workspaces even when imported", async () => {
    const names = (await drift.discoverWorkspaceLibraries({ root })).map((entry) => entry.name);
    assert.ok(!names.includes("@scope/secret"), names.join(", "));
  });

  it("records who the consumers are", async () => {
    const lib = (await drift.discoverWorkspaceLibraries({ root })).find((entry) => entry.name === "@scope/lib");
    assert.deepEqual(lib?.consumers, ["@scope/deep"]);
  });
});
