import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createFileVerifiedInScope,
  openVerifiedWithinScope,
  resolveExistingWithinRoot,
  writeFileVerifiedInScope,
  type VerifiedFileHooks,
  type VerifiedScope,
} from "../../src/files/verified.js";

// `anchor` is the trusted root (the workspace); the scope is `anchor/root`. `outside` sits in the anchor
// but outside the scope, `far` outside the anchor. A race is simulated by swapping paths at a hook.
let anchor = "";
let root = "";
let outside = "";
let far = "";
let dir = "";
const scope = (): VerifiedScope => ({ trustedReal: anchor, scopeWithinTrusted: "root" });

const swapOut = async (): Promise<void> => {
  renameSync(dir, `${dir}-real`);
  symlinkSync(outside, dir);
};
const swapBack = async (): Promise<void> => {
  unlinkSync(dir);
  renameSync(`${dir}-real`, dir);
};
const linkScopeFar = async (): Promise<void> => {
  renameSync(root, `${root}-original`);
  symlinkSync(far, root);
};

const readThrough = async (relative: string, hooks: VerifiedFileHooks = {}): Promise<string | null> => {
  const handle = await openVerifiedWithinScope(scope(), relative, hooks);
  if (handle === null) return null;
  try {
    return (await handle.readFile()).toString("utf-8");
  } finally {
    await handle.close();
  }
};

