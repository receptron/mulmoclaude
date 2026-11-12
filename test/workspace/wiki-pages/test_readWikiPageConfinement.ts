// A wiki page is read only when it is a file inside the workspace: a page, pages folder or wiki folder that links
// out reads as missing, so neither its body nor its frontmatter reaches the page, its history, or a caller (#3573).

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readWikiPage, writeWikiPage } from "../../../server/workspace/wiki-pages/io.js";

const skipWithoutSymlinks = { skip: process.platform === "win32" ? "symlinks need POSIX" : false };
const INSIDE = "---\ncreated: '2020-01-01'\n---\n# inside\n";
const OUTSIDE = "---\nsecret: outside\n---\n# outside\n";

let base = "";
let workspace = "";
let wiki = "";
let pages = "";
let outside = "";

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "wiki-read-")));
  workspace = path.join(base, "ws");
  wiki = path.join(workspace, "data", "wiki");
  pages = path.join(wiki, "pages");
  outside = path.join(base, "outside");
  mkdirSync(pages, { recursive: true });
  mkdirSync(path.join(outside, "pages"), { recursive: true });
  writeFileSync(path.join(pages, "page.md"), INSIDE);
  writeFileSync(path.join(outside, "page.md"), OUTSIDE);
  writeFileSync(path.join(outside, "pages", "page.md"), OUTSIDE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const read = (root = workspace): Promise<string | null> => readWikiPage("page", { workspaceRoot: root });

const linkOut = (folder: string, target: string): void => {
  renameSync(folder, `${folder}.parked`);
  symlinkSync(target, folder);
};

describe("readWikiPage confinement", () => {
  it("reads a page in a plain workspace", async () => {
    assert.equal(await read(), INSIDE);
  });

  it("reads a missing page as null", async () => {
    rmSync(path.join(pages, "page.md"));
    assert.equal(await read(), null);
  });

  it("reads a page that is a folder as null", async () => {
    rmSync(path.join(pages, "page.md"));
    mkdirSync(path.join(pages, "page.md"));
    assert.equal(await read(), null);
  });

  it("reads through a workspace reached by a link", skipWithoutSymlinks, async () => {
    const linkedRoot = path.join(base, "ws-link");
    symlinkSync(workspace, linkedRoot);
    assert.equal(await read(linkedRoot), INSIDE);
  });

  it("reads a page linked to a file inside the workspace", skipWithoutSymlinks, async () => {
    const target = path.join(workspace, "target.md");
    renameSync(path.join(pages, "page.md"), target);
    symlinkSync(target, path.join(pages, "page.md"));
    assert.equal(await read(), INSIDE);
  });

  it("reads a page that links out as null", skipWithoutSymlinks, async () => {
    linkOut(path.join(pages, "page.md"), path.join(outside, "page.md"));
    assert.equal(await read(), null);
  });

  it("reads a page under a pages folder linked out as null", skipWithoutSymlinks, async () => {
    linkOut(pages, path.join(outside, "pages"));
    assert.equal(await read(), null);
  });

  it("reads a page under a wiki folder linked out as null", skipWithoutSymlinks, async () => {
    linkOut(wiki, outside);
    assert.equal(await read(), null);
  });

  it("keeps the frontmatter of a page that links out out of the saved page", skipWithoutSymlinks, async () => {
    linkOut(path.join(pages, "page.md"), path.join(outside, "page.md"));
    await writeWikiPage("page", "# saved\n", { editor: "user" }, { workspaceRoot: workspace });
    assert.doesNotMatch(readFileSync(path.join(pages, "page.md"), "utf8"), /secret/);
    assert.equal(readFileSync(path.join(outside, "page.md"), "utf8"), OUTSIDE);
  });
});
