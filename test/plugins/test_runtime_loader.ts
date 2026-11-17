import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPluginFromCacheDir, isCacheValid, EXTRACT_MARKER, ensureInsideBase, resolveExecute, toPackageJson } from "../../server/plugins/runtime-loader.js";
import { makeTempDir } from "../helpers/tempDir.js";

interface FixtureOpts {
  exportsImport?: string;
  /** Override the entry-file content. Default exports a healthy
   *  TOOL_DEFINITION so the import loads cleanly. */
  entryContent?: string;
  /** When true, omit `package.json` to test missing-pkg behaviour. */
  omitPackageJson?: boolean;
  /** When true, write malformed JSON in `package.json`. */
  corruptPackageJson?: boolean;
  /** Override the `exports` field shape entirely. Used to exercise
   *  the four legal Node.js shapes (#1077 review). When set, the
   *  default conditional-subpath shape is skipped. */
  exportsField?: unknown;
  /** When true, omit `exports` and use `main` instead (legacy form). */
  useMainOnly?: string;
}

function makeFixture(opts: FixtureOpts = {}): string {
  const dir = makeTempDir("mulmo-runtime-loader-");
  if (opts.omitPackageJson) return dir;
  const entrySpec = opts.exportsImport ?? "./entry.js";
  let pkgRecord: Record<string, unknown>;
  if (opts.useMainOnly) {
    pkgRecord = {
      name: "@fixture/plugin",
      version: "1.0.0",
      type: "module",
      main: opts.useMainOnly,
    };
  } else {
    pkgRecord = {
      name: "@fixture/plugin",
      version: "1.0.0",
      type: "module",
      exports: opts.exportsField ?? { ".": { import: entrySpec } },
    };
  }
  const pkg = opts.corruptPackageJson ? "{ broken json" : JSON.stringify(pkgRecord);
  writeFileSync(path.join(dir, "package.json"), pkg);
  if (opts.corruptPackageJson) return dir;
  const entryRel = opts.useMainOnly ?? opts.exportsImport ?? "entry.js";
  const entryPath = path.join(dir, entryRel);
  mkdirSync(path.dirname(entryPath), { recursive: true });
  writeFileSync(
    entryPath,
    opts.entryContent ??
      `export const TOOL_DEFINITION = {
  name: "fixture",
  description: "a fixture plugin for tests",
  parameters: { type: "object", properties: {} }
};
`,
  );
  return dir;
}

