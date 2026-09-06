// `/api/mindmap` used to hand every call an empty context, so `add_node` had no
// map to add to: in MulmoClaude a plugin's `execute()` never runs in the client,
// and the create's result lived only in the session (#2754).
import { describe, it, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Request } from "express";
import { sessionToolContext } from "../../server/api/routes/plugins.ts";
import { __resetForTests, getOrCreateSession, initSessionStore, pushToolResult } from "../../server/events/session-store/index.ts";
import { TOOL_NAMES } from "../../src/config/toolNames.ts";

const NOW = "2026-08-03T00:00:00.000Z";

// A real file, not "/dev/null": `pushToolResult` awaits its append, and on
// Windows a leading-slash path resolves against the current drive, so the
// null device becomes `D:\dev\null` and the open fails (#2779).
let resultsFilePath = "";
let tmpRoot = "";

const session = (sessionId: string) => getOrCreateSession(sessionId, { roleId: "general", resultsFilePath, startedAt: NOW, updatedAt: NOW });

// The MCP bridge appends `?session=<id>` to every request, which is how the id
// reaches a plugin route at all.
const reqWith = (query: Record<string, unknown>) => ({ query }) as unknown as Request<object, unknown, unknown>;

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "session-tool-context-"));
  resultsFilePath = path.join(tmpRoot, "results.jsonl");
});
after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  __resetForTests();
  initSessionStore({ publish: () => {} } as unknown as Parameters<typeof initSessionStore>[0]);
});
afterEach(() => __resetForTests());

describe("sessionToolContext (#2754)", () => {
  it("passes the session's latest result for that tool", async () => {
    session("s1");
    await pushToolResult("s1", { toolName: TOOL_NAMES.createMindMap, message: "made a map", data: { nodes: ["root"] } });
    const context = sessionToolContext(reqWith({ session: "s1" }), TOOL_NAMES.createMindMap);
    assert.deepEqual(context.currentResult?.data, { nodes: ["root"] });
  });

  // Every fallback below is a legitimate create, not an error: the empty
  // context is what this route passed before and is still valid.
  it("falls back to an empty context when the session has no result for that tool", async () => {
    session("s1");
    await pushToolResult("s1", { toolName: TOOL_NAMES.putQuestions, message: "q", data: {} });
    assert.equal(sessionToolContext(reqWith({ session: "s1" }), TOOL_NAMES.createMindMap).currentResult, undefined);
  });

  it("falls back when the session is unknown", () => {
    assert.equal(sessionToolContext(reqWith({ session: "nope" }), TOOL_NAMES.createMindMap).currentResult, undefined);
  });

  it("falls back when no session id was sent at all", () => {
    assert.equal(sessionToolContext(reqWith({}), TOOL_NAMES.createMindMap).currentResult, undefined);
  });

  // #2758 generalised this past mindmap: every plugin route that used to get a
  // frozen empty context now gets its own tool's latest result. The risk of
  // widening it is one tool seeing another's state, so that is what is pinned.
  it("gives each wired tool its own result, and never another tool's", async () => {
    session("s1");
    await pushToolResult("s1", { toolName: TOOL_NAMES.putQuestions, message: "q", data: { quiz: 1 } });
    await pushToolResult("s1", { toolName: TOOL_NAMES.presentShapeScript, message: "3d", data: { scene: 2 } });
    const req = reqWith({ session: "s1" });
    assert.deepEqual(sessionToolContext(req, TOOL_NAMES.putQuestions).currentResult?.data, { quiz: 1 });
    assert.deepEqual(sessionToolContext(req, TOOL_NAMES.presentShapeScript).currentResult?.data, { scene: 2 });
    assert.equal(sessionToolContext(req, TOOL_NAMES.mapControl).currentResult, undefined, "an untouched tool stays on the empty context");
    assert.equal(sessionToolContext(req, TOOL_NAMES.createMindMap).currentResult, undefined);
  });

  it("does not leak another session's map", async () => {
    session("s1");
    session("s2");
    await pushToolResult("s1", { toolName: TOOL_NAMES.createMindMap, message: "m", data: { which: "s1" } });
    assert.equal(sessionToolContext(reqWith({ session: "s2" }), TOOL_NAMES.createMindMap).currentResult, undefined);
  });
});
