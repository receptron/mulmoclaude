import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";

import { makeTempDir } from "../helpers/tempDir.js";
import { buildDockerSpawnArgs, SANDBOX_IMAGE } from "../../server/agent/config.js";
import { readEnvFileInput, removeSandboxEnvStaging, resolveSandboxEnv } from "../../server/agent/sandboxEnv.js";
import {
  dockerEnvNames,
  ENTRYPOINT_ENV_NAMES,
  insertDockerOptions,
  isEnvName,
  parseEnvFileText,
  planSandboxEnv,
  type SandboxEnvInput,
} from "../../server/agent/sandboxEnvPlan.js";

const RESERVED = new Set(["HOME", "MULMOCLAUDE_HOST"]);
const posixOnly = { skip: process.platform === "win32" };

function input(overrides: Partial<SandboxEnvInput>): SandboxEnvInput {
  return { names: [], envFile: null, hostEnv: {}, reservedNames: RESERVED, ...overrides };
}

const fileOf = (text: string) => ({ path: "/etc/agent.env", text });

function sandboxArgv(sshAgentForward: boolean): string[] {
  return buildDockerSpawnArgs({
    workspacePath: "/ws",
    cliArgs: ["-p", "hi"],
    uid: 1000,
    gid: 1000,
    platform: process.platform,
    projectRoot: "/proj",
    packageRoot: "/proj",
    homeDir: "/home/user",
    chatSessionId: "chat-test-session",
    sandboxAuthArgs: ["-e", "GH_TOKEN=secret"],
    sshAgentForward,
  });
}

describe("isEnvName", () => {
  it("accepts every name docker's env-file reader accepts", () => {
    ["A", "_x", "a.b", "1LEADING_DIGIT", "with-dash", "ünicode"].forEach((name) => assert.equal(isEnvName(name), true, name));
  });

  it("rejects empty names, whitespace anywhere, and = (which would make -e an assignment)", () => {
    ["", "has space", "tab\there", "trailing\n", "cr\r", "A=B", "=x"].forEach((name) => assert.equal(isEnvName(name), false, JSON.stringify(name)));
  });
});

describe("parseEnvFileText", () => {
  it("reads docker's env-file shape: blanks and comments skipped, leading space dropped, name ends at the first =", () => {
    const entries = parseEnvFileText(["# comment", "", "   ", "  API_TOKEN=a=b=c ", "BARE", "EMPTY=", "  # indented comment"].join("\n"));
    assert.deepEqual(entries, [
      { name: "API_TOKEN", bare: false, line: "API_TOKEN=a=b=c ", lineNumber: 4 },
      { name: "BARE", bare: true, line: "BARE", lineNumber: 5 },
      { name: "EMPTY", bare: false, line: "EMPTY=", lineNumber: 6 },
    ]);
  });

  it("drops a trailing CR as docker does", () => {
    assert.deepEqual(parseEnvFileText("A=1\r\nBARE\r\n"), [
      { name: "A", bare: false, line: "A=1", lineNumber: 1 },
      { name: "BARE", bare: true, line: "BARE", lineNumber: 2 },
    ]);
  });

  it("returns nothing for an empty file", () => {
    assert.deepEqual(parseEnvFileText(""), []);
  });
});

describe("dockerEnvNames", () => {
  it("collects -e and --env names before the image, ignoring their values", () => {
    const args = ["run", "-e", "HOME=/home/node", "--env", "A=x=y", "-e", "BARE", "-v", "/a:/b", SANDBOX_IMAGE, "claude", "-e", "AFTER_IMAGE=1"];
    assert.deepEqual(dockerEnvNames(args, SANDBOX_IMAGE), new Set(["HOME", "A", "BARE"]));
  });

  it("reads every fixed variable off the real sandbox argv", () => {
    const names = dockerEnvNames(sandboxArgv(false), SANDBOX_IMAGE);
    ["HOME", "MULMOCLAUDE_HOST", "MULMOCLAUDE_CHAT_SESSION_ID", "MCP_CONNECT_TIMEOUT_MS", "GH_TOKEN"].forEach((name) => assert.ok(names.has(name), name));
  });
});

// The entrypoint reads variables a run need not set (HOST_UID only appears in the
// argv with SSH forwarding on), so the argv alone cannot reserve them.
describe("ENTRYPOINT_ENV_NAMES", () => {
  it("covers every variable sandbox-entrypoint.sh reads from outside", () => {
    const lines = readFileSync(path.join(import.meta.dirname, "../../sandbox-entrypoint.sh"), "utf-8")
      .split("\n")
      .map((line) => line.trimStart())
      .filter((line) => !line.startsWith("#"));
    const referenced = new Set(lines.flatMap((line) => [...line.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)].map((match) => match[1])));
    const assigned = new Set(lines.map((line) => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1]));
    const external = [...referenced].filter((name) => name !== undefined && !assigned.has(name));
    assert.ok(external.length > 0, "the scan found no variables — it has stopped working");
    external.forEach((name) => assert.ok(ENTRYPOINT_ENV_NAMES.includes(name ?? ""), `${name} is read by the entrypoint but not reserved`));
  });
});

