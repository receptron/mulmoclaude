// Route-level checks for presentDocument's two forms on
// POST /api/markdown.
//
//   - `markdown` → fills image placeholders, saves a NEW file under
//     `artifacts/documents/YYYY/MM/`, returns that path.
//   - `path`     → presents an EXISTING file in place; nothing is
//     written, and `data.markdown` carries the caller's path verbatim so
//     the View's edits (PUT /api/markdown/update) land on that file.
//
// Driven with plain Request / Response mocks rather than an Express +
// supertest harness, matching `test_canvasImageRoutes.ts`. HOME is
// redirected to a tmp dir BEFORE the route module is imported so
// `workspacePath` resolves inside the sandbox.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "fs";
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Request, Response } from "express";
import { isolateHome } from "../helpers/isolatedHome.js";

type PluginsModule = typeof import("../../server/api/routes/plugins.js");

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
  message?: string;
  instructions?: string;
  title?: string;
  data?: { markdown: string; docPath?: string; filenamePrefix?: string };
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

function req(body: unknown): Request {
  return { body, params: {} } as unknown as Request;
}

const EXISTING_REL = "artifacts/documents/2026/07/existing-test123.md";
const EXISTING_BODY = "# Existing\n\nAlready on disk.\n";
// A DIRECTORY whose name ends in `.md` — passes a bare existence check but
// makes the View's subsequent read fail with EISDIR.
const DIR_REL = "artifacts/documents/2026/07/directory-test123.md";
// A well-named entry inside the workspace that resolves OUTSIDE it.
const SYMLINK_REL = "artifacts/documents/2026/07/symlink-test123.md";
// A workspace document that is NOT an artifact this app wrote.
const OUTSIDE_ARTIFACTS_REL = "docs/design.md";

let tmpRoot: string;
let workspaceDir: string;
let documentsDir: string;
let restoreHome: () => void = () => {};
let createHandler: Handler;
let updateHandler: Handler;
// Assigned in `before` — a path outside the workspace entirely.
let outsideAbsolutePath: string;

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-present-document-route-"));
  restoreHome = isolateHome(tmpRoot);

  const { workspacePath } = await import("../../server/workspace/workspace.js");
  const { WORKSPACE_DIRS } = await import("../../server/workspace/paths.js");
  workspaceDir = workspacePath;
  documentsDir = path.join(workspaceDir, WORKSPACE_DIRS.markdowns);
  mkdirSync(path.join(workspaceDir, path.dirname(EXISTING_REL)), { recursive: true });
  await writeFile(path.join(workspaceDir, EXISTING_REL), EXISTING_BODY, "utf-8");
  mkdirSync(path.join(workspaceDir, DIR_REL), { recursive: true });
  const outsideFile = path.join(tmpRoot, "outside-secret.md");
  await writeFile(outsideFile, "# secret\n", "utf-8");
  await symlink(outsideFile, path.join(workspaceDir, SYMLINK_REL));
  mkdirSync(path.join(workspaceDir, path.dirname(OUTSIDE_ARTIFACTS_REL)), { recursive: true });
  await writeFile(path.join(workspaceDir, OUTSIDE_ARTIFACTS_REL), "# design\n", "utf-8");
  outsideAbsolutePath = path.join(tmpRoot, "elsewhere", "notes.md");
  mkdirSync(path.dirname(outsideAbsolutePath), { recursive: true });
  await writeFile(outsideAbsolutePath, "# elsewhere\n", "utf-8");

  const pluginsMod: PluginsModule = await import("../../server/api/routes/plugins.js");
  createHandler = extractRouteHandler(pluginsMod, "/api/markdown", "post");
  updateHandler = extractRouteHandler(pluginsMod, "/api/markdown/update", "put");
});

