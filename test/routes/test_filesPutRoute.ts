// Route-level checks for PUT /api/files/content — the editor-save
// endpoint added in #477 for the Files UI.
//
// We drive the handler with plain Request / Response mocks so we
// don't pay for an Express + supertest harness, mirroring the pattern
// established in test_sessionsRoute.ts. The workspace path is resolved
// from homedir() at module load, so HOME is redirected to a tmp
// dir BEFORE the route module is imported.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, promises, readdirSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
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
let putHandler: Handler;

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-files-put-route-"));
  restoreHome = isolateHome(tmpRoot);
  const { workspacePath: workspacePth } = await import("../../server/workspace/workspace.js");
  workspaceDir = workspacePth;
  mkdirSync(workspaceDir, { recursive: true });
  const routeMod = await import("../../server/api/routes/files.js");
  putHandler = extractRouteHandler(routeMod, "/api/files/content", "put");
});

after(async () => {
  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

async function resetWorkspace(): Promise<void> {
  // Clean workspace contents but keep the directory — files.ts
  // captured its realpath at module load, so rm'ing the whole thing
  // would leave the handler with a dangling reference.
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

describe("PUT /api/files/content — happy path", () => {
  it("overwrites an existing markdown file with the new content", async () => {
    const rel = "notes.md";
    await writeFile(path.join(workspaceDir, rel), "# old\n", "utf-8");

    const { state, res } = mockRes();
    await putHandler(req({ path: rel, content: "# new\nbody\n" }), res);

    assert.equal(state.status, 200);
    const body = state.body as WriteBody;
    assert.equal(body.path, rel);
    assert.equal(typeof body.size, "number");
    assert.equal(typeof body.modifiedMs, "number");

    const onDisk = await promises.readFile(path.join(workspaceDir, rel), "utf-8");
    assert.equal(onDisk, "# new\nbody\n");
  });

  it("writes UTF-8 content correctly (multi-byte characters)", async () => {
    const rel = "unicode.md";
    await writeFile(path.join(workspaceDir, rel), "old", "utf-8");

    const { state, res } = mockRes();
    await putHandler(req({ path: rel, content: "日本語テスト — em–dash" }), res);

    assert.equal(state.status, 200);
    const onDisk = await promises.readFile(path.join(workspaceDir, rel), "utf-8");
    assert.equal(onDisk, "日本語テスト — em–dash");
  });
});

describe("PUT /api/files/content — validation", () => {
  it("rejects a missing body entirely", async () => {
    const { state, res } = mockRes();
    await putHandler({ body: undefined } as unknown as Request, res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error, /path required/i);
  });

  it("rejects a missing path", async () => {
    const { state, res } = mockRes();
    await putHandler(req({ content: "x" }), res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error, /path required/i);
  });

  it("rejects an empty path string", async () => {
    const { state, res } = mockRes();
    await putHandler(req({ path: "", content: "x" }), res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error, /path required/i);
  });

  it("rejects a missing content field", async () => {
    await writeFile(path.join(workspaceDir, "a.md"), "x", "utf-8");
    const { state, res } = mockRes();
    await putHandler(req({ path: "a.md" }), res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error, /content required/i);
  });

  it("rejects a non-string content field", async () => {
    await writeFile(path.join(workspaceDir, "a.md"), "x", "utf-8");
    const { state, res } = mockRes();
    await putHandler(req({ path: "a.md", content: 42 }), res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error, /content required/i);
  });

  it("rejects content larger than the 1 MB preview limit", async () => {
    const rel = "big.md";
    await writeFile(path.join(workspaceDir, rel), "x", "utf-8");
    // One byte over the 1 MiB preview cap enforced by the handler.
    const oversized = "x".repeat(1024 * 1024 + 1);
    const { state, res } = mockRes();
    await putHandler(req({ path: rel, content: oversized }), res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error, /exceeds/i);
  });
});

describe("PUT /api/files/content — security", () => {
  it("rejects a path-traversal escape", async () => {
    const { state, res } = mockRes();
    await putHandler(req({ path: "../escape.md", content: "pwn" }), res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error, /outside workspace/i);
  });

  it("rejects a sensitive basename (.env)", async () => {
    // Pre-create the file so we'd otherwise reach the write step. The
    // rejection must fire on the name check, not the stat.
    await writeFile(path.join(workspaceDir, ".env"), "SECRET=1", "utf-8");
    const { state, res } = mockRes();
    await putHandler(req({ path: ".env", content: "SECRET=2" }), res);
    assert.equal(state.status, 400);
    // Verify the original content is unchanged.
    const onDisk = await promises.readFile(path.join(workspaceDir, ".env"), "utf-8");
    assert.equal(onDisk, "SECRET=1");
  });

  it("rejects an executable suffix even though it previews as text", async () => {
    // The preview gate and the write gate are deliberately different questions:
    // a `.sh` renders in the Files view, and cannot be overwritten through the
    // bearer-exempt file API — the same policy the upload route applies.
    for (const name of ["deploy.sh", "run.bat", "run.cmd", "run.ps1"]) {
      await writeFile(path.join(workspaceDir, name), "original", "utf-8");
      const { state, res } = mockRes();
      await putHandler(req({ path: name, content: "overwritten" }), res);
      assert.equal(state.status, 400, `expected 400 for ${name}, got ${state.status}`);
      assert.match((state.body as ErrorBody).error, /not editable/i);
      assert.equal(await promises.readFile(path.join(workspaceDir, name), "utf-8"), "original");
    }
  });

  it("rejects a binary-classified extension even when the file exists", async () => {
    const rel = "image.png";
    await writeFile(path.join(workspaceDir, rel), "\x89PNG...", "utf-8");
    const { state, res } = mockRes();
    await putHandler(req({ path: rel, content: "overwritten" }), res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error, /not editable/i);
  });
});

describe("PUT /api/files/content — missing targets", () => {
  it("returns 404 when the target file does not exist", async () => {
    const { state, res } = mockRes();
    await putHandler(req({ path: "new.md", content: "hello" }), res);
    assert.equal(state.status, 404);
    assert.match((state.body as ErrorBody).error, /not found/i);
  });

  it("returns 400 when the target is a directory", async () => {
    mkdirSync(path.join(workspaceDir, "adir"));
    const { state, res } = mockRes();
    await putHandler(req({ path: "adir", content: "x" }), res);
    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error, /not a file/i);
  });
});

describe("PUT /api/files/content — JSON validation (#833)", () => {
  it("rejects a syntactically invalid .json save with 400 and does not write to disk", async () => {
    const rel = "config.json";
    const original = '{\n  "a": 1\n}';
    await writeFile(path.join(workspaceDir, rel), original, "utf-8");

    const { state, res } = mockRes();
    await putHandler(req({ path: rel, content: "{ broken" }), res);

    assert.equal(state.status, 400);
    assert.match((state.body as ErrorBody).error, /invalid json/i);
    // The malformed body must never reach disk — the original stays.
    const onDisk = await promises.readFile(path.join(workspaceDir, rel), "utf-8");
    assert.equal(onDisk, original);
  });

  it("accepts a valid .json save", async () => {
    const rel = "config.json";
    await writeFile(path.join(workspaceDir, rel), "{}", "utf-8");

    const { state, res } = mockRes();
    await putHandler(req({ path: rel, content: '{\n  "theme": "dark"\n}' }), res);

    assert.equal(state.status, 200);
    const onDisk = await promises.readFile(path.join(workspaceDir, rel), "utf-8");
    assert.equal(onDisk, '{\n  "theme": "dark"\n}');
  });

  it("does not apply JSON validation to .jsonl (multi-document; whole-file parse would always fail)", async () => {
    const rel = "log.jsonl";
    await writeFile(path.join(workspaceDir, rel), '{"n":1}\n', "utf-8");

    const { state, res } = mockRes();
    // Two newline-delimited objects: not a single JSON value, so a
    // .json gate would reject it. .jsonl must remain writable.
    await putHandler(req({ path: rel, content: '{"n":1}\n{"n":2}\n' }), res);

    assert.equal(state.status, 200);
    const onDisk = await promises.readFile(path.join(workspaceDir, rel), "utf-8");
    assert.equal(onDisk, '{"n":1}\n{"n":2}\n');
  });
});
