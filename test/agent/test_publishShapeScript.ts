// The host side of `publishShapeScript`: the document it writes is the plugin's
// post plus the two server stamps mulmoserver's rules demand, the thumbnail
// lands under the owner's path the Storage rule scopes, and a session without
// Storage still posts (without a picture).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Firestore } from "firebase/firestore";
import { SHAPE_POST_KEYS, shapePostFrom } from "@mulmoclaude/shapescript-plugin";
import { galleryWriterFrom, postDocumentOf, shapeObjectPath } from "../../server/agent/mcp-tools/publishShapeScript.js";

const post = shapePostFrom({ uid: "u-alice", authorName: "Alice" }, { title: "Lamp", script: "cube", keywords: ["lamp"] });

describe("publishShapeScript host adapter", () => {
  it("writes the post plus server-stamped createdAt / updatedAt, and nothing else", () => {
    const document = postDocumentOf(post);
    assert.deepEqual(Object.keys(document), [...SHAPE_POST_KEYS, "createdAt", "updatedAt"]);
    // A FieldValue sentinel, not a client clock: the rules refuse `createdAt != request.time`.
    for (const key of ["createdAt", "updatedAt"]) {
      const value = document[key] as { _methodName?: string };
      assert.equal(typeof value, "object");
      assert.equal(value._methodName, "serverTimestamp");
    }
  });

  it("keeps a picture under the owner, where the Storage rule scopes writes", () => {
    assert.equal(shapeObjectPath("u-alice", "s-1", "o-1"), "shapes/u-alice/s-1/o-1");
  });

  it("offers a thumbnail upload only when the session has Storage", () => {
    const firestore = {} as Firestore;
    const without = galleryWriterFrom({ firestore, uid: "u-alice", authorName: "Alice" });
    assert.equal(without.uid, "u-alice");
    assert.equal(without.authorName, "Alice");
    assert.equal(without.uploadThumbnail, undefined);
  });
});
