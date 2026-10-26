// Route-level checks for GET /api/sessions — end-to-end behaviour
// of the cursor-aware incremental fetch added for issue #205.
//
// We drive the handler with plain Request / Response mocks so we
// don't pay for an Express + supertest harness. The handler itself
// stats real files in a temp workspace, so these tests double as a
// regression check on the mtime-based `updatedAt` wiring.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "fs";
import { mkdtemp, rm, writeFile, utimes } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Request, Response } from "express";
import { encodeCursor } from "../../server/api/routes/sessionsCursor.js";
import { isolateHome } from "../helpers/isolatedHome.js";

type RouteModule = typeof import("../../server/api/routes/sessions.js");
let clearMetaCache: () => void;

interface SessionSummary {
  id: string;
  roleId: string;
  startedAt: string;
  updatedAt: string;
  preview: string;
}

interface SessionsResponse {
  sessions: SessionSummary[];
  cursor: string;
  deletedIds: string[];
}

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

function extractRouteHandler(mod: RouteModule, routePath: string, method: string): Handler {
  const router = mod.default as unknown as RouterInternals;
  for (const frame of router.stack) {
    if (frame.route?.path !== routePath) continue;
    const layer = frame.route.stack.find((stackLayer) => stackLayer.method === method);
    if (layer) return layer.handle;
  }
  throw new Error(`route ${method.toUpperCase()} ${routePath} not registered`);
}

function mockRes() {
  const state: { status: number; body: SessionsResponse | undefined } = {
    status: 200,
    body: undefined,
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: SessionsResponse) {
      state.body = payload;
      return res;
    },
  };
  return { state, res: res as unknown as Response };
}

// Base timestamps comfortably within the 90-day window so the
// SESSIONS_LIST_WINDOW_DAYS cutoff never hides them during tests.
// All per-test timestamps are offsets from this base.
// Rounded to whole seconds so the utimes(secs) → stat(mtimeMs)
// roundtrip doesn't lose sub-ms precision on CI filesystems.
const BASE_MS = Math.floor((Date.now() - 10 * 86_400_000) / 1000) * 1000;

let tmpRoot: string;
let chatDir: string;
// Resolved at runtime from the same modules the handler uses, so
// tests keep working if the on-disk layout moves again (issue
// #1902 fixed the drift where the two used to point at different
// trees).
let manifestDir: string;
let restoreHome: () => void = () => {};
let getHandler: Handler;
let markReadHandler: Handler;

async function writeSession(
  sessionId: string,
  opts: {
    roleId?: string;
    mtimeMs: number;
    indexedAtMs?: number;
    firstUserMessage?: string;
  },
): Promise<void> {
  // Minimal session files: a .json meta + an empty-ish .jsonl.
  const meta = {
    roleId: opts.roleId ?? "general",
    startedAt: new Date(opts.mtimeMs).toISOString(),
    firstUserMessage: opts.firstUserMessage ?? `msg for ${sessionId}`,
  };
  await writeFile(path.join(chatDir, `${sessionId}.json`), JSON.stringify(meta));
  await writeFile(path.join(chatDir, `${sessionId}.jsonl`), "");
  // Set both atime and mtime so the handler's stat.mtimeMs reads
  // what the test intends. Back-date the .json meta too — the cursor
  // derivation reads it alongside the .jsonl mtime (hasUnread writes
  // bump meta but not jsonl), so a freshly-written meta at "now"
  // would otherwise dominate the computed changeMs.
  const secs = opts.mtimeMs / 1000;
  await utimes(path.join(chatDir, `${sessionId}.jsonl`), secs, secs);
  await utimes(path.join(chatDir, `${sessionId}.json`), secs, secs);

  if (opts.indexedAtMs !== undefined) {
    const manifestPath = path.join(manifestDir, "manifest.json");
    let entries: unknown[] = [];
    try {
      entries = JSON.parse(readFileSync(manifestPath, "utf-8")).entries ?? [];
    } catch {
      /* first write */
    }
    entries.push({
      id: sessionId,
      roleId: meta.roleId,
      startedAt: meta.startedAt,
      indexedAt: new Date(opts.indexedAtMs).toISOString(),
      title: `AI title ${sessionId}`,
      summary: `AI summary ${sessionId}`,
      keywords: ["k1"],
    });
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({ version: 1, entries }));
  }
}

