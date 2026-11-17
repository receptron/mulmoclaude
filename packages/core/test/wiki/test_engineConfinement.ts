// The wiki read engine lists and reads only regular files inside the workspace; anything leading out reads as absent.

import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectLintIssues, loadWikiGraph, readWikiIndex, readWikiLog, readWikiPage, resolvePagePath } from "../../src/wiki/server/engine.ts";
import { __resetPageIndexCache } from "../../src/wiki/server/pageIndex.ts";
import { isWithin, readTextSafe, readTextSafeSync } from "../../src/wiki/server/fs.ts";

const POSIX_ONLY = process.platform === "win32" ? "symlinks and FIFOs need POSIX" : false;
const OUTSIDE_PAGE = "OUTSIDE PAGE\n";
// A fixed mtime set before the page index is built and again after the swap, so the index stays cached.
const PINNED_MTIME = new Date(Date.UTC(2020, 0, 1));
const NO_PAGES_ISSUE = "- Wiki `pages/` directory does not exist yet. Start ingesting sources.";

interface Fixture {
  base: string;
  workspace: string;
  wiki: string;
  pages: string;
  outside: string;
}

function makeFixture(context: TestContext): Fixture {
  __resetPageIndexCache();
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "wiki-engine-confine-")));
  const workspace = path.join(base, "ws");
  const wiki = path.join(workspace, "data", "wiki");
  const pages = path.join(wiki, "pages");
  const outside = path.join(base, "outside");
  mkdirSync(pages, { recursive: true });
  writeFileSync(path.join(pages, "inside.md"), "inside\n");
  writeFileSync(path.join(wiki, "index.md"), "- [Inside](pages/inside.md)\n");
  writeFileSync(path.join(wiki, "log.md"), "inside log\n");
  mkdirSync(path.join(outside, "pages"), { recursive: true });
  writeFileSync(path.join(outside, "pages", "outside.md"), OUTSIDE_PAGE);
  writeFileSync(path.join(outside, "index.md"), "- [Outside](pages/outside.md)\n");
  writeFileSync(path.join(outside, "log.md"), "outside log\n");
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, workspace, wiki, pages, outside };
}

const linkTo = (entry: string, target: string): void => {
  renameSync(entry, `${entry}.parked`);
  symlinkSync(target, entry);
};

async function assertNothingOutsideIsShown(workspace: string): Promise<void> {
  assert.equal(await resolvePagePath(workspace, "outside"), null);
  assert.deepEqual(await readWikiPage(workspace, "outside"), { filePath: null, content: "", exists: false, resolvedTitle: "outside" });
  assert.deepEqual((await loadWikiGraph(workspace)).nodes, []);
  assert.deepEqual(await collectLintIssues(workspace), [NO_PAGES_ISSUE]);
}

