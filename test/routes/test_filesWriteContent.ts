// `writeFileContent` is PUT /api/files/content's write, run after the path check. A folder swapped for
// a link out between the check and the write must not be written through (#3573). HOME is redirected
// BEFORE the route module is imported: the workspace path is fixed at module load.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type RouteModule = typeof import("../../server/api/routes/files.js");

let tmpRoot: string;
let workspaceDir: string;
let outsideDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let routeMod: RouteModule;

before(async () => {
  tmpRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "mulmo-files-write-content-")));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  const { workspacePath } = await import("../../server/workspace/workspace.js");
  workspaceDir = workspacePath;
  mkdirSync(workspaceDir, { recursive: true });
  outsideDir = path.join(tmpRoot, "outside");
  mkdirSync(outsideDir, { recursive: true });
  routeMod = await import("../../server/api/routes/files.js");
});

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(tmpRoot, { recursive: true, force: true });
});

// files.ts captured the workspace realpath at load, so the folder itself stays.
beforeEach(async () => {
  for (const entry of [...readdirSync(workspaceDir), ...readdirSync(outsideDir).map((name) => path.join("..", "outside", name))]) {
    await rm(path.join(workspaceDir, entry), { recursive: true, force: true });
  }
  mkdirSync(path.join(workspaceDir, "d"));
  await writeFile(path.join(workspaceDir, "d", "f.txt"), "inside");
  await writeFile(path.join(outsideDir, "f.txt"), "outside");
});

const checkedPath = (): string => path.join(realpathSync(workspaceDir), "d", "f.txt");

describe("writeFileContent", () => {
  it("replaces the file's content", async () => {
    await routeMod.writeFileContent(checkedPath(), "saved");
    assert.equal(readFileSync(path.join(workspaceDir, "d", "f.txt"), "utf8"), "saved");
  });

  it("leaves no staging file behind", async () => {
    await routeMod.writeFileContent(checkedPath(), "saved");
    assert.deepEqual(readdirSync(path.join(workspaceDir, "d")), ["f.txt"]);
  });

  it(
    "does not write through a folder replaced by a link out after the check",
    { skip: process.platform === "win32" ? "symlinks need POSIX" : false },
    async () => {
      const target = checkedPath();
      renameSync(path.join(workspaceDir, "d"), path.join(workspaceDir, "d.parked"));
      symlinkSync(outsideDir, path.join(workspaceDir, "d"));
      await assert.rejects(routeMod.writeFileContent(target, "saved"));
      assert.equal(readFileSync(path.join(outsideDir, "f.txt"), "utf8"), "outside");
      assert.deepEqual(readdirSync(outsideDir), ["f.txt"]);
    },
  );
});
