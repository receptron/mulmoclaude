// Validation-level tests for POST /api/edit-image (the editImages
// plugin's HTTP back-end). Confirms the route is fully stateless and
// rejects malformed payloads with 400 — no Gemini call, no session
// lookup, no disk read. Happy-path Gemini integration is exercised
// manually / in e2e since it requires real API credentials.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Request, Response } from "express";
import { isolateHome } from "../helpers/isolatedHome.js";

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

interface ErrorBody {
  success?: false;
  message?: string;
}

function mockRes() {
  const state: { status: number; body: ErrorBody | undefined } = {
    status: 200,
    body: undefined,
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: ErrorBody) {
      state.body = payload;
      return res;
    },
  };
  return { state, res: res as unknown as Response };
}

function req(body: unknown): Request {
  return { body, params: {}, query: {} } as unknown as Request;
}

let tmpRoot: string;
let restoreHome: () => void = () => {};
let editHandler: Handler;

before(async () => {
  // Redirect HOME so workspacePath resolves under a sandbox dir. The
  // route module reads workspacePath at import time via the image
  // store, so this MUST happen before importing.
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-edit-images-route-"));
  restoreHome = isolateHome(tmpRoot);

  const imageMod: ImageModule = await import("../../server/api/routes/image.js");
  editHandler = extractRouteHandler(imageMod, "/api/edit-image", "post");
});

after(async () => {
  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("POST /api/edit-image — input validation", () => {
  it("rejects when prompt is missing", async () => {
    const { state, res } = mockRes();
    await editHandler(req({ imagePaths: ["artifacts/images/2026/04/x.png"] }), res);
    assert.equal(state.status, 400);
    assert.match(state.body?.message ?? "", /prompt/i);
  });

  it("rejects when prompt is an empty string", async () => {
    const { state, res } = mockRes();
    await editHandler(req({ prompt: "", imagePaths: ["artifacts/images/2026/04/x.png"] }), res);
    assert.equal(state.status, 400);
    assert.match(state.body?.message ?? "", /prompt/i);
  });

  it("rejects when imagePaths is missing", async () => {
    const { state, res } = mockRes();
    await editHandler(req({ prompt: "ghibli style" }), res);
    assert.equal(state.status, 400);
    assert.match(state.body?.message ?? "", /imagepaths/i);
  });

  it("rejects when imagePaths is an empty array", async () => {
    const { state, res } = mockRes();
    await editHandler(req({ prompt: "ghibli style", imagePaths: [] }), res);
    assert.equal(state.status, 400);
    assert.match(state.body?.message ?? "", /imagepaths/i);
  });

  it("rejects when imagePaths contains a non-string entry", async () => {
    const { state, res } = mockRes();
    await editHandler(req({ prompt: "ghibli", imagePaths: ["artifacts/images/x.png", 42] }), res);
    assert.equal(state.status, 400);
    assert.match(state.body?.message ?? "", /imagepaths/i);
  });

  it("rejects when imagePaths is not an array", async () => {
    const { state, res } = mockRes();
    await editHandler(req({ prompt: "ghibli", imagePaths: "artifacts/images/x.png" }), res);
    assert.equal(state.status, 400);
    assert.match(state.body?.message ?? "", /imagepaths/i);
  });

  it("rejects when imagePaths exceeds the per-call cap", async () => {
    // Build 9 entries to overflow the MAX_EDIT_IMAGES = 8 limit.
    const tooMany = Array.from({ length: 9 }, (_, i) => `artifacts/images/2026/04/x${i}.png`);
    const { state, res } = mockRes();
    await editHandler(req({ prompt: "merge", imagePaths: tooMany }), res);
    assert.equal(state.status, 400);
    assert.match(state.body?.message ?? "", /maximum/i);
  });

  it("rejects a path that lives outside the allowed roots before hitting Gemini", async () => {
    // Wrong prefix — neither artifacts/images/ nor data/attachments/.
    // Goes past validation but the loadSourceImage step throws inside
    // try/catch and surfaces as 500 with a descriptive message.
    const { state, res } = mockRes();
    await editHandler(req({ prompt: "x", imagePaths: ["/etc/passwd"] }), res);
    assert.equal(state.status, 500);
    assert.match(state.body?.message ?? "", /imagepath must live under/i);
  });
});
