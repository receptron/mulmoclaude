// Route-level checks for GET /api/files/content and GET /api/files/raw: what they serve, and that a
// file swapped for a link out of its root after the path check is not what they read (#3573).
//
// The handlers are driven with a PassThrough standing in for the Response, so the raw stream has
// somewhere to pipe. HOME is redirected BEFORE the route module is imported: the workspace path is
// fixed at module load.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Request, Response } from "express";

type RouteModule = typeof import("../../server/api/routes/files.js");
type Handler = (req: Request, res: Response) => Promise<void> | void;

interface StackFrame {
  route?: { path: string; stack: { method: string; handle: Handler }[] };
}

function extractRouteHandler(mod: RouteModule, routePath: string, method: string): Handler {
  const router = mod.default as unknown as { stack: StackFrame[] };
  const layer = router.stack.find((frame) => frame.route?.path === routePath)?.route?.stack.find((stackLayer) => stackLayer.method === method);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${routePath} not registered`);
  return layer.handle;
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Starts the handler and returns once its synchronous part has run, with a promise of the reply. */
function start(handler: Handler, relPath: string, range?: string): Promise<Reply> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  const res = Object.assign(sink, {
    statusCode: 200,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    json(payload: unknown) {
      headers["content-type"] ??= "application/json";
      sink.end(JSON.stringify(payload));
      return res;
    },
  });
  sink.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<Reply>((resolve) => sink.on("end", () => resolve({ status: res.statusCode, headers, body: Buffer.concat(chunks).toString() })));
  const req = { query: { path: relPath }, headers: range === undefined ? {} : { range }, body: {} };
  const handled = Promise.resolve(handler(req as unknown as Request, res as unknown as Response));
  return handled.then(() => ended);
}

const INSIDE = "inside bytes";
const OUTSIDE = "outside bytes";

let tmpRoot: string;
let workspaceDir: string;
let outsideDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let contentHandler: Handler;
let rawHandler: Handler;

before(async () => {
  tmpRoot = await realpath(await mkdtemp(path.join(tmpdir(), "mulmo-files-read-route-")));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  const { workspacePath } = await import("../../server/workspace/workspace.js");
  workspaceDir = workspacePath;
  mkdirSync(workspaceDir, { recursive: true });
  outsideDir = path.join(tmpRoot, "outside");
  mkdirSync(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, "f.txt"), OUTSIDE);
  const routeMod = await import("../../server/api/routes/files.js");
  contentHandler = extractRouteHandler(routeMod, "/api/files/content", "get");
  rawHandler = extractRouteHandler(routeMod, "/api/files/raw", "get");
});

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(tmpRoot, { recursive: true, force: true });
});

// files.ts captured the workspace realpath at load, so the folder itself stays.
beforeEach(async () => {
  for (const entry of readdirSync(workspaceDir)) {
    await rm(path.join(workspaceDir, entry), { recursive: true, force: true });
  }
  mkdirSync(path.join(workspaceDir, "d"));
  await writeFile(path.join(workspaceDir, "d", "f.txt"), INSIDE);
});

describe("GET /api/files/content", () => {
  it("returns a text file with its size", async () => {
    const reply = await start(contentHandler, "d/f.txt");
    const { kind, size, content } = JSON.parse(reply.body);
    assert.deepEqual({ status: reply.status, kind, size, content }, { status: 200, kind: "text", size: INSIDE.length, content: INSIDE });
  });

  it("answers 404 for a missing file and 400 for a folder", async () => {
    assert.equal((await start(contentHandler, "d/missing.txt")).status, 404);
    assert.equal((await start(contentHandler, "d")).status, 400);
  });
});

describe("GET /api/files/raw", () => {
  it("streams the whole file with its length", async () => {
    const reply = await start(rawHandler, "d/f.txt");
    assert.deepEqual(
      { status: reply.status, length: reply.headers["content-length"], body: reply.body },
      { status: 200, length: String(INSIDE.length), body: INSIDE },
    );
  });

  it("serves a byte range as 206 and an unsatisfiable one as 416", async () => {
    const part = await start(rawHandler, "d/f.txt", "bytes=0-5");
    assert.deepEqual(
      { status: part.status, range: part.headers["content-range"], body: part.body },
      { status: 206, range: `bytes 0-5/${INSIDE.length}`, body: INSIDE.slice(0, 6) },
    );
    const beyond = await start(rawHandler, "d/f.txt", "bytes=9999-");
    assert.deepEqual({ status: beyond.status, range: beyond.headers["content-range"] }, { status: 416, range: `bytes */${INSIDE.length}` });
  });

  it("streams an empty file as an empty 200", async () => {
    await writeFile(path.join(workspaceDir, "d", "empty.txt"), "");
    const reply = await start(rawHandler, "d/empty.txt");
    assert.deepEqual({ status: reply.status, length: reply.headers["content-length"], body: reply.body }, { status: 200, length: "0", body: "" });
  });

  it("answers 404 for a missing file and 400 for a folder", async () => {
    assert.equal((await start(rawHandler, "d/missing.txt")).status, 404);
    assert.equal((await start(rawHandler, "d")).status, 400);
  });
});

const posixOnly = { skip: process.platform === "win32" ? "symlinks, FIFOs and file modes need POSIX" : false };

describe("a path swapped after the check", posixOnly, () => {
  // Synchronous, so the swap lands after the handler's check and before anything it awaits.
  function swapFileForLinkOut(): void {
    rmSync(path.join(workspaceDir, "d", "f.txt"));
    symlinkSync(path.join(outsideDir, "f.txt"), path.join(workspaceDir, "d", "f.txt"));
  }

  function swapFileForAnotherFile(): void {
    writeFileSync(path.join(workspaceDir, "d", "other.txt"), "other bytes");
    renameSync(path.join(workspaceDir, "d", "other.txt"), path.join(workspaceDir, "d", "f.txt"));
  }

  function swapFolderForLinkOut(): void {
    renameSync(path.join(workspaceDir, "d"), path.join(workspaceDir, "d.parked"));
    symlinkSync(outsideDir, path.join(workspaceDir, "d"));
  }

  for (const [name, handlerOf] of [
    ["content", () => contentHandler],
    ["raw", () => rawHandler],
  ] as const) {
    it(`${name}: a file replaced by a link out is not read`, async () => {
      const pending = start(handlerOf(), "d/f.txt");
      swapFileForLinkOut();
      const reply = await pending;
      assert.ok(!reply.body.includes(OUTSIDE), reply.body);
      assert.equal(reply.status, 404);
    });

    it(`${name}: a file replaced by another file is not read in its place`, async () => {
      const pending = start(handlerOf(), "d/f.txt");
      swapFileForAnotherFile();
      const reply = await pending;
      assert.ok(!reply.body.includes("other bytes"), reply.body);
      assert.equal(reply.status, 404);
    });

    it(`${name}: a folder replaced by a link out is not read`, async () => {
      const pending = start(handlerOf(), "d/f.txt");
      swapFolderForLinkOut();
      const reply = await pending;
      assert.ok(!reply.body.includes(OUTSIDE), reply.body);
      assert.equal(reply.status, 404);
    });
  }

  it("a link out in place before the request is refused as outside the workspace", async () => {
    swapFileForLinkOut();
    assert.equal((await start(rawHandler, "d/f.txt")).status, 400);
    assert.equal((await start(contentHandler, "d/f.txt")).status, 400);
  });

  it("a named pipe is refused as not a file, without blocking", async () => {
    execFileSync("mkfifo", [path.join(workspaceDir, "d", "pipe.txt")]);
    assert.equal((await start(rawHandler, "d/pipe.txt")).status, 400);
    assert.equal((await start(contentHandler, "d/pipe.txt")).status, 400);
  });
});

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("an unreadable file", { skip: process.platform === "win32" || asRoot ? "file modes are not enforced here" : false }, () => {
  it("raw answers 500 with a JSON body, whatever the Range", async () => {
    const file = path.join(workspaceDir, "d", "f.txt");
    chmodSync(file, 0o000);
    try {
      for (const range of [undefined, "bytes=0-1", "bytes=9999-"]) {
        const reply = await start(rawHandler, "d/f.txt", range);
        assert.deepEqual({ status: reply.status, type: reply.headers["content-type"] }, { status: 500, type: "application/json" }, String(range));
      }
      assert.equal((await start(contentHandler, "d/f.txt")).status, 500);
    } finally {
      chmodSync(file, 0o600);
    }
  });
});
