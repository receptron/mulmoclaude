// An overwrite through `writeWikiPage` must not write through a wiki folder that leads out of the workspace,
// whether it was a link from the start or swapped for one after the path was built (#3573).

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeWikiPage } from "../../../server/workspace/wiki-pages/io.js";

const skipWithoutSymlinks = { skip: process.platform === "win32" ? "symlinks need POSIX" : false };

let base = "";
let workspace = "";
let wiki = "";
let pages = "";
let outside = "";

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "wiki-overwrite-")));
  workspace = path.join(base, "ws");
  wiki = path.join(workspace, "data", "wiki");
  pages = path.join(wiki, "pages");
  outside = path.join(base, "outside");
  mkdirSync(pages, { recursive: true });
  mkdirSync(path.join(outside, "pages"), { recursive: true });
  writeFileSync(path.join(pages, "page.md"), "# inside\n");
  writeFileSync(path.join(outside, "page.md"), "# outside\n");
  writeFileSync(path.join(outside, "pages", "page.md"), "# outside\n");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const save = (slug: string, root = workspace): Promise<void> => writeWikiPage(slug, "# saved\n", { editor: "user" }, { workspaceRoot: root });

const outsideFiles = (): string[] =>
  readdirSync(outside, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), "utf8"));

const assertOutsideUntouched = (): void => outsideFiles().forEach((content) => assert.equal(content, "# outside\n"));

describe("writeWikiPage overwrite", () => {
  it("overwrites an existing page in place", async () => {
    await save("page");
    assert.match(readFileSync(path.join(pages, "page.md"), "utf8"), /\n---\n\n# saved\n$/);
    assert.deepEqual(readdirSync(pages), ["page.md"]);
  });

  it("creates the pages folder when it is missing", async () => {
    rmSync(pages, { recursive: true });
    await save("fresh");
    assert.match(readFileSync(path.join(pages, "fresh.md"), "utf8"), /# saved\n$/);
  });

  it("writes through a workspace reached by a link", skipWithoutSymlinks, async () => {
    const linkedRoot = path.join(base, "ws-link");
    symlinkSync(workspace, linkedRoot);
    await save("page", linkedRoot);
    assert.match(readFileSync(path.join(pages, "page.md"), "utf8"), /# saved\n$/);
  });

  it("writes through a pages folder linked to a folder inside the workspace", skipWithoutSymlinks, async () => {
    const elsewhere = path.join(workspace, "elsewhere");
    renameSync(pages, elsewhere);
    symlinkSync(elsewhere, pages);
    await save("page");
    assert.match(readFileSync(path.join(elsewhere, "page.md"), "utf8"), /# saved\n$/);
  });

  it("refuses a pages folder replaced by a link out", skipWithoutSymlinks, async () => {
    renameSync(pages, `${pages}.parked`);
    symlinkSync(outside, pages);
    await assert.rejects(save("page"));
    assertOutsideUntouched();
    assert.deepEqual(readdirSync(outside).sort(), ["page.md", "pages"]);
  });

  it("refuses a wiki folder replaced by a link out", skipWithoutSymlinks, async () => {
    renameSync(wiki, `${wiki}.parked`);
    symlinkSync(outside, wiki);
    await assert.rejects(save("page"));
    assertOutsideUntouched();
    assert.deepEqual(readdirSync(path.join(outside, "pages")), ["page.md"]);
  });

  it("creates no folder outside when the wiki folder links out to a place without pages/", skipWithoutSymlinks, async () => {
    const bare = path.join(base, "bare");
    mkdirSync(bare);
    renameSync(wiki, `${wiki}.parked`);
    symlinkSync(bare, wiki);
    await assert.rejects(save("page"));
    await assert.rejects(writeWikiPage("fresh", "# saved\n", { editor: "user" }, { workspaceRoot: workspace, exclusive: true }));
    assert.deepEqual(readdirSync(bare), []);
  });

  it("refuses a page that is itself a link out, leaving the target as it was", skipWithoutSymlinks, async () => {
    rmSync(path.join(pages, "page.md"));
    symlinkSync(path.join(outside, "page.md"), path.join(pages, "page.md"));
    await save("page");
    assertOutsideUntouched();
    assert.match(readFileSync(path.join(pages, "page.md"), "utf8"), /# saved\n$/);
  });
});
