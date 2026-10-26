// The create-only mode of `writeWikiPage` (POST /api/files/create on a wiki page) must refuse an existing page and
// must not write through a pages folder swapped for a link out after the path check (#3573).

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeWikiPage } from "../../../server/workspace/wiki-pages/io.js";

let base = "";
let workspace = "";
let pages = "";
let outside = "";

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "wiki-exclusive-")));
  workspace = path.join(base, "ws");
  pages = path.join(workspace, "data", "wiki", "pages");
  outside = path.join(base, "outside");
  mkdirSync(pages, { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(pages, "taken.md"), "# taken\n");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const create = (slug: string): Promise<void> => writeWikiPage(slug, "# body\n", { editor: "user" }, { workspaceRoot: workspace, exclusive: true });

describe("writeWikiPage exclusive", () => {
  it("creates a new page with its frontmatter", async () => {
    await create("fresh");
    assert.match(readFileSync(path.join(pages, "fresh.md"), "utf8"), /^---\n[\s\S]*editor: user[\s\S]*\n---\n\n# body\n$/);
  });

  it("refuses an existing page with EEXIST and leaves it as it was", async () => {
    await assert.rejects(create("taken"), { code: "EEXIST" });
    assert.equal(readFileSync(path.join(pages, "taken.md"), "utf8"), "# taken\n");
  });

  it("does not write through a pages folder replaced by a link out", { skip: process.platform === "win32" ? "symlinks need POSIX" : false }, async () => {
    renameSync(pages, `${pages}.parked`);
    symlinkSync(outside, pages);
    await assert.rejects(create("fresh"));
    readdirSync(outside).forEach((name) => assert.doesNotMatch(readFileSync(path.join(outside, name), "utf8"), /# body/));
  });
});
