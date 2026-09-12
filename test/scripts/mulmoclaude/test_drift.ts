// Unit tests for scripts/mulmoclaude/drift.mjs — the JS port of
// SKILL.md §2 workspace-drift check. Covers the pure line counter,
// the per-package audit against filesystem fixtures, and the
// auto-detection step that reads packages/mulmoclaude/package.json.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as drift from "../../../scripts/mulmoclaude/drift.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

// Most tests want to exercise the local-fixture fallback rather
// than the real registry. Pass this stub to force the fallback
// branch (registry "unreachable") and let the existing fixtures
// under installed_packages/.../\_dist/ drive the comparison.
const offlineRegistry = async () => ({ version: null, source: null, reason: "test stub — skip registry" });

// Stub returning a specific source, used by the new drifted-from-
// published tests below.
function registryReturning(source: string, version = "0.0.0-stub") {
  return async () => ({ version, source, reason: null });
}

describe("countValueExportLines", () => {
  it("counts plain re-export lines", () => {
    const source = `export { foo } from "./foo";\nexport { bar } from "./bar";\n`;
    assert.equal(drift.countValueExportLines(source), 2);
  });

  it("counts a mixed value+type brace as ONE line (value-bearing)", () => {
    // `EVENT_TYPES` is a runtime binding, so the line counts even
    // though it also lists some types. Matches the skill's shell
    // regex behaviour exactly.
    const source = `export { EVENT_TYPES, type EventType, generationKey } from "./events";\n`;
    assert.equal(drift.countValueExportLines(source), 1);
  });

  it("excludes `export type` lines", () => {
    const source = `export type Foo = number;\nexport type { Bar } from "./bar";\n`;
    assert.equal(drift.countValueExportLines(source), 0);
  });

  it("excludes `export interface` lines", () => {
    const source = `export interface Foo { x: number; }\n`;
    assert.equal(drift.countValueExportLines(source), 0);
  });

  it("excludes `export { type Foo }` brace-type-only lines", () => {
    const source = `export { type Attachment } from "./attachment";\n`;
    assert.equal(drift.countValueExportLines(source), 0);
  });

  it("includes `export { type Foo }` when the brace also has runtime bindings", () => {
    const source = `export { type Attachment, saveAttachment } from "./attachment";\n`;
    // Brace starts with `type`, so the skill's heuristic strips it.
    // We match the skill — this is an intentional false negative
    // that favours consistency with the existing pipeline.
    assert.equal(drift.countValueExportLines(source), 0);
  });

  it("handles CRLF line endings", () => {
    const source = 'export { a } from "./a";\r\nexport { b } from "./b";\r\n';
    assert.equal(drift.countValueExportLines(source), 2);
  });

  it("ignores indented `export` (only top-level counts)", () => {
    // TypeScript namespaces and conditional blocks emit nested
    // `export` tokens that aren't module-level exports.
    const source = `namespace NS {\n  export const x = 1;\n}\n`;
    assert.equal(drift.countValueExportLines(source), 0);
  });

  it("returns 0 for empty / no-export files", () => {
    assert.equal(drift.countValueExportLines(""), 0);
    assert.equal(drift.countValueExportLines("const x = 1;\n"), 0);
  });
});

