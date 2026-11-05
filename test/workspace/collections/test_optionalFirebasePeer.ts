// `firebase` is an OPTIONAL peer of `@mulmoclaude/core` — so every entry that
// does not need Firestore has to LOAD without it, under `import` and under
// `require` alike (#3263).
//
// Why a child process with a resolution hook, rather than reading the source:
// the invariant was already WRITTEN in `collection/server/index.ts`, and it was
// broken seven lines below the sentence stating it. Nothing that reads the tree
// notices — `typecheck` passes because types erase, and this repository's own
// tests pass because this repository installs firebase. The only check that
// bites is loading the built entry with the package made unresolvable, which is
// exactly what a consumer without it does. `@receptron/sharedapp` is one: a
// pure projection library with no I/O and no Firestore, where core 5 failed at
// load with `ERR_MODULE_NOT_FOUND`.
//
// One import took down six entries, not the one reported, so this sweeps the
// whole exports map rather than naming the entry that happened to be noticed.
// A new entry is covered the day it is declared.
//
// This runs against `packages/core/dist`, the artifact that ships — CI builds
// the workspace packages before the test step, so what it reads there is this
// commit. Run by hand on a tree whose `dist` predates your edit, it answers for
// the OLD build and says so nowhere: `yarn build:packages` first. A missing
// `dist` fails loudly, which is the case worth having loud; a stale one cannot
// be told apart from a fresh one by reading it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "@mulmoclaude/common";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const NO_FIREBASE_HOOKS = pathToFileURL(resolve(HERE, "fixtures", "noFirebaseHooks.mjs")).href;
const PACKAGE_NAME = "@mulmoclaude/core";

/** The entries whose NAME says they need the SDK. Everything else in the
 *  exports map must load without it. */
const SDK_BOUND = new Set(["./collection/firestore", "./remote-host/server"]);

/** Fences the child's answer off from anything else it may print — a module
 *  that logged on import would otherwise turn a real result into a parse
 *  crash, which reads as a broken test rather than as whatever it actually is. */
const MARKER = "__ENTRY_RESULTS__";

type Condition = "import" | "require";

interface EntryResult {
  specifier: string;
  ok: boolean;
  names: string[];
  code: string;
  message: string;
}

/** Every declared subpath, with the conditions it declares. Read from the
 *  package itself so the sweep cannot fall behind it. */
function declaredEntries(): { subpath: string; conditions: Condition[] }[] {
  const manifest: unknown = JSON.parse(readFileSync(resolve(REPO_ROOT, "packages", "core", "package.json"), "utf-8"));
  const exportsMap = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {};
  return Object.entries(exportsMap).map(([subpath, target]) => ({
    subpath,
    conditions: (["import", "require"] as const).filter((condition) => isRecord(target) && condition in target),
  }));
}

const specifierOf = (subpath: string): string => `${PACKAGE_NAME}${subpath.slice(1)}`;

/** The child's loop, as source. One child per condition loads every entry and
 *  reports each outcome, instead of one process per entry. */
function childScript(condition: Condition, specifiers: string[]): string {
  const load = condition === "import" ? "await import(specifier)" : "requireFromRoot(specifier)";
  const results = `
    const results = [];
    for (const specifier of ${JSON.stringify(specifiers)}) {
      try {
        const entry = ${load};
        results.push({ specifier, ok: true, names: Object.keys(entry), code: "", message: "" });
      } catch (error) {
        results.push({ specifier, ok: false, names: [], code: String(error?.code ?? ""), message: String(error?.message ?? error) });
      }
    }
    process.stdout.write("\\n${MARKER}" + JSON.stringify(results));
  `;
  return condition === "import" ? results : `const requireFromRoot = require("node:module").createRequire(process.cwd() + "/");\n${results}`;
}

const isEntryResult = (value: unknown): value is EntryResult =>
  isRecord(value) && typeof value.specifier === "string" && typeof value.ok === "boolean" && Array.isArray(value.names);

/** Load `specifiers` under `condition` in a child whose `firebase` cannot be
 *  resolved. Throws — rather than returning an empty list — when the child
 *  itself fails, so a broken harness cannot read as "nothing failed". */