async function resetChatDir(): Promise<void> {
  await rm(chatDir, { recursive: true, force: true });
  await rm(manifestDir, { recursive: true, force: true });
  mkdirSync(chatDir, { recursive: true });
  mkdirSync(manifestDir, { recursive: true });
}

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-sessions-route-"));
  // The workspace path resolves once at module load from homedir(),
  // so we have to steer it BEFORE importing the route module. This
  // mirrors the setup in test_configRoute.ts.
  restoreHome = isolateHome(tmpRoot);
  // Resolve both roots from the real modules so the test still
  // agrees with production paths no matter how the layout evolves.
  const { WORKSPACE_PATHS } = await import("../../server/workspace/paths.js");
  const { indexDirFor } = await import("../../server/workspace/chat-index/paths.js");
  const { workspacePath: workspacePth } = await import("../../server/workspace/workspace.js");
  chatDir = WORKSPACE_PATHS.chat;
  manifestDir = indexDirFor(workspacePth);
  mkdirSync(chatDir, { recursive: true });
  mkdirSync(manifestDir, { recursive: true });
  const routeMod = await import("../../server/api/routes/sessions.js");
  clearMetaCache = routeMod.clearSessionMetaCache;
  getHandler = extractRouteHandler(routeMod, "/api/sessions", "get");
  markReadHandler = extractRouteHandler(routeMod, "/api/sessions/:id/mark-read", "post");
});

after(async () => {
  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetChatDir();
  // The meta cache is module-level and outlives the wiped fixture dir. Cases
  // here legitimately rewrite the same session id at the same mtime, which
  // production never does, so the stamp would read as unchanged (#2588).
  clearMetaCache();
});

describe("GET /api/sessions — full fetch (no ?since=)", () => {
  it("returns every visible session plus an envelope with cursor + empty deletedIds", async () => {
    await writeSession("s1", { mtimeMs: BASE_MS });
    await writeSession("s2", { mtimeMs: BASE_MS + 100_000_000 });

    const { state, res } = mockRes();
    await getHandler({ query: {} } as unknown as Request, res);

    assert.equal(state.status, 200);
    const { body } = state;
    assert.ok(body);
    assert.equal(body.sessions.length, 2);
    assert.deepEqual(body.deletedIds, [], "deletedIds is always [] today");
    assert.ok(body.cursor.startsWith("v1:"), `opaque cursor, got: ${body.cursor}`);
    assert.equal(body.cursor, encodeCursor(BASE_MS + 100_000_000));
  });

  it("sorts newest updatedAt first", async () => {
    await writeSession("older", { mtimeMs: BASE_MS });
    await writeSession("newer", { mtimeMs: BASE_MS + 500_000_000 });

    const { state, res } = mockRes();
    await getHandler({ query: {} } as unknown as Request, res);
    assert.ok(state.body);
    const ids = state.body.sessions.map((sess) => sess.id);
    assert.deepEqual(ids, ["newer", "older"]);
  });
});

