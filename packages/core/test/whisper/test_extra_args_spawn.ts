// Drives the real path env → createWhisper → sidecar spawn with a fake
// whisper-server that records its argv, so a dropped forward goes red. The fake
// answers the readiness probe: one that exits early leaves the sidecar polling
// until its 60 s readiness timeout, which would hold the test run open.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createWhisper } from "../../src/whisper/whisper.ts";
import { WHISPER_SERVER_EXTRA_ARGS_ENV } from "../../src/whisper/extra-args.ts";

const POSIX_ONLY = process.platform === "win32" ? "the fake server is a shell script" : false;

// Records argv, then serves any request on the --port the sidecar chose.
const FAKE_SERVER_JS = `
const { writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const args = process.argv.slice(2);
writeFileSync(process.env.ARGV_FILE, args.join("\\n"));
const port = Number(args[args.indexOf("--port") + 1]);
createServer((_req, res) => res.end("ok")).listen(port, "127.0.0.1");
`;
const SILENT = { info: () => undefined, warn: () => undefined, error: () => undefined };

let workDir = "";
let argvFile = "";
let fakeServer = "";

function setExtraArgsEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.WHISPER_SERVER_EXTRA_ARGS;
  else process.env.WHISPER_SERVER_EXTRA_ARGS = value;
}

async function argvSeenByServer(envValue: string | undefined): Promise<string[]> {
  const previous = process.env[WHISPER_SERVER_EXTRA_ARGS_ENV];
  setExtraArgsEnv(envValue);
  try {
    rmSync(argvFile, { force: true });
    const whisper = createWhisper({ modelsDir: workDir, logger: SILENT, serverBinary: fakeServer });
    await whisper.warmup("large-v3-turbo");
    whisper.shutdown();
    return readFileSync(argvFile, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  } finally {
    setExtraArgsEnv(previous);
  }
}

describe("WHISPER_SERVER_EXTRA_ARGS reaches the spawned whisper-server", { skip: POSIX_ONLY }, () => {
  before(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "whisper-extra-args-"));
    argvFile = path.join(workDir, "argv.txt");
    fakeServer = path.join(workDir, "fake-whisper-server");
    const fakeServerJs = path.join(workDir, "fake-whisper-server.cjs");
    writeFileSync(fakeServerJs, FAKE_SERVER_JS);
    writeFileSync(fakeServer, `#!/bin/sh\nARGV_FILE='${argvFile}' exec '${process.execPath}' '${fakeServerJs}' "$@"\n`);
    chmodSync(fakeServer, 0o755);
  });

  after(() => rmSync(workDir, { recursive: true, force: true }));

  it("passes only the owned flags when the variable is unset", async () => {
    const argv = await argvSeenByServer(undefined);
    assert.deepEqual(
      argv.filter((arg) => arg.startsWith("-")),
      ["--model", "--host", "--port"],
    );
  });

  it("appends the extra flags after the owned ones", async () => {
    const argv = await argvSeenByServer('["--vad", "--vad-model", "/a b/silero.bin"]');
    assert.deepEqual(argv.slice(-3), ["--vad", "--vad-model", "/a b/silero.bin"]);
    assert.equal(argv[0], "--model");
  });

  it("drops every extra flag when the value is rejected", async () => {
    const argv = await argvSeenByServer("--vad --port=1");
    assert.deepEqual(
      argv.filter((arg) => arg.startsWith("-")),
      ["--model", "--host", "--port"],
    );
  });
});
