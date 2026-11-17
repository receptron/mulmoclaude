// Memory reaches the agent's system prompt every turn, so only regular files inside the workspace are read: a memory
// folder or file that leads out of it contributes nothing, and a FIFO does not hang the turn.

import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildMemoryContext } from "../../../server/agent/prompt.js";
import { loadMemorySnapshot } from "../../../server/workspace/memory/snapshot.js";
import { WORKSPACE_DIRS } from "../../../server/workspace/paths.js";

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