after(async () => {
  restoreHome();
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Every `.md` currently under `artifacts/documents/YYYY/MM/`. Used to prove
 *  the `path` form writes nothing. */
async function documentFiles(): Promise<string[]> {
  const dir = path.join(documentsDir, "2026", "07");
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

describe("POST /api/markdown — `path` form", () => {
  it("presents the existing file in place, writing nothing", async () => {
    const filesBefore = await documentFiles();
    const { state, res } = mockRes();
    await createHandler(req({ title: "Report", path: EXISTING_REL }), res);

    assert.equal(state.status, 200);
    assert.equal(state.body?.data?.markdown, EXISTING_REL, "data.markdown must carry the caller's path verbatim");
    assert.deepEqual(await documentFiles(), filesBefore, "the `path` form must not create a copy");
  });

  it("rejects a path together with markdown", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", markdown: "# hi", path: EXISTING_REL }), res);

    assert.equal(state.status, 400);
    assert.match(state.body?.error ?? "", /not both/);
  });

  it("rejects neither markdown nor path", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T" }), res);

    assert.equal(state.status, 400);
    assert.match(state.body?.error ?? "", /either `markdown` or `path`/);
  });

  it("rejects a traversal path", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: "artifacts/documents/../../secrets.md" }), res);

    assert.equal(state.status, 400);
  });

  // The widening: a document this app did not write is presented the same way.
  it("presents a workspace file outside artifacts/documents/", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: OUTSIDE_ARTIFACTS_REL }), res);

    assert.equal(state.status, 200);
    assert.equal(state.body?.data?.docPath, OUTSIDE_ARTIFACTS_REL);
  });

  it("presents an absolute path outside the workspace", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: outsideAbsolutePath }), res);

    assert.equal(state.status, 200, "absolute paths are the documented behaviour, not an escape to refuse");
    assert.equal(state.body?.data?.docPath, outsideAbsolutePath);
  });

  it("rejects a non-markdown path", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: "docs/design.txt" }), res);

    assert.equal(state.status, 400);
  });

  it("rejects a path whose file does not exist", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: "artifacts/documents/2026/07/gone-zzz999.md" }), res);

    assert.equal(state.status, 400);
    assert.match(state.body?.error ?? "", /No document exists/);
  });

  it("rejects a directory that merely ends in .md", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: DIR_REL }), res);

    assert.equal(state.status, 400, "a directory would fail the View's read — reject it at present time");
  });

  // Containment was dropped deliberately when `path` was widened to any file
  // on disk: a symlink out of the workspace is no different from naming the
  // target directly, which is now allowed.
  it("follows a symlink pointing outside the workspace", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", path: SYMLINK_REL }), res);

    assert.equal(state.status, 200);
  });
});

describe("PUT /api/markdown/update — write-back", () => {
  it("overwrites a workspace file the view was pointed at", async () => {
    const { state, res } = mockRes();
    await updateHandler(req({ relativePath: OUTSIDE_ARTIFACTS_REL, markdown: "# edited\n" }), res);

    assert.equal(state.status, 200);
    assert.equal(await readFile(path.join(workspaceDir, OUTSIDE_ARTIFACTS_REL), "utf-8"), "# edited\n");
  });

  it("overwrites a file outside the workspace by absolute path", async () => {
    const { state, res } = mockRes();
    await updateHandler(req({ relativePath: outsideAbsolutePath, markdown: "# edited elsewhere\n" }), res);

    assert.equal(state.status, 200);
    assert.equal(await readFile(outsideAbsolutePath, "utf-8"), "# edited elsewhere\n");
  });

  it("refuses to CREATE a document at a path that does not exist", async () => {
    const target = path.join(workspaceDir, "docs", "never-written.md");
    const { state, res } = mockRes();
    await updateHandler(req({ relativePath: "docs/never-written.md", markdown: "# nope\n" }), res);

    // A stale view or a wrong path is a client error, not a server fault —
    // same status presentHtml's update route returns for the same race.
    assert.equal(state.status, 400);
    await assert.rejects(readFile(target, "utf-8"), "a write to a vanished path must not scatter a new file");
  });

  it("refuses a non-markdown path", async () => {
    const { state, res } = mockRes();
    await updateHandler(req({ relativePath: "docs/design.txt", markdown: "# nope\n" }), res);

    assert.equal(state.status, 400);
  });

  // An atomic write renames a temp file into place, so writing THROUGH a
  // symlink would replace the link with a regular file and leave the document
  // the user was editing untouched.
  it("writes through a symlink to its target, leaving the link a link", async () => {
    const { state, res } = mockRes();
    await updateHandler(req({ relativePath: SYMLINK_REL, markdown: "# via symlink\n" }), res);

    assert.equal(state.status, 200);
    const linkPath = path.join(workspaceDir, SYMLINK_REL);
    assert.equal(await readFile(path.join(tmpRoot, "outside-secret.md"), "utf-8"), "# via symlink\n", "the target receives the edit");
    assert.ok((await lstat(linkPath)).isSymbolicLink(), "the link itself must survive the write");
  });
});

describe("POST /api/markdown — `markdown` form", () => {
  it("saves a new document under the given prefix", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", markdown: "# New\n", filenamePrefix: "my-report" }), res);

    assert.equal(state.status, 200);
    assert.match(state.body?.data?.markdown ?? "", /^artifacts\/documents\/\d{4}\/\d{2}\/my-report-[0-9a-z]+\.md$/);
  });

  // `filenamePrefix` became conditional when `path` arrived, so a caller
  // reading `required` may omit it. The route defaults instead of 400-ing,
  // matching the shared plugin core.
  it("defaults the prefix when it is omitted", async () => {
    const { state, res } = mockRes();
    await createHandler(req({ title: "T", markdown: "# New\n" }), res);

    assert.equal(state.status, 200);
    assert.match(state.body?.data?.markdown ?? "", /^artifacts\/documents\/\d{4}\/\d{2}\/document-[0-9a-z]+\.md$/);
  });
});
