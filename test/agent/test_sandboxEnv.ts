import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Writable } from "node:stream";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";

import { makeTempDir } from "../helpers/tempDir.js";
import { buildDockerSpawnArgs, SANDBOX_IMAGE } from "../../server/agent/config.js";
import { ENV_FILE_FD, readEnvFileInput, resolveSandboxEnv } from "../../server/agent/sandboxEnv.js";
import { dockerMountArgs } from "../../server/agent/dockerMount.js";
import {
  dockerEnvNames,
  dockerMountSources,
  ENTRYPOINT_ENV_NAMES,
  IMAGE_ENV_NAMES,
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

  it("drops the CR of a last line that has no newline after it", () => {
    assert.deepEqual(parseEnvFileText("A=1\nBARE\r"), [
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

describe("dockerMountSources", () => {
  it("reads the host side of -v (with or without :ro, with a Windows drive) and --mount", () => {
    const args = [
      "run",
      "-v",
      "/ws:/home/node/workspace",
      "-v",
      "/proj/server:/app/server:ro",
      "-v",
      "C:/Users/me/ws:/home/node/workspace",
      "--mount",
      "type=bind,source=/odd:path,target=/x,readonly",
      "--mount",
      "type=bind,src=/short,target=/y",
      "-e",
      "A=/not/a/mount",
      SANDBOX_IMAGE,
      "-v",
      "/after/image:/z",
    ];
    assert.deepEqual(dockerMountSources(args, SANDBOX_IMAGE), ["/ws", "/proj/server", "C:/Users/me/ws", "/odd:path", "/short"]);
  });

  it("finds a source for every mount flag the real sandbox argv carries", () => {
    const args = sandboxArgv(false);
    const flags = args.slice(0, args.indexOf(SANDBOX_IMAGE)).filter((arg) => arg === "-v" || arg === "--mount");
    const sources = dockerMountSources(args, SANDBOX_IMAGE);
    assert.equal(sources.length, flags.length);
    ["/ws", "/proj/server", "/proj/src", "/proj/node_modules"].forEach((source) =>
      assert.ok(
        sources.some((found) => path.resolve(found) === path.resolve(source)),
        source,
      ),
    );
  });

  it("refuses an env file under any mount of the real argv: app code, workspace, and an added plugin tree", () => {
    const root = makeTempDir("sandbox-env-mounts-");
    const dirs = ["proj/server", "proj/src", "proj/node_modules", "ws", "plugin-tree"].map((dir) => path.join(root, dir));
    dirs.forEach((dir) => mkdirSync(dir, { recursive: true }));
    const [, , , workspace, pluginTree] = dirs;
    assert.ok(workspace !== undefined && pluginTree !== undefined);
    const pluginMount = dockerMountArgs({ hostPath: pluginTree, containerPath: "/home/node/.claude/plugins/x", readOnly: true }, process.platform);
    assert.ok(pluginMount.kind === "args");
    const args = buildDockerSpawnArgs({
      workspacePath: workspace,
      cliArgs: [],
      uid: 1000,
      gid: 1000,
      platform: process.platform,
      projectRoot: path.join(root, "proj"),
      packageRoot: path.join(root, "proj"),
      homeDir: path.join(root, "home"),
      chatSessionId: "s",
      sandboxAuthArgs: pluginMount.args,
    });
    const mounted = dockerMountSources(args, SANDBOX_IMAGE);
    dirs.forEach((dir) => {
      const envFile = path.join(dir, "agent.env");
      writeFileSync(envFile, "A=1\n");
      const result = readEnvFileInput(envFile, mounted);
      assert.ok(result !== null && "error" in result && /mounted/.test(result.error), dir);
    });
    const outside = path.join(root, "agent.env");
    writeFileSync(outside, "A=1\n");
    const allowed = readEnvFileInput(outside, mounted);
    assert.ok(allowed !== null && "text" in allowed);
  });

  it("reads back the exact host path from both shapes dockerMountArgs emits", () => {
    ["/plain/dir", "/has:colon/dir"].forEach((hostPath) => {
      const mount = dockerMountArgs({ hostPath, containerPath: "/c", readOnly: true }, "linux");
      assert.ok(mount.kind === "args");
      assert.deepEqual(dockerMountSources([...mount.args, SANDBOX_IMAGE], SANDBOX_IMAGE), [hostPath]);
    });
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

describe("IMAGE_ENV_NAMES", () => {
  const imageEnv = (() => {
    try {
      return execFileSync("docker", ["image", "inspect", SANDBOX_IMAGE, "--format", "{{range .Config.Env}}{{println .}}{{end}}"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  })();

  it("includes PATH, which the entrypoint and the CLI are started by, and the image's other variables", () => {
    ["PATH", "NODE_VERSION", "YARN_VERSION"].forEach((name) => assert.ok(IMAGE_ENV_NAMES.includes(name), name));
  });

  it("covers every variable the built sandbox image sets", { skip: imageEnv === null ? "no local mulmoclaude-sandbox image" : false }, () => {
    const names = (imageEnv ?? "").split("\n").flatMap((line) => (line === "" ? [] : [line.split("=", 1).join("")]));
    assert.ok(names.length > 0);
    names.forEach((name) => assert.ok(IMAGE_ENV_NAMES.includes(name), `${name} is set by the image but not reserved`));
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
    assert.deepEqual(planSandboxEnv(input({})), { nameArgs: [], envFileText: null, fileNames: [], namedNames: [], skipped: [] });
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
  it("keeps the accepted lines verbatim and leaves the values out of everything else", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("# c\n  API_TOKEN=s3cret \nDOTTED.NAME=1\n") }));
    assert.equal(plan.envFileText, "API_TOKEN=s3cret \nDOTTED.NAME=1\n");
    assert.deepEqual(plan.fileNames, ["API_TOKEN", "DOTTED.NAME"]);
    assert.deepEqual(plan.nameArgs, []);
    assert.ok(!JSON.stringify({ ...plan, envFileText: null }).includes("s3cret"));
  });

  it("drops reserved lines from the file text instead of relying on docker's precedence", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("HOME=/tmp\nOK=1\n") }));
    assert.equal(plan.envFileText, "OK=1\n");
    assert.deepEqual(plan.skipped, [{ source: "SANDBOX_ENV_FILE", entry: "HOME", reason: "reserved" }]);
  });

  it("drops an invalid line alone, reporting its line number and not its text", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("OK=1\nmy token s3cret=x\n") }));
    assert.equal(plan.envFileText, "OK=1\n");
    assert.deepEqual(plan.skipped, [{ source: "SANDBOX_ENV_FILE", entry: "line 2", reason: "invalid-name" }]);
    assert.ok(!JSON.stringify(plan.skipped).includes("s3cret"));
  });

  it("drops a line whose value holds a NUL, which the container runtime refuses, by line number", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("OK=1\nBAD=s3c\0ret\n") }));
    assert.equal(plan.envFileText, "OK=1\n");
    assert.deepEqual(plan.skipped, [{ source: "SANDBOX_ENV_FILE", entry: "line 2", reason: "invalid-value" }]);
    assert.ok(!JSON.stringify(plan.skipped).includes("s3c"));
  });

  it("keeps a bare name the host has, and drops one it lacks", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("FROM_HOST\nNOT_ON_HOST\n"), hostEnv: { FROM_HOST: "1" } }));
    assert.equal(plan.envFileText, "FROM_HOST\n");
    assert.deepEqual(plan.skipped, [{ source: "SANDBOX_ENV_FILE", entry: "NOT_ON_HOST", reason: "unset-on-host" }]);
  });

  it("lets the last repeated line decide, as docker does", () => {
    const plan = planSandboxEnv(input({ envFile: fileOf("TWICE=first\nTWICE=second\n") }));
    assert.equal(plan.envFileText, "TWICE=second\n");
  });

  it("hands over nothing when no line passes, and for an unreadable file", () => {
    assert.equal(planSandboxEnv(input({ envFile: fileOf("# only a comment\nHOME=/x\n") })).envFileText, null);
    assert.equal(planSandboxEnv(input({ envFile: { path: "/nope.env", error: "ENOENT" } })).envFileText, null);
  });

  it("keeps SANDBOX_ENV names alongside the file, so they follow --env-file and win", () => {
    const plan = planSandboxEnv(input({ names: ["SHARED"], envFile: fileOf("SHARED=from-file\n"), hostEnv: { SHARED: "from-host" } }));
    assert.deepEqual(plan.nameArgs, ["-e", "SHARED"]);
    assert.equal(plan.envFileText, "SHARED=from-file\n");
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

  it("refuses a file that is not valid UTF-8, which docker would refuse whole", () => {
    const filePath = path.join(dir, "latin1.env");
    writeFileSync(filePath, Buffer.from([0x4f, 0x4b, 0x3d, 0x31, 0x0a, 0x42, 0x3d, 0xff, 0xfe, 0x0a]));
    const result = readEnvFileInput(filePath, []);
    assert.ok(result !== null && "error" in result);
  });

  it("drops a UTF-8 byte-order mark the way docker does, so the first name is intact", () => {
    const filePath = path.join(dir, "bom.env");
    writeFileSync(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("FIRST=1\n")]));
    const result = readEnvFileInput(filePath, []);
    assert.ok(result !== null && "text" in result);
    assert.deepEqual(
      parseEnvFileText(result.text).map((entry) => entry.name),
      ["FIRST"],
    );
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

  it("treats a name that merely starts with .. as inside, and a sibling directory as outside", posixOnly, () => {
    const workspace = path.join(dir, "ws-dots");
    mkdirSync(workspace);
    const dotted = path.join(workspace, "..secrets.env");
    writeFileSync(dotted, "A=1\n");
    const dottedResult = readEnvFileInput(dotted, [workspace]);
    assert.ok(dottedResult !== null && "error" in dottedResult && /mounted/.test(dottedResult.error));
    const sibling = path.join(dir, "ws-dots-sibling");
    mkdirSync(sibling);
    writeFileSync(path.join(sibling, "agent.env"), "A=1\n");
    const siblingResult = readEnvFileInput(path.join(sibling, "agent.env"), [workspace]);
    assert.ok(siblingResult !== null && "text" in siblingResult);
  });

  const caseDir = path.join(dir, "ws-case");
  mkdirSync(caseDir);
  const caseInsensitive = existsSync(caseDir.toUpperCase());

  it("refuses a file under a mount spelled in a different letter case", { skip: caseInsensitive ? false : "case-sensitive filesystem" }, () => {
    writeFileSync(path.join(caseDir, "agent.env"), "A=1\n");
    const upperFile = path.join(caseDir.toUpperCase(), "AGENT.ENV");
    [readEnvFileInput(upperFile, [caseDir]), readEnvFileInput(path.join(caseDir, "agent.env"), [caseDir.toUpperCase()])].forEach((result) =>
      assert.ok(result !== null && "error" in result && /mounted/.test(result.error)),
    );
  });
});

