import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { makeTempDir } from "../helpers/tempDir.js";
import { buildDockerSpawnArgs, SANDBOX_IMAGE } from "../../server/agent/config.js";
import { readEnvFileInput } from "../../server/agent/sandboxEnv.js";
import { dockerEnvNames, insertDockerOptions, parseEnvFileText, planSandboxEnv, type SandboxEnvInput } from "../../server/agent/sandboxEnvPlan.js";

const RESERVED = new Set(["HOME", "MULMOCLAUDE_HOST"]);

function input(overrides: Partial<SandboxEnvInput>): SandboxEnvInput {
  return { names: [], envFile: null, hostEnv: {}, reservedNames: RESERVED, ...overrides };
}

const fileOf = (text: string) => ({ path: "/etc/agent.env", text });

describe("parseEnvFileText", () => {
  it("reads docker's env-file shape: blanks and comments skipped, leading space dropped, name ends at the first =", () => {
    const parsed = parseEnvFileText(["# comment", "", "   ", "  API_TOKEN=a=b=c", "BARE", "EMPTY=", "  # indented comment"].join("\n"));
    assert.deepEqual(parsed.entries, [
      { name: "API_TOKEN", bare: false },
      { name: "BARE", bare: true },
      { name: "EMPTY", bare: false },
    ]);
    assert.deepEqual(parsed.invalidLines, []);
  });

  it("reports the line numbers of names docker would reject or read differently", () => {
    const parsed = parseEnvFileText(["OK=1", "=no-name", "has space=1", "a.b=1", "1LEADING_DIGIT=1", "export FOO=1"].join("\n"));
    assert.deepEqual(parsed.entries, [{ name: "OK", bare: false }]);
    assert.deepEqual(parsed.invalidLines, [2, 3, 4, 5, 6]);
  });

  it("returns nothing for an empty file", () => {
    assert.deepEqual(parseEnvFileText(""), { entries: [], invalidLines: [] });
  });
});

describe("dockerEnvNames", () => {
  it("collects -e and --env names before the image, ignoring their values", () => {
    const args = ["run", "-e", "HOME=/home/node", "--env", "A=x=y", "-e", "BARE", "-v", "/a:/b", SANDBOX_IMAGE, "claude", "-e", "AFTER_IMAGE=1"];
    assert.deepEqual(dockerEnvNames(args, SANDBOX_IMAGE), new Set(["HOME", "A", "BARE"]));
  });

  it("reads every fixed variable off the real sandbox argv", () => {
    const args = buildDockerSpawnArgs({
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
    });
    const names = dockerEnvNames(args, SANDBOX_IMAGE);
    ["HOME", "MULMOCLAUDE_HOST", "MULMOCLAUDE_CHAT_SESSION_ID", "MCP_CONNECT_TIMEOUT_MS", "GH_TOKEN"].forEach((name) => assert.ok(names.has(name), name));
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
    const args = ["run", SANDBOX_IMAGE, "claude"];
    assert.deepEqual(insertDockerOptions(args, SANDBOX_IMAGE, []), args);
  });

  it("throws rather than appending after the command when the image is missing", () => {
    assert.throws(() => insertDockerOptions(["run", "claude"], SANDBOX_IMAGE, ["-e", "B"]), /no image/);
  });
});

describe("planSandboxEnv — SANDBOX_ENV names", () => {
  it("adds nothing when neither setting is used", () => {
    assert.deepEqual(planSandboxEnv(input({})), { args: [], passedNames: [], skipped: [], envFileProblem: null });
  });

  it("passes a host variable by name only, never its value", () => {
    const plan = planSandboxEnv(input({ names: ["API_TOKEN"], hostEnv: { API_TOKEN: "s3cret" } }));
    assert.deepEqual(plan.args, ["-e", "API_TOKEN"]);
    assert.deepEqual(plan.passedNames, ["API_TOKEN"]);
    assert.ok(!plan.args.join(" ").includes("s3cret"));
  });

  it("passes a variable that is set but empty", () => {
    assert.deepEqual(planSandboxEnv(input({ names: ["EMPTY"], hostEnv: { EMPTY: "" } })).args, ["-e", "EMPTY"]);
  });

  it("skips reserved, unset and malformed names, and de-duplicates", () => {
    const plan = planSandboxEnv(input({ names: ["HOME", "MISSING", "A=B", "has space", "OK", "OK"], hostEnv: { HOME: "/x", OK: "1", "A=B": "1" } }));
    assert.deepEqual(plan.args, ["-e", "OK"]);
    assert.deepEqual(plan.skipped, [
      { name: "HOME", reason: "reserved" },
      { name: "MISSING", reason: "unset-on-host" },
      { name: "A=B", reason: "invalid-name" },
      { name: "has space", reason: "invalid-name" },
    ]);
  });
});

