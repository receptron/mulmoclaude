// Realpath-based containment + slug-safety tests for the collections module.
//
// Locks in the symlink-traversal fix from the PR-1483 second review:
// `resolveDataDir` used to do only lexical normalization, so a
// schema could declare `dataPath: "data/clients/items"` while the
// `clients` directory was actually a symlink to `/etc` or anywhere
// outside the workspace. The fix (`isContainedInRoot` realpaths the
// closest existing ancestor) is exercised here against three
// scenarios CodeQL flagged: a symlinked dataPath, a symlinked
// ancestor of dataPath, and a symlinked sibling that does NOT shadow
// the dataPath but lives in the same tree.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isContainedInRoot, isUnderRealRoot, safeRecordId, safeSlugName } from "@mulmoclaude/core/collection/server";

let rootDir: string;
let outsideDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), "apps-paths-root-"));
  outsideDir = mkdtempSync(path.join(tmpdir(), "apps-paths-outside-"));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

// #2972: `manageCollection` resolved the itemsFile with `fs/promises.realpath`
// and then handed the result to `isContainedInRoot`, which canonicalises the
// ROOT with `fs.realpathSync`. On Windows those two APIs disagree — the async
// one expands an 8.3 short name (`C:\Users\RUNNER~1\…`, which is what
// `os.tmpdir()` hands back on a GitHub runner) and the sync one does not — so
// every file under the workspace compared as if it were outside it.
//
// The rule these tests pin is not "the APIs agree" (they need not) but
// "whatever resolves the two sides must be the SAME function".
describe("realpath canonicalisation is api-dependent", () => {
  it("compares equal only when both sides come from the same resolver", async () => {
    const file = path.join(rootDir, "rows.json");
    writeFileSync(file, "[]");
    const [syncRoot, syncFile, asyncRoot, asyncFile] = [realpathSync(rootDir), realpathSync(file), await realpath(rootDir), await realpath(file)];

    assert.equal(isUnderRealRoot(syncFile, syncRoot), true, `sync/sync: ${syncFile} under ${syncRoot}`);
    assert.equal(isUnderRealRoot(asyncFile, asyncRoot), true, `async/async: ${asyncFile} under ${asyncRoot}`);
    // The mixed pairing is the defect. It happens to hold where the two APIs
    // agree (POSIX), so this documents the requirement rather than asserting a
    // platform: what must never happen is code that MIXES them.
    assert.equal(
      isUnderRealRoot(asyncFile, syncRoot),
      asyncRoot === syncRoot,
      `mixing resolvers is only safe while they agree — syncRoot=${syncRoot} asyncRoot=${asyncRoot}`,
    );
  });
});

describe("isContainedInRoot", () => {
  it("accepts a real subdirectory of the root", () => {
    const sub = path.join(rootDir, "data", "clients", "items");
    mkdirSync(sub, { recursive: true });
    assert.equal(isContainedInRoot(sub, rootDir), true);
  });

  it("accepts a not-yet-existing subdirectory whose parent is inside the root", () => {
    // Common first-write case: the data dir hasn't been created
    // yet, but its parent (workspace root) is real and contained.
    const sub = path.join(rootDir, "data", "clients", "items");
    assert.equal(isContainedInRoot(sub, rootDir), true);
  });

  // #2972: `manageCollection`'s `itemsFile` guard refuses a file the test wrote
  // directly under its own `mkdtempSync` root — but only on Windows, where
  // `os.tmpdir()` hands back the 8.3 short form (`C:\Users\RUNNER~1\...`).
  // Every case above contains a DIRECTORY; this one contains a FILE, which is
  // the shape that guard actually checks. The message names both realpaths so a
  // failure says which side failed to canonicalise, rather than just "false".
  it("accepts a FILE written directly under the root", () => {
    const file = path.join(rootDir, "rows.json");
    writeFileSync(file, "[]");
    const detail = `root=${rootDir} rootReal=${realpathSync(rootDir)} file=${file} fileReal=${realpathSync(file)}`;
    assert.equal(isContainedInRoot(file, rootDir), true, detail);
  });

  it("rejects a directory that IS a symlink pointing outside the root", () => {
    // `<root>/escape` → `<outside>/`. Lexical check would pass
    // because `path.resolve(root, "escape")` stays under root.
    const linkPath = path.join(rootDir, "escape");
    symlinkSync(outsideDir, linkPath);
    assert.equal(isContainedInRoot(linkPath, rootDir), false);
  });

  it("rejects a path whose ancestor is a symlink pointing outside the root", () => {
    // `<root>/data` → `<outside>/data`; then `<root>/data/clients`
    // resolves to `<outside>/data/clients`. The escape happens at
    // the ancestor, not the leaf — the lexical check missed this
    // because it only normalised the textual path.
    const outsideData = path.join(outsideDir, "data");
    mkdirSync(outsideData);
    symlinkSync(outsideData, path.join(rootDir, "data"));
    const escapedLeaf = path.join(rootDir, "data", "clients", "items");
    assert.equal(isContainedInRoot(escapedLeaf, rootDir), false);
  });

  it("rejects an absolute path that lives outside the root entirely", () => {
    assert.equal(isContainedInRoot(outsideDir, rootDir), false);
    assert.equal(isContainedInRoot(path.join(outsideDir, "items"), rootDir), false);
  });

  it("accepts a symlink whose target is itself inside the root", () => {
    // Sibling symlinks within a workspace are common (the catalog
    // sync writes them in some setups). Make sure we don't reject
    // them — only the escape case should fail.
    const insideTarget = path.join(rootDir, "real-data");
    mkdirSync(insideTarget);
    const link = path.join(rootDir, "link-data");
    symlinkSync(insideTarget, link);
    assert.equal(isContainedInRoot(link, rootDir), true);
  });

  // A link whose text spells the root's own folder in other case: the JS realpath keeps that case, so a plain prefix
  // test against the root's realpath read the target as outside.
  it("accepts a link inside the root whose text spells the root with different case", (context) => {
    const rootReal = realpathSync(rootDir);
    const otherCase = path.join(path.dirname(rootReal), path.basename(rootReal).toUpperCase());
    if (!existsSync(otherCase)) {
      context.skip("case-sensitive disk");
      return;
    }
    mkdirSync(path.join(rootDir, "real-data"));
    symlinkSync(path.join(otherCase, "real-data"), path.join(rootDir, "case-link"));
    assert.equal(isContainedInRoot(path.join(rootDir, "case-link", "items"), rootDir), true);
  });
});

