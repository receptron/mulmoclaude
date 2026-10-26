// Route-level checks for the canvas image persistence path.
//
// Covers:
//   - POST /api/canvas        → pre-allocates a PNG file and bakes its
//     workspace-relative path into `data.imageData` on the tool result.
//   - PUT  /api/images/update → overwrites that pre-allocated file
//     with new PNG bytes (the canvas's autosave path). The route now
//     takes the workspace-relative path in the body rather than
//     reconstructing it from a `:filename` URL param — required after
//     #764 sharded `images/` by YYYY/MM.
//
// We drive the handlers with plain Request / Response mocks so we
// don't pay for an Express + supertest harness — matching the pattern
// in `test_filesPutRoute.ts`. HOME is redirected to a tmp dir BEFORE
// the route modules are imported so `workspacePath` resolves inside
// the sandbox; files created during the tests are cleaned up in
// `after()`.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, promises } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Request, Response } from "express";
import { isolateHome } from "../helpers/isolatedHome.js";

type PluginsModule = typeof import("../../server/api/routes/plugins.js");
type ImageModule = typeof import("../../server/api/routes/image.js");

type Handler = (req: Request, res: Response) => Promise<void> | void;

interface StackFrame {
  route?: {
    path: string;
    stack: { method: string; handle: Handler }[];
  };
}
interface RouterInternals {
  stack: StackFrame[];
}

function extractRouteHandler(mod: { default: unknown }, routePath: string, method: string): Handler {
  const router = mod.default as unknown as RouterInternals;
  for (const frame of router.stack) {
    if (frame.route?.path !== routePath) continue;
    const layer = frame.route.stack.find((stackLayer) => stackLayer.method === method);
    if (layer) return layer.handle;
  }
  throw new Error(`route ${method.toUpperCase()} ${routePath} not registered`);
}

interface OpenCanvasBody {
  message?: string;
  instructions?: string;
  title?: string;
  data?: { imageData: string; prompt: string };
}

interface PutOkBody {
  path: string;
}

interface ErrorBody {
  error?: string;
  message?: string;
}

type ResBody = OpenCanvasBody | PutOkBody | ErrorBody;

function mockRes() {
  const state: { status: number; body: ResBody | undefined } = {
    status: 200,
    body: undefined,
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: ResBody) {
      state.body = payload;
      return res;
    },
  };
  return { state, res: res as unknown as Response };
}

// Smallest valid PNG — 1×1, opaque red. Distinct from the route's
// placeholder (1×1 transparent) so we can verify the PUT actually
// overwrote the placeholder bytes.
const TEST_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

let tmpRoot: string;
let workspaceDir: string;
let imagesDir: string;
let restoreHome: () => void = () => {};
let canvasHandler: Handler;
let putImageHandler: Handler;
// Paths created by `executeOpenCanvas` during the tests. Recorded per
// `before`/`it` and removed in `after` so the tests leave no residue.
const createdImagePaths: string[] = [];

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-canvas-image-routes-"));
  restoreHome = isolateHome(tmpRoot);

  const { workspacePath: workspacePth } = await import("../../server/workspace/workspace.js");
  const { WORKSPACE_DIRS } = await import("../../server/workspace/paths.js");
  workspaceDir = workspacePth;
  imagesDir = path.join(workspaceDir, WORKSPACE_DIRS.images);
  mkdirSync(imagesDir, { recursive: true });

  const pluginsMod: PluginsModule = await import("../../server/api/routes/plugins.js");
  const imageMod: ImageModule = await import("../../server/api/routes/image.js");
  canvasHandler = extractRouteHandler(pluginsMod, "/api/canvas", "post");
  putImageHandler = extractRouteHandler(imageMod, "/api/images/update", "put");
});

