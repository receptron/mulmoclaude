// Route-level checks for the wiki history endpoints (#763 PR 2).
// Same handler-extract pattern as test_wikiSaveRoute.ts so we
// don't need supertest. HOME is redirected to a tmp dir BEFORE
// the route module is imported so `workspacePath` resolves into
// the sandbox.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "fs";
import { mkdtemp, readFile, rm, unlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Request, Response } from "express";
import { isolateHome } from "../helpers/isolatedHome.js";

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

interface ResBody {
  slug?: string;
  snapshots?: { stamp: string; reason?: string; editor?: string }[];
  snapshot?: { stamp: string; body?: string; meta?: Record<string, unknown> };
  restored?: { fromStamp: string };
  error?: string;
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

function makeReq(params: Record<string, string>): Request {
  return { params } as unknown as Request;
}

let tmpRoot: string;
let pagesDir: string;
let restoreHome: () => void = () => {};
let listHandler: Handler;
let readHandler: Handler;
let restoreHandler: Handler;
let writeWikiPage: typeof import("../../server/workspace/wiki-pages/io.js").writeWikiPage;
let listSnapshots: typeof import("../../server/workspace/wiki-pages/snapshot.js").listSnapshots;

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-wiki-history-route-"));
  restoreHome = isolateHome(tmpRoot);

  const { workspacePath: workspacePth } = await import("../../server/workspace/workspace.js");
  const { WORKSPACE_DIRS } = await import("../../server/workspace/paths.js");
  pagesDir = path.join(workspacePth, WORKSPACE_DIRS.wikiPages);
  mkdirSync(pagesDir, { recursive: true });

  const historyMod = await import("../../server/api/routes/wiki/history.js");
  listHandler = extractRouteHandler(historyMod, "/pages/:slug/history", "get");
  readHandler = extractRouteHandler(historyMod, "/pages/:slug/history/:stamp", "get");
  restoreHandler = extractRouteHandler(historyMod, "/pages/:slug/history/:stamp/restore", "post");

  ({ writeWikiPage } = await import("../../server/workspace/wiki-pages/io.js"));
  ({ listSnapshots } = await import("../../server/workspace/wiki-pages/snapshot.js"));
});

