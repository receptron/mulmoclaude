// Files read into the system prompt come only from inside the workspace: a wiki or memory file that leads out of it
// contributes nothing, so its contents never reach the agent.

import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildMemoryContext, buildWikiContext } from "../../server/agent/prompt.js";
import { WORKSPACE_FILES } from "../../server/workspace/paths.js";
import type { MemorySnapshot } from "../../server/workspace/memory/snapshot.js";

const POSIX_ONLY = process.platform === "win32" ? "symlinks need POSIX" : false;
const EMPTY_ATOMIC_SNAPSHOT: MemorySnapshot = { format: "atomic", entries: [] };
const OUTSIDE_TEXT = "OUTSIDE SECRET";
const NO_WIKI_HINT = "No wiki exists yet";

interface Fixture {
  base: string;
  workspace: string;
  outside: string;
}

function makeFixture(context: TestContext): Fixture {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "prompt-confine-")));
  const workspace = path.join(base, "ws");
  const outside = path.join(base, "outside");
  [WORKSPACE_FILES.wikiIndex, WORKSPACE_FILES.wikiSummary, WORKSPACE_FILES.wikiSchema, WORKSPACE_FILES.memory].forEach((relPath) => {
    mkdirSync(path.dirname(path.join(workspace, relPath)), { recursive: true });
    writeFileSync(path.join(workspace, relPath), `inside ${path.basename(relPath)}\n`);
  });
  mkdirSync(outside);
  ["index.md", "summary.md", "SCHEMA.md", "memory.md"].forEach((name) => writeFileSync(path.join(outside, name), `${OUTSIDE_TEXT} ${name}\n`));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, workspace, outside };
}

const linkTo = (entry: string, target: string): void => {
  renameSync(entry, `${entry}.parked`);
  symlinkSync(target, entry);
};

describe("system prompt reads stay inside the workspace", () => {
  it("includes the wiki summary and legacy memory of a plain workspace", (context) => {
    const { workspace } = makeFixture(context);
    assert.match(buildWikiContext(workspace) ?? "", /inside summary\.md/);
    assert.match(buildMemoryContext(EMPTY_ATOMIC_SNAPSHOT, workspace), /inside memory\.md/);
  });

  it("reads files linked to other files inside the workspace", { skip: POSIX_ONLY }, (context) => {
    const { workspace } = makeFixture(context);
    linkTo(path.join(workspace, WORKSPACE_FILES.wikiSummary), path.join(workspace, `${WORKSPACE_FILES.wikiSummary}.parked`));
    linkTo(path.join(workspace, WORKSPACE_FILES.memory), path.join(workspace, `${WORKSPACE_FILES.memory}.parked`));
    assert.match(buildWikiContext(workspace) ?? "", /inside summary\.md/);
    assert.match(buildMemoryContext(EMPTY_ATOMIC_SNAPSHOT, workspace), /inside memory\.md/);
  });

  it("treats a wiki folder linked out as no wiki", { skip: POSIX_ONLY }, (context) => {
    const { workspace, outside } = makeFixture(context);
    linkTo(path.join(workspace, "data", "wiki"), outside);
    const wikiContext = buildWikiContext(workspace) ?? "";
    assert.match(wikiContext, new RegExp(NO_WIKI_HINT));
    assert.doesNotMatch(wikiContext, new RegExp(OUTSIDE_TEXT));
  });

  it("leaves out a summary or schema that links out", { skip: POSIX_ONLY }, (context) => {
    const { workspace, outside } = makeFixture(context);
    linkTo(path.join(workspace, WORKSPACE_FILES.wikiSummary), path.join(outside, "summary.md"));
    rmSync(path.join(workspace, WORKSPACE_FILES.wikiSchema));
    symlinkSync(path.join(outside, "SCHEMA.md"), path.join(workspace, WORKSPACE_FILES.wikiSchema));
    const wikiContext = buildWikiContext(workspace) ?? "";
    assert.doesNotMatch(wikiContext, new RegExp(OUTSIDE_TEXT));
    assert.doesNotMatch(wikiContext, /<reference type="wiki-summary">/);
    assert.doesNotMatch(wikiContext, /SCHEMA\.md/);
  });

  it("leaves out a legacy memory file that links out", { skip: POSIX_ONLY }, (context) => {
    const { workspace, outside } = makeFixture(context);
    linkTo(path.join(workspace, WORKSPACE_FILES.memory), path.join(outside, "memory.md"));
    assert.doesNotMatch(buildMemoryContext(EMPTY_ATOMIC_SNAPSHOT, workspace), new RegExp(OUTSIDE_TEXT));
  });

  it("does not throw on a summary that is a folder", (context) => {
    const { workspace } = makeFixture(context);
    rmSync(path.join(workspace, WORKSPACE_FILES.wikiSummary));
    mkdirSync(path.join(workspace, WORKSPACE_FILES.wikiSummary));
    assert.doesNotMatch(buildWikiContext(workspace) ?? "", /<reference type="wiki-summary">/);
  });
});