describe("insertDockerOptions", () => {
  it("splices the options in immediately before the image", () => {
    assert.deepEqual(insertDockerOptions(["run", "-e", "A=1", SANDBOX_IMAGE, "claude"], SANDBOX_IMAGE, ["-e", "B"]), [
      "run",
      "-e",
      "A=1",
      "-e",
      "B",
      SANDBOX_IMAGE,
      "claude",
    ]);
  });

  it("leaves the argv unchanged when there is nothing to add", () => {
    const args = sandboxArgv(false);
    assert.deepEqual(insertDockerOptions(args, SANDBOX_IMAGE, []), args);
  });

  it("throws rather than appending after the command when the image is missing", () => {
    assert.throws(() => insertDockerOptions(["run", "claude"], SANDBOX_IMAGE, ["-e", "B"]), /no image/);
  });
});

describe("planSandboxEnv — SANDBOX_ENV names", () => {
  it("adds nothing when neither setting is used", () => {
    assert.deepEqual(planSandboxEnv(input({})), { nameArgs: [], stagedEnvFileText: null, fileNames: [], namedNames: [], skipped: [] });
  });

  it("passes a host variable by name only, never its value", () => {
    const plan = planSandboxEnv(input({ names: ["API_TOKEN"], hostEnv: { API_TOKEN: "s3cret" } }));
    assert.deepEqual(plan.nameArgs, ["-e", "API_TOKEN"]);
    assert.deepEqual(plan.namedNames, ["API_TOKEN"]);
    assert.ok(!JSON.stringify(plan).includes("s3cret"));
  });

  it("passes a variable that is set but empty", () => {
    assert.deepEqual(planSandboxEnv(input({ names: ["EMPTY"], hostEnv: { EMPTY: "" } })).nameArgs, ["-e", "EMPTY"]);
  });

  it("skips reserved, unset and malformed names, de-duplicates, and never echoes a malformed entry", () => {
    const plan = planSandboxEnv(
      input({ names: ["HOME", "MISSING", "TOKEN=s3cret", "has space", "OK", "OK"], hostEnv: { HOME: "/x", OK: "1", "TOKEN=s3cret": "1" } }),
    );
    assert.deepEqual(plan.nameArgs, ["-e", "OK"]);
    assert.deepEqual(plan.skipped, [
      { source: "SANDBOX_ENV", entry: "HOME", reason: "reserved" },
      { source: "SANDBOX_ENV", entry: "MISSING", reason: "unset-on-host" },
      { source: "SANDBOX_ENV", entry: "#3", reason: "invalid-name" },
      { source: "SANDBOX_ENV", entry: "#4", reason: "invalid-name" },
    ]);
    assert.ok(!JSON.stringify(plan.skipped).includes("s3cret"));
  });
});

describe("planSandboxEnv — SANDBOX_ENV_FILE", () => {
  it("stages the accepted lines verbatim and leaves the values out of everything else", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("# c\n  API_TOKEN=s3cret \nDOTTED.NAME=1\n") }));
    assert.equal(plan.stagedEnvFileText, "API_TOKEN=s3cret \nDOTTED.NAME=1\n");
    assert.deepEqual(plan.fileNames, ["API_TOKEN", "DOTTED.NAME"]);
    assert.deepEqual(plan.nameArgs, []);
    assert.ok(!JSON.stringify({ ...plan, stagedEnvFileText: null }).includes("s3cret"));
  });

  it("drops reserved lines from the staged file instead of relying on docker's precedence", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("HOME=/tmp\nOK=1\n") }));
    assert.equal(plan.stagedEnvFileText, "OK=1\n");
    assert.deepEqual(plan.skipped, [{ source: "SANDBOX_ENV_FILE", entry: "HOME", reason: "reserved" }]);
  });

  it("drops an invalid line alone, reporting its line number and not its text", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("OK=1\nmy token s3cret=x\n") }));
    assert.equal(plan.stagedEnvFileText, "OK=1\n");
    assert.deepEqual(plan.skipped, [{ source: "SANDBOX_ENV_FILE", entry: "line 2", reason: "invalid-name" }]);
    assert.ok(!JSON.stringify(plan.skipped).includes("s3cret"));
  });

  it("keeps a bare name the host has, and drops one it lacks", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("FROM_HOST\nNOT_ON_HOST\n"), hostEnv: { FROM_HOST: "1" } }));
    assert.equal(plan.stagedEnvFileText, "FROM_HOST\n");
    assert.deepEqual(plan.skipped, [{ source: "SANDBOX_ENV_FILE", entry: "NOT_ON_HOST", reason: "unset-on-host" }]);
  });

  it("lets the last repeated line decide, as docker does", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("TWICE=first\nTWICE=second\n") }));
    assert.equal(plan.stagedEnvFileText, "TWICE=second\n");
  });

  it("stages nothing when no line passes, and for an unreadable file", () => {
    assert.equal(planSandboxEnv(input({ envFile: fileOf("# only a comment\nHOME=/x\n") })).stagedEnvFileText, null);
    assert.equal(planSandboxEnv(input({ envFile: { path: "/nope.env", error: "ENOENT" } })).stagedEnvFileText, null);
  });

  it("keeps SANDBOX_ENV names alongside the file, so they follow --env-file and win", () => {
    const plan = planSandboxEnv(input({ names: ["SHARED"], envFile: fileOf("SHARED=from-file\n"), hostEnv: { SHARED: "from-host" } }));
    assert.deepEqual(plan.nameArgs, ["-e", "SHARED"]);
    assert.equal(plan.stagedEnvFileText, "SHARED=from-file\n");
  });
});

