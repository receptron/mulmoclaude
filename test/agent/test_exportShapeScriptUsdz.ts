// The host side of `exportShapeScriptUsdz`: the artifacts FileOps adapter must
// refuse to read or write THROUGH a symlink that leaves the artifacts root —
// `artifacts/shapes -> /outside` is the case codex raised on #3065. The plugin
// rejects `..` lexically; this is the realpath layer beneath it.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeArtifactsShapeFiles } from "../../server/agent/mcp-tools/exportShapeScriptUsdz.js";

const CUBE = "cube { size 1 }";

describe("exportShapeScriptUsdz artifacts adapter", () => {
  let tmp: string;
  let artifacts: string;
  let outside: string;

  before(async () => {
    tmp = await realpath(await mkdtemp(path.join(tmpdir(), "mulmo-usdz-")));
    artifacts = path.join(tmp, "workspace", "artifacts");
    outside = path.join(tmp, "outside");
    await mkdir(path.join(artifacts, "shapes"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(artifacts, "shapes", "lamp.shape"), CUBE);
    await writeFile(path.join(outside, "secret.shape"), "sphere");
    // A symlinked DIRECTORY inside artifacts, pointing out of it.
    await symlink(outside, path.join(artifacts, "escape"));
    // A symlinked FILE inside artifacts, pointing out of it.
    await symlink(path.join(outside, "secret.shape"), path.join(artifacts, "shapes", "link.shape"));
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads and writes ordinary paths under the root", async () => {
    const files = makeArtifactsShapeFiles(() => artifacts);
    assert.equal(await files.read("shapes/lamp.shape"), CUBE);
    assert.equal(await files.exists("shapes/lamp.shape"), true);
    assert.equal(await files.exists("shapes/missing.shape"), false);
    await files.write("shapes/lamp.usdz", new Uint8Array([1, 2, 3]));
    assert.deepEqual([...(await readFile(path.join(artifacts, "shapes", "lamp.usdz")))], [1, 2, 3]);
  });

  it("refuses to read through a symlink that leaves the root", async () => {
    const files = makeArtifactsShapeFiles(() => artifacts);
    await assert.rejects(files.read("escape/secret.shape"), /No ShapeScript exists/);
    await assert.rejects(files.read("shapes/link.shape"), /No ShapeScript exists/);
    assert.equal(await files.exists("escape/secret.shape"), false);
    assert.equal(await files.exists("shapes/link.shape"), false);
  });

  it("refuses to write through a symlinked directory that leaves the root", async () => {
    const files = makeArtifactsShapeFiles(() => artifacts);
    await assert.rejects(files.write("escape/out.usdz", new Uint8Array([1])), /escapes artifacts/);
    await assert.rejects(files.write("../out.usdz", new Uint8Array([1])), /escapes artifacts/);
    await assert.rejects(readFile(path.join(outside, "out.usdz")), /ENOENT/);
  });

  it("creates the root on a fresh workspace instead of failing the first export", async () => {
    const fresh = path.join(tmp, "fresh", "artifacts");
    const files = makeArtifactsShapeFiles(() => fresh);
    assert.equal(await files.exists("shapes/none.shape"), false);
    await files.write("shapes/first.usdz", new Uint8Array([7]));
    assert.deepEqual([...(await readFile(path.join(fresh, "shapes", "first.usdz")))], [7]);
  });
});
