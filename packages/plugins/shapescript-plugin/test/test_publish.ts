// The `publishShapeScript` tool, against a fake gallery writer. What is pinned
// here is the CONTRACT with mulmoserver: the document's key set (its rules
// refuse any other), the keyword normalisation both sides share, that nothing
// is written when the host has no session, and that a refusal leaves no
// object behind.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileOps } from "gui-chat-protocol";
import {
  executePublishShapeScript,
  normalizeShapeKeywords,
  shapePostFrom,
  shapePostUrl,
  NOT_CONNECTED_MESSAGE,
  PUBLISH_SCHEMA,
  PUBLISH_TOOL_NAME,
  SHAPE_POST_KEYS,
  SHAPE_POST_LIMITS,
  type PublishShapeScriptContext,
  type ShapeGalleryWriter,
  type ShapePostDoc,
} from "../src/core/index";

const CUBE = "cube { size 1 }";

function memoryFiles(seed: Record<string, string> = {}): FileOps {
  const store = new Map(Object.entries(seed));
  const missing = (name: string) => (): never => {
    throw new Error(`FileOps.${name} is not part of this double`);
  };
  return {
    read: async (rel: string) => {
      const value = store.get(rel);
      if (value === undefined) throw new Error(`ENOENT: ${rel}`);
      return value;
    },
    write: async (rel: string, content: string | Uint8Array) => {
      store.set(rel, typeof content === "string" ? content : new TextDecoder().decode(content));
    },
    exists: async (rel: string) => store.has(rel),
    list: missing("list"),
    delete: missing("delete"),
    mkdir: missing("mkdir"),
    stat: missing("stat"),
  } as unknown as FileOps;
}

/** A writer that records what it was asked to do. `createPost` may be replaced
 *  to simulate a refused write. */
function fakeGallery(createPost?: ShapeGalleryWriter["createPost"], siteUrl?: string) {
  const posts = new Map<string, ShapePostDoc>();
  const uploads: Array<{ id: string; bytes: number }> = [];
  const deleted: Array<{ id: string; objectId: string }> = [];
  const writer: ShapeGalleryWriter = {
    uid: "u-alice",
    authorName: "Alice",
    ...(siteUrl === undefined ? {} : { siteUrl }),
    createPost:
      createPost ??
      (async (id, doc) => {
        posts.set(id, doc);
      }),
    uploadThumbnail: async (id, png) => {
      uploads.push({ id, bytes: png.byteLength });
      return `obj-${uploads.length}`;
    },
    deleteObject: async (id, objectId) => {
      deleted.push({ id, objectId });
    },
  };
  return { writer, posts, uploads, deleted };
}

const noThumbnail = async (): Promise<Uint8Array | null> => null;
const onePixel = async (): Promise<Uint8Array | null> => new Uint8Array([1, 2, 3]);

function contextFor(gallery: ShapeGalleryWriter | null, renderThumbnail = noThumbnail, files: FileOps = memoryFiles()): PublishShapeScriptContext {
  return { files: { artifacts: files }, gallery, renderThumbnail };
}

