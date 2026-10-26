import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { isolateHome } from "../../helpers/isolatedHome.js";

// workspace-io imports workspacePath at module load. We override
// HOME/USERPROFILE so homedir() → our temp root, then dynamic-
// import so the module picks up the overridden HOME.
let tmpRoot: string;
let restoreHome: () => void = () => {};

type WsIo = typeof import("../../../server/utils/files/workspace-io.js");
let mod: WsIo;

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "ws-io-test-"));
  restoreHome = isolateHome(tmpRoot);
  // Pre-create the workspace root that paths.ts expects.
  mkdirSync(path.join(tmpRoot, "mulmoclaude"), { recursive: true });
  mod = await import("../../../server/utils/files/workspace-io.js");
});

after(() => {
  restoreHome();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function wsRoot(): string {
  return path.join(tmpRoot, "mulmoclaude");
}

describe("resolveWorkspacePath", () => {
  it("joins the workspace root with the relative path", () => {
    const abs = mod.resolveWorkspacePath("data/wiki/index.md");
    assert.equal(abs, path.join(wsRoot(), "data", "wiki", "index.md"));
  });

  it("handles an empty string (returns workspace root)", () => {
    assert.equal(mod.resolveWorkspacePath(""), wsRoot());
  });
});

describe("readWorkspaceText / writeWorkspaceText", () => {
  it("round-trips a text file", async () => {
    await mod.writeWorkspaceText("test-rw/hello.txt", "world");
    const content = await mod.readWorkspaceText("test-rw/hello.txt");
    assert.equal(content, "world");
  });

  it("returns null for a missing file", async () => {
    assert.equal(await mod.readWorkspaceText("missing/file.txt"), null);
  });

  it("write is atomic — no .tmp leftover on success", async () => {
    await mod.writeWorkspaceText("test-atomic/clean.txt", "ok");
    const entries = readdirSync(path.join(wsRoot(), "test-atomic"));
    assert.equal(entries.filter((file) => file.endsWith(".tmp")).length, 0);
  });

  it("creates parent directories on write", async () => {
    await mod.writeWorkspaceText("deep/nested/dir/file.md", "content");
    assert.equal(readFileSync(path.join(wsRoot(), "deep", "nested", "dir", "file.md"), "utf-8"), "content");
  });
});

describe("readWorkspaceTextSync / writeWorkspaceTextSync", () => {
  it("round-trips synchronously", () => {
    mod.writeWorkspaceTextSync("test-sync/file.txt", "sync-data");
    assert.equal(mod.readWorkspaceTextSync("test-sync/file.txt"), "sync-data");
  });

  it("returns null for missing file", () => {
    assert.equal(mod.readWorkspaceTextSync("not-here.txt"), null);
  });
});

describe("readWorkspaceJson / writeWorkspaceJson", () => {
  it("round-trips a JSON value", async () => {
    await mod.writeWorkspaceJson("test-json/data.json", { a: 1, b: [2, 3] });
    const data = await mod.readWorkspaceJson("test-json/data.json", null);
    assert.deepEqual(data, { a: 1, b: [2, 3] });
  });

  it("returns fallback for missing file", async () => {
    const data = await mod.readWorkspaceJson("nope.json", { fallback: true });
    assert.deepEqual(data, { fallback: true });
  });

  it("returns fallback for malformed JSON", async () => {
    await mod.writeWorkspaceText("test-json/bad.json", "{broken");
    const data = await mod.readWorkspaceJson("test-json/bad.json", []);
    assert.deepEqual(data, []);
  });
});

describe("readWorkspaceJsonSync", () => {
  it("returns parsed JSON", () => {
    mod.writeWorkspaceTextSync("test-json-sync/ok.json", '{"x":42}');
    assert.deepEqual(mod.readWorkspaceJsonSync("test-json-sync/ok.json", {}), {
      x: 42,
    });
  });

  it("returns fallback on missing file", () => {
    assert.deepEqual(mod.readWorkspaceJsonSync("gone.json", { y: 0 }), {
      y: 0,
    });
  });
});

describe("existsInWorkspace", () => {
  it("returns true for an existing file", async () => {
    await mod.writeWorkspaceText("test-exists/yes.txt", "here");
    assert.equal(mod.existsInWorkspace("test-exists/yes.txt"), true);
  });

  it("returns false for a non-existent path", () => {
    assert.equal(mod.existsInWorkspace("test-exists/no.txt"), false);
  });
});

describe("ensureWorkspaceDir", () => {
  it("creates a nested directory", () => {
    mod.ensureWorkspaceDir("test-ensure/a/b/c");
    const abs = path.join(wsRoot(), "test-ensure", "a", "b", "c");
    assert.ok(statSync(abs).isDirectory());
  });

  it("is idempotent", () => {
    mod.ensureWorkspaceDir("test-ensure/idem");
    mod.ensureWorkspaceDir("test-ensure/idem");
    const abs = path.join(wsRoot(), "test-ensure", "idem");
    assert.ok(statSync(abs).isDirectory());
  });
});
