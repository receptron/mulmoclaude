// Unit tests for the bridge token reader (#272 Phase 2). The
// helper is tiny but covers the two sources (env var, file) and
// three "no token" shapes (missing file, empty file, whitespace-
// only file), so explicit coverage is worth it.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// The token file path is computed once at module load from the
// workspace root, so we cache-bust the module per test via a query
// string and override the root before importing. That way we can drop
// real `.session-token` files into the tmp-dir workspace layout and
// exercise the production code path. Both roots get coverage:
// `MULMOCLAUDE_WORKSPACE_PATH` when set (#3078), `process.env.HOME`
// via `os.homedir()` otherwise.

interface TokenModule {
  readBridgeToken: () => string | null;
  tokenFilePath: () => string;
  TOKEN_FILE_PATH: string;
}

let cacheBuster = 0;
async function loadFresh(): Promise<TokenModule> {
  cacheBuster++;
  const mod = await import(`../src/token.ts?t=${cacheBuster}`);
  return mod as TokenModule;
}

let tmpDir = "";
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedToken: string | undefined;
let savedWorkspace: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mulmo-bridge-token-test-"));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedToken = process.env.MULMOCLAUDE_AUTH_TOKEN;
  savedWorkspace = process.env.MULMOCLAUDE_WORKSPACE_PATH;
  // `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows;
  // override both so the test is platform-agnostic.
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
  delete process.env.MULMOCLAUDE_AUTH_TOKEN;
  // The homedir cases below only mean anything with no configured
  // workspace — and a developer's shell may well have one set.
  delete process.env.MULMOCLAUDE_WORKSPACE_PATH;
  // Pre-create the workspace dir so the token file has a home.
  fs.mkdirSync(path.join(tmpDir, "mulmoclaude"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  if (savedToken === undefined) delete process.env.MULMOCLAUDE_AUTH_TOKEN;
  else process.env.MULMOCLAUDE_AUTH_TOKEN = savedToken;
  if (savedWorkspace === undefined) delete process.env.MULMOCLAUDE_WORKSPACE_PATH;
  else process.env.MULMOCLAUDE_WORKSPACE_PATH = savedWorkspace;
});

function writeTokenFile(home: string, value: string): void {
  fs.writeFileSync(path.join(home, "mulmoclaude", ".session-token"), value, "utf-8");
}

describe("readBridgeToken — env var wins", () => {
  it("returns MULMOCLAUDE_AUTH_TOKEN when set", async () => {
    process.env.MULMOCLAUDE_AUTH_TOKEN = "env-token";
    writeTokenFile(tmpDir, "file-token");
    const { readBridgeToken } = await loadFresh();
    assert.equal(readBridgeToken(), "env-token");
  });

  it("falls through to the file when env var is empty string", async () => {
    process.env.MULMOCLAUDE_AUTH_TOKEN = "";
    writeTokenFile(tmpDir, "file-token");
    const { readBridgeToken } = await loadFresh();
    assert.equal(readBridgeToken(), "file-token");
  });
});

describe("readBridgeToken — file fallback", () => {
  it("reads the token file and trims surrounding whitespace", async () => {
    writeTokenFile(tmpDir, "file-token-with-newline\n");
    const { readBridgeToken } = await loadFresh();
    assert.equal(readBridgeToken(), "file-token-with-newline");
  });

  it("returns null when the file is missing", async () => {
    const { readBridgeToken } = await loadFresh();
    assert.equal(readBridgeToken(), null);
  });

  it("returns null when the file is empty", async () => {
    writeTokenFile(tmpDir, "");
    const { readBridgeToken } = await loadFresh();
    assert.equal(readBridgeToken(), null);
  });

  it("returns null when the file is whitespace only", async () => {
    writeTokenFile(tmpDir, "   \n\t  ");
    const { readBridgeToken } = await loadFresh();
    assert.equal(readBridgeToken(), null);
  });
});

describe("TOKEN_FILE_PATH", () => {
  it("is <homedir>/mulmoclaude/.session-token", async () => {
    const { TOKEN_FILE_PATH } = await loadFresh();
    assert.equal(TOKEN_FILE_PATH, path.join(tmpDir, "mulmoclaude", ".session-token"));
  });

  it("follows MULMOCLAUDE_WORKSPACE_PATH when the workspace was moved", async () => {
    const moved = path.join(tmpDir, "elsewhere");
    fs.mkdirSync(moved, { recursive: true });
    process.env.MULMOCLAUDE_WORKSPACE_PATH = moved;
    const { TOKEN_FILE_PATH } = await loadFresh();
    assert.equal(TOKEN_FILE_PATH, path.join(moved, ".session-token"));
  });
});

// Before #3078 the token was read from `<homedir>/mulmoclaude` no matter
// where the server had been told to put its workspace, so a moved workspace
// meant "no bearer token found" with the wrong path in the message.
describe("readBridgeToken — MULMOCLAUDE_WORKSPACE_PATH", () => {
  it("reads the token the server wrote into the configured workspace", async () => {
    const moved = path.join(tmpDir, "elsewhere");
    fs.mkdirSync(moved, { recursive: true });
    fs.writeFileSync(path.join(moved, ".session-token"), "moved-token\n", "utf-8");
    // A decoy in the default location, to prove which one is read.
    writeTokenFile(tmpDir, "homedir-token");
    process.env.MULMOCLAUDE_WORKSPACE_PATH = moved;
    const { readBridgeToken } = await loadFresh();
    assert.equal(readBridgeToken(), "moved-token");
  });

  it("ignores an empty MULMOCLAUDE_WORKSPACE_PATH and uses the homedir workspace", async () => {
    writeTokenFile(tmpDir, "homedir-token");
    process.env.MULMOCLAUDE_WORKSPACE_PATH = "";
    const { readBridgeToken } = await loadFresh();
    assert.equal(readBridgeToken(), "homedir-token");
  });
});

// The boundary the constant-vs-function split lives on: a consumer that
// imports the package BEFORE its `.env` is applied. `readBridgeToken()` and
// `tokenFilePath()` re-resolve, `TOKEN_FILE_PATH` does not — which is exactly
// why anything doing I/O should call the function (Codex, #3078).
describe("workspace set AFTER import", () => {
  it("tokenFilePath() re-resolves where TOKEN_FILE_PATH cannot", async () => {
    const { TOKEN_FILE_PATH, tokenFilePath } = await loadFresh();
    const moved = path.join(tmpDir, "late");
    fs.mkdirSync(moved, { recursive: true });
    process.env.MULMOCLAUDE_WORKSPACE_PATH = moved;
    assert.equal(TOKEN_FILE_PATH, path.join(tmpDir, "mulmoclaude", ".session-token"), "the constant keeps its import-time value");
    assert.equal(tokenFilePath(), path.join(moved, ".session-token"), "the function follows the new workspace");
  });

  it("readBridgeToken() reads the workspace configured after import", async () => {
    const { readBridgeToken } = await loadFresh();
    const moved = path.join(tmpDir, "late");
    fs.mkdirSync(moved, { recursive: true });
    fs.writeFileSync(path.join(moved, ".session-token"), "late-token\n", "utf-8");
    writeTokenFile(tmpDir, "homedir-token");
    process.env.MULMOCLAUDE_WORKSPACE_PATH = moved;
    assert.equal(readBridgeToken(), "late-token");
  });
});
