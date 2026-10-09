import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fsSync from "node:fs";
import osModule from "node:os";
import path from "node:path";

const SCRIPT_PATH = path.resolve("scripts", "repair-journal-session-links.ts");
const SESSION_ID = "aaa";
const BROKEN_LINK = `[s](../../../chat/${SESSION_ID}.jsonl)`;
const FIXED_LINK = `[s](../../chat/${SESSION_ID}.jsonl)`;

function runScript(workspace: string, ...flags: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, "--workspace", workspace, ...flags], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("repair-journal-session-links script", () => {
  let workspace = "";
  let topicFile = "";
  let binaryFile = "";
  const binaryBytes = Buffer.concat([Buffer.from("ok "), Buffer.from([0xff, 0xfe]), Buffer.from(` ${BROKEN_LINK}\n`)]);

  before(() => {
    workspace = fsSync.mkdtempSync(path.join(osModule.tmpdir(), "repair-links-"));
    fsSync.mkdirSync(path.join(workspace, "conversations", "chat"), { recursive: true });
    fsSync.mkdirSync(path.join(workspace, "conversations", "summaries", "topics"), { recursive: true });
    fsSync.writeFileSync(path.join(workspace, "conversations", "chat", `${SESSION_ID}.jsonl`), "");
    topicFile = path.join(workspace, "conversations", "summaries", "topics", "t.md");
    binaryFile = path.join(workspace, "conversations", "summaries", "topics", "bin.md");
    fsSync.writeFileSync(topicFile, `${BROKEN_LINK}\n`);
    fsSync.writeFileSync(binaryFile, binaryBytes);
  });

  after(() => fsSync.rmSync(workspace, { recursive: true, force: true }));

  it("dry run writes nothing, a real run repairs, a second run changes nothing", () => {
    const dryRunOutput = runScript(workspace, "--dry-run");
    assert.match(dryRunOutput, /would repair 1 link/);
    assert.ok(dryRunOutput.includes(`workspace ${workspace}`), "the resolved workspace is printed before anything is written");
    assert.equal(fsSync.readFileSync(topicFile, "utf-8"), `${BROKEN_LINK}\n`);
    assert.match(runScript(workspace), /repaired 1 link/);
    assert.equal(fsSync.readFileSync(topicFile, "utf-8"), `${FIXED_LINK}\n`);
    assert.match(runScript(workspace), /repaired 0 link/);
  });

  it("warns about broken links it deliberately left in an HTML paragraph", () => {
    const htmlFile = path.join(workspace, "conversations", "summaries", "topics", "html.md");
    fsSync.writeFileSync(htmlFile, `<b>x</b> ${BROKEN_LINK}\n`);
    const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, "--workspace", workspace, "--dry-run"], { encoding: "utf-8" });
    assert.match(result.stderr, /left 1 broken link\(s\) in conversations\/summaries\/topics\/html\.md/);
    assert.equal(fsSync.readFileSync(htmlFile, "utf-8"), `<b>x</b> ${BROKEN_LINK}\n`);
    fsSync.rmSync(htmlFile);
  });

  it("refuses to run on a flag without its value or on an unknown flag, and touches nothing", () => {
    const env = { ...process.env, MULMOCLAUDE_WORKSPACE_PATH: workspace };
    const contentBefore = fsSync.readFileSync(topicFile, "utf-8");
    [[], ["--workspace"], ["--workspace", ""], ["--workspace", "  "], ["--workspace", "--dry-run"], ["--dry-rn"], ["stray"]].forEach((args) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], { encoding: "utf-8", env });
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, /unknown argument|needs a directory|needs --workspace/, args.join(" "));
      assert.equal(fsSync.readFileSync(topicFile, "utf-8"), contentBefore);
    });
  });

  it("leaves a file that is not valid UTF-8 byte-for-byte untouched", () => {
    assert.ok(fsSync.readFileSync(binaryFile).equals(binaryBytes));
  });
});