describe("loadPluginFromCacheDir", () => {
  it("loads a healthy plugin and returns RuntimePlugin", async () => {
    const dir = makeFixture();
    const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
    assert.ok(plugin);
    assert.equal(plugin?.name, "@fixture/plugin");
    assert.equal(plugin?.version, "1.0.0");
    assert.equal(plugin?.cachePath, dir);
    assert.equal(plugin?.definition.name, "fixture");
    assert.equal(plugin?.definition.description, "a fixture plugin for tests");
  });

  it("returns null when package.json is missing", async () => {
    const dir = makeFixture({ omitPackageJson: true });
    const plugin = await loadPluginFromCacheDir("@x/missing", "0.0.1", dir);
    assert.equal(plugin, null);
  });

  it("returns null when package.json is corrupt JSON", async () => {
    const dir = makeFixture({ corruptPackageJson: true });
    const plugin = await loadPluginFromCacheDir("@x/corrupt", "0.0.1", dir);
    assert.equal(plugin, null);
  });

  it("returns null when entry-point export has no TOOL_DEFINITION", async () => {
    const dir = makeFixture({ entryContent: "export const SOMETHING_ELSE = {};\n" });
    const plugin = await loadPluginFromCacheDir("@x/no-def", "0.0.1", dir);
    assert.equal(plugin, null);
  });

  it("returns null when TOOL_DEFINITION is the wrong shape", async () => {
    const dir = makeFixture({
      entryContent: `export const TOOL_DEFINITION = "not-an-object";\n`,
    });
    const plugin = await loadPluginFromCacheDir("@x/bad-shape", "0.0.1", dir);
    assert.equal(plugin, null);
  });

  it("falls through exports → module → main when resolving entry path", async () => {
    const dir = makeTempDir("mulmo-runtime-loader-fallback-");
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@x/legacy-main",
        version: "1.0.0",
        type: "module",
        main: "./legacy.js",
      }),
    );
    writeFileSync(
      path.join(dir, "legacy.js"),
      `export const TOOL_DEFINITION = { name: "legacy", description: "main fallback" };
`,
    );
    const plugin = await loadPluginFromCacheDir("@x/legacy-main", "1.0.0", dir);
    assert.ok(plugin);
    assert.equal(plugin?.definition.name, "legacy");
  });

  it("returns null when no entry specifier resolvable", async () => {
    const dir = makeTempDir("mulmo-runtime-loader-noentry-");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@x/empty", version: "1.0.0" }));
    const plugin = await loadPluginFromCacheDir("@x/empty", "1.0.0", dir);
    assert.equal(plugin, null);
  });

  it("ensureInsideBase: accepts paths inside the base", () => {
    const base = path.join(tmpdir(), "mulmo-base-positive");
    assert.equal(ensureInsideBase(path.join(base, "ok"), base), true);
    assert.equal(ensureInsideBase(path.join(base, "a", "b"), base), true);
    assert.equal(ensureInsideBase(base, base), true, "the base itself is inside the base");
  });

  it("ensureInsideBase: rejects lexical traversal escape", () => {
    const base = path.join(tmpdir(), "mulmo-base-traversal");
    // Mirrors what `path.join(base, ledgerName, version)` does when the
    // ledger entry is `"../../etc"`.
    assert.equal(ensureInsideBase(path.join(base, "..", "..", "etc"), base), false);
    assert.equal(ensureInsideBase(path.join(base, "..", "sibling"), base), false);
  });

  it("ensureInsideBase: rejects an absolute path outside the base", () => {
    const base = path.join(tmpdir(), "mulmo-base-absolute");
    assert.equal(ensureInsideBase("/etc/passwd", base), false);
  });

  it("ensureInsideBase: catches a malicious `tgz` ledger field too", () => {
    // The ledger has TWO user-controlled fields that join against
    // different bases: `tgz` (against WORKSPACE_PATHS.plugins) and
    // (name, version) (against pluginCache). Both must be checked,
    // not just one.
    const pluginsRoot = path.join(tmpdir(), "mulmo-base-tgz");
    const malicious = path.join(pluginsRoot, "..", "..", "etc", "passwd");
    assert.equal(ensureInsideBase(malicious, pluginsRoot), false);
  });

  it("ensureInsideBase: a base at the filesystem root holds everything under it", () => {
    const fsRoot = path.parse(process.cwd()).root;
    assert.equal(ensureInsideBase(path.join(fsRoot, "plugins", "x.tgz"), fsRoot), true);
  });

  it("ensureInsideBase: a base-prefix without separator is not enough", () => {
    // `/cache/foo` is NOT inside `/cache/fo`. Naive startsWith would
    // accept it; the explicit `path.sep` boundary check rejects it.
    const base = path.join(tmpdir(), "mulmo-base-prefix-fo");
    const sibling = path.join(tmpdir(), "mulmo-base-prefix-foo");
    assert.equal(ensureInsideBase(sibling, base), false);
  });

  it("isCacheValid: false on a directory missing the completion marker (partial extract)", () => {
    const dir = makeTempDir("mulmo-runtime-cache-partial-");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@x/half", version: "1.0.0" }));
    // No EXTRACT_MARKER → cache is partial / invalid even though the
    // directory exists. This is what stops a sticky broken cache.
    assert.equal(isCacheValid(dir), false);
  });

  it("isCacheValid: true once the completion marker is present", () => {
    const dir = makeTempDir("mulmo-runtime-cache-complete-");
    writeFileSync(path.join(dir, EXTRACT_MARKER), "");
    assert.equal(isCacheValid(dir), true);
  });

  // Proto-key regression (#2319): `definitionName` is a plugin-controlled
  // `TOOL_DEFINITION.name`. A bare `carrier[definitionName]` for a proto name
  // resolves to an Object.prototype function, DEFEATING the `typeof !==
  // "function"` gate — a plugin exporting no matching handler gets `Object` /
  // `Object.prototype.toString` registered and dispatched instead of null.
  describe("resolveExecute — prototype-key guard", () => {
    // `__proto__` resolves to Object.prototype (an object), already caught by the
    // typeof gate; the callable Object.prototype functions are the real hazard.
    for (const proto of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      it(`returns null for the prototype key "${proto}" on a carrier that does not own it`, () => {
        assert.equal(resolveExecute({}, proto, false), null);
      });
    }

    it("returns null for a normal unexported name", () => {
      assert.equal(resolveExecute({}, "myTool", false), null);
    });

    it("returns the legacy handler a carrier actually exports", () => {
      const handler = () => undefined;
      assert.equal(resolveExecute({ myTool: handler }, "myTool", false), handler);
    });

    it("returns a handler legitimately exported under a proto-collision name (boundary)", () => {
      const handler = () => "real";
      assert.equal(resolveExecute({ toString: handler }, "toString", false), handler);
    });

    it("wraps a factory handler so the dispatch route's `context` arg is dropped", () => {
      const seen: unknown[][] = [];
      const execute = resolveExecute({ myTool: (...args: unknown[]) => seen.push(args) }, "myTool", true);
      assert.ok(execute);
      execute({ ctx: true }, { a: 1 });
      assert.deepEqual(seen, [[{ a: 1 }]]);
    });

    for (const notAFunction of [undefined, null, 42, "handler", { call: true }, []]) {
      it(`returns null when the exported value is ${JSON.stringify(notAFunction) ?? "undefined"} rather than a function`, () => {
        assert.equal(resolveExecute({ myTool: notAFunction }, "myTool", false), null);
      });
    }
  });

  // `package.json` is plugin-authored, so every field the loader reads has to
  // survive being the wrong type. Before #2692 the parsed JSON was asserted
  // straight to `PackageJson`, which let a non-string `main` reach `path.join`.
  describe("toPackageJson", () => {
    it("keeps the string fields the entry resolver reads", () => {
      const pkg = toPackageJson({ name: "@x/p", version: "1.2.3", main: "./m.js", module: "./esm.js" });
      assert.deepEqual(pkg, { name: "@x/p", version: "1.2.3", exports: undefined, main: "./m.js", module: "./esm.js" });
    });

    it("drops non-string values instead of letting them pose as strings", () => {
      const pkg = toPackageJson({ name: 42, version: null, main: { nested: true }, module: ["./a.js"] });
      assert.deepEqual(pkg, { name: undefined, version: undefined, exports: undefined, main: undefined, module: undefined });
    });

    it("passes `exports` through unnarrowed so every legal Node.js shape survives", () => {
      assert.deepEqual(toPackageJson({ exports: "./e.js" })?.exports, "./e.js");
      assert.deepEqual(toPackageJson({ exports: ["./a.js", "./b.js"] })?.exports, ["./a.js", "./b.js"]);
      assert.deepEqual(toPackageJson({ exports: { ".": { import: "./e.js" } } })?.exports, { ".": { import: "./e.js" } });
    });

    for (const notAnObject of [null, 42, "pkg", [], true]) {
      it(`returns null for a package.json parsing to ${JSON.stringify(notAnObject) ?? "null"}`, () => {
        assert.equal(toPackageJson(notAnObject), null);
      });
    }
  });

  it("returns null when entry file is missing on disk", async () => {
    const dir = makeTempDir("mulmo-runtime-loader-missing-entry-");
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@x/missing-entry",
        version: "1.0.0",
        type: "module",
        exports: { ".": { import: "./gone.js" } },
      }),
    );
    const plugin = await loadPluginFromCacheDir("@x/missing-entry", "1.0.0", dir);
    assert.equal(plugin, null);
  });

  // Cover the four legal `exports` shapes per the Node.js spec.
  // Earlier the loader only matched the conditional-subpath form
  // (form 4) and silently fell through to `module` / `main` for the
  // others. Real npm packages using the simpler forms wouldn't load
  // (#1077 review).
  describe("resolveEntrySpecifier — `exports` field shapes", () => {
    it("loads a plugin with top-level string `exports` (form 1: sugar)", async () => {
      const dir = makeFixture({ exportsField: "./entry.js" });
      const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
      assert.ok(plugin, "string-form `exports` must resolve to the entry");
      assert.equal(plugin.definition.name, "fixture");
    });

    it("loads a plugin with conditional-root `exports` (form 2: { import, require })", async () => {
      const dir = makeFixture({ exportsField: { import: "./entry.js", require: "./entry.cjs" } });
      const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
      assert.ok(plugin, "conditional-root `exports.import` must resolve to the entry");
      assert.equal(plugin.definition.name, "fixture");
    });

    it('loads a plugin with subpath-string `exports["."]` (form 3)', async () => {
      const dir = makeFixture({ exportsField: { ".": "./entry.js" } });
      const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
      assert.ok(plugin, "subpath-string `exports['.']` must resolve to the entry");
      assert.equal(plugin.definition.name, "fixture");
    });

    it("falls back to `main` when `exports` is absent (legacy)", async () => {
      const dir = makeFixture({ useMainOnly: "./entry.js" });
      const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
      assert.ok(plugin, "legacy `main`-only packages must still load");
      assert.equal(plugin.definition.name, "fixture");
    });

    it("falls back to `default` in a top-level conditional `exports` (ESM-only package, no `import` key)", async () => {
      // Node.js resolves `exports: { default: "./entry.js" }` via the
      // `default` condition because it "always matches" when no
      // earlier condition fired. ESM-only packages may publish in
      // exactly this shape with no `import` key at all (Codex review
      // on #1116).
      const dir = makeFixture({ exportsField: { default: "./entry.js" } });
      const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
      assert.ok(plugin, "top-level `exports.default` must resolve to the entry");
      assert.equal(plugin.definition.name, "fixture");
    });

    it('falls back to `default` in a subpath conditional `exports["."]`', async () => {
      const dir = makeFixture({ exportsField: { ".": { default: "./entry.js" } } });
      const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
      assert.ok(plugin, "subpath `exports['.'].default` must resolve to the entry");
      assert.equal(plugin.definition.name, "fixture");
    });

    it("prefers `import` over `default` in a conditional object", async () => {
      // When both keys are present, `import` is the more-specific
      // condition and wins. Sanity: a fixture pointing `default` at a
      // file we never write proves the loader didn't pick `default`.
      const dir = makeFixture({ exportsField: { import: "./entry.js", default: "./never-written.js" } });
      const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
      assert.ok(plugin, "`import` must take precedence over `default`");
      assert.equal(plugin.definition.name, "fixture");
    });

    it("resolves a top-level array fallback chain", async () => {
      // Per Node.js spec, `exports` may be an array of fallback
      // targets. We don't probe disk per element — we pick the first
      // string. Codex review iter-2 on #1116.
      const dir = makeFixture({ exportsField: ["./entry.js", "./never-written.js"] });
      const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
      assert.ok(plugin, "top-level array `exports` first element must resolve");
      assert.equal(plugin.definition.name, "fixture");
    });

    it('resolves an `exports["."]` array fallback chain', async () => {
      const dir = makeFixture({ exportsField: { ".": ["./entry.js", "./never-written.js"] } });
      const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
      assert.ok(plugin, "subpath array `exports['.'][0]` must resolve");
      assert.equal(plugin.definition.name, "fixture");
    });

    it("resolves an array containing condition objects", async () => {
      // A real-world shape from packages that ship multiple module
      // formats: an array of condition objects. The loader picks the
      // first one with a usable ESM target (`import` then `default`).
      const dir = makeFixture({
        exportsField: { ".": [{ require: "./cjs.js" }, { import: "./entry.js" }] },
      });
      const plugin = await loadPluginFromCacheDir("@fixture/plugin", "1.0.0", dir);
      assert.ok(plugin, "array of condition objects must surface the ESM target");
      assert.equal(plugin.definition.name, "fixture");
    });
  });
});
