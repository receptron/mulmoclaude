import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import osModule from "node:os";
import path from "node:path";
import { replaceIfUnchanged } from "../../server/workspace/journal/replaceIfUnchanged.js";

describe("replaceIfUnchanged", () => {
  let dir = "";
  before(() => {
    dir = fsSync.mkdtempSync(path.join(osModule.tmpdir(), "replace-if-unchanged-"));
  });
  after(() => fsSync.rmSync(dir, { recursive: true, force: true }));

  it("replaces a file whose bytes are as expected", async () => {
    const filePath = path.join(dir, "same.md");
    fsSync.writeFileSync(filePath, "old");
    assert.equal(await replaceIfUnchanged(filePath, Buffer.from("old"), "new"), true);
    assert.equal(fsSync.readFileSync(filePath, "utf-8"), "new");
  });

  it("leaves a file alone when its text changed", async () => {
    const filePath = path.join(dir, "text.md");
    fsSync.writeFileSync(filePath, "changed");
    assert.equal(await replaceIfUnchanged(filePath, Buffer.from("old"), "new"), false);
    assert.equal(fsSync.readFileSync(filePath, "utf-8"), "changed");
  });

  it("leaves a file alone when the bytes differ but decode to the same text", async () => {
    const filePath = path.join(dir, "bytes.md");
    const replacementChar = Buffer.from([0xef, 0xbf, 0xbd]);
    const invalidByte = Buffer.from([0xff]);
    assert.equal(replacementChar.toString("utf-8"), invalidByte.toString("utf-8"));
    fsSync.writeFileSync(filePath, invalidByte);
    assert.equal(await replaceIfUnchanged(filePath, replacementChar, "new"), false);
    assert.ok(fsSync.readFileSync(filePath).equals(invalidByte));
  });

  it("reports a file that vanished as an error rather than creating it", async () => {
    await assert.rejects(replaceIfUnchanged(path.join(dir, "gone.md"), Buffer.from("x"), "new"), /ENOENT/);
    assert.equal(fsSync.existsSync(path.join(dir, "gone.md")), false);
  });
});
