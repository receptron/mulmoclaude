// The shared containment checks accept a target truly inside the root even when the two realpaths were taken with
// different letter case, or the root is a filesystem root, and still refuse anything outside.

import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isWithinRoot, respelledWithinRoot } from "../../src/files/containment.ts";
import { resolveWithinRoot } from "../../src/files/safe.ts";
import { openVerifiedWithinScope, resolveExistingWithinRoot } from "../../src/files/verified.ts";

const POSIX_ONLY = process.platform === "win32" ? "symlinks need POSIX" : false;

interface Fixture {
  base: string;
  root: string;
  outside: string;
}

function makeFixture(context: TestContext): Fixture {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "containment-")));
  const root = path.join(base, "Work");
  const outside = path.join(base, "Out");
  mkdirSync(path.join(root, "dir"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, "dir", "a.md"), "inside\n");
  writeFileSync(path.join(outside, "s.md"), "outside\n");
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, outside };
}

const caseInsensitiveDisk = (probe: string): boolean => existsSync(probe.toLowerCase()) && existsSync(probe.toUpperCase());

describe("resolveWithinRoot", () => {
  it("resolves a link inside the root whose text spells the root with different case", { skip: POSIX_ONLY }, (context) => {
    const { base, root } = makeFixture(context);
    if (!caseInsensitiveDisk(root)) {
      context.skip("needs a case-insensitive disk");
      return;
    }
    symlinkSync(path.join(base, "work", "dir"), path.join(root, "linked"));
    assert.equal(resolveWithinRoot(root, "linked/a.md"), path.join(root, "dir", "a.md"));
  });

  it("still refuses a link out, spelled with different case where the disk allows it", { skip: POSIX_ONLY }, (context) => {
    const { base, root, outside } = makeFixture(context);
    symlinkSync(caseInsensitiveDisk(root) ? path.join(base, "out") : outside, path.join(root, "linkOut"));
    assert.equal(resolveWithinRoot(root, "linkOut/s.md"), null);
  });

  it("accepts anything under a filesystem root", { skip: POSIX_ONLY }, (context) => {
    const { root } = makeFixture(context);
    assert.equal(resolveWithinRoot("/", path.relative("/", path.join(root, "dir", "a.md"))), path.join(root, "dir", "a.md"));
  });
});

describe("verified containment with a root spelled in different case", () => {
  it("opens a file inside the root", async (context) => {
    const { base, root } = makeFixture(context);
    if (!caseInsensitiveDisk(root)) {
      context.skip("needs a case-insensitive disk");
      return;
    }
    const rootSpelledLower = realpathSync(path.join(base, "work"));
    assert.equal(await resolveExistingWithinRoot(rootSpelledLower, "dir/a.md"), path.join(root, "dir", "a.md"));
    const handle = await openVerifiedWithinScope({ trustedReal: rootSpelledLower, scopeWithinTrusted: "" }, "dir/a.md");
    assert.ok(handle !== null);
    assert.equal(await handle.readFile("utf-8"), "inside\n");
    await handle.close();
  });

  it("refuses a link out", { skip: POSIX_ONLY }, async (context) => {
    const { base, root, outside } = makeFixture(context);
    symlinkSync(outside, path.join(root, "linkOut"));
    const rootSpelledLower = caseInsensitiveDisk(root) ? realpathSync(path.join(base, "work")) : root;
    assert.equal(await resolveExistingWithinRoot(rootSpelledLower, "linkOut/s.md"), null);
    assert.equal(await openVerifiedWithinScope({ trustedReal: rootSpelledLower, scopeWithinTrusted: "" }, "linkOut/s.md"), null);
  });
});

describe("respelledWithinRoot", () => {
  it("re-spells an inside target under the caller's root", (context) => {
    const { root } = makeFixture(context);
    assert.equal(respelledWithinRoot(root, path.join(root, "dir", "a.md")), path.join(root, "dir", "a.md"));
  });

  it("returns null for an outside target or a missing path", (context) => {
    const { root, outside } = makeFixture(context);
    assert.equal(respelledWithinRoot(root, path.join(outside, "s.md")), null);
    assert.equal(respelledWithinRoot(root, path.join(root, "missing.md")), null);
  });
});

// Every caller hands isWithinRoot normalized paths (path.resolve / path.join / a realpath). Over those, it must agree with
// path.relative's verdict for a candidate spelled in the root's case; path.win32.relative folds case, and this must not.
const SEGMENTS = ["a", "b", "A", "ab", "..", ".", ""];

function normalizedCandidates(flavour: typeof path.posix, anchor: string): string[] {
  return SEGMENTS.flatMap((first) => SEGMENTS.flatMap((second) => SEGMENTS.map((third) => flavour.resolve(anchor, first, second, third))));
}

function relativeVerdict(flavour: typeof path.posix, root: string, candidate: string): boolean {
  const rel = flavour.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !flavour.isAbsolute(rel));
}

describe("isWithinRoot over normalized paths", () => {
  const flavours: [string, typeof path.posix, string, string[]][] = [
    ["posix", path.posix, "/", ["/", "/a", "/a/b", "/ab"]],
    ["win32", path.win32, "C:\\", ["C:\\", "C:\\a", "C:\\a\\b", "C:\\ab"]],
  ];
  flavours.forEach(([name, flavour, anchor, roots]) => {
    it(`agrees with ${name} path.relative for every pair spelled in the root's case`, () => {
      roots.forEach((root) => {
        normalizedCandidates(flavour, anchor).forEach((candidate) => {
          const spelledLikeRoot = candidate.slice(0, root.length) === root;
          const expected = spelledLikeRoot && relativeVerdict(flavour, root, candidate);
          assert.equal(isWithinRoot(root, candidate, flavour.sep), expected, `root=${root} candidate=${candidate}`);
        });
      });
    });
  });

  it("does not take a sibling sharing the root's prefix as inside", () => {
    assert.equal(isWithinRoot("/a", "/ab"), false);
    assert.equal(isWithinRoot("C:\\a", "C:\\ab", "\\"), false);
  });
});