function loadWithoutFirebase(condition: Condition, specifiers: string[]): Map<string, EntryResult> {
  const inputType = condition === "import" ? "module" : "commonjs";
  const child = spawnSync(process.execPath, ["--import", NO_FIREBASE_HOOKS, `--input-type=${inputType}`, "-e", childScript(condition, specifiers)], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  const fenced = (child.stdout ?? "").split("\n").find((line) => line.startsWith(MARKER));
  if (child.status !== 0 || fenced === undefined) {
    throw new Error(`the ${condition} child did not report (status ${String(child.status)}): ${child.error?.message ?? ""}\n${child.stderr ?? ""}`);
  }
  const parsed: unknown = JSON.parse(fenced.slice(MARKER.length));
  const results = Array.isArray(parsed) ? parsed.filter(isEntryResult) : [];
  return new Map(results.map((result) => [result.specifier, result]));
}

const describeFailure = (result: EntryResult | undefined, specifier: string): string =>
  result === undefined ? `${specifier}: no result` : `${specifier}: ${result.code} ${result.message.split("\n")[0]}`;

// The exemption list must name real entries. A name left behind by a rename or
// a removal would sit here exempting nothing, and the control below would go on
// passing on whatever remained — a stale set that reads as a checked one. (A
// renamed SDK-bound entry is already loud: under its new name it is not exempt,
// so the sweep expects it to load and it fails.)
describe("the SDK-bound exemption list", () => {
  it("names only entries the package actually declares", () => {
    const declared = new Set(declaredEntries().map((entry) => entry.subpath));
    const stale = [...SDK_BOUND].filter((subpath) => !declared.has(subpath));
    assert.deepEqual(stale, [], `SDK_BOUND names entries the exports map no longer has: ${stale.join(", ")}`);
  });
});

(["import", "require"] as const).forEach((condition) => {
  describe(`the optional \`firebase\` peer, under \`${condition}\` (#3263)`, () => {
    const entries = declaredEntries().filter((entry) => entry.conditions.includes(condition));
    const results = loadWithoutFirebase(
      condition,
      entries.map((entry) => specifierOf(entry.subpath)),
    );

    // THE CONTROL, and it is not decoration: without it a green sweep could
    // mean "the hook never fired" just as easily as "the entries are clean".
    // It is exactly how an earlier version of this harness would have gone
    // wrong under `require`, which the async hook API does not reach.
    it("really is unresolvable — every SDK-bound entry still fails", () => {
      const bound = entries.filter((entry) => SDK_BOUND.has(entry.subpath));
      assert.ok(bound.length > 0, `no SDK-bound entry declares \`${condition}\`, so nothing proves the hook bites`);
      bound.forEach((entry) => {
        const result = results.get(specifierOf(entry.subpath));
        assert.equal(result?.ok, false, `${entry.subpath} loaded without firebase — the hook is not intercepting \`${condition}\``);
        assert.equal(result?.code, "ERR_MODULE_NOT_FOUND", describeFailure(result, entry.subpath));
        assert.match(result?.message ?? "", /firebase/);
      });
    });

    it("loads every other entry with firebase absent", () => {
      const broken = entries
        .filter((entry) => !SDK_BOUND.has(entry.subpath))
        .map((entry) => ({ entry, result: results.get(specifierOf(entry.subpath)) }))
        .filter(({ result }) => result?.ok !== true)
        .map(({ entry, result }) => describeFailure(result, entry.subpath));
      assert.deepEqual(broken, [], `these entries need firebase, which is an OPTIONAL peer:\n${broken.join("\n")}`);
    });

    it("serves `collection/server`'s whole surface, not a subset that happens to link", () => {
      const names = results.get(specifierOf("./collection/server"))?.names ?? [];
      // `parseAppManifest` is why this is load-bearing rather than tidiness: it
      // exists on NO other subpath, so a consumer that cannot load this entry
      // has no way around it. `storeFor` is the module that carried the SDK
      // import in (the backend registry names the Firestore store), and
      // `sharedItemsPath` is the value the barrel re-exports from it.
      ["parseAppManifest", "storeFor", "sharedItemsPath", "discoverCollections"].forEach((name) => {
        assert.ok(names.includes(name), `expected '${name}' among the entry's exports`);
      });
    });
  });
});
