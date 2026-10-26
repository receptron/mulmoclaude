// Route-level tests for `POST /api/wiki/internal/snapshot` —
// hit by the LLM-write hook script after a Claude CLI Write/Edit
// touches a wiki page (#763 PR 2 prereq). Same handler-extract
// pattern as test_wikiSaveRoute.ts so we exercise the route
// without spinning up an Express server / supertest.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
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
  ok?: boolean;
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

function makeReq(body: unknown): Request {
  return { body } as unknown as Request;
}

let tmpRoot: string;
let pagesDir: string;
let restoreHome: () => void = () => {};
let snapshotHandler: Handler;
let listSnapshots: typeof import("../../server/workspace/wiki-pages/snapshot.js").listSnapshots;
let getOrCreateSession: typeof import("../../server/events/session-store/index.js").getOrCreateSession;
let onSessionEvent: typeof import("../../server/events/session-store/index.js").onSessionEvent;

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-internal-snap-"));
  restoreHome = isolateHome(tmpRoot);

  const { workspacePath: workspacePth } = await import("../../server/workspace/workspace.js");
  const { WORKSPACE_DIRS } = await import("../../server/workspace/paths.js");
  pagesDir = path.join(workspacePth, WORKSPACE_DIRS.wikiPages);
  mkdirSync(pagesDir, { recursive: true });

  const historyMod = await import("../../server/api/routes/wiki/history.js");
  snapshotHandler = extractRouteHandler(historyMod, "/internal/snapshot", "post");
  ({ listSnapshots } = await import("../../server/workspace/wiki-pages/snapshot.js"));
  ({ getOrCreateSession, onSessionEvent } = await import("../../server/events/session-store/index.js"));
});

