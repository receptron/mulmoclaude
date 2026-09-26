import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isReadableAttachmentType, READABLE_MIMES } from "../../../src/utils/attachment/readableTypes.ts";
import { knownAttachmentMimes } from "../../../server/utils/files/attachment-mime.ts";

describe("isReadableAttachmentType", () => {
  it("matches the server's stored MIME table exactly (chip never disagrees with what the model gets)", () => {
    assert.deepEqual([...READABLE_MIMES].sort(), knownAttachmentMimes().sort());
  });

  for (const mime of knownAttachmentMimes()) {
    it(`reads ${mime}`, () => assert.equal(isReadableAttachmentType(mime), true));
  }

  for (const mime of [
    "",
    "application/octet-stream",
    "application/zip",
    "application/vnd.ms-project",
    "image/x-icon",
    "text/x-python",
    "text/javascript",
    "video/mp4",
    "IMAGE/PNG",
  ]) {
    it(`file only: ${JSON.stringify(mime)}`, () => assert.equal(isReadableAttachmentType(mime), false));
  }
});
