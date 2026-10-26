// Route-level checks for the `POST /api/wiki { action: "save" }`
// handler added in #775. We drive the handler with plain
// Request / Response mocks (same pattern as
// test_canvasImageRoutes.ts) instead of spinning up Express +
// supertest. HOME is redirected to a tmp dir BEFORE the route
// module is imported so `workspacePath` resolves inside the
// sandbox; files created during the tests are cleaned in
// `after()`.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Request, Response } from "express";
import { isolateHome } from "../helpers/isolatedHome.js";

type WikiModule = typeof import("../../server/api/routes/wiki.js");

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
  data?: { content?: string; pageExists?: boolean };
  error?: string;
}

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

function req(body: unknown): Request {
  return { body } as unknown as Request;
}

// GET /api/wiki?slug=… mock — the wiki route reads `req.query.slug`
// (forwarded by `getOptionalStringQuery`), so the test harness only
// needs to expose that field.
function getReqWithSlug(slug: string): Request {
  return { query: { slug } } as unknown as Request;
}

let tmpRoot: string;
let pagesDir: string;
let restoreHome: () => void = () => {};
let postWikiHandler: Handler;
let getWikiHandler: Handler;

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-wiki-save-route-"));
  restoreHome = isolateHome(tmpRoot);

  const { workspacePath: workspacePth } = await import("../../server/workspace/workspace.js");
  const { WORKSPACE_DIRS } = await import("../../server/workspace/paths.js");
  pagesDir = path.join(workspacePth, WORKSPACE_DIRS.wikiPages);
  mkdirSync(pagesDir, { recursive: true });

  const wikiMod: WikiModule = await import("../../server/api/routes/wiki.js");
  postWikiHandler = extractRouteHandler(wikiMod, "/api/wiki", "post");
  getWikiHandler = extractRouteHandler(wikiMod, "/api/wiki", "get");
});

