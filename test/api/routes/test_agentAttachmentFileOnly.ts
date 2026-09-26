// A file whose type cannot become a content block (e.g. `.mpp`) must still
// reach the agent by path: the marker is emitted, no bytes are sent. A path
// that does not exist must not be announced at all.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

let workspaceRoot: string;
let originalHome: string | undefined;
let prepareRequestExtras: typeof import("../../../server/api/routes/agent.ts").prepareRequestExtras;
let saveAttachment: typeof import("../../../server/utils/files/attachment-store.ts").saveAttachment;

const PARTITION = "2026/09";
const FILE_ONLY_PATH = `data/attachments/${PARTITION}/0a1b2c3d4e5f6071.mpp.bin`;
const READABLE_PATH = `data/attachments/${PARTITION}/0a1b2c3d4e5f6072.csv`;
const MISSING_PATH = `data/attachments/${PARTITION}/0a1b2c3d4e5f6073.mpp.bin`;
const IMAGE_PATH = `artifacts/images/${PARTITION}/0a1b2c3d4e5f6074.png`;

before(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "mulmoclaude-attachment-file-only-"));
  originalHome = process.env.HOME;
  process.env.HOME = workspaceRoot;
  process.env.MULMOCLAUDE_WORKSPACE_PATH = workspaceRoot;

  const attachmentsDir = path.join(workspaceRoot, "data", "attachments", ...PARTITION.split("/"));
  await mkdir(attachmentsDir, { recursive: true });
  await writeFile(path.join(workspaceRoot, FILE_ONLY_PATH), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  await writeFile(path.join(workspaceRoot, READABLE_PATH), "a,b\n1,2\n", "utf-8");
  await mkdir(path.join(attachmentsDir, "subdir.mpp"));
  await mkdir(path.join(workspaceRoot, path.dirname(IMAGE_PATH)), { recursive: true });
  await writeFile(path.join(workspaceRoot, IMAGE_PATH), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  ({ prepareRequestExtras } = await import("../../../server/api/routes/agent.ts"));
  ({ saveAttachment } = await import("../../../server/utils/files/attachment-store.ts"));
});

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.MULMOCLAUDE_WORKSPACE_PATH;
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
});

describe("prepareRequestExtras — file-only attachments", () => {
  it("announces an existing unreadable file without sending its bytes", async () => {
    const out = await prepareRequestExtras([{ path: FILE_ONLY_PATH, filename: "工程表.mpp" }]);
    assert.deepEqual(out.attachedFiles, [{ path: FILE_ONLY_PATH, filename: "工程表.mpp" }]);
    assert.equal(out.attachments, undefined);
  });

  it("keeps readable and file-only entries apart in one turn", async () => {
    const out = await prepareRequestExtras([{ path: FILE_ONLY_PATH }, { path: READABLE_PATH }]);
    assert.deepEqual(
      out.attachedFiles.map((file) => file.path),
      [FILE_ONLY_PATH, READABLE_PATH],
    );
    assert.deepEqual(
      out.attachments?.map((att) => att.path),
      [READABLE_PATH],
    );
  });

  it("does not announce a path that does not exist", async () => {
    const out = await prepareRequestExtras([{ path: MISSING_PATH }]);
    assert.deepEqual(out.attachedFiles, []);
    assert.equal(out.attachments, undefined);
  });

  it("does not announce a directory", async () => {
    const out = await prepareRequestExtras([{ path: `data/attachments/${PARTITION}/subdir.mpp` }]);
    assert.deepEqual(out.attachedFiles, []);
  });

  it("does not announce a path outside the attachment store", async () => {
    const out = await prepareRequestExtras([{ path: "data/attachments/../../etc/passwd.mpp" }]);
    assert.deepEqual(out.attachedFiles, []);
  });
});

describe("prepareRequestExtras — the stored extension decides, not a declared MIME", () => {
  it("a .bin file stays file-only whatever MIME the entry declares", async () => {
    for (const mimeType of ["application/octet-stream", "text/plain", "application/pdf", "image/png"]) {
      const out = await prepareRequestExtras([{ path: FILE_ONLY_PATH, mimeType }]);
      assert.deepEqual(out.attachedFiles, [{ path: FILE_ONLY_PATH }], mimeType);
      assert.equal(out.attachments, undefined, mimeType);
    }
  });

  it("a readable file is loaded under its extension's MIME, not the declared one", async () => {
    const out = await prepareRequestExtras([{ path: READABLE_PATH, mimeType: "application/pdf" }]);
    assert.equal(out.attachments?.[0]?.mimeType, "text/csv");
  });

  it("a selected image is always image/png, whatever MIME the entry declares", async () => {
    const out = await prepareRequestExtras([{ path: IMAGE_PATH, mimeType: "text/plain" }]);
    assert.equal(out.attachments?.[0]?.mimeType, "image/png");
  });
});

describe("saveAttachment — unknown MIME round trip", () => {
  it("keeps the original extension as a hint, ends in .bin, and is announced file-only", async () => {
    const saved = await saveAttachment(Buffer.from("mpp-bytes").toString("base64"), "application/octet-stream", "schedule.mpp");
    assert.ok(saved.relativePath.endsWith(".mpp.bin"), saved.relativePath);
    const out = await prepareRequestExtras([{ path: saved.relativePath }]);
    assert.deepEqual(out.attachedFiles, [{ path: saved.relativePath }]);
    assert.equal(out.attachments, undefined);
  });

  it("a bridge-shaped entry (path + the saved MIME) is file-only too", async () => {
    const saved = await saveAttachment(Buffer.from("mpp-bytes").toString("base64"), "application/octet-stream", "schedule.mpp");
    const out = await prepareRequestExtras([{ path: saved.relativePath, mimeType: saved.mimeType, filename: "schedule.mpp" }]);
    assert.deepEqual(out.attachedFiles, [{ path: saved.relativePath, filename: "schedule.mpp" }]);
    assert.equal(out.attachments, undefined);
  });

  it("stores under .bin without a filename, as before", async () => {
    const saved = await saveAttachment(Buffer.from("x").toString("base64"), "application/octet-stream");
    assert.equal(path.posix.extname(saved.relativePath), ".bin");
  });
});
