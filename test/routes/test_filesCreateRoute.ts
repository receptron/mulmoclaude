// Route-level checks for POST /api/files/create — the File Explorer
// "New file" context-menu endpoint (#1598).
//
// Mirrors test_filesPutRoute.ts's harness: plain Request / Response
// mocks, HOME redirected to a tmp dir before the route module loads
// so the workspace path is sandboxed.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Request, Response } from "express";
import { isolateHome } from "../helpers/isolatedHome.js";

type RouteModule = typeof import("../../server/api/routes/files.js");

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

interface ErrorBody {
  error: string;
}
interface WriteBody {
  path: string;
  size: number;
  modifiedMs: number;
}
type ResBody = ErrorBody | WriteBody;

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

let tmpRoot: string;
let workspaceDir: string;
let restoreHome: () => void = () => {};
let createHandler: Handler;

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-files-create-route-"));
  restoreHome = isolateHome(tmpRoot);
  const { workspacePath: workspacePth } = await import("../../server/workspace/workspace.js");
  workspaceDir = workspacePth;
  mkdirSync(workspaceDir, { recursive: true });
  const routeMod = await import("../../server/api/routes/files.js");
  createHandler = extractRouteHandler(routeMod, "/api/files/create", "post");
});

after(async () => {
  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

async function resetWorkspace(): Promise<void> {
  for (const entry of readdirSync(workspaceDir)) {
    await rm(path.join(workspaceDir, entry), { recursive: true, force: true });
  }
}

beforeEach(async () => {
  await resetWorkspace();
});

function req(body: unknown): Request {
  return { body } as unknown as Request;
}

describe("POST /api/files/create — happy path", () => {
  it("creates an empty non-wiki file and returns the size + mtime", async () => {
    // Parent dir is created on demand by writeFileAtomic.
    mkdirSync(path.join(workspaceDir, "conversations", "summaries"), { recursive: true });
    const { state, res } = mockRes();
    await createHandler(req({ path: "conversations/summaries/2026-06.md", content: "" }), res);
    assert.equal(state.status, 200, `expected 200, got ${state.status} with body=${JSON.stringify(state.body)}`);
    const body = state.body as WriteBody;
    assert.equal(body.path, "conversations/summaries/2026-06.md");
    assert.equal(body.size, 0);
    assert.ok(typeof body.modifiedMs === "number" && body.modifiedMs > 0);
    const onDisk = await readFile(path.join(workspaceDir, body.path), "utf8");
    assert.equal(onDisk, "");
  });

  it("seeds frontmatter when creating a wiki page (writeWikiPage takes over)", async () => {
    // POSTing to data/wiki/pages routes through writeWikiPage which
    // adds the canonical frontmatter block — so even an "empty" wiki
    // page lands on disk with the metadata its consumers expect.
    mkdirSync(path.join(workspaceDir, "data", "wiki", "pages"), { recursive: true });
    const { state, res } = mockRes();
    await createHandler(req({ path: "data/wiki/pages/hello.md", content: "" }), res);
    assert.equal(state.status, 200);
    const body = state.body as WriteBody;
    assert.equal(body.path, "data/wiki/pages/hello.md");
    // Frontmatter pushes the on-disk size above zero — the route's
    // response reports the post-write stat.
    assert.ok(body.size > 0, `expected wiki frontmatter to take up bytes, got ${body.size}`);
    const onDisk = await readFile(path.join(workspaceDir, body.path), "utf8");
    assert.match(onDisk, /^---\n/, "wiki page should start with frontmatter");
  });

  it("creates a non-empty file when content is supplied", async () => {
    mkdirSync(path.join(workspaceDir, "artifacts", "documents"), { recursive: true });
    const { state, res } = mockRes();
    await createHandler(req({ path: "artifacts/documents/notes.md", content: "# Notes\n" }), res);
    assert.equal(state.status, 200);
    const onDisk = await readFile(path.join(workspaceDir, "artifacts/documents/notes.md"), "utf8");
    assert.equal(onDisk, "# Notes\n");
  });
});

describe("POST /api/files/create — conflict", () => {
  it("refuses with 409 when the target already exists", async () => {
    mkdirSync(path.join(workspaceDir, "data", "wiki", "pages"), { recursive: true });
    await writeFile(path.join(workspaceDir, "data/wiki/pages/dup.md"), "existing", "utf8");
    const { state, res } = mockRes();
    await createHandler(req({ path: "data/wiki/pages/dup.md", content: "" }), res);
    assert.equal(state.status, 409);
    // The existing content stays intact.
    const onDisk = await readFile(path.join(workspaceDir, "data/wiki/pages/dup.md"), "utf8");
    assert.equal(onDisk, "existing");
  });

  it("refuses with 409 (not 500) when the target is an existing directory", async () => {
    // `wx` write to a directory throws EISDIR — that's a client-visible
    // conflict, not a server error. Codex review on b08b37ba flagged
    // the original 500 fallthrough.
    mkdirSync(path.join(workspaceDir, "conversations", "summaries", "stuck.md"), { recursive: true });
    const { state, res } = mockRes();
    await createHandler(req({ path: "conversations/summaries/stuck.md", content: "" }), res);
    assert.equal(state.status, 409);
  });
});

describe("POST /api/files/create — security", () => {
  it("refuses an absolute path", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ path: "/etc/passwd", content: "" }), res);
    assert.equal(state.status, 400);
  });

  it("refuses a parent-traversal path", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ path: "../escape.md", content: "" }), res);
    assert.equal(state.status, 400);
  });

  it("refuses a binary-extension target", async () => {
    mkdirSync(path.join(workspaceDir, "artifacts", "images"), { recursive: true });
    const { state, res } = mockRes();
    await createHandler(req({ path: "artifacts/images/x.png", content: "" }), res);
    assert.equal(state.status, 400);
  });

  it("refuses every executable suffix the upload route refuses, though they still PREVIEW", async () => {
    // `/api/files/*` is exempt from bearer auth, and the upload route already
    // refuses these as "things a later double-click would execute" — so
    // authoring one through create is the same capability by another door.
    // `.sh` was reachable this way before the text set was widened.
    for (const name of ["deploy.sh", "run.bat", "run.cmd", "run.ps1"]) {
      const { state, res } = mockRes();
      await createHandler(req({ path: name, content: "echo hi" }), res);
      assert.equal(state.status, 400, `expected 400 for ${name}, got ${state.status}`);
      assert.match((state.body as ErrorBody).error, /not editable/i);
    }
  });

  it("refuses a sensitive basename (.env)", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ path: ".env", content: "SECRET=1" }), res);
    assert.equal(state.status, 400);
  });

  it("refuses a path that traverses a hidden directory (.git/)", async () => {
    mkdirSync(path.join(workspaceDir, ".git"), { recursive: true });
    const { state, res } = mockRes();
    await createHandler(req({ path: ".git/config", content: "" }), res);
    assert.equal(state.status, 400);
  });

  it("refuses a symlinked in-workspace folder that escapes the workspace", async () => {
    // Set up: workspace/data/escape -> tmpRoot/outside.
    // A naive containment check on `data/escape/file.md` would allow
    // it because the syntactic path stays under workspaceDir; the
    // realpath-walk in resolveNewFilePath must catch the escape.
    const outside = path.join(tmpRoot, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(path.join(workspaceDir, "data"), { recursive: true });
    await symlink(outside, path.join(workspaceDir, "data", "escape"));
    const { state, res } = mockRes();
    await createHandler(req({ path: "data/escape/leak.md", content: "secret" }), res);
    assert.equal(state.status, 400);
    // And the outside location stayed clean.
    let leaked = true;
    try {
      await readFile(path.join(outside, "leak.md"));
    } catch {
      leaked = false;
    }
    assert.equal(leaked, false, "symlink escape should not have written outside the workspace");
  });
});

describe("POST /api/files/create — validation", () => {
  it("refuses when `path` is missing", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ content: "hi" }), res);
    assert.equal(state.status, 400);
  });

  it("refuses when `content` is missing", async () => {
    mkdirSync(path.join(workspaceDir, "data", "wiki", "pages"), { recursive: true });
    const { state, res } = mockRes();
    await createHandler(req({ path: "data/wiki/pages/x.md" }), res);
    assert.equal(state.status, 400);
  });

  it("refuses invalid JSON content for a .json target", async () => {
    mkdirSync(path.join(workspaceDir, "artifacts", "stories"), { recursive: true });
    const { state, res } = mockRes();
    await createHandler(req({ path: "artifacts/stories/bad.json", content: "{not json" }), res);
    assert.equal(state.status, 400);
  });
});
