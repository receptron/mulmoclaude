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

  it("ignores type-only exports and `default`", () => {
    const source = "export type Foo = string;\nexport interface Bar {}\nexport { type Baz } from './b.js';\nexport default thing;\n";
    assert.deepEqual([...drift.parseExportedNames(source).names], []);
  });

  it("marks `export * from` opaque — the set cannot be enumerated from this file alone", () => {
    const { names, opaque } = drift.parseExportedNames(`export * from "./chunk.js";\nexport const visible = 1;\n`);
    assert.equal(opaque, true);
    assert.deepEqual([...names], ["visible"]);
  });

  it("ignores indented exports (only module-level counts)", () => {
    assert.equal(drift.parseExportedNames("  export const inner = 1;\n").names.size, 0);
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

  it("falls back to module / main when there is no exports map", () => {
    assert.deepEqual([...drift.entryTargets({ main: "./dist/entry.js" })], [[".", "dist/entry.js"]]);
    assert.deepEqual([...drift.entryTargets({})], [[".", "dist/index.js"]]);
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