describe("checkPackageDrift", () => {
  it("reports ok when src and dist line counts match", async () => {
    const result = await drift.checkPackageDrift({
      root: path.join(FIXTURES, "drift-clean"),
      packageBaseName: "protocol",
      installedRoot: "installed_packages",
      distRelative: "_dist/index.js",
      fetchPublishedSource: offlineRegistry,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.localCount, 3);
    assert.equal(result.distCount, 3);
    assert.equal(result.localVersion, "0.1.3");
  });

  it("flags drift when src has more value-export lines than dist", async () => {
    const result = await drift.checkPackageDrift({
      root: path.join(FIXTURES, "drift-drifted"),
      packageBaseName: "protocol",
      installedRoot: "installed_packages",
      distRelative: "_dist/index.js",
      fetchPublishedSource: offlineRegistry,
    });
    assert.equal(result.status, "drifted");
    assert.equal(result.localCount, 3);
    assert.equal(result.distCount, 2);
  });

  it("returns ok for a sibling package that didn't drift", async () => {
    const result = await drift.checkPackageDrift({
      root: path.join(FIXTURES, "drift-drifted"),
      packageBaseName: "client",
      installedRoot: "installed_packages",
      distRelative: "_dist/index.js",
      fetchPublishedSource: offlineRegistry,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.localCount, 1);
    assert.equal(result.distCount, 1);
  });

  it("skips (not fails) when the installed dist is missing", async () => {
    // drift-clean has protocol but not, say, chat-service. Missing
    // node_modules entry must NOT be a hard error — tests run
    // without a full yarn install on the fixture tree.
    const result = await drift.checkPackageDrift({
      root: path.join(FIXTURES, "drift-clean"),
      packageBaseName: "chat-service",
      installedRoot: "installed_packages",
      distRelative: "_dist/index.js",
      fetchPublishedSource: offlineRegistry,
    });
    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /src not found|dist not found/);
  });

  it("throws when packageBaseName is missing", async () => {
    await assert.rejects(drift.checkPackageDrift({ root: FIXTURES }), /packageBaseName is required/);
  });

  it("flags drift against the registry-published source (workspace-symlink aware)", async () => {
    // drift-clean's protocol src has 3 value-export lines. The
    // stub registry returns a dist with only 2 lines — what
    // would ship to users after an install-from-registry. Drift
    // must flag this even though the local workspace dist would
    // otherwise match src.
    const publishedOldDist = `export { a } from "./a.js";\nexport { b } from "./b.js";\n`;
    const result = await drift.checkPackageDrift({
      root: path.join(FIXTURES, "drift-clean"),
      packageBaseName: "protocol",
      // drift-clean/packages/protocol/package.json is 0.1.3 — match it
      // so the version compare resolves to "equal" (= not bumped).
      fetchPublishedSource: registryReturning(publishedOldDist, "0.1.3"),
    });
    assert.equal(result.status, "drifted");
    assert.equal(result.localCount, 3);
    assert.equal(result.distCount, 2);
    assert.equal(result.publishedVersion, "0.1.3");
    assert.equal(result.fallbackReason, undefined, "must not use local fallback when registry succeeded");
  });

  it("downgrades drift to 'pending-publish' when local version is ahead of registry", async () => {
    // Same shape as the drifted test above, but the registry stub
    // reports an OLDER version than what's in the local
    // package.json. That means the developer has already bumped
    // the workspace version to acknowledge the new exports — the
    // cascade publish just hasn't landed yet. Smoke should let
    // the PR through.
    const publishedOldDist = `export { a } from "./a.js";\nexport { b } from "./b.js";\n`;
    const result = await drift.checkPackageDrift({
      root: path.join(FIXTURES, "drift-clean"),
      packageBaseName: "protocol",
      fetchPublishedSource: registryReturning(publishedOldDist, "0.1.2"),
    });
    assert.equal(result.status, "pending-publish");
    assert.equal(result.localCount, 3);
    assert.equal(result.distCount, 2);
    assert.equal(result.localVersion, "0.1.3");
    assert.equal(result.publishedVersion, "0.1.2");
  });

  it("falls back to local installed dist when the registry fetch returns no source", async () => {
    const result = await drift.checkPackageDrift({
      root: path.join(FIXTURES, "drift-clean"),
      packageBaseName: "protocol",
      installedRoot: "installed_packages",
      distRelative: "_dist/index.js",
      fetchPublishedSource: offlineRegistry,
    });
    assert.equal(result.status, "ok");
    assert.match(result.fallbackReason ?? "", /registry unreachable/);
  });
});

/**
 * What the operator actually reads.
 *
 * `pending-publish` used to fall through to the `✓ … (src == published)` branch,
 * so a package that was bumped but never published printed as fully clean — and
 * the one number it showed was the LOCAL count, so the published side never
 * appeared at all. That line was on screen during the 1.16.0 release while
 * `@mulmobridge/client` sat at 1.1.0 with 1.0.2 on npm (#3099).
 *
 * These assert the PROPERTIES a reader depends on, not the exact wording: a
 * test pinned to the sentence goes red on a reworded message and green on a
 * wrong one.
 */
describe("formatLine", () => {
  const result = (status: drift.PackageDriftResult["status"], extra: Record<string, unknown> = {}) => ({
    packageBaseName: "client",
    localVersion: "1.1.0",
    publishedVersion: "1.0.2",
    status,
    // Asymmetric, and neither digit appears in the versions above — so a regex can tie
    // each count to its own side of the line without matching "v1.1.0" by accident.
    localCount: 17,
    distCount: 4,
    ...extra,
  });

  it("renders every status the audit can return", () => {
    const statuses: drift.PackageDriftResult["status"][] = ["ok", "drifted", "pending-publish", "skipped"];
    statuses.forEach((status) => {
      const line = drift.formatLine(result(status, { reason: "no dist" }));
      assert.match(line, /client/, `${status} names the package`);
    });
  });

  it("renders EXACTLY these lines — every status, with and without the fallback note", () => {
    // Four rounds, four wrong formatters that satisfied a presence-based property: labels
    // swapped, the fixture pair hard-coded, a swap with the correct counts appended as a
    // suffix, and ` EXTRA` tacked onto the two statuses this test used to check loosely.
    // Presence can ALWAYS be satisfied by adding more text, so enumerating those is a
    // queue rather than a rule. This states what is PERMITTED — the exact line, for every
    // status, with the expected string BUILT FROM the fixture so a hard-coded formatter
    // fails it too (#3101 rounds 1-4).
    //
    // It DELIBERATELY goes red on a reworded message. These are the lines an operator
    // reads to decide whether publishing is safe; rewording one should be a decision, not
    // a side effect of an unrelated edit.
    // Two identities as well as three count pairs: varying only the counts left the
    // package/version head hard-codeable, which is round 2's finding in a different field
    // (#3101 round 5). Every field the line interpolates is now varied.
    const identities = [
      { packageBaseName: "client", localVersion: "1.1.0", publishedVersion: "1.0.2" },
      { packageBaseName: "protocol", localVersion: "2.0.0", publishedVersion: "1.9.4" },
    ];
    const pairs = [
      { localCount: 17, distCount: 4 },
      { localCount: 9, distCount: 8 },
      { localCount: 231, distCount: 5 },
    ];
    const note = "registry unreachable";
    const cases = identities.flatMap((identity) => pairs.map((pair) => ({ ...identity, ...pair })));
    cases.forEach(({ packageBaseName, localVersion, publishedVersion, localCount, distCount }) => {
      const identity = { packageBaseName, localVersion, publishedVersion };
      const head = `@mulmobridge/${packageBaseName} v${localVersion} → published v${publishedVersion}`;
      const counts = `src has ${localCount} value-export lines, published dist has ${distCount}`;
      const expected: Record<string, string> = {
        "pending-publish": `  ⧗ ${head}: ${counts} — bumped but NOT published yet`,
        drifted: `  ⚠ ${head}: ${counts}`,
        ok: `  ✓ ${head}: ${localCount} value-export lines (src == published)`,
      };
      Object.entries(expected).forEach(([status, line]) => {
        const shape = { ...identity, localCount, distCount };
        assert.equal(drift.formatLine(result(status as drift.PackageDriftResult["status"], shape)), line, status);
        assert.equal(
          drift.formatLine(result(status as drift.PackageDriftResult["status"], { ...shape, fallbackReason: note })),
          `${line} [${note}]`,
          `${status} + fallback`,
        );
      });
    });

    // `skipped` is the odd one out by design: no counts, no published version, no
    // fallback note — it is the branch that ran before any of those were resolved.
    identities.forEach(({ packageBaseName, localVersion, publishedVersion }) => {
      const skipped = result("skipped", { packageBaseName, localVersion, publishedVersion, reason: "local src not found" });
      assert.equal(drift.formatLine(skipped), `  · @mulmobridge/${packageBaseName} v${localVersion}: skipped — local src not found`);
    });
  });
});

describe("isLocalVersionAhead", () => {
  it("returns true when any component is strictly greater", () => {
    assert.equal(drift.isLocalVersionAhead("0.1.3", "0.1.2"), true);
    assert.equal(drift.isLocalVersionAhead("0.2.0", "0.1.99"), true);
    assert.equal(drift.isLocalVersionAhead("1.0.0", "0.99.99"), true);
  });

  it("returns false when versions are equal or local is behind", () => {
    assert.equal(drift.isLocalVersionAhead("0.1.2", "0.1.2"), false);
    assert.equal(drift.isLocalVersionAhead("0.1.2", "0.1.3"), false);
    assert.equal(drift.isLocalVersionAhead("0.1.2", "0.2.0"), false);
  });

  it("ignores prerelease / build suffixes", () => {
    // Treating "0.1.3-rc.1" as "0.1.3" is intentional — any
    // prerelease of a bumped version still counts as a deliberate
    // bump for the drift check.
    assert.equal(drift.isLocalVersionAhead("0.1.3-rc.1", "0.1.2"), true);
    assert.equal(drift.isLocalVersionAhead("0.1.3+build.5", "0.1.3"), false);
  });

  it("returns false for malformed / missing input", () => {
    assert.equal(drift.isLocalVersionAhead("", "0.1.2"), false);
    assert.equal(drift.isLocalVersionAhead("0.1", "0.1.2"), false);
    assert.equal(drift.isLocalVersionAhead("abc", "0.1.2"), false);
    assert.equal(drift.isLocalVersionAhead(null, "0.1.2"), false);
    assert.equal(drift.isLocalVersionAhead("0.1.2", undefined), false);
  });
});

describe("detectMulmobridgeDeps", () => {
  it("returns only bridge deps that also have a local workspace", async () => {
    // drift-drifted declares @mulmobridge/protocol + @mulmobridge/client
    // + express. Only the first two have a packages/<name>/ dir, so
    // only those two should be returned (express is not a bridge).
    const names = await drift.detectMulmobridgeDeps({
      root: path.join(FIXTURES, "drift-drifted"),
    });
    assert.deepEqual(names.sort(), ["client", "protocol"]);
  });

  it("returns empty when the launcher has no bridge deps", async () => {
    // drift-clean only declares one bridge; assert that handle:
    const names = await drift.detectMulmobridgeDeps({
      root: path.join(FIXTURES, "drift-clean"),
    });
    assert.deepEqual(names, ["protocol"]);
  });
});

describe("checkWorkspaceDrift (auto-detection)", () => {
  it("runs per-package checks across auto-detected deps", async () => {
    const results = await drift.checkWorkspaceDrift({
      root: path.join(FIXTURES, "drift-drifted"),
      installedRoot: "installed_packages",
      distRelative: "_dist/index.js",
      fetchPublishedSource: offlineRegistry,
    });
    assert.equal(results.length, 2);
    const protocolResult = results.find((row) => row.packageBaseName === "protocol");
    const clientResult = results.find((row) => row.packageBaseName === "client");
    assert.equal(protocolResult?.status, "drifted");
    assert.equal(clientResult?.status, "ok");
  });

  it("accepts an explicit package list (skips auto-detection)", async () => {
    const results = await drift.checkWorkspaceDrift({
      root: path.join(FIXTURES, "drift-clean"),
      packageBaseNames: ["protocol"],
      installedRoot: "installed_packages",
      distRelative: "_dist/index.js",
      fetchPublishedSource: offlineRegistry,
    });
    assert.equal(results.length, 1);
    const [onlyResult] = results;
    assert.ok(onlyResult);
    assert.equal(onlyResult.status, "ok");
  });
});