describe("readEnvFileInput", () => {
  const dir = makeTempDir("sandbox-env-");

  it("returns null when no file is configured", () => {
    assert.equal(readEnvFileInput(undefined, []), null);
    assert.equal(readEnvFileInput("", []), null);
  });

  it("reads the file and resolves its path to an absolute one", () => {
    const filePath = path.join(dir, "agent.env");
    writeFileSync(filePath, "A=1\n");
    assert.deepEqual(readEnvFileInput(path.relative(process.cwd(), filePath), []), { path: filePath, text: "A=1\n" });
  });

  it("reports a missing file, a directory and an oversized file as errors", () => {
    const subdir = path.join(dir, "a-directory");
    mkdirSync(subdir);
    const big = path.join(dir, "big.env");
    writeFileSync(big, "A=".padEnd(64 * 1024 + 1, "x"));
    [path.join(dir, "missing.env"), subdir, big].forEach((filePath) => {
      const result = readEnvFileInput(filePath, []);
      assert.ok(result !== null && "error" in result, filePath);
    });
  });

  it("refuses a FIFO at once instead of blocking until a writer appears", posixOnly, () => {
    const fifo = path.join(dir, "agent.fifo");
    execFileSync("mkfifo", [fifo]);
    const result = readEnvFileInput(fifo, []);
    assert.ok(result !== null && "error" in result && /not a regular file/.test(result.error));
  });

  it("refuses a file inside a directory mounted into the sandbox, including through a symlink", posixOnly, () => {
    const workspace = path.join(dir, "workspace");
    mkdirSync(workspace);
    const inside = path.join(workspace, "agent.env");
    writeFileSync(inside, "A=1\n");
    const link = path.join(dir, "linked.env");
    symlinkSync(inside, link);
    [inside, link].forEach((filePath) => {
      const result = readEnvFileInput(filePath, [workspace]);
      assert.ok(result !== null && "error" in result && /mounted/.test(result.error), filePath);
    });
    const outside = readEnvFileInput(path.join(dir, "agent.env"), [workspace]);
    assert.ok(outside !== null && "text" in outside);
  });
});

describe("resolveSandboxEnv", () => {
  const dir = makeTempDir("sandbox-env-resolve-");
  const base = { names: [], hostEnv: {}, reservedNames: RESERVED, mountedHostPaths: [] };

  it("adds nothing and stages nothing with neither setting", () => {
    assert.deepEqual(resolveSandboxEnv({ ...base, envFilePath: undefined }), { args: [], stagingDir: null });
  });

  it("hands docker a private copy of the checked lines, not the user's file", () => {
    const userFile = path.join(dir, "agent.env");
    writeFileSync(userFile, "OK=1\nHOME=/evil\n");
    const resolved = resolveSandboxEnv({ ...base, envFilePath: userFile });
    const { stagingDir } = resolved;
    assert.ok(stagingDir !== null);
    try {
      const [flag, stagedPath] = resolved.args;
      assert.equal(flag, "--env-file");
      assert.ok(stagedPath !== undefined && stagedPath !== userFile);
      assert.equal(readFileSync(stagedPath, "utf-8"), "OK=1\n");
      if (process.platform !== "win32") assert.equal(statSync(stagingDir).mode & 0o077, 0);
    } finally {
      removeSandboxEnvStaging(stagingDir);
    }
    assert.equal(existsSync(stagingDir), false);
  });
});