after(async () => {
  // Delete every image file the tests allocated. The tmp root gets
  // rm'd below anyway, but explicit per-file cleanup matches the
  // spirit of the task ("make sure the test code deletes the created
  // image at the end") and surfaces any path mismatch early.
  for (const relPath of createdImagePaths) {
    await rm(path.join(workspaceDir, relPath), { force: true });
  }

  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

function req(body: unknown, params: Record<string, string> = {}): Request {
  return { body, params } as unknown as Request;
}

describe("POST /api/canvas — pre-allocate image file", () => {
  it("creates a PNG on disk and returns its workspace-relative path in data.imageData", async () => {
    const { state, res } = mockRes();
    await canvasHandler(req({}), res);

    assert.equal(state.status, 200);
    const body = state.body as OpenCanvasBody;
    assert.ok(body.data, "response should have data");
    assert.equal(typeof body.data.imageData, "string");
    assert.equal(body.data.prompt, "");
    assert.match(body.data.imageData, /^artifacts\/images\/\d{4}\/\d{2}\/[0-9a-f]+\.png$/, "expected an artifacts/images/YYYY/MM/*.png path (#764)");

    // File exists and is non-empty (placeholder PNG).
    const absPath = path.join(workspaceDir, body.data.imageData);
    const stat = await promises.stat(absPath);
    assert.ok(stat.isFile(), "allocated path should be a regular file");
    assert.ok(stat.size > 0, "placeholder PNG should have bytes");

    // Also surfaces the human-readable fields from executeOpenCanvas.
    assert.equal(body.title, "Drawing Canvas");
    assert.equal(typeof body.message, "string");
    // message must surface the same imagePath the route allocated, so the
    // LLM can reference the file when reading it back later.
    assert.ok(body.message?.includes(body.data.imageData), `message should embed the allocated imagePath; got: ${body.message}`);
    // instructions must read as pre-draw — the canvas was just shown, the
    // user has not drawn yet. Guards against reverting to past-tense wording.
    assert.match(body.instructions ?? "", /about to draw/i, `instructions should be pre-draw tense; got: ${body.instructions}`);

    createdImagePaths.push(body.data.imageData);
  });

  it("allocates a distinct file on each call (no filename collisions)", async () => {
    const firstCall = mockRes();
    await canvasHandler(req({}), firstCall.res);
    const secondCall = mockRes();
    await canvasHandler(req({}), secondCall.res);

    const firstBody = firstCall.state.body as OpenCanvasBody | undefined;
    const secondBody = secondCall.state.body as OpenCanvasBody | undefined;
    assert.ok(firstBody?.data);
    assert.ok(secondBody?.data);
    const firstPath = firstBody.data.imageData;
    const secondPath = secondBody.data.imageData;
    assert.notEqual(firstPath, secondPath, "two consecutive opens must not share a filename");

    createdImagePaths.push(firstPath, secondPath);
  });
});

describe("PUT /api/images/update — overwrite pre-allocated file", () => {
  it("overwrites the pre-allocated PNG with the new data-URI bytes", async () => {
    // Allocate a canvas image the same way the client would.
    const { state: openState, res: openRes } = mockRes();
    await canvasHandler(req({}), openRes);
    const openBody = openState.body as OpenCanvasBody | undefined;
    assert.ok(openBody?.data);
    const relPath = openBody.data.imageData;
    createdImagePaths.push(relPath);

    const absPath = path.join(workspaceDir, relPath);
    const originalBytes = await readFile(absPath);

    // Overwrite with a distinct 1×1 red PNG.
    const { state, res } = mockRes();
    await putImageHandler(req({ relativePath: relPath, imageData: `data:image/png;base64,${TEST_PNG_BASE64}` }), res);

    assert.equal(state.status, 200);
    const body = state.body as PutOkBody;
    assert.equal(body.path, relPath, "PUT should echo back the same relative path");

    const updatedBytes = await readFile(absPath);
    assert.notDeepEqual(updatedBytes, originalBytes, "bytes on disk should have changed");
    assert.deepEqual(updatedBytes, Buffer.from(TEST_PNG_BASE64, "base64"), "bytes on disk should equal the posted PNG");
  });

  it("accepts raw base64 without a data-URI prefix (stripDataUri is a no-op)", async () => {
    const { state: openState, res: openRes } = mockRes();
    await canvasHandler(req({}), openRes);
    const openBody = openState.body as OpenCanvasBody | undefined;
    assert.ok(openBody?.data);
    const relPath = openBody.data.imageData;
    createdImagePaths.push(relPath);

    const { state, res } = mockRes();
    await putImageHandler(req({ relativePath: relPath, imageData: TEST_PNG_BASE64 }), res);

    assert.equal(state.status, 200);
    const updatedBytes = await readFile(path.join(workspaceDir, relPath));
    assert.deepEqual(updatedBytes, Buffer.from(TEST_PNG_BASE64, "base64"));
  });

  it("rejects a request with no imageData body field", async () => {
    const { state, res } = mockRes();
    await putImageHandler(req({ relativePath: "artifacts/images/2026/04/whatever.png" }), res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error ?? "", /imagedata/i);
  });

  it("rejects a relativePath that doesn't satisfy isImagePath", async () => {
    const { state, res } = mockRes();
    // Wrong prefix — not under artifacts/images/.
    await putImageHandler(req({ relativePath: "artifacts/notes/foo.png", imageData: `data:image/png;base64,${TEST_PNG_BASE64}` }), res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error ?? "", /invalid image relativepath/i);
  });

  it("rejects a missing relativePath", async () => {
    const { state, res } = mockRes();
    await putImageHandler(req({ imageData: `data:image/png;base64,${TEST_PNG_BASE64}` }), res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error ?? "", /invalid image relativepath/i);
  });

  it("creates the file when the target partition does not exist yet", async () => {
    // overwriteImage uses the write-time confinement helper: it
    // mkdir-p's the parent inside the images root and realpath-checks
    // that parent (not the leaf). A target whose partition was never
    // allocated still writes correctly inside root.
    const { state, res } = mockRes();
    await putImageHandler(req({ relativePath: "artifacts/images/2026/04/does-not-exist.png", imageData: `data:image/png;base64,${TEST_PNG_BASE64}` }), res);
    assert.equal(state.status, 200);
  });
});