describe("resolveSandboxEnv", () => {
  const dir = makeTempDir("sandbox-env-resolve-");
  const base = { names: [], hostEnv: {}, reservedNames: RESERVED, mountedHostPaths: [], platform: "linux" as const };

  it("adds nothing and opens no extra pipe with neither setting", () => {
    assert.deepEqual(resolveSandboxEnv({ ...base, envFilePath: undefined }), { args: [], envFileText: null });
  });

  it("points docker at the fd 3 pipe and hands over only the checked lines", () => {
    const userFile = path.join(dir, "agent.env");
    writeFileSync(userFile, "OK=1\nHOME=/evil\n");
    const resolved = resolveSandboxEnv({ ...base, envFilePath: userFile });
    assert.deepEqual(resolved.args, ["--env-file", `/dev/fd/${ENV_FILE_FD}`]);
    assert.equal(resolved.envFileText, "OK=1\n");
  });

  it("puts -e names after the pipe, so they win over the same name in the file", () => {
    const userFile = path.join(dir, "shared.env");
    writeFileSync(userFile, "SHARED=from-file\n");
    const resolved = resolveSandboxEnv({ ...base, names: ["SHARED"], hostEnv: { SHARED: "from-host" }, envFilePath: userFile });
    assert.deepEqual(resolved.args, ["--env-file", `/dev/fd/${ENV_FILE_FD}`, "-e", "SHARED"]);
  });

  it("does not pass the file on Windows, which has no /dev/fd, but still passes SANDBOX_ENV names", () => {
    const userFile = path.join(dir, "win.env");
    writeFileSync(userFile, "OK=1\n");
    const resolved = resolveSandboxEnv({ ...base, platform: "win32", names: ["NAMED"], hostEnv: { NAMED: "1" }, envFilePath: userFile });
    assert.deepEqual(resolved, { args: ["-e", "NAMED"], envFileText: null });
  });
});

