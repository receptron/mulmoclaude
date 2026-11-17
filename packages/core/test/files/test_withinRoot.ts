// Sync containment and whole-file reads: only a regular file that leads inside the root, checked after the open.

import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isWithinRoot, realpathSyncOrNull } from "../../src/files/containment.ts";
import { readTextWithinRoot, readTextWithinRootSync } from "../../src/files/withinRoot.ts";

const POSIX_ONLY = process.platform === "win32" ? "symlinks and FIFOs need POSIX" : false;

interface Fixture {
  rootReal: string;
  folder: string;
  outside: string;
}

function makeFixture(context: TestContext): Fixture {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "within-root-")));
  const rootReal = path.join(base, "root");
  const folder = path.join(rootReal, "folder");
  const outside = path.join(base, "outside");
  mkdirSync(folder, { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(folder, "note.md"), "inside\n");
  writeFileSync(path.join(outside, "note.md"), "OUTSIDE\n");
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return { rootReal, folder, outside };
}

describe("readTextWithinRoot / readTextWithinRootSync", () => {
  it("read a regular file inside the root", async (context) => {
    const { rootReal, folder } = makeFixture(context);
    assert.equal(readTextWithinRootSync(rootReal, path.join(folder, "note.md")), "inside\n");
    assert.equal(await readTextWithinRoot(rootReal, path.join(folder, "note.md")), "inside\n");
  });

  it("read a missing file or a folder as null", async (context) => {
    const { rootReal, folder } = makeFixture(context);
    assert.equal(readTextWithinRootSync(rootReal, path.join(folder, "missing.md")), null);
    assert.equal(readTextWithinRootSync(rootReal, folder), null);
    assert.equal(await readTextWithinRoot(rootReal, folder), null);
  });

  it("read a file whose link leads out as null", { skip: POSIX_ONLY }, async (context) => {
    const { rootReal, folder, outside } = makeFixture(context);
    symlinkSync(path.join(outside, "note.md"), path.join(folder, "linked.md"));
    assert.equal(readTextWithinRootSync(rootReal, path.join(folder, "linked.md")), null);
    assert.equal(await readTextWithinRoot(rootReal, path.join(folder, "linked.md")), null);
  });

  it("refuse a folder swapped for a link out after the caller resolved it", { skip: POSIX_ONLY }, async (context) => {
    const { rootReal, folder, outside } = makeFixture(context);
    const resolvedPath = path.join(folder, "note.md");
    renameSync(folder, `${folder}.parked`);
    symlinkSync(outside, folder);
    assert.equal(readTextWithinRootSync(rootReal, resolvedPath), null);
    assert.equal(await readTextWithinRoot(rootReal, resolvedPath), null);
  });

  it("read a FIFO as null instead of blocking", { skip: POSIX_ONLY }, async (context) => {
    const { rootReal, folder } = makeFixture(context);
    execFileSync("mkfifo", [path.join(folder, "pipe.md")]);
    assert.equal(readTextWithinRootSync(rootReal, path.join(folder, "pipe.md")), null);
    assert.equal(await readTextWithinRoot(rootReal, path.join(folder, "pipe.md")), null);
  });
});

describe("realpathSyncOrNull", () => {
  it("returns null for a missing path", (context) => {
    const { rootReal } = makeFixture(context);
    assert.equal(realpathSyncOrNull(path.join(rootReal, "missing")), null);
  });
});

describe("isWithinRoot", () => {
  const cases: [string, string, string, boolean][] = [
    ["the root itself", "/ws", "/ws", true],
    ["a path below it", "/ws", "/ws/data/wiki", true],
    ["a name that starts with two dots", "/ws", "/ws/..notes", true],
    ["a root at the filesystem root", "/", "/data/wiki/pages", true],
    ["a sibling sharing the prefix", "/ws", "/ws2/data", false],
    ["the parent", "/ws/a", "/ws", false],
    ["the filesystem root", "/ws", "/", false],
    ["a folder whose name differs only in letter case", "/ws", "/WS/data", false],
    ["a root given with a trailing separator", "/ws/", "/ws/data", true],
  ];
  cases.forEach(([label, root, candidate, expected]) => {
    it(`${expected ? "accepts" : "rejects"} ${label}`, { skip: process.platform === "win32" ? "POSIX paths" : false }, () => {
      assert.equal(isWithinRoot(root, candidate), expected);
    });
  });
});
