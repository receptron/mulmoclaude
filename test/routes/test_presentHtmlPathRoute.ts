// presentHtml's `path` form after it was widened past `artifacts/html/**`:
// any page on disk can be presented and edited in place. Route-level, with
// plain Request / Response mocks (same harness as
// `test_presentDocumentRoute.ts` / `test_canvasImageRoutes.ts`).
//
// The artifact case still has to work through the OLD road — `files.artifacts`,
// which is rooted at `<workspace>/artifacts` — so both are exercised here: a
// regression in the routing between the two FileOps is exactly the failure this
// file is for.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Request, Response } from "express";
import { isolateHome } from "../helpers/isolatedHome.js";

type PresentHtmlModule = typeof import("../../server/api/routes/presentHtml.js");

type Handler = (req: Request, res: Response) => Promise<void> | void;

interface StackFrame {
  route?: { path: string; stack: { method: string; handle: Handler }[] };
}

function extractRouteHandler(mod: { default: unknown }, routePath: string, method: string): Handler {
  const router = mod.default as unknown as { stack: StackFrame[] };
  for (const frame of router.stack) {
    if (frame.route?.path !== routePath) continue;
    const layer = frame.route.stack.find((stackLayer) => stackLayer.method === method);
    if (layer) return layer.handle;
  }
  throw new Error(`route ${method.toUpperCase()} ${routePath} not registered`);
}

interface ResBody {
  message?: string;
  data?: { filePath: string; title?: string };
  error?: string;
  path?: string;
}

function mockRes() {
  const state: { status: number; body: ResBody | undefined } = { status: 200, body: undefined };
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

function req(body: unknown): Request {
  return { body, params: {} } as unknown as Request;
}

const ARTIFACT_REL = "artifacts/html/2026/07/artifact-test123.html";
const WORKSPACE_REL = "docs/report.html";
const PAGE_HTML = "<!DOCTYPE html><html><body>hi</body></html>";

let tmpRoot: string;
let workspaceDir: string;
let outsideAbsolutePath: string;
let restoreHome: () => void = () => {};
let createHandler: Handler;
let updateHandler: Handler;

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-present-html-path-"));
  restoreHome = isolateHome(tmpRoot);

  const { workspacePath } = await import("../../server/workspace/workspace.js");
  workspaceDir = workspacePath;
  for (const rel of [ARTIFACT_REL, WORKSPACE_REL]) {
    mkdirSync(path.join(workspaceDir, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(workspaceDir, rel), PAGE_HTML, "utf-8");
  }
  outsideAbsolutePath = path.join(tmpRoot, "elsewhere", "page.html");
  mkdirSync(path.dirname(outsideAbsolutePath), { recursive: true });
  await writeFile(outsideAbsolutePath, PAGE_HTML, "utf-8");

  const mod: PresentHtmlModule = await import("../../server/api/routes/presentHtml.js");
  createHandler = extractRouteHandler(mod, "/api/html", "post");
  updateHandler = extractRouteHandler(mod, "/api/html/update", "put");
});

after(async () => {
  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("POST /api/html — `path` form", () => {
  it("presents an artifact page (the pre-existing road)", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: ARTIFACT_REL }), res);

    assert.equal(state.status, 200);
    assert.equal(state.body?.data?.filePath, ARTIFACT_REL);
  });

  it("presents a workspace page outside artifacts/html/", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: WORKSPACE_REL }), res);

    assert.equal(state.status, 200);
    assert.equal(state.body?.data?.filePath, WORKSPACE_REL);
  });

  it("presents an absolute page outside the workspace", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: outsideAbsolutePath }), res);

    assert.equal(state.status, 200);
    assert.equal(state.body?.data?.filePath, outsideAbsolutePath);
  });

  it("rejects a traversal path", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: "docs/../../secret.html" }), res);

    assert.equal(state.status, 400);
  });

  it("rejects a non-HTML path", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: "docs/report.md" }), res);

    assert.equal(state.status, 400);
  });

  it("rejects a page that does not exist", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: "docs/missing.html" }), res);

    assert.equal(state.status, 400);
  });
});

describe("PUT /api/html/update — write-back", () => {
  it("overwrites a workspace page outside artifacts/html/", async () => {
    const { state, res } = mockRes();
    await updateHandler(req({ relativePath: WORKSPACE_REL, html: "<p>edited</p>" }), res);

    assert.equal(state.status, 200);
    assert.equal(await readFile(path.join(workspaceDir, WORKSPACE_REL), "utf-8"), "<p>edited</p>");
  });

  it("overwrites a page outside the workspace by absolute path", async () => {
    const { state, res } = mockRes();
    await updateHandler(req({ relativePath: outsideAbsolutePath, html: "<p>elsewhere</p>" }), res);

    assert.equal(state.status, 200);
    assert.equal(await readFile(outsideAbsolutePath, "utf-8"), "<p>elsewhere</p>");
  });

  it("refuses to CREATE a page at a path that does not exist", async () => {
    const { state, res } = mockRes();
    await updateHandler(req({ relativePath: "docs/never-written.html", html: "<p>nope</p>" }), res);

    assert.notEqual(state.status, 200);
    await assert.rejects(readFile(path.join(workspaceDir, "docs", "never-written.html"), "utf-8"));
  });
});