after(async () => {
  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("POST /api/wiki — action: save", () => {
  // Reset the module-level page-index cache before every test.
  // The cache invalidates on `pagesDir` mtime change, but Windows
  // NTFS has ~10–15 ms mtime granularity — two file writes within
  // that window leave the cache pinned to the first state, so a
  // page created in test N can be invisible to test N+1's
  // resolvePagePath. Linux/macOS happen to land on different ms
  // each time so the bug only surfaces on Windows CI runners.
  // (Pre-existing from #775 / PR #795; surfaced on PR #801.)
  beforeEach(async () => {
    const { __resetPageIndexCache } = await import("@mulmoclaude/core/wiki/server");
    __resetPageIndexCache();
  });

  it("overwrites an existing page atomically (with auto-stamped frontmatter)", async () => {
    // Post-#895-PR-B: even body-only saves get a frontmatter
    // envelope stamped with created / updated / editor. The body
    // content survives verbatim; the wrapper is the new shape.
    const slug = "test-page";
    const filePath = path.join(pagesDir, `${slug}.md`);
    await writeFile(filePath, "# Original\n\n- [ ] task\n", "utf-8");

    const newContent = "# Original\n\n- [x] task\n";
    const { state, res } = mockRes();
    await postWikiHandler(req({ action: "save", pageName: slug, content: newContent }), res);

    assert.equal(state.status, 200);
    const onDisk = await readFile(filePath, "utf-8");
    // Body must be preserved verbatim, but the file now carries a
    // frontmatter envelope with auto-stamped fields.
    assert.match(onDisk, /\n- \[x\] task\n$/);
    assert.match(onDisk, /^---\n/);
    assert.match(onDisk, /editor: user/);
    // Response should reflect the on-disk canonical content.
    assert.equal(state.body?.data?.content, onDisk);
    assert.equal(state.body?.data?.pageExists, true);
  });

  it("preserves frontmatter when the body has been toggled", async () => {
    // The route now stamps `created` / `updated` / `editor` on save
    // (#895 PR B). Existing user-supplied keys must still survive
    // verbatim. Assert the stable fields explicitly rather than
    // comparing the whole file byte-for-byte.
    const slug = "with-frontmatter";
    const filePath = path.join(pagesDir, `${slug}.md`);
    const original = "---\ntitle: Foo\ntags: [a, b]\n---\n\n- [ ] task one\n- [ ] task two\n";
    await writeFile(filePath, original, "utf-8");

    const updated = "---\ntitle: Foo\ntags: [a, b]\n---\n\n- [x] task one\n- [ ] task two\n";
    const { state, res } = mockRes();
    await postWikiHandler(req({ action: "save", pageName: slug, content: updated }), res);

    assert.equal(state.status, 200);
    const onDisk = await readFile(filePath, "utf-8");
    assert.match(onDisk, /^---\n/, "frontmatter delimiters should round-trip");
    assert.match(onDisk, /title: Foo/, "user-supplied title preserved");
    assert.match(onDisk, /\n- \[x\] task one\n- \[ \] task two\n$/, "body toggled correctly");
    // `tags` round-trips as either flow-style `[a, b]` or block list.
    // Either is fine — assert both entries appear somewhere in the
    // header rather than pinning a specific YAML serialisation.
    const headerEnd = onDisk.indexOf("\n---\n", 4);
    const header = onDisk.slice(0, headerEnd);
    assert.match(header, /\ba\b/);
    assert.match(header, /\bb\b/);
  });

  it("end-to-end: header-less page → save → reload (GET) shows frontmatter, body byte-identical (#895 完了条件)", async () => {
    // The issue body's last unchecked completion item:
    //   "header の無い既存 md を書き込む → 自動で minimal header 付与"
    //   "e2e: 既存 header なし wiki page を編集 → 次回読み込みで
    //   header あり / body は変わらない"
    //
    // Route-level integration test for that flow. We exercise BOTH
    // the POST save handler and the GET reload handler (codex
    // review iter-1 #915 — reading the file directly via fs.readFile
    // doesn't actually pin the GET / buildPageResponse path the
    // frontend hits on a real reload).
    //
    //   1. Seed a header-less page on disk (legacy wiki content shape).
    //   2. POST /api/wiki { action: "save", content: <new body> } —
    //      same call shape the frontend's task-checkbox toggler uses.
    //   3. GET  /api/wiki?slug=<slug> — same call the wiki view
    //      issues on reload.
    //   4. Read the file too, assert (a) frontmatter envelope
    //      wraps the body, (b) body bytes BYTE-identical to what
    //      the caller sent (no `trimStart()` slack — the offset
    //      includes the canonical envelope spacer `\n---\n\n`),
    //      (c) GET response content matches the file on disk.
    const slug = "lazy-on-write";
    const filePath = path.join(pagesDir, `${slug}.md`);
    const headerlessOriginal = "# Lazy\n\nA pre-existing page that has no frontmatter yet.\n";
    await writeFile(filePath, headerlessOriginal, "utf-8");

    const newBody = "# Lazy\n\nUpdated body — same shape, different prose.\n";
    const postCtx = mockRes();
    await postWikiHandler(req({ action: "save", pageName: slug, content: newBody }), postCtx.res);

    assert.equal(postCtx.state.status, 200);

    // Read on disk.
    const onDisk = await readFile(filePath, "utf-8");

    // Header now exists with the auto-stamped minimum.
    assert.match(onDisk, /^---\n/);
    assert.match(onDisk, /\ncreated: /);
    assert.match(onDisk, /\nupdated: /);
    assert.match(onDisk, /\neditor: user\n/);
    assert.match(onDisk, /\n---\n\n/);

    // BYTE-identical body extraction. `serializeWithFrontmatter`
    // emits `---\n${yaml}\n---\n\n${body}` — the closing fence
    // sequence is exactly `\n---\n\n` (closing newline + fence +
    // newline + spacer line). Slice past those bytes and the
    // remainder is the user-supplied body verbatim.
    const fenceEnd = onDisk.indexOf("\n---\n\n", 4);
    assert.notEqual(fenceEnd, -1, "closing fence + spacer not found");
    const bodyAfter = onDisk.slice(fenceEnd + "\n---\n\n".length);
    assert.equal(bodyAfter, newBody);

    // POST response carries the same canonical content the GET
    // would return — the optimistic client update matches reload.
    assert.equal(postCtx.state.body?.data?.content, onDisk);

    // GET /api/wiki?slug=… — the actual reload path the frontend
    // would take. The response's `data.content` MUST match the
    // file on disk (i.e. round-trips through `buildPageResponse`).
    const getCtx = mockRes();
    await getWikiHandler(getReqWithSlug(slug), getCtx.res);
    assert.equal(getCtx.state.status, 200);
    assert.equal(getCtx.state.body?.data?.content, onDisk);
    assert.equal(getCtx.state.body?.data?.pageExists, true);
  });

  it("rejects a request with no pageName", async () => {
    const { state, res } = mockRes();
    await postWikiHandler(req({ action: "save", content: "anything" }), res);
    assert.equal(state.status, 400);
    assert.match(state.body?.error ?? "", /pagename/i);
  });

  it("rejects a request with no content field", async () => {
    const { state, res } = mockRes();
    await postWikiHandler(req({ action: "save", pageName: "test-page" }), res);
    assert.equal(state.status, 400);
    assert.match(state.body?.error ?? "", /content/i);
  });

  it("rejects a request with non-string content (e.g. accidental array)", async () => {
    const { state, res } = mockRes();
    await postWikiHandler(req({ action: "save", pageName: "test-page", content: ["foo"] }), res);
    assert.equal(state.status, 400);
    assert.match(state.body?.error ?? "", /content/i);
  });

  it("returns 404 when the page doesn't exist (no creation via save)", async () => {
    const { state, res } = mockRes();
    await postWikiHandler(req({ action: "save", pageName: "nonexistent-page", content: "hello" }), res);
    assert.equal(state.status, 404);
    assert.match(state.body?.error ?? "", /not found/i);
  });

  it("traversal-shaped pageName is sanitised by slugify and refused as not-found", async () => {
    const { state, res } = mockRes();
    // wikiSlugify strips slashes / dots; the resulting empty / sanitised
    // slug doesn't match any real page so resolvePagePath returns null.
    await postWikiHandler(req({ action: "save", pageName: "../../etc/passwd", content: "x" }), res);
    assert.equal(state.status, 404);
  });
});