// The whole env-file path rests on docker opening `/dev/fd/3` as a file. Checked
// against the real CLI wherever the sandbox image is present.
describe("docker --env-file /dev/fd/3", () => {
  const hasImage = (() => {
    try {
      execFileSync("docker", ["image", "inspect", SANDBOX_IMAGE], { stdio: "ignore" });
      return process.platform !== "win32";
    } catch {
      return false;
    }
  })();

  it("reads the env file from the pipe, valued and bare lines alike", { skip: hasImage ? false : "no local mulmoclaude-sandbox image" }, async () => {
    const proc = spawn("docker", ["run", "--rm", "--entrypoint", "env", "--env-file", `/dev/fd/${ENV_FILE_FD}`, SANDBOX_IMAGE], {
      stdio: ["ignore", "pipe", "ignore", "pipe"],
      env: { ...process.env, MC3617_BARE: "from-host" },
    });
    const pipe = proc.stdio[ENV_FILE_FD];
    assert.ok(pipe instanceof Writable);
    pipe.end("MC3617_PIPED=piped-value\nMC3617_BARE\n");
    const chunks: string[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));
    assert.equal(code, 0);
    const lines = chunks.join("").split("\n");
    assert.ok(lines.includes("MC3617_PIPED=piped-value"));
    assert.ok(lines.includes("MC3617_BARE=from-host"));
  });
});