describe("verified file access", () => {
  beforeEach(() => {
    // `.native` matches the async `realpath` the code compares against; plain `realpathSync` keeps Windows 8.3 names (RUNNER~1).
    anchor = realpathSync.native(mkdtempSync(path.join(tmpdir(), "verified-anchor-")));
    far = realpathSync.native(mkdtempSync(path.join(tmpdir(), "verified-far-")));
    root = path.join(anchor, "root");
    outside = path.join(anchor, "outside");
    dir = path.join(root, "dir");
    mkdirSync(dir, { recursive: true });
    mkdirSync(outside);
    mkdirSync(path.join(far, "dir"));
    writeFileSync(path.join(dir, "in.json"), "inside");
    writeFileSync(path.join(outside, "in.json"), "secret");
    writeFileSync(path.join(far, "dir", "in.json"), "far-secret");
  });
  afterEach(() => {
    rmSync(`${anchor}-moved`, { recursive: true, force: true });
    rmSync(anchor, { recursive: true, force: true });
    rmSync(far, { recursive: true, force: true });
  });

  it("reads an in-scope file through the verified handle", async () => {
    assert.equal(await readThrough("dir/in.json"), "inside");
  });

  it("refuses a handle opened while a parent was swapped out, even if it is swapped back before the check", async () => {
    assert.equal(await readThrough("dir/in.json", { beforeOpen: swapOut, afterOpen: swapBack }), null);
  });

  // Windows refuses to rename a directory holding an open file (EPERM), so this swap cannot happen there.
  it("refuses when the parent is swapped out after the open and left there", { skip: process.platform === "win32" }, async () => {
    assert.equal(await readThrough("dir/in.json", { afterOpen: swapOut }), null);
  });

  it("reports a missing or outside path as null", async () => {
    assert.equal(await readThrough("dir/none.json"), null);
    assert.equal(await readThrough("../outside/in.json"), null);
    symlinkSync(outside, path.join(root, "link"));
    assert.equal(await resolveExistingWithinRoot(root, "link/in.json"), null);
  });

  it("refuses a scope that is already a link out of the anchor when the call begins", async () => {
    await linkScopeFar();
    assert.equal(await readThrough("dir/in.json"), null);
    await assert.rejects(writeFileVerifiedInScope(scope(), path.join(root, "dir"), "in.json", "planted"), /left the scope/);
    assert.equal(readFileSync(path.join(far, "dir", "in.json"), "utf8"), "far-secret");
  });

  it("refuses when the scope is swapped for a link out of the anchor mid-call", async () => {
    assert.equal(await readThrough("dir/in.json", { beforeOpen: linkScopeFar }), null);
    assert.equal(readFileSync(path.join(far, "dir", "in.json"), "utf8"), "far-secret");
  });

  it("refuses when the anchor itself is replaced mid-call", async () => {
    const replaceAnchor = async (): Promise<void> => {
      renameSync(anchor, `${anchor}-moved`);
      mkdirSync(path.join(anchor, "root", "dir"), { recursive: true });
      writeFileSync(path.join(anchor, "root", "dir", "in.json"), "impostor");
    };
    assert.equal(await readThrough("dir/in.json", { beforeOpen: replaceAnchor }), null);
  });

  // Deliberate: a real directory renamed into the scope's place from inside the anchor IS the scope from
  // then on — the same as moving it there before the request. Only a way OUT of the anchor is refused.
  it("treats a real directory moved into the scope's place from inside the anchor as the scope", async () => {
    const moveInFromAnchor = async (): Promise<void> => {
      renameSync(root, `${root}-original`);
      mkdirSync(path.join(outside, "dir"));
      writeFileSync(path.join(outside, "dir", "in.json"), "moved-in");
      renameSync(outside, root);
    };
    assert.equal(await readThrough("dir/in.json", { beforeOpen: moveInFromAnchor }), "moved-in");
  });

  it("writes atomically into a verified directory", async () => {
    await writeFileVerifiedInScope(scope(), dir, "new.json", "written");
    assert.equal(readFileSync(path.join(dir, "new.json"), "utf8"), "written");
    assert.deepEqual(readdirSync(dir).sort(), ["in.json", "new.json"]);
  });

  it("writes nothing outside when the parent is swapped before the staging file is created", async () => {
    await assert.rejects(writeFileVerifiedInScope(scope(), dir, "in.json", "planted", { beforeOpen: swapOut, afterOpen: swapBack }), /left the scope/);
    assert.equal(readFileSync(path.join(outside, "in.json"), "utf8"), "secret");
    assert.equal(readFileSync(path.join(dir, "in.json"), "utf8"), "inside");
    readdirSync(outside).forEach((name) => assert.notEqual(readFileSync(path.join(outside, name), "utf8"), "planted"));
  });

  it("writes nothing outside when the scope is swapped for a link out of the anchor before the staging file", async () => {
    await assert.rejects(writeFileVerifiedInScope(scope(), dir, "in.json", "planted", { beforeOpen: linkScopeFar }), /left the scope/);
    assert.equal(readFileSync(path.join(far, "dir", "in.json"), "utf8"), "far-secret");
    readdirSync(path.join(far, "dir")).forEach((name) => assert.notEqual(readFileSync(path.join(far, "dir", name), "utf8"), "planted"));
  });

  it("fails rather than renaming outside when the parent is swapped after verification", async () => {
    await assert.rejects(writeFileVerifiedInScope(scope(), dir, "in.json", "planted", { beforeRename: swapOut }));
    assert.equal(readFileSync(path.join(outside, "in.json"), "utf8"), "secret");
    assert.deepEqual(readdirSync(outside), ["in.json"]);
  });

  it("refuses a leaf that is not a single file name, before touching the disk", async () => {
    for (const leaf of ["", ".", "..", "../escape.json", "sub/x.json", `..${path.sep}x.json`]) {
      await assert.rejects(createFileVerifiedInScope(scope(), dir, leaf, "planted"), /not a single file name/, leaf);
      await assert.rejects(writeFileVerifiedInScope(scope(), dir, leaf, "planted"), /not a single file name/, leaf);
    }
    assert.deepEqual(readdirSync(root).sort(), ["dir"]);
    assert.deepEqual(readdirSync(dir), ["in.json"]);
  });

  it("creates a new file exclusively in a verified directory", async () => {
    await createFileVerifiedInScope(scope(), dir, "new.json", "created");
    assert.equal(readFileSync(path.join(dir, "new.json"), "utf8"), "created");
    assert.deepEqual(readdirSync(dir).sort(), ["in.json", "new.json"]);
  });

  it("refuses to create over an existing file with EEXIST, leaving it as it was", async () => {
    await assert.rejects(createFileVerifiedInScope(scope(), dir, "in.json", "planted"), { code: "EEXIST" });
    assert.equal(readFileSync(path.join(dir, "in.json"), "utf8"), "inside");
  });

  it("creates nothing outside with content when the parent is swapped before the create", async () => {
    await assert.rejects(createFileVerifiedInScope(scope(), dir, "new.json", "planted", { beforeOpen: swapOut, afterOpen: swapBack }), /left the scope/);
    assert.equal(readFileSync(path.join(outside, "in.json"), "utf8"), "secret");
    assert.deepEqual(readdirSync(dir), ["in.json"]);
    readdirSync(outside).forEach((name) => assert.notEqual(readFileSync(path.join(outside, name), "utf8"), "planted"));
  });

  it("creates nothing with content when the parent is swapped out and left there", { skip: process.platform === "win32" }, async () => {
    await assert.rejects(createFileVerifiedInScope(scope(), dir, "new.json", "planted", { beforeOpen: swapOut }), /left the scope/);
    readdirSync(outside).forEach((name) => assert.notEqual(readFileSync(path.join(outside, name), "utf8"), "planted"));
  });

  it("creates nothing with content when the scope is swapped for a link out of the anchor before the create", async () => {
    await assert.rejects(createFileVerifiedInScope(scope(), dir, "new.json", "planted", { beforeOpen: linkScopeFar }), /left the scope/);
    readdirSync(path.join(far, "dir")).forEach((name) => assert.notEqual(readFileSync(path.join(far, "dir", name), "utf8"), "planted"));
  });

  it("lands in the verified directory itself when it is moved after verification and a link to it put in its place", async () => {
    const moveAndLinkBack = async (): Promise<void> => {
      renameSync(dir, `${dir}-moved`);
      symlinkSync(`${dir}-moved`, dir);
    };
    await writeFileVerifiedInScope(scope(), dir, "new.json", "written", { beforeRename: moveAndLinkBack });
    assert.equal(readFileSync(path.join(`${dir}-moved`, "new.json"), "utf8"), "written");
    assert.deepEqual(readdirSync(outside), ["in.json"]);
  });
});