describe("GET /api/sessions?since=<cursor> — incremental fetch", () => {
  it("omits sessions whose changeMs <= cursor", async () => {
    await writeSession("old", { mtimeMs: BASE_MS });
    await writeSession("new", { mtimeMs: BASE_MS + 200_000_000 });

    const { state, res } = mockRes();
    await getHandler(
      {
        query: { since: encodeCursor(BASE_MS + 100_000_000) },
      } as unknown as Request,
      res,
    );
    assert.ok(state.body);
    const ids = state.body.sessions.map((sess) => sess.id);
    assert.deepEqual(ids, ["new"]);
  });

  it("includes a session whose chat-index indexedAt bumped past cursor (mtime alone would miss it)", async () => {
    await writeSession("summarised", {
      mtimeMs: BASE_MS,
      indexedAtMs: BASE_MS + 500_000_000,
    });

    const { state, res } = mockRes();
    await getHandler(
      {
        query: { since: encodeCursor(BASE_MS + 100_000_000) },
      } as unknown as Request,
      res,
    );
    assert.ok(state.body);
    const ids = state.body.sessions.map((sess) => sess.id);
    assert.deepEqual(ids, ["summarised"]);
    // The returned cursor must advance to the indexedAt time, not
    // just the mtime, so the next call won't re-fetch this row.
    assert.equal(state.body.cursor, encodeCursor(BASE_MS + 500_000_000));
  });

  it("returns an empty diff when nothing has changed since cursor", async () => {
    await writeSession("s", { mtimeMs: BASE_MS });

    const { state, res } = mockRes();
    await getHandler(
      {
        query: { since: encodeCursor(BASE_MS + 100_000_000) },
      } as unknown as Request,
      res,
    );
    assert.ok(state.body);
    assert.deepEqual(state.body.sessions, []);
    // Cursor is echoed to the server's view of the max change —
    // same or higher than the client's — so subsequent idempotent
    // calls keep getting empty diffs.
    assert.equal(state.body.cursor, encodeCursor(BASE_MS));
  });

  it("falls back to a full resend when the cursor is malformed", async () => {
    await writeSession("a", { mtimeMs: BASE_MS });
    await writeSession("b", { mtimeMs: BASE_MS + 100_000_000 });

    const { state, res } = mockRes();
    await getHandler({ query: { since: "not-a-cursor" } } as unknown as Request, res);
    assert.ok(state.body);
    assert.equal(state.body.sessions.length, 2);
  });

  it("round-trips: feed the returned cursor back in → empty diff", async () => {
    await writeSession("a", { mtimeMs: BASE_MS });

    const first = mockRes();
    await getHandler({ query: {} } as unknown as Request, first.res);
    assert.ok(first.state.body);
    const { cursor } = first.state.body;

    const second = mockRes();
    await getHandler({ query: { since: cursor } } as unknown as Request, second.res);
    assert.ok(second.state.body);
    assert.deepEqual(second.state.body.sessions, []);
  });
});

// ── POST /api/sessions/:id/mark-read ──────────────────────────

function mockMarkReadRes() {
  const state: { status: number; body: { ok: boolean } | undefined } = {
    status: 200,
    body: undefined,
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: { ok: boolean }) {
      state.body = payload;
      return res;
    },
  };
  return { state, res: res as unknown as Response };
}

describe("POST /api/sessions/:id/mark-read", () => {
  it("returns { ok: true } for a session that exists on disk", async () => {
    await writeSession("s1", { mtimeMs: BASE_MS });
    const { state, res } = mockMarkReadRes();
    await markReadHandler({ params: { id: "s1" } } as unknown as Request, res);
    assert.equal(state.status, 200);
    assert.deepEqual(state.body, { ok: true });
  });

  it("succeeds even when no session file exists (graceful no-op)", async () => {
    const { state, res } = mockMarkReadRes();
    await markReadHandler({ params: { id: "nonexistent" } } as unknown as Request, res);
    assert.equal(state.status, 200);
    assert.deepEqual(state.body, { ok: true });
  });

  it("persists hasUnread=false to the meta .json file", async () => {
    // Write a meta with hasUnread=true
    const metaPath = path.join(chatDir, "s1.json");
    await writeFile(metaPath, JSON.stringify({ roleId: "general", hasUnread: true }));
    await writeFile(path.join(chatDir, "s1.jsonl"), "");

    const { res } = mockMarkReadRes();
    await markReadHandler({ params: { id: "s1" } } as unknown as Request, res);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    assert.equal(meta.hasUnread, false);
  });
});