after(async () => {
  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/wiki/pages/:slug/history", () => {
  it("returns an empty list for a slug with no live page (history outlives the page)", async () => {
    // Codex iter-2 #917: gating this route on the live page existing
    // would block restore for deleted/renamed pages — exactly when
    // history is most needed. Empty 200 still answers "no history"
    // unambiguously.
    const { state, res } = mockRes();
    await listHandler(makeReq({ slug: "does-not-exist" }), res);
    assert.equal(state.status, 200);
    assert.equal(state.body?.slug, "does-not-exist");
    assert.deepEqual(state.body?.snapshots, []);
  });

  it("returns 400 on an unsafe slug", async () => {
    const { state, res } = mockRes();
    await listHandler(makeReq({ slug: "../etc/passwd" }), res);
    assert.equal(state.status, 400);
  });

  it("returns the snapshot list for a real page", async () => {
    // Two saves → two snapshots. We assert presence + ordering;
    // exact stamps depend on the live clock.
    const slug = "list-test";
    await writeWikiPage(slug, "first body\n", { editor: "user", reason: "draft" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeWikiPage(slug, "second body\n", { editor: "user", reason: "revise" });

    const { state, res } = mockRes();
    await listHandler(makeReq({ slug }), res);
    assert.equal(state.status, 200);
    assert.equal(state.body?.slug, slug);
    assert.ok(state.body?.snapshots);
    assert.ok((state.body.snapshots ?? []).length >= 2, "expected at least 2 snapshots");
    // Newest-first.
    const reasons = (state.body.snapshots ?? []).map((entry) => entry.reason);
    assert.equal(reasons[0], "revise");
    assert.equal(reasons[1], "draft");
  });

  it("still lists snapshots after the live page is deleted", async () => {
    // Codex iter-2 #917: history must outlive the page so the user
    // can find and restore deleted/renamed content.
    const slug = "list-after-delete";
    await writeWikiPage(slug, "doomed body\n", { editor: "user", reason: "before delete" });
    await unlink(path.join(pagesDir, `${slug}.md`));

    const { state, res } = mockRes();
    await listHandler(makeReq({ slug }), res);
    assert.equal(state.status, 200);
    assert.equal(state.body?.slug, slug);
    assert.ok((state.body?.snapshots ?? []).length >= 1, "snapshot of deleted page must remain visible");
  });
});

describe("GET /api/wiki/pages/:slug/history/:stamp", () => {
  it("returns 400 on an unsafe stamp", async () => {
    const { state, res } = mockRes();
    await readHandler(makeReq({ slug: "any", stamp: "../etc" }), res);
    assert.equal(state.status, 400);
  });

  it("returns the snapshot body + meta for a known stamp", async () => {
    const slug = "read-test";
    await writeWikiPage(slug, "hello body\n", { editor: "user", reason: "first" });
    const snapshots = await listSnapshots(slug);
    assert.ok(snapshots.length >= 1);
    const [newest] = snapshots;
    assert.ok(newest);
    const { stamp } = newest;

    const { state, res } = mockRes();
    await readHandler(makeReq({ slug, stamp }), res);
    assert.equal(state.status, 200);
    assert.equal(state.body?.snapshot?.stamp, stamp);
    assert.equal(state.body?.snapshot?.body, "hello body\n");
    assert.equal(state.body?.snapshot?.meta?._snapshot_reason, "first");
  });

  it("returns 404 for an unknown stamp on a known slug", async () => {
    const slug = "miss-test";
    await writeWikiPage(slug, "body\n", { editor: "user" });
    const fakeStamp = "2099-01-01T00-00-00-000Z-fakeid";
    const { state, res } = mockRes();
    await readHandler(makeReq({ slug, stamp: fakeStamp }), res);
    assert.equal(state.status, 404);
  });
});

describe("POST /api/wiki/pages/:slug/history/:stamp/restore", () => {
  it("writes the snapshot's body back to the live page and produces a new snapshot", async () => {
    const slug = "restore-test";
    await writeWikiPage(slug, "v1 body\n", { editor: "user", reason: "first" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeWikiPage(slug, "v2 body\n", { editor: "user", reason: "second" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const beforeRestore = await listSnapshots(slug);
    const oldest = beforeRestore[beforeRestore.length - 1];
    assert.ok(oldest);

    const { state, res } = mockRes();
    await restoreHandler(makeReq({ slug, stamp: oldest.stamp }), res);
    assert.equal(state.status, 200);
    assert.equal(state.body?.restored?.fromStamp, oldest.stamp);

    // Live page now reads "v1 body" again.
    const { workspacePath: workspacePth } = await import("../../server/workspace/workspace.js");
    const { WORKSPACE_DIRS } = await import("../../server/workspace/paths.js");
    const livePath = path.join(workspacePth, WORKSPACE_DIRS.wikiPages, `${slug}.md`);
    const live = await readFile(livePath, "utf-8");
    assert.match(live, /\nv1 body\n$/);
    // The restore must NOT have leaked _snapshot_* into the live frontmatter.
    assert.doesNotMatch(live, /_snapshot_/);

    // History grew by one entry (the restore itself).
    const afterRestore = await listSnapshots(slug);
    assert.equal(afterRestore.length, beforeRestore.length + 1, "restore should add a new snapshot");
    const [restoreSnapshot] = afterRestore;
    assert.ok(restoreSnapshot);
    assert.match(restoreSnapshot.reason ?? "", /^Restored from /);
  });

  it("returns 404 when the stamp doesn't exist", async () => {
    const slug = "restore-miss";
    await writeWikiPage(slug, "body\n", { editor: "user" });

    const { state, res } = mockRes();
    await restoreHandler(makeReq({ slug, stamp: "2099-01-01T00-00-00-000Z-fakeid" }), res);
    assert.equal(state.status, 404);
  });
});
