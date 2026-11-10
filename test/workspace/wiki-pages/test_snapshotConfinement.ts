// Snapshot writes, reads and GC must stay inside the workspace when a folder above the slug's history dir is a
// link out (#3573).

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendSnapshot, gcSnapshots, listSnapshots, readSnapshot, SNAPSHOT_RETAIN_COUNT } from "../../../server/workspace/wiki-pages/snapshot.js";

const skipWithoutSymlinks = { skip: process.platform === "win32" ? "symlinks need POSIX" : false };
const SLUG = "page";
const OLD_STAMP = "2020-01-01T00-00-00-000Z-old";
const OLD_SNAPSHOT = "---\n_snapshot_ts: 2020-01-01T00:00:00.000Z\n---\n# outside\n";
// Far enough ahead that every seeded snapshot is past the age window, so GC would delete the oldest one.
const GC_NOW = new Date(Date.UTC(2030, 0, 1));
const NEWER_STAMPS = Array.from({ length: SNAPSHOT_RETAIN_COUNT }, (_, index) => `2021-01-01T00-00-00-000Z-n${index}`);

function seedHistory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  [OLD_STAMP, ...NEWER_STAMPS].forEach((stamp) => writeFileSync(path.join(dir, `${stamp}.md`), OLD_SNAPSHOT));
}

let base = "";
let workspace = "";
let wiki = "";
let outside = "";

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "snapshot-confine-")));
  workspace = path.join(base, "ws");
  wiki = path.join(workspace, "data", "wiki");
  outside = path.join(base, "outside");
  mkdirSync(path.join(wiki, ".history"), { recursive: true });
  seedHistory(path.join(outside, SLUG));
  seedHistory(path.join(outside, ".history", SLUG));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const append = (root = workspace): Promise<string> => appendSnapshot(SLUG, null, "---\n---\n# saved\n", { editor: "user" }, { workspaceRoot: root });

const outsideTree = (): string[] => readdirSync(outside, { recursive: true, encoding: "utf8" }).sort();

const linkOut = (folder: string, target: string): void => {
  renameSync(folder, `${folder}.parked`);
  symlinkSync(target, folder);
};

async function assertConfined(): Promise<void> {
  const before = outsideTree();
  await assert.rejects(append(), /leads outside the workspace/);
  assert.deepEqual(await listSnapshots(SLUG, { workspaceRoot: workspace }), []);
  assert.equal(await readSnapshot(SLUG, OLD_STAMP, { workspaceRoot: workspace }), null);
  await gcSnapshots(SLUG, GC_NOW, { workspaceRoot: workspace });
  assert.deepEqual(outsideTree(), before);
}

describe("snapshot history dir confinement", () => {
  it("writes and lists a snapshot in a plain workspace", async () => {
    const stamp = await append();
    assert.deepEqual(readdirSync(path.join(wiki, ".history", SLUG)), [`${stamp}.md`]);
    assert.equal((await listSnapshots(SLUG, { workspaceRoot: workspace })).length, 1);
  });

  it("makes the missing history folders", async () => {
    rmSync(path.join(wiki, ".history"), { recursive: true });
    const stamp = await append();
    assert.match(readFileSync(path.join(wiki, ".history", SLUG, `${stamp}.md`), "utf8"), /# saved\n$/);
  });

  it("works through a workspace reached by a link", skipWithoutSymlinks, async () => {
    const linkedRoot = path.join(base, "ws-link");
    symlinkSync(workspace, linkedRoot);
    const stamp = await append(linkedRoot);
    assert.equal((await readSnapshot(SLUG, stamp, { workspaceRoot: linkedRoot }))?.body, "# saved\n");
  });

  it("works through a history folder linked to a folder inside the workspace", skipWithoutSymlinks, async () => {
    const elsewhere = path.join(workspace, "elsewhere");
    mkdirSync(elsewhere);
    linkOut(path.join(wiki, ".history"), elsewhere);
    const stamp = await append();
    assert.deepEqual(readdirSync(path.join(elsewhere, SLUG)), [`${stamp}.md`]);
  });

  it("refuses a history folder linked out", skipWithoutSymlinks, async () => {
    linkOut(path.join(wiki, ".history"), outside);
    await assertConfined();
  });

  it("refuses a wiki folder linked out", skipWithoutSymlinks, async () => {
    linkOut(wiki, outside);
    await assertConfined();
  });

  it("creates no folder outside when the wiki folder links to a place without .history/", skipWithoutSymlinks, async () => {
    const bare = path.join(base, "bare");
    mkdirSync(bare);
    linkOut(wiki, bare);
    await assert.rejects(append(), /leads outside the workspace/);
    assert.deepEqual(readdirSync(bare), []);
  });
});