describe("wiki read engine confinement", () => {
  it("reads a plain workspace", async (context) => {
    const { workspace } = makeFixture(context);
    assert.equal((await readWikiPage(workspace, "inside")).content, "inside\n");
    assert.equal(readWikiLog(workspace), "inside log\n");
    assert.deepEqual(
      readWikiIndex(workspace).entries.map((entry) => entry.slug),
      ["inside"],
    );
  });

  it("keeps the caller's spelling of the path for a workspace reached by a link", { skip: POSIX_ONLY }, async (context) => {
    const { base, workspace } = makeFixture(context);
    const linkedRoot = path.join(base, "ws-link");
    symlinkSync(workspace, linkedRoot);
    assert.deepEqual(await readWikiPage(linkedRoot, "inside"), {
      filePath: path.join(linkedRoot, "data", "wiki", "pages", "inside.md"),
      content: "inside\n",
      exists: true,
      resolvedTitle: "inside",
    });
  });

  it("reads a wiki folder linked to a folder inside the workspace", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, wiki } = makeFixture(context);
    const elsewhere = path.join(workspace, "wiki-elsewhere");
    renameSync(wiki, elsewhere);
    symlinkSync(elsewhere, wiki);
    assert.equal((await readWikiPage(workspace, "inside")).content, "inside\n");
    assert.equal(readWikiLog(workspace), "inside log\n");
  });

  it("reads an index and log linked to files inside the workspace", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, wiki } = makeFixture(context);
    renameSync(path.join(wiki, "index.md"), path.join(workspace, "index-elsewhere.md"));
    renameSync(path.join(wiki, "log.md"), path.join(workspace, "log-elsewhere.md"));
    symlinkSync(path.join(workspace, "index-elsewhere.md"), path.join(wiki, "index.md"));
    symlinkSync(path.join(workspace, "log-elsewhere.md"), path.join(wiki, "log.md"));
    assert.deepEqual(
      readWikiIndex(workspace).entries.map((entry) => entry.slug),
      ["inside"],
    );
    assert.equal(readWikiLog(workspace), "inside log\n");
  });

  it("reads a link inside the workspace whose spelling differs only in letter case", async (context) => {
    const { base, workspace, pages } = makeFixture(context);
    if (process.platform === "win32" || !existsSync(workspace.toUpperCase())) {
      context.skip("needs POSIX symlinks on a case-insensitive disk");
      return;
    }
    renameSync(pages, path.join(workspace, "elsewhere"));
    symlinkSync(path.join(base, "WS", "elsewhere"), pages);
    assert.equal((await readWikiPage(workspace, "inside")).content, "inside\n");
  });

  it("shows nothing from a wiki folder linked out", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, wiki, outside } = makeFixture(context);
    linkTo(wiki, outside);
    await assertNothingOutsideIsShown(workspace);
    assert.equal(readWikiLog(workspace), "");
    assert.deepEqual(readWikiIndex(workspace), { content: "", entries: [] });
  });

  it("shows nothing from a pages folder linked out", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, pages, outside } = makeFixture(context);
    linkTo(pages, path.join(outside, "pages"));
    await assertNothingOutsideIsShown(workspace);
  });

  it("reads an index or log that links out as empty", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, wiki, outside } = makeFixture(context);
    linkTo(path.join(wiki, "index.md"), path.join(outside, "index.md"));
    linkTo(path.join(wiki, "log.md"), path.join(outside, "log.md"));
    assert.deepEqual(readWikiIndex(workspace), { content: "", entries: [] });
    assert.equal(readWikiLog(workspace), "");
  });

  it("does not follow a page swapped for a link out while the page index is cached", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, pages, outside } = makeFixture(context);
    utimesSync(pages, PINNED_MTIME, PINNED_MTIME);
    assert.equal((await readWikiPage(workspace, "inside")).content, "inside\n");
    rmSync(path.join(pages, "inside.md"));
    symlinkSync(path.join(outside, "pages", "outside.md"), path.join(pages, "inside.md"));
    utimesSync(pages, PINNED_MTIME, PINNED_MTIME);
    assert.deepEqual(await readWikiPage(workspace, "inside"), {
      filePath: path.join(pages, "inside.md"),
      content: "",
      exists: true,
      resolvedTitle: "inside",
    });
  });

  it("reads an index or log that is a FIFO as empty instead of blocking", { skip: POSIX_ONLY }, (context) => {
    const { workspace, wiki } = makeFixture(context);
    rmSync(path.join(wiki, "index.md"));
    rmSync(path.join(wiki, "log.md"));
    execFileSync("mkfifo", [path.join(wiki, "index.md"), path.join(wiki, "log.md")]);
    assert.deepEqual(readWikiIndex(workspace), { content: "", entries: [] });
    assert.equal(readWikiLog(workspace), "");
  });
});

describe("wiki file reads after the caller's check", () => {
  it("refuse a pages folder swapped for a link out after its location was resolved", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, pages, outside } = makeFixture(context);
    const workspaceReal = realpathSync.native(workspace);
    const pageInResolvedFolder = path.join(realpathSync.native(pages), "outside.md");
    linkTo(pages, path.join(outside, "pages"));
    assert.equal(readTextSafeSync(pageInResolvedFolder, workspaceReal), null);
    assert.equal(await readTextSafe(pageInResolvedFolder, workspaceReal), null);
  });

  it("read a regular file inside the workspace", (context) => {
    const { workspace, pages } = makeFixture(context);
    assert.equal(readTextSafeSync(path.join(pages, "inside.md"), realpathSync.native(workspace)), "inside\n");
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