// `readSessionMeta` used to gate on `meta?.roleId && meta?.startedAt` — a truthy
// test, so a corrupt row with empty strings was skipped. Replacing that with a
// type guard is only equivalent if the guard keeps the non-empty invariant;
// `typeof x === "string"` alone would start letting those rows into the list.
// Both read paths are covered because they narrow independently.
describe("GET /api/sessions — corrupt meta rows are skipped", () => {
  it("skips a .json meta whose roleId/startedAt are empty strings", async () => {
    await writeFile(path.join(chatDir, "empty-meta.json"), JSON.stringify({ roleId: "", startedAt: "" }));
    await writeFile(path.join(chatDir, "empty-meta.jsonl"), "");

    const { state, res } = mockRes();
    await getHandler({ query: {} } as unknown as Request, res);

    const ids = (state.body?.sessions ?? []).map((session) => session.id);
    assert.ok(!ids.includes("empty-meta"), `corrupt session leaked into the list: ${ids.join(", ")}`);
  });

  it("skips a legacy .jsonl first line whose roleId/startedAt are empty strings", async () => {
    // No .json meta at all, so the handler falls through to the legacy path.
    await writeFile(path.join(chatDir, "legacy-empty.jsonl"), `${JSON.stringify({ roleId: "", startedAt: "" })}\n`);

    const { state, res } = mockRes();
    await getHandler({ query: {} } as unknown as Request, res);

    const ids = (state.body?.sessions ?? []).map((session) => session.id);
    assert.ok(!ids.includes("legacy-empty"), `corrupt legacy session leaked into the list: ${ids.join(", ")}`);
  });

  it("still lists a session whose meta is well-formed", async () => {
    await writeSession("good-meta", { mtimeMs: BASE_MS });

    const { state, res } = mockRes();
    await getHandler({ query: {} } as unknown as Request, res);

    const ids = (state.body?.sessions ?? []).map((session) => session.id);
    assert.ok(ids.includes("good-meta"), `well-formed session missing: ${ids.join(", ")}`);
  });
});

// The scan caches each session's file-derived meta, keyed by the mtimes it
// stats anyway (#2588). The dangerous failure is a HIT that should have been a
// miss: the sidebar would then keep showing a title the file no longer has,
// and nothing would ever correct it. These drive the real handler twice with a
// mutation in between, which is the only way that shows up.
describe("GET /api/sessions — the meta cache cannot serve a changed file", () => {
  const previewOf = (body: { sessions: { id: string; preview: string }[] } | undefined, sessionId: string): string | undefined =>
    body?.sessions.find((session) => session.id === sessionId)?.preview;

  it("serves the new title after the meta is rewritten", async () => {
    await writeSession("renamed", { mtimeMs: BASE_MS, firstUserMessage: "before" });

    const first = mockRes();
    await getHandler({ query: {} } as unknown as Request, first.res);
    assert.equal(previewOf(first.state.body, "renamed"), "before");

    // Rewrite with a LATER mtime, as any real write would.
    const metaPath = path.join(chatDir, "renamed.json");
    await writeFile(metaPath, JSON.stringify({ roleId: "general", startedAt: new Date(BASE_MS).toISOString(), firstUserMessage: "after" }));
    const laterSecs = (BASE_MS + 60_000) / 1000;
    await utimes(metaPath, laterSecs, laterSecs);

    const second = mockRes();
    await getHandler({ query: {} } as unknown as Request, second.res);
    assert.equal(previewOf(second.state.body, "renamed"), "after", "the cache served a meta the file no longer holds");
  });

  it("drops a session from the list once its files are gone", async () => {
    await writeSession("vanishing", { mtimeMs: BASE_MS });

    const first = mockRes();
    await getHandler({ query: {} } as unknown as Request, first.res);
    assert.ok(previewOf(first.state.body, "vanishing"), "precondition: the session was listed");

    await rm(path.join(chatDir, "vanishing.jsonl"));
    await rm(path.join(chatDir, "vanishing.json"));

    const second = mockRes();
    await getHandler({ query: {} } as unknown as Request, second.res);
    assert.equal(previewOf(second.state.body, "vanishing"), undefined, "a deleted session must not survive in the cache");
  });

  it("keeps serving the other sessions across scans", async () => {
    await writeSession("stable-a", { mtimeMs: BASE_MS, firstUserMessage: "A" });
    await writeSession("stable-b", { mtimeMs: BASE_MS, firstUserMessage: "B" });

    for (const pass of [1, 2]) {
      const { state, res } = mockRes();
      await getHandler({ query: {} } as unknown as Request, res);
      assert.equal(previewOf(state.body, "stable-a"), "A", `pass ${pass}`);
      assert.equal(previewOf(state.body, "stable-b"), "B", `pass ${pass}`);
    }
  });
});
