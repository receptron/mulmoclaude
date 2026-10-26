// Integration test for `listMarpThemes` (#1649). Sandboxes HOME so
// the module's cached `workspacePath` resolves under a tmp dir,
// matching `test_filesCreateRoute.ts`'s pattern.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { isolateHome } from "../helpers/isolatedHome.js";

type WorkspaceModule = typeof import("../../server/workspace/workspace.js");
type PathsModule = typeof import("../../server/workspace/paths.js");
type ThemesModule = typeof import("../../server/workspace/marp-themes.js");

let tmpRoot: string;
let workspaceDir: string;
let themesDir: string;
let restoreHome: () => void = () => {};
let listMarpThemes: ThemesModule["listMarpThemes"];

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-marp-themes-"));
  restoreHome = isolateHome(tmpRoot);
  const workspaceMod = (await import("../../server/workspace/workspace.js")) as WorkspaceModule;
  workspaceDir = workspaceMod.workspacePath;
  const pathsMod = (await import("../../server/workspace/paths.js")) as PathsModule;
  themesDir = path.join(workspaceDir, pathsMod.WORKSPACE_DIRS.marpThemes);
  mkdirSync(workspaceDir, { recursive: true });
  ({ listMarpThemes } = (await import("../../server/workspace/marp-themes.js")) as ThemesModule);
});

after(async () => {
  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(themesDir, { recursive: true, force: true });
});

describe("listMarpThemes", () => {
  it("returns an empty list when the dir does not exist", () => {
    const out = listMarpThemes();
    assert.deepEqual(out, []);
  });

  it("returns an empty list when the dir is empty", () => {
    mkdirSync(themesDir, { recursive: true });
    const out = listMarpThemes();
    assert.deepEqual(out, []);
  });

  it("loads a valid theme, stamping the @theme directive with the filename slug", async () => {
    mkdirSync(themesDir, { recursive: true });
    await writeFile(path.join(themesDir, "corporate.css"), "section { background: navy; }", "utf-8");
    const out = listMarpThemes();
    assert.equal(out.length, 1);
    const [theme] = out;
    assert.ok(theme);
    assert.equal(theme.name, "corporate");
    assert.match(theme.css, /^\/\* @theme corporate \*\//);
    assert.match(theme.css, /section \{ background: navy; \}/);
  });

  it("ignores files whose name does not pass the slug validator", async () => {
    mkdirSync(themesDir, { recursive: true });
    await writeFile(path.join(themesDir, "with space.css"), "section {}", "utf-8");
    await writeFile(path.join(themesDir, "good.css"), "section {}", "utf-8");
    const out = listMarpThemes();
    assert.deepEqual(
      out.map((entry) => entry.name),
      ["good"],
    );
  });

  it("rejects a theme containing @import url(http...) (security gate)", async () => {
    mkdirSync(themesDir, { recursive: true });
    await writeFile(path.join(themesDir, "ok.css"), "section { color: white; }", "utf-8");
    await writeFile(path.join(themesDir, "bad.css"), '@import url("http://attacker.example/track.css");', "utf-8");
    const out = listMarpThemes();
    assert.deepEqual(
      out.map((entry) => entry.name),
      ["ok"],
    );
  });

  it("skips an empty file", async () => {
    mkdirSync(themesDir, { recursive: true });
    await writeFile(path.join(themesDir, "empty.css"), "", "utf-8");
    const out = listMarpThemes();
    assert.deepEqual(out, []);
  });

  it("ignores non-.css files in the same dir", async () => {
    mkdirSync(themesDir, { recursive: true });
    await writeFile(path.join(themesDir, "readme.md"), "# Marp themes", "utf-8");
    await writeFile(path.join(themesDir, "good.css"), "section {}", "utf-8");
    const out = listMarpThemes();
    assert.deepEqual(
      out.map((entry) => entry.name),
      ["good"],
    );
  });
});
