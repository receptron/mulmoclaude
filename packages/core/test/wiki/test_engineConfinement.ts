// The wiki read engine lists and reads only what sits inside the workspace: a wiki folder, pages folder, index or
// log that links out reads as absent (#3573).

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectLintIssues, loadWikiGraph, readWikiIndex, readWikiLog, readWikiPage, resolvePagePath } from "../../src/wiki/server/engine.ts";
import { __resetPageIndexCache } from "../../src/wiki/server/pageIndex.ts";
import { isWithin } from "../../src/wiki/server/locations.ts";

const skipWithoutSymlinks = { skip: process.platform === "win32" ? "symlinks need POSIX" : false };
const OUTSIDE_PAGE = "OUTSIDE PAGE\n";
const NO_PAGES_ISSUE = "- Wiki `pages/` directory does not exist yet. Start ingesting sources.";

let base = "";
let workspace = "";
let wiki = "";
let outside = "";

beforeEach(() => {
  __resetPageIndexCache();
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "wiki-engine-confine-")));
  workspace = path.join(base, "ws");
  wiki = path.join(workspace, "data", "wiki");
  outside = path.join(base, "outside");
  mkdirSync(path.join(wiki, "pages"), { recursive: true });
  writeFileSync(path.join(wiki, "pages", "inside.md"), "inside\n");
  writeFileSync(path.join(wiki, "index.md"), "- [Inside](pages/inside.md)\n");
  writeFileSync(path.join(wiki, "log.md"), "inside log\n");
  mkdirSync(path.join(outside, "pages"), { recursive: true });
  writeFileSync(path.join(outside, "pages", "outside.md"), OUTSIDE_PAGE);
  writeFileSync(path.join(outside, "index.md"), "- [Outside](pages/outside.md)\n");
  writeFileSync(path.join(outside, "log.md"), "outside log\n");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const linkOut = (entry: string, target: string): void => {
  renameSync(entry, `${entry}.parked`);
  symlinkSync(target, entry);
};

async function assertNothingOutsideIsShown(): Promise<void> {
  assert.equal(await resolvePagePath(workspace, "outside"), null);
  assert.deepEqual(await readWikiPage(workspace, "outside"), { filePath: null, content: "", exists: false, resolvedTitle: "outside" });
  assert.deepEqual((await loadWikiGraph(workspace)).nodes, []);
  assert.deepEqual(await collectLintIssues(workspace), [NO_PAGES_ISSUE]);
}

describe("wiki read engine confinement", () => {
  it("reads a plain workspace", async () => {
    assert.equal((await readWikiPage(workspace, "inside")).content, "inside\n");
    assert.equal(readWikiLog(workspace), "inside log\n");
    assert.deepEqual(
      readWikiIndex(workspace).entries.map((entry) => entry.slug),
      ["inside"],
    );
  });

  it("keeps the caller's spelling of the path for a workspace reached by a link", skipWithoutSymlinks, async () => {
    const linkedRoot = path.join(base, "ws-link");
    symlinkSync(workspace, linkedRoot);
    assert.deepEqual(await readWikiPage(linkedRoot, "inside"), {
      filePath: path.join(linkedRoot, "data", "wiki", "pages", "inside.md"),
      content: "inside\n",
      exists: true,
      resolvedTitle: "inside",
    });
  });

  it("reads a wiki folder linked to a folder inside the workspace", skipWithoutSymlinks, async () => {
    const elsewhere = path.join(workspace, "wiki-elsewhere");
    renameSync(wiki, elsewhere);
    symlinkSync(elsewhere, wiki);
    assert.equal((await readWikiPage(workspace, "inside")).content, "inside\n");
    assert.equal(readWikiLog(workspace), "inside log\n");
  });

  it("reads a link inside the workspace whose spelling differs only in letter case", async (context) => {
    if (process.platform === "win32" || !existsSync(workspace.toUpperCase())) {
      context.skip("needs POSIX symlinks on a case-insensitive disk");
      return;
    }
    renameSync(path.join(wiki, "pages"), path.join(workspace, "elsewhere"));
    symlinkSync(path.join(base, "WS", "elsewhere"), path.join(wiki, "pages"));
    assert.equal((await readWikiPage(workspace, "inside")).content, "inside\n");
  });

  it("shows nothing from a wiki folder linked out", skipWithoutSymlinks, async () => {
    linkOut(wiki, outside);
    await assertNothingOutsideIsShown();
    assert.equal(readWikiLog(workspace), "");
    assert.deepEqual(readWikiIndex(workspace), { content: "", entries: [] });
  });

  it("shows nothing from a pages folder linked out", skipWithoutSymlinks, async () => {
    linkOut(path.join(wiki, "pages"), path.join(outside, "pages"));
    await assertNothingOutsideIsShown();
  });

  it("reads an index or log that links out as empty", skipWithoutSymlinks, async () => {
    linkOut(path.join(wiki, "index.md"), path.join(outside, "index.md"));
    linkOut(path.join(wiki, "log.md"), path.join(outside, "log.md"));
    assert.deepEqual(readWikiIndex(workspace), { content: "", entries: [] });
    assert.equal(readWikiLog(workspace), "");
  });
});

describe("isWithin", () => {
  const cases: [string, string, string, boolean][] = [
    ["the workspace itself", "/ws", "/ws", true],
    ["a path below it", "/ws", "/ws/data/wiki", true],
    ["a name that starts with two dots", "/ws", "/ws/..notes", true],
    ["a workspace at the filesystem root", "/", "/data/wiki/pages", true],
    ["a sibling sharing the prefix", "/ws", "/ws2/data", false],
    ["the parent", "/ws/a", "/ws", false],
    ["the filesystem root", "/ws", "/", false],
  ];
  cases.forEach(([label, root, candidate, expected]) => {
    it(`${expected ? "accepts" : "rejects"} ${label}`, { skip: process.platform === "win32" ? "POSIX paths" : false }, () => {
      assert.equal(isWithin(root, candidate), expected);
    });
  });
});
