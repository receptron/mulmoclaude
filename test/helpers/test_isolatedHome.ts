// `isolateHome` must clear an inherited MULMOCLAUDE_WORKSPACE_PATH, so workspacePath lands under the temp HOME, and
// must put every variable back as it found it, set or unset.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolateHome } from "./isolatedHome.js";

const VARIABLES = ["HOME", "USERPROFILE", "MULMOCLAUDE_WORKSPACE_PATH"] as const;
const before = VARIABLES.map((name) => [name, process.env[name]] as const);
const tmpRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "isolated-home-")));
const configured = realpathSync(mkdtempSync(path.join(tmpdir(), "configured-workspace-")));

after(() => {
  before.forEach(([name, value]) => {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  });
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(configured, { recursive: true, force: true });
});

describe("isolateHome", () => {
  it("resolves workspacePath under the temp HOME despite an inherited workspace variable", async () => {
    process.env.MULMOCLAUDE_WORKSPACE_PATH = configured;
    const restore = isolateHome(tmpRoot);
    const { workspacePath } = await import("../../server/workspace/paths.js");
    restore();
    assert.ok(workspacePath.startsWith(tmpRoot + path.sep), workspacePath);
  });

  it("restores a set variable and removes one that was unset", () => {
    process.env.MULMOCLAUDE_WORKSPACE_PATH = configured;
    process.env.HOME = "/home/before";
    Reflect.deleteProperty(process.env, "USERPROFILE");
    const restore = isolateHome(tmpRoot);
    assert.deepEqual([process.env.HOME, process.env.USERPROFILE, process.env.MULMOCLAUDE_WORKSPACE_PATH], [tmpRoot, tmpRoot, undefined]);
    restore();
    assert.deepEqual([process.env.HOME, process.env.USERPROFILE, process.env.MULMOCLAUDE_WORKSPACE_PATH], ["/home/before", undefined, configured]);
  });
});
