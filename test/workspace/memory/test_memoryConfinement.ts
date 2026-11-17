// Memory reaches the agent's system prompt every turn, so only regular files inside the workspace are read: a memory
// folder or file that leads out of it contributes nothing, and a FIFO does not hang the turn.

import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildMemoryContext } from "../../../server/agent/prompt.js";
import { migrateLegacyMemory } from "../../../server/workspace/memory/migrate.js";
import { seedTopicLayoutIfFresh } from "../../../server/workspace/memory/seed-topic-layout-run.js";
import { loadMemorySnapshot } from "../../../server/workspace/memory/snapshot.js";
import { countClusterInput } from "../../../server/workspace/memory/topic-migrate.js";
import { WORKSPACE_DIRS, WORKSPACE_FILES } from "../../../server/workspace/paths.js";

const POSIX_ONLY = process.platform === "win32" ? "symlinks and FIFOs need POSIX" : false;
const OUTSIDE_TEXT = "OUTSIDE_SECRET";

interface Fixture {
  workspace: string;
  memory: string;
  outside: string;
}

function makeFixture(context: TestContext): Fixture {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "memory-confine-")));
  const workspace = path.join(base, "ws");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(workspace, WORKSPACE_DIRS.memoryDir), { recursive: true });
  mkdirSync(outside);
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return { workspace, memory: path.join(workspace, WORKSPACE_DIRS.memoryDir), outside };
}

const topicFile = (type: string, topic: string, heading: string): string => `---\ntype: ${type}\ntopic: ${topic}\n---\n\n## ${heading}\n\n- note\n`;
const atomicEntry = (name: string, body: string): string => `---\nname: ${name}\ndescription: about ${name}\ntype: fact\n---\n\n${body}\n`;

function writeAt(absPath: string, text: string): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, text);
}

async function memoryPromptOf(workspace: string): Promise<string> {
  return buildMemoryContext(await loadMemorySnapshot(workspace), workspace);
}

describe("memory reads stay inside the workspace", () => {
  it("lists a topic file of a plain workspace", async (context) => {
    const { workspace, memory } = makeFixture(context);
    writeAt(path.join(memory, "fact", "kept.md"), topicFile("fact", "kept", "Kept heading"));
    assert.match(await memoryPromptOf(workspace), /Kept heading/);
  });

  it("reads a topic file linked to another file inside the workspace", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, memory } = makeFixture(context);
    writeAt(path.join(workspace, "notes", "kept.md"), topicFile("fact", "kept", "Linked heading"));
    mkdirSync(path.join(memory, "fact"));
    symlinkSync(path.join(workspace, "notes", "kept.md"), path.join(memory, "fact", "kept.md"));
    assert.match(await memoryPromptOf(workspace), /Linked heading/);
  });

  it("skips a topic file linked outside", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, memory, outside } = makeFixture(context);
    writeAt(path.join(outside, "secret.md"), topicFile("fact", "secret", OUTSIDE_TEXT));
    mkdirSync(path.join(memory, "fact"));
    symlinkSync(path.join(outside, "secret.md"), path.join(memory, "fact", "secret.md"));
    assert.doesNotMatch(await memoryPromptOf(workspace), new RegExp(OUTSIDE_TEXT));
  });

  it("skips a type folder linked outside", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, memory, outside } = makeFixture(context);
    mkdirSync(path.join(memory, "fact"));
    writeAt(path.join(outside, "secret.md"), topicFile("preference", "secret", OUTSIDE_TEXT));
    symlinkSync(outside, path.join(memory, "preference"));
    assert.doesNotMatch(await memoryPromptOf(workspace), new RegExp(OUTSIDE_TEXT));
  });

  it("skips a memory folder linked outside", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, memory, outside } = makeFixture(context);
    rmSync(memory, { recursive: true });
    writeAt(path.join(outside, "fact", "secret.md"), topicFile("fact", "secret", OUTSIDE_TEXT));
    symlinkSync(outside, memory);
    assert.doesNotMatch(await memoryPromptOf(workspace), new RegExp(OUTSIDE_TEXT));
  });

  it("skips an atomic entry linked outside", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, memory, outside } = makeFixture(context);
    writeAt(path.join(memory, "kept.md"), atomicEntry("kept", "inside body"));
    writeAt(path.join(outside, "secret.md"), atomicEntry("secret", OUTSIDE_TEXT));
    symlinkSync(path.join(outside, "secret.md"), path.join(memory, "secret.md"));
    const prompt = await memoryPromptOf(workspace);
    assert.match(prompt, /inside body/);
    assert.doesNotMatch(prompt, new RegExp(OUTSIDE_TEXT));
  });

  it("returns instead of blocking on a FIFO topic file", { skip: POSIX_ONLY }, async (context) => {
    const { workspace, memory } = makeFixture(context);
    writeAt(path.join(memory, "fact", "kept.md"), topicFile("fact", "kept", "Kept heading"));
    execFileSync("mkfifo", [path.join(memory, "fact", "pipe.md")]);
    assert.match(await memoryPromptOf(workspace), /Kept heading/);
  });
});

// The single-file memory.md is migrated into memory files at startup; one that leads outside must not be copied in.
describe("legacy memory.md migration stays inside the workspace", () => {
  const LEGACY_TEXT = `# Memory\n\n## Facts\n\n- ${OUTSIDE_TEXT} bullet\n`;
  const classifyAsFact = async (): Promise<{ type: "fact" }> => ({ type: "fact" });

  function linkLegacyOut({ workspace, outside }: Fixture): void {
    writeAt(path.join(outside, "memory.md"), LEGACY_TEXT);
    symlinkSync(path.join(outside, "memory.md"), path.join(workspace, WORKSPACE_FILES.memory));
  }

  it("migrates a plain memory.md", async (context) => {
    const fixture = makeFixture(context);
    writeAt(path.join(fixture.workspace, WORKSPACE_FILES.memory), LEGACY_TEXT);
    const result = await migrateLegacyMemory(fixture.workspace, classifyAsFact);
    assert.equal(result.written.fact, 1);
  });

  it("does not migrate, count or keep a memory.md linked outside", { skip: POSIX_ONLY }, async (context) => {
    const fixture = makeFixture(context);
    linkLegacyOut(fixture);
    assert.equal(await countClusterInput(fixture.workspace), 0);
    const result = await migrateLegacyMemory(fixture.workspace, classifyAsFact);
    assert.equal(result.noop, true);
    assert.deepEqual(readdirSync(fixture.memory), []);
  });

  it("seeds the topic layout when the only memory is a memory.md linked outside", { skip: POSIX_ONLY }, (context) => {
    const fixture = makeFixture(context);
    linkLegacyOut(fixture);
    assert.equal(seedTopicLayoutIfFresh(fixture.workspace), true);
    assert.equal(existsSync(path.join(fixture.memory, "fact")), true);
  });
});