describe("planSandboxEnv — SANDBOX_ENV_FILE", () => {
  it("hands the file to docker by path, not by copying its values", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("API_TOKEN=s3cret\n") }));
    assert.deepEqual(plan.args, ["--env-file", "/etc/agent.env"]);
    assert.deepEqual(plan.passedNames, ["API_TOKEN"]);
    assert.ok(!plan.args.join(" ").includes("s3cret"));
  });

  it("reports reserved names in the file instead of claiming they pass", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("HOME=/tmp\nOK=1\n") }));
    assert.deepEqual(plan.args, ["--env-file", "/etc/agent.env"]);
    assert.deepEqual(plan.passedNames, ["OK"]);
    assert.deepEqual(plan.skipped, [{ name: "HOME", reason: "reserved" }]);
  });

  it("takes a bare name from the host, and reports it when the host lacks it", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("FROM_HOST\nNOT_ON_HOST\n"), hostEnv: { FROM_HOST: "1" } }));
    assert.deepEqual(plan.passedNames, ["FROM_HOST"]);
    assert.deepEqual(plan.skipped, [{ name: "NOT_ON_HOST", reason: "unset-on-host" }]);
  });

  it("lets the last repeated line decide, as docker does", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("TWICE\nTWICE=value\n") }));
    assert.deepEqual(plan.passedNames, ["TWICE"]);
    assert.deepEqual(plan.skipped, []);
  });

  it("does not pass a file docker would reject", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("OK=1\nbad name=1\n") }));
    assert.deepEqual(plan.args, []);
    assert.deepEqual(plan.envFileProblem, { path: "/etc/agent.env", reason: "invalid-line", lines: [2] });
  });

  it("reads a CRLF file the way docker does, line endings and all", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("# comment\r\nAPI_TOKEN=s3cret\r\nFROM_HOST\r\n"), hostEnv: { FROM_HOST: "1" } }));
    assert.deepEqual(plan.args, ["--env-file", "/etc/agent.env"]);
    assert.deepEqual(plan.passedNames, ["API_TOKEN", "FROM_HOST"]);
    assert.equal(plan.envFileProblem, null);
  });

  it("does not pass an unreadable file", () => {
    const plan = planSandboxEnv(input({ envFile: { path: "/nope.env", error: "ENOENT" } }));
    assert.deepEqual(plan.args, []);
    assert.deepEqual(plan.envFileProblem, { path: "/nope.env", reason: "unreadable", lines: [] });
  });

  it("puts names after the file, so a SANDBOX_ENV name overrides the same line in the file", () => {
    const plan = planSandboxEnv(input({ names: ["SHARED"], envFile: fileOf("SHARED=from-file\n"), hostEnv: { SHARED: "from-host" } }));
    assert.deepEqual(plan.args, ["--env-file", "/etc/agent.env", "-e", "SHARED"]);
    assert.deepEqual(plan.passedNames, ["SHARED"]);
  });

  it("still passes SANDBOX_ENV names when the file is rejected", () => {
    const plan = planSandboxEnv(input({ names: ["OK"], envFile: fileOf("a.b=1\n"), hostEnv: { OK: "1" } }));
    assert.deepEqual(plan.args, ["-e", "OK"]);
  });
});

describe("readEnvFileInput", () => {
  const dir = makeTempDir("sandbox-env-");

  it("returns null when no file is configured", () => {
    assert.equal(readEnvFileInput(undefined), null);
    assert.equal(readEnvFileInput(""), null);
  });

  it("reads the file and resolves its path to an absolute one", () => {
    const filePath = path.join(dir, "agent.env");
    writeFileSync(filePath, "A=1\n");
    assert.deepEqual(readEnvFileInput(path.relative(process.cwd(), filePath)), { path: filePath, text: "A=1\n" });
  });

  it("reports a missing file, a directory and an oversized file as errors", () => {
    const subdir = path.join(dir, "a-directory");
    mkdirSync(subdir);
    const big = path.join(dir, "big.env");
    writeFileSync(big, "A=".padEnd(64 * 1024 + 1, "x"));
    [path.join(dir, "missing.env"), subdir, big].forEach((filePath) => {
      const result = readEnvFileInput(filePath);
      assert.ok(result !== null && "error" in result, filePath);
    });
  });
});
