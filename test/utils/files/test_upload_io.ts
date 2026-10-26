// `writeNewFileExclusive` is the exclusive create behind POST /api/files/create and /api/files/upload, run after
// the path check. It must never replace a file, and must not write through a folder swapped for a link out between
// the check and the create (#3573).

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeNewFileExclusive } from "../../../server/utils/files/upload-io.js";

let base = "";
let workspace = "";
let outside = "";

beforeEach(() => {
  // `.native` matches the async realpath the verified create compares against (Windows 8.3 names).
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "upload-io-")));
  workspace = path.join(base, "ws");
  outside = path.join(base, "outside");
  mkdirSync(path.join(workspace, "d"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(workspace, "d", "taken.txt"), "inside");
  writeFileSync(path.join(outside, "keep.txt"), "outside");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("writeNewFileExclusive", () => {
  it("creates the file, and its missing parent folders", async () => {
    await writeNewFileExclusive(workspace, path.join(workspace, "d", "new", "deeper", "f.txt"), "made");
    assert.equal(readFileSync(path.join(workspace, "d", "new", "deeper", "f.txt"), "utf8"), "made");
  });

  it("writes bytes as given", async () => {
    await writeNewFileExclusive(workspace, path.join(workspace, "d", "bytes.bin"), Buffer.from([0, 255, 1]));
    assert.deepEqual([...readFileSync(path.join(workspace, "d", "bytes.bin"))], [0, 255, 1]);
  });

  it("refuses an existing file with EEXIST and leaves it as it was", async () => {
    await assert.rejects(writeNewFileExclusive(workspace, path.join(workspace, "d", "taken.txt"), "planted"), { code: "EEXIST" });
    assert.equal(readFileSync(path.join(workspace, "d", "taken.txt"), "utf8"), "inside");
  });

  it(
    "does not write through a folder replaced by a link out after the check",
    { skip: process.platform === "win32" ? "symlinks need POSIX" : false },
    async () => {
      const checked = path.join(workspace, "d", "f.txt");
      renameSync(path.join(workspace, "d"), path.join(workspace, "d.parked"));
      symlinkSync(outside, path.join(workspace, "d"));
      await assert.rejects(writeNewFileExclusive(workspace, checked, "planted"));
      readdirSync(outside).forEach((name) => assert.notEqual(readFileSync(path.join(outside, name), "utf8"), "planted"));
    },
  );
});