describe("isUnderRealRoot", () => {
  it("accepts anything under a filesystem root and refuses a sibling sharing the prefix", () => {
    const fsRoot = path.parse(rootDir).root;
    assert.equal(isUnderRealRoot(path.join(fsRoot, "x"), fsRoot), true);
    assert.equal(isUnderRealRoot(path.join(rootDir, "x"), rootDir), true);
    assert.equal(isUnderRealRoot(`${rootDir}x`, rootDir), false);
  });
});

describe("safeSlugName", () => {
  it("accepts normal slugs", () => {
    assert.equal(safeSlugName("acme-corp"), "acme-corp");
    assert.equal(safeSlugName("client42"), "client42");
    assert.equal(safeSlugName("a"), "a");
  });

  it("rejects path separators and traversal", () => {
    assert.equal(safeSlugName("../etc"), null);
    assert.equal(safeSlugName("a/b"), null);
    assert.equal(safeSlugName("a\\b"), null);
    assert.equal(safeSlugName(".."), null);
  });

  it("rejects leading/trailing hyphens and empty input", () => {
    assert.equal(safeSlugName("-leading"), null);
    assert.equal(safeSlugName("trailing-"), null);
    assert.equal(safeSlugName(""), null);
  });

  it("rejects non-string input", () => {
    assert.equal(safeSlugName(null as unknown as string), null);
    assert.equal(safeSlugName(undefined as unknown as string), null);
    assert.equal(safeSlugName(42 as unknown as string), null);
  });
});

describe("safeRecordId", () => {
  it("accepts everything a slug accepts, including repeated -/_", () => {
    assert.equal(safeRecordId("acme-corp"), "acme-corp");
    assert.equal(safeRecordId("client42"), "client42");
    assert.equal(safeRecordId("a--b"), "a--b");
    assert.equal(safeRecordId("a__b"), "a__b");
  });

  it("accepts natural keys with interior dots", () => {
    assert.equal(safeRecordId("1718900000.123456"), "1718900000.123456"); // Slack ts
    assert.equal(safeRecordId("1.2.3"), "1.2.3"); // SemVer
  });

  it("rejects `..`, path separators, and leading/trailing dots", () => {
    assert.equal(safeRecordId("a..b"), null);
    assert.equal(safeRecordId(".."), null);
    assert.equal(safeRecordId(".hidden"), null);
    assert.equal(safeRecordId("trailing."), null);
    assert.equal(safeRecordId("../etc"), null);
    assert.equal(safeRecordId("a/b"), null);
    assert.equal(safeRecordId("a\\b"), null);
  });

  it("rejects non-string and empty input", () => {
    assert.equal(safeRecordId(""), null);
    assert.equal(safeRecordId(null as unknown as string), null);
    assert.equal(safeRecordId(42 as unknown as string), null);
  });
});