after(async () => {
  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("POST /api/wiki/internal/snapshot", () => {
  it("returns 400 when slug is missing", async () => {
    const { state, res } = mockRes();
    await snapshotHandler(makeReq({}), res);
    assert.equal(state.status, 400);
  });

  it("returns 400 when slug contains a path separator", async () => {
    const { state, res } = mockRes();
    await snapshotHandler(makeReq({ slug: "../etc/passwd" }), res);
    assert.equal(state.status, 400);
  });

  it("returns 400 for the literal `..` slug", async () => {
    const { state, res } = mockRes();
    await snapshotHandler(makeReq({ slug: ".." }), res);
    assert.equal(state.status, 400);
  });

  it("returns 404 when the slug's file doesn't exist on disk", async () => {
    const { state, res } = mockRes();
    await snapshotHandler(makeReq({ slug: "missing" }), res);
    assert.equal(state.status, 404);
  });

  it("records a snapshot tagged editor=llm for a valid slug", async () => {
    const slug = "valid-llm-write";
    const filePath = path.join(pagesDir, `${slug}.md`);
    await writeFile(filePath, "---\ntitle: x\n---\n\nllm-written body\n", "utf-8");

    const { state, res } = mockRes();
    await snapshotHandler(makeReq({ slug }), res);
    assert.equal(state.status, 200);
    assert.equal(state.body?.ok, true);
    assert.equal(state.body?.slug, slug);

    const snapshots = await listSnapshots(slug);
    assert.equal(snapshots.length, 1, "endpoint should have written exactly one snapshot");
    const [snapshot] = snapshots;
    assert.ok(snapshot);
    assert.equal(snapshot.editor, "llm", "hook always tags as llm — user-driven writes go through writeWikiPage");
    // The hook never supplies `reason` (the LLM has no natural source
    // for one) — the field is absent from this code path.
    assert.equal(snapshot.reason, undefined);
  });

  it("propagates sessionId when the hook supplies one", async () => {
    const slug = "with-session";
    const filePath = path.join(pagesDir, `${slug}.md`);
    await writeFile(filePath, "body\n", "utf-8");

    const { state, res } = mockRes();
    await snapshotHandler(makeReq({ slug, sessionId: "chat-abc-123" }), res);
    assert.equal(state.status, 200);

    const snapshots = await listSnapshots(slug);
    const [snapshot] = snapshots;
    assert.ok(snapshot);
    assert.equal(snapshot.sessionId, "chat-abc-123");
  });

  // Stage 3a (#963): the snapshot endpoint also publishes a synthetic
  // manageWiki / page-edit toolResult into the active chat session
  // so the canvas timeline shows the LLM's edit inline.
  it("publishes a manageWiki/page-edit toolResult to an active session", async () => {
    const slug = "publishes-toolresult";
    const sessionId = "chat-publish-1";
    await writeFile(path.join(pagesDir, `${slug}.md`), "body\n", "utf-8");
    const sessionFile = path.join(tmpRoot, `${sessionId}.jsonl`);
    getOrCreateSession(sessionId, {
      roleId: "general",
      resultsFilePath: sessionFile,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const events: Record<string, unknown>[] = [];
    const unsubscribe = onSessionEvent(sessionId, (event) => {
      events.push(event);
    });

    const { state, res } = mockRes();
    await snapshotHandler(makeReq({ slug, sessionId }), res);
    assert.equal(state.status, 200);

    unsubscribe();
    const toolResultEvent = events.find((event) => event.type === "tool_result");
    assert.ok(toolResultEvent, "expected a tool_result event published to the session");
    const result = toolResultEvent.result as {
      toolName?: string;
      data?: { action?: string; slug?: string; stamp?: string; pagePath?: string };
    };
    assert.equal(result.toolName, "manageWiki");
    assert.equal(result.data?.action, "page-edit");
    assert.equal(result.data?.slug, slug);
    assert.match(result.data?.stamp ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result.data?.pagePath, `data/wiki/pages/${slug}.md`);
  });

  it("skips snapshot + toolResult when the new content matches the previous snapshot (sans auto-stamps)", async () => {
    const slug = "no-meaningful-change";
    const sessionId = "chat-no-op-1";
    const filePath = path.join(pagesDir, `${slug}.md`);
    await writeFile(filePath, "---\ntitle: x\nupdated: '2026-04-30T00:00:00.000Z'\neditor: llm\n---\n\nbody A\n", "utf-8");

    // Set up a session so pushToolResult would actually fire if the
    // dedupe gate let through the no-op call (codex review iter-1
    // #1017): without this listener we'd only catch a snapshot regression,
    // not a stray toolResult.
    const sessionFile = path.join(tmpRoot, `${sessionId}.jsonl`);
    getOrCreateSession(sessionId, {
      roleId: "general",
      resultsFilePath: sessionFile,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const events: Record<string, unknown>[] = [];
    const unsubscribe = onSessionEvent(sessionId, (event) => {
      events.push(event);
    });

    // First call records the baseline AND publishes a toolResult.
    const first = mockRes();
    await snapshotHandler(makeReq({ slug, sessionId }), first.res);
    assert.equal(first.state.status, 200);
    assert.equal((await listSnapshots(slug)).length, 1, "first call should record baseline");
    assert.equal(events.length, 1, "first call should publish exactly one toolResult");

    // Second call with only `updated` re-stamped → must be a no-op
    // for BOTH snapshot and toolResult.
    await writeFile(filePath, "---\ntitle: x\nupdated: '2026-04-30T00:01:00.000Z'\neditor: llm\n---\n\nbody A\n", "utf-8");
    const second = mockRes();
    await snapshotHandler(makeReq({ slug, sessionId }), second.res);
    assert.equal(second.state.status, 200);
    assert.equal((second.state.body as Record<string, unknown> | undefined)?.skipped, "no-meaningful-change");
    assert.equal((await listSnapshots(slug)).length, 1, "no second snapshot for an updated-only diff");
    assert.equal(events.length, 1, "no second toolResult for an updated-only diff");

    // Third call with a real body change → must record AND publish.
    await writeFile(filePath, "---\ntitle: x\nupdated: '2026-04-30T00:02:00.000Z'\neditor: llm\n---\n\nbody B\n", "utf-8");
    const third = mockRes();
    await snapshotHandler(makeReq({ slug, sessionId }), third.res);
    assert.equal(third.state.status, 200);
    assert.equal((await listSnapshots(slug)).length, 2, "real body change must record");
    assert.equal(events.length, 2, "real body change must publish a toolResult");

    unsubscribe();
  });

  it("does not publish a toolResult when sessionId is absent", async () => {
    const slug = "no-publish-without-session";
    await writeFile(path.join(pagesDir, `${slug}.md`), "body\n", "utf-8");
    // Pre-register a listener under a sentinel id so a stray publish
    // (regression) would still be caught — even though we expect
    // none with no sessionId.
    const events: Record<string, unknown>[] = [];
    const unsubscribe = onSessionEvent("never-published-to", (event) => {
      events.push(event);
    });

    const { state, res } = mockRes();
    await snapshotHandler(makeReq({ slug }), res);
    assert.equal(state.status, 200);

    unsubscribe();
    assert.equal(events.length, 0);
  });
});
