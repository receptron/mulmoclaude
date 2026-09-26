import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferMimeFromExtension, knownAttachmentMimes, storedExtensionFor } from "../../../server/utils/files/attachment-mime.ts";

const OCTET = "application/octet-stream";

describe("storedExtensionFor — known MIME", () => {
  it("uses the MIME's extension and ignores the filename", () => {
    assert.equal(storedExtensionFor("application/pdf", "report.mpp"), ".pdf");
    assert.equal(storedExtensionFor("image/jpeg", "photo.png"), ".jpg");
    assert.equal(storedExtensionFor("text/csv", undefined), ".csv");
  });
});

describe("storedExtensionFor — unknown MIME keeps the original extension as a hint", () => {
  for (const [filename, expected] of [
    ["schedule.mpp", ".mpp.bin"],
    ["SCHEDULE.MPP", ".mpp.bin"],
    ["archive.tar.gz", ".gz.bin"],
    ["model.3dm", ".3dm.bin"],
    ["page.htm", ".htm.bin"],
    ["page.html", ".html.bin"],
    ["icon.svg", ".svg.bin"],
    ["script.js", ".js.bin"],
  ] as const) {
    it(`${filename} → ${expected}`, () => {
      assert.equal(storedExtensionFor(OCTET, filename), expected);
      assert.equal(storedExtensionFor("", filename), expected);
    });
  }
});

describe("storedExtensionFor — unknown MIME without a usable extension → .bin", () => {
  for (const filename of [undefined, "", "noext", ".hidden", "trailingdot.", "weird.m-p", "space.m p", "long.abcdefghijklmnopq", "dir/../x.m$p", "x.日本"]) {
    it(`filename ${JSON.stringify(filename)}`, () => {
      assert.equal(storedExtensionFor(OCTET, filename), ".bin");
    });
  }
});

describe("storedExtensionFor — an unknown MIME never lands on a type something dispatches on", () => {
  const filenames = ["a.mpp", "b.html", "c.htm", "d.svg", "e.pdf", "f.json", "g.js", "h.xhtml", "i.md", "j"];
  for (const filename of filenames) {
    it(filename, () => {
      const ext = storedExtensionFor(OCTET, filename);
      assert.ok(ext.endsWith(".bin"), ext);
      assert.equal(inferMimeFromExtension(`x${ext}`), undefined);
    });
  }
});

describe("knownAttachmentMimes", () => {
  it("every known MIME stores under a real extension, never .bin", () => {
    knownAttachmentMimes().forEach((mime) => assert.notEqual(storedExtensionFor(mime, "x.mpp"), ".bin", mime));
  });
});