describe("publishShapeScript tool", () => {
  it("exposes its name and takes a title plus script XOR path", () => {
    assert.equal(PUBLISH_TOOL_NAME, "publishShapeScript");
    assert.deepEqual(Object.keys(PUBLISH_SCHEMA.properties), ["title", "script", "path", "description", "keywords", "prompt", "published"]);
    assert.deepEqual(PUBLISH_SCHEMA.required, ["title"]);
  });

  // mulmoserver's rules pin the key set with hasOnly: this list IS the contract.
  it("writes exactly the keys mulmoserver's rules accept, every one present", () => {
    const doc = shapePostFrom({ uid: "u", authorName: "A" }, { title: "Lamp", script: CUBE });
    assert.deepEqual(Object.keys(doc), [...SHAPE_POST_KEYS]);
    for (const [key, value] of Object.entries(doc)) assert.notEqual(value, undefined, `${key} must not be undefined`);
    assert.deepEqual(
      { ...doc },
      {
        uid: "u",
        authorName: "A",
        title: "Lamp",
        description: "",
        script: CUBE,
        source: "prompt",
        prompt: "",
        photoIds: [],
        thumbnailId: "",
        forkedFrom: null,
        keywords: [],
        published: true,
      },
    );
  });

  it("normalises keywords the way the gallery does, from a list or a comma string", () => {
    assert.deepEqual(normalizeShapeKeywords([" Lamp", "lamp", "DESK ", "", 42, "x".repeat(40)]), ["lamp", "desk", "x".repeat(SHAPE_POST_LIMITS.keywordMax)]);
    assert.deepEqual(normalizeShapeKeywords("lamp, Desk lamp ,, wood"), ["lamp", "desk lamp", "wood"]);
    assert.equal(normalizeShapeKeywords(Array.from({ length: 14 }, (_, i) => `k${i}`)).length, SHAPE_POST_LIMITS.keywordsMax);
    assert.deepEqual(normalizeShapeKeywords(undefined), []);
  });

  it("refuses what the rules would refuse, naming the field", () => {
    const writer = { uid: "u", authorName: "A" };
    assert.throws(() => shapePostFrom(writer, { title: "  ", script: CUBE }), /`title` is required/);
    assert.throws(() => shapePostFrom(writer, { title: "x".repeat(121), script: CUBE }), /`title` is too long/);
    assert.throws(() => shapePostFrom(writer, { title: "t", script: CUBE, description: "d".repeat(2001) }), /`description` is too long/);
    assert.equal(shapePostFrom({ uid: "u", authorName: "n".repeat(100) }, { title: "t", script: CUBE }).authorName.length, SHAPE_POST_LIMITS.authorNameMax);
  });

  it("posts nothing without a session, and says how to get one", async () => {
    await assert.rejects(executePublishShapeScript(contextFor(null), { title: "Lamp", script: CUBE }), new RegExp(NOT_CONNECTED_MESSAGE.slice(0, 30)));
  });

  it("publishes an inline script with its thumbnail and answers the model's URL", async () => {
    const { writer, posts, uploads } = fakeGallery();
    const result = await executePublishShapeScript(contextFor(writer, onePixel), {
      title: "Tiny Cube",
      script: CUBE,
      description: "A cube",
      keywords: ["Cube", "test"],
      prompt: "make a cube",
    });
    assert.equal(posts.size, 1);
    const [id, doc] = [...posts.entries()][0]!;
    assert.equal(result.id, id);
    assert.equal(result.url, shapePostUrl(id));
    assert.match(result.url, /^https:\/\/server\.mulmocast\.com\/shapes\/[0-9a-f-]{36}$/);
    assert.equal(result.thumbnail, true);
    assert.deepEqual(uploads, [{ id, bytes: 3 }]);
    assert.equal(doc.thumbnailId, "obj-1");
    assert.deepEqual(doc.keywords, ["cube", "test"]);
    assert.equal(doc.prompt, "make a cube");
    assert.equal(doc.published, true);
    assert.match(result.message, /^Published: "Tiny Cube" is at https:/);
    assert.doesNotMatch(result.message, /No thumbnail/);
  });

  it("publishes an existing artifact by path, as a draft, where no browser can render", async () => {
    const { writer, posts } = fakeGallery(undefined, "https://staging.example/");
    const artifacts = memoryFiles({ "shapes/lamp-1-aaaaaaaa.shape": CUBE });
    const result = await executePublishShapeScript(contextFor(writer, noThumbnail, artifacts), {
      title: "Lamp",
      path: "artifacts/shapes/lamp-1-aaaaaaaa.shape",
      published: false,
    });
    const doc = [...posts.values()][0]!;
    assert.equal(doc.script, CUBE);
    assert.equal(doc.published, false);
    assert.equal(result.thumbnail, false);
    assert.equal(result.url, `https://staging.example/shapes/${result.id}`);
    assert.match(result.message, /^Saved as a draft/);
    assert.match(result.message, /No thumbnail could be attached/);
  });

  it("posts without a picture when the thumbnail fails, and says so as a warning", async () => {
    const { writer, posts } = fakeGallery();
    const warnings: string[] = [];
    const failing = async (): Promise<Uint8Array | null> => {
      throw new Error("no GPU");
    };
    const result = await executePublishShapeScript({ ...contextFor(writer, failing), onWarning: (m) => warnings.push(m) }, { title: "Lamp", script: CUBE });
    assert.equal(posts.size, 1);
    assert.equal(result.thumbnail, false);
    assert.deepEqual(warnings, ["thumbnail skipped: no GPU"]);
  });

  it("refuses a script that will not build, or a post over a limit, before anything is uploaded or written", async () => {
    const { writer, posts, uploads } = fakeGallery();
    const context = contextFor(writer, onePixel);
    await assert.rejects(executePublishShapeScript(context, { title: "Bad", script: "loft { square }" }), /cross-sections/);
    await assert.rejects(executePublishShapeScript(context, { title: "x".repeat(121), script: CUBE }), /`title` is too long/);
    await assert.rejects(executePublishShapeScript(context, { script: CUBE }), /`title` is required/);
    await assert.rejects(executePublishShapeScript(context, { title: "t", script: CUBE, path: "artifacts/shapes/x.shape" }), /not both/);
    assert.equal(posts.size, 0);
    assert.deepEqual(uploads, []);
  });

  it("takes the thumbnail back out when the post itself is refused", async () => {
    const { writer, uploads, deleted } = fakeGallery(async () => {
      throw new Error("permission-denied");
    });
    await assert.rejects(executePublishShapeScript(contextFor(writer, onePixel), { title: "Lamp", script: CUBE }), /permission-denied/);
    assert.equal(uploads.length, 1);
    assert.deepEqual(deleted, [{ id: uploads[0]!.id, objectId: "obj-1" }]);
  });
});
