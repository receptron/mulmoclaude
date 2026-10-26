// #3294. The session detail response tells a catch-up whether the snapshot was
// taken mid-run: while a run is in progress the text being streamed is not in
// the file yet, so the client must not adopt it. The flag rides on the
// `session_meta` row, which is now always present.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Request, Response } from "express";
import { isolateHome } from "../helpers/isolatedHome.js";

type RouteModule = typeof import("../../server/api/routes/sessions.js");
type SessionStore = typeof import("../../server/events/session-store/index.js");
type Handler = (req: Request, res: Response) => Promise<void> | void;
interface RouterInternals {
  stack: { route?: { path: string; stack: { method: string; handle: Handler }[] } }[];
}

let tmpRoot: string;
let chatDir: string;
let restoreHome: () => void = () => {};
let detailHandler: Handler;
let store: SessionStore;

function extractRouteHandler(mod: RouteModule, routePath: string, method: string): Handler {
  const router = mod.default as unknown as RouterInternals;
  const layer = router.stack.find((frame) => frame.route?.path === routePath)?.route?.stack.find((stackLayer) => stackLayer.method === method);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${routePath} not registered`);
  return layer.handle;
}

async function fetchDetail(sessionId: string): Promise<unknown[]> {
  let body: unknown[] = [];
  const res = {
    status() {
      return res;
    },
    json(payload: unknown[]) {
      body = payload;
      return res;
    },
  };
  await detailHandler({ params: { id: sessionId } } as unknown as Request, res as unknown as Response);
  return body;
}

function runFacts(meta: unknown): Record<string, unknown> {
  const row = meta as Record<string, unknown>;
  return { type: row.type, isRunning: row.isRunning, snapshotMayBeIncomplete: row.snapshotMayBeIncomplete };
}

async function writeSession(sessionId: string, withMeta: boolean): Promise<void> {
  if (withMeta) await writeFile(path.join(chatDir, `${sessionId}.json`), JSON.stringify({ roleId: "general", startedAt: new Date().toISOString() }));
  await writeFile(path.join(chatDir, `${sessionId}.jsonl`), `${JSON.stringify({ source: "user", type: "text", message: "hi" })}\n`);
}

function startRun(sessionId: string): void {
  const now = new Date().toISOString();
  store.getOrCreateSession(sessionId, { roleId: "general", resultsFilePath: path.join(tmpRoot, "results.jsonl"), startedAt: now, updatedAt: now });
  assert.equal(
    store.beginRun(sessionId, () => {}),
    true,
  );
}

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-session-detail-running-"));
  restoreHome = isolateHome(tmpRoot);
  const { WORKSPACE_PATHS } = await import("../../server/workspace/paths.js");
  chatDir = WORKSPACE_PATHS.chat;
  mkdirSync(chatDir, { recursive: true });
  store = await import("../../server/events/session-store/index.js");
  store.initSessionStore({ publish() {}, subscribe: () => () => {} } as unknown as Parameters<SessionStore["initSessionStore"]>[0]);
  detailHandler = extractRouteHandler(await import("../../server/api/routes/sessions.js"), "/api/sessions/:id", "get");
});

beforeEach(() => {
  store.__resetForTests();
  store.initSessionStore({ publish() {}, subscribe: () => () => {} } as unknown as Parameters<SessionStore["initSessionStore"]>[0]);
});

after(async () => {
  // initSessionStore starts an eviction interval that would keep the process alive.
  store.__resetForTests();
  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/sessions/:id — run facts on the snapshot", () => {
  it("reports a run in progress", async () => {
    await writeSession("running-1", true);
    startRun("running-1");
    const [meta] = await fetchDetail("running-1");
    assert.deepEqual(
      { type: (meta as { type: string }).type, isRunning: (meta as { isRunning: boolean }).isRunning },
      { type: "session_meta", isRunning: true },
    );
  });

  it("reports no run once it has ended", async () => {
    await writeSession("ended-1", true);
    startRun("ended-1");
    store.endRun("ended-1");
    const [meta] = await fetchDetail("ended-1");
    assert.deepEqual(runFacts(meta), { type: "session_meta", isRunning: false, snapshotMayBeIncomplete: false });
  });

  it("reports no run for a session the store has never seen", async () => {
    await writeSession("cold-1", true);
    const [meta, first] = await fetchDetail("cold-1");
    assert.deepEqual(runFacts(meta), { type: "session_meta", isRunning: false, snapshotMayBeIncomplete: false });
    assert.deepEqual(first, { source: "user", type: "text", message: "hi" });
  });

  it("still carries the flag when the session has no meta file", async () => {
    await writeSession("no-meta-1", false);
    startRun("no-meta-1");
    const [meta, first] = await fetchDetail("no-meta-1");
    assert.deepEqual(meta, { type: "session_meta", isRunning: true, snapshotMayBeIncomplete: true });
    assert.deepEqual(first, { source: "user", type: "text", message: "hi" });
  });
});

describe("snapshotMayBeMidRun", () => {
  it("is false only when no run was live at either end and none happened in between", async () => {
    const { snapshotMayBeMidRun } = await import("../../server/api/routes/snapshotRunState.js");
    assert.equal(snapshotMayBeMidRun({ isRunning: false, runGeneration: 3 }, { isRunning: false, runGeneration: 3 }), false);
    assert.equal(snapshotMayBeMidRun({ isRunning: true, runGeneration: 3 }, { isRunning: false, runGeneration: 3 }), true);
    assert.equal(snapshotMayBeMidRun({ isRunning: false, runGeneration: 3 }, { isRunning: true, runGeneration: 4 }), true);
    // A whole run started and ended during the read: both samples idle, generation moved.
    assert.equal(snapshotMayBeMidRun({ isRunning: false, runGeneration: 3 }, { isRunning: false, runGeneration: 4 }), true);
  });
});

describe("the session store's run generation", () => {
  function createSession(sessionId: string) {
    const now = new Date().toISOString();
    return store.getOrCreateSession(sessionId, { roleId: "general", resultsFilePath: path.join(tmpRoot, "results.jsonl"), startedAt: now, updatedAt: now });
  }

  it("moves on every accepted run and not on a rejected one", () => {
    const session = createSession("gen-1");
    assert.equal(
      store.beginRun("gen-1", () => {}),
      true,
    );
    const first = session.runGeneration;
    store.endRun("gen-1");
    assert.equal(
      store.beginRun("gen-1", () => {}),
      true,
    );
    const second = session.runGeneration;
    assert.ok(second > first);
    assert.equal(
      store.beginRun("gen-1", () => {}),
      false,
      "a rejected begin must not move it",
    );
    assert.equal(session.runGeneration, second);
  });

  it("never repeats for a session evicted and recreated during a read", () => {
    const original = createSession("gen-2");
    assert.equal(
      store.beginRun("gen-2", () => {}),
      true,
    );
    store.endRun("gen-2");
    const beforeRead = { isRunning: original.isRunning, runGeneration: original.runGeneration };
    store.evictSession("gen-2");
    assert.equal(store.getSession("gen-2"), undefined);
    const recreated = createSession("gen-2");
    assert.equal(
      store.beginRun("gen-2", () => {}),
      true,
    );
    store.endRun("gen-2");
    assert.notEqual(recreated.runGeneration, beforeRead.runGeneration);
  });
});
