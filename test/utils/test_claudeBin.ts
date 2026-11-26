// Unit tests for `claudeBinPath()` cross-platform resolution. The
// helper accepts injectable `platform` / `spawnSync` / `existsSync` /
// `env` so we can simulate every install layout without actually
// having `@anthropic-ai/claude-code` on disk.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { claudeBinPath, ClaudeCliNotFoundError, type ResolveOptions } from "../../server/utils/claudeBin.js";

// All probed paths in claudeBin.ts use `path.win32`, so tests must
// compose / normalise expected paths the same way to compare equal
// regardless of which OS the test runner is on.
const winPath = path.win32;

const FAKE_NPM_PREFIX = "C:\\Users\\test\\AppData\\Roaming\\npm";
const FAKE_YARN_BIN = "C:\\Users\\test\\AppData\\Local\\Yarn\\bin";
const NPM_CLAUDE_EXE = winPath.join(FAKE_NPM_PREFIX, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const YARN_CLAUDE_EXE = winPath.join(
  "C:\\Users\\test\\AppData\\Local\\Yarn",
  "config",
  "global",
  "node_modules",
  "@anthropic-ai",
  "claude-code",
  "bin",
  "claude.exe",
);

interface FakeSpawnCase {
  readonly command: string;
  /** When set, the case only answers a call with exactly these arguments. */
  readonly args?: readonly string[];
  readonly stdout: string;
  readonly status?: number;
}

function argsMatch(expected: readonly string[] | undefined, actual: readonly string[]): boolean {
  if (!expected) return true;
  return expected.length === actual.length && expected.every((arg, idx) => arg === actual[idx]);
}

function makeSpawnSync(cases: readonly FakeSpawnCase[]): typeof import("node:child_process").spawnSync {
  return ((cmd: string, args: readonly string[] = []): SpawnSyncReturns<string> => {
    const hit = cases.find((entry) => entry.command === cmd && argsMatch(entry.args, args));
    if (!hit) return { pid: 0, output: [], stdout: "", stderr: "", status: 1, signal: null };
    return { pid: 0, output: [], stdout: hit.stdout, stderr: "", status: hit.status ?? 0, signal: null };
  }) as never;
}

function makeExistsSync(existingPaths: readonly string[]): typeof import("node:fs").existsSync {
  const set = new Set(existingPaths.map((candidate) => winPath.normalize(candidate)));
  return ((candidate: string | URL | Buffer): boolean => {
    if (typeof candidate !== "string") return false;
    return set.has(winPath.normalize(candidate));
  }) as typeof import("node:fs").existsSync;
}

// Map directory → entry names. Lookup uses normalized win32 paths so
// tests can declare keys in either separator style.
function makeReaddirSync(dirs: Record<string, readonly string[]>): typeof import("node:fs").readdirSync {
  const normalized: Record<string, readonly string[]> = {};
  for (const [dir, entries] of Object.entries(dirs)) {
    normalized[winPath.normalize(dir)] = entries;
  }
  return ((dir: string | URL | Buffer): string[] => {
    if (typeof dir !== "string") throw new Error("ENOENT");
    const hit = normalized[winPath.normalize(dir)];
    if (!hit) throw new Error("ENOENT");
    return [...hit];
  }) as typeof import("node:fs").readdirSync;
}

function commonOpts(overrides: Partial<ResolveOptions> = {}): ResolveOptions {
  return {
    platform: "win32",
    env: {},
    resetCache: true,
    spawnSync: makeSpawnSync([]),
    existsSync: makeExistsSync([]),
    readdirSync: makeReaddirSync({}),
    ...overrides,
  };
}

describe("claudeBinPath — non-Windows", () => {
  it("returns the literal 'claude' on darwin", () => {
    assert.equal(claudeBinPath({ platform: "darwin", resetCache: true }), "claude");
  });

  it("returns the literal 'claude' on linux", () => {
    assert.equal(claudeBinPath({ platform: "linux", resetCache: true }), "claude");
  });

  it("never probes spawnSync on non-Windows (no install required)", () => {
    let calls = 0;
    const spawnSync = ((cmd: string): SpawnSyncReturns<string> => {
      calls++;
      return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null, command: cmd } as never;
    }) as never;
    claudeBinPath({ platform: "darwin", spawnSync, resetCache: true });
    assert.equal(calls, 0);
  });
});

describe("claudeBinPath — Windows resolution", () => {
  it("resolves via `where claude.cmd` (npm layout: bin/claude.cmd sibling of node_modules)", () => {
    const claudeCmd = winPath.join(FAKE_NPM_PREFIX, "claude.cmd");
    const opts = commonOpts({
      spawnSync: makeSpawnSync([{ command: "where", stdout: `${claudeCmd}\r\n` }]),
      existsSync: makeExistsSync([NPM_CLAUDE_EXE]),
    });
    assert.equal(claudeBinPath(opts), NPM_CLAUDE_EXE);
  });

  it("resolves via `where claude.cmd` (yarn layout: walk up to find node_modules)", () => {
    // Yarn classic puts claude.cmd in AppData\Local\Yarn\bin\ but the
    // real package lives in AppData\Local\Yarn\config\global\node_modules\…
    // — two directories above bin/.
    const claudeCmd = winPath.join(FAKE_YARN_BIN, "claude.cmd");
    const opts = commonOpts({
      spawnSync: makeSpawnSync([{ command: "where", stdout: claudeCmd }]),
      existsSync: makeExistsSync([YARN_CLAUDE_EXE]),
    });
    assert.equal(claudeBinPath(opts), YARN_CLAUDE_EXE);
  });

  it("falls back to `npm config get prefix` when `where` returns nothing", () => {
    const opts = commonOpts({
      spawnSync: makeSpawnSync([
        { command: "where", stdout: "", status: 1 },
        { command: "npm", stdout: `${FAKE_NPM_PREFIX}\r\n` },
      ]),
      existsSync: makeExistsSync([NPM_CLAUDE_EXE]),
    });
    assert.equal(claudeBinPath(opts), NPM_CLAUDE_EXE);
  });

  it("falls back to %APPDATA%\\npm default when neither `where` nor `npm` produce a hit", () => {
    const opts = commonOpts({
      spawnSync: makeSpawnSync([]),
      existsSync: makeExistsSync([NPM_CLAUDE_EXE]),
      env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
    });
    assert.equal(claudeBinPath(opts), NPM_CLAUDE_EXE);
  });

  it("throws a descriptive error listing every probed path when nothing is found", () => {
    const opts = commonOpts({
      env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    });
    assert.throws(
      () => claudeBinPath(opts),
      (err: Error) => {
        // Must be the typed error consumers across journal / memory /
        // chat-index / translation pattern-match on with
        // `err instanceof ClaudeCliNotFoundError` — a generic Error
        // here would bypass each subsystem's self-disable latch and
        // they'd keep retrying instead.
        assert.ok(err instanceof ClaudeCliNotFoundError, `expected ClaudeCliNotFoundError, got ${err.name}`);
        assert.match(err.message, /claude CLI binary not found/);
        assert.match(err.message, /Install with: npm install -g @anthropic-ai\/claude-code/);
        assert.match(err.message, /AppData\\Roaming\\npm/);
        assert.match(err.message, /Yarn\\config\\global/);
        // pnpm coverage is asserted by the dedicated `pnpm version-
        // agnostic global probe` tests below — the entries only appear
        // here when readdirSync actually finds `<root>/global/<v>/`.
        return true;
      },
    );
  });
});

describe("claudeBinPath — native installer (claude.exe directly on PATH)", () => {
  const FAKE_PROFILE = "C:\\Users\\test";
  const NATIVE_CLAUDE_EXE = winPath.join(FAKE_PROFILE, ".local", "bin", "claude.exe");
  const NPM_CLAUDE_CMD = winPath.join(FAKE_NPM_PREFIX, "claude.cmd");
  const WHERE_ARGS = ["claude"];

  it("returns a claude.exe that `where claude` lists, without walking up for node_modules", () => {
    const opts = commonOpts({
      spawnSync: makeSpawnSync([{ command: "where", args: WHERE_ARGS, stdout: `${NATIVE_CLAUDE_EXE}\r\n` }]),
      existsSync: makeExistsSync([NATIVE_CLAUDE_EXE]),
    });
    assert.equal(claudeBinPath(opts), NATIVE_CLAUDE_EXE);
  });

  it("accepts an upper-case .EXE extension", () => {
    const upper = winPath.join(FAKE_PROFILE, ".local", "bin", "CLAUDE.EXE");
    const opts = commonOpts({
      spawnSync: makeSpawnSync([{ command: "where", args: WHERE_ARGS, stdout: upper }]),
      existsSync: makeExistsSync([upper]),
    });
    assert.equal(claudeBinPath(opts), upper);
  });

  it("follows PATH order: native exe listed first wins over an npm install", () => {
    const opts = commonOpts({
      spawnSync: makeSpawnSync([{ command: "where", args: WHERE_ARGS, stdout: `${NATIVE_CLAUDE_EXE}\r\n${NPM_CLAUDE_CMD}\r\n` }]),
      existsSync: makeExistsSync([NATIVE_CLAUDE_EXE, NPM_CLAUDE_EXE]),
    });
    assert.equal(claudeBinPath(opts), NATIVE_CLAUDE_EXE);
  });

  it("follows PATH order: npm shim listed first wins over a native exe", () => {
    const opts = commonOpts({
      spawnSync: makeSpawnSync([{ command: "where", args: WHERE_ARGS, stdout: `${NPM_CLAUDE_CMD}\r\n${NATIVE_CLAUDE_EXE}\r\n` }]),
      existsSync: makeExistsSync([NATIVE_CLAUDE_EXE, NPM_CLAUDE_EXE]),
    });
    assert.equal(claudeBinPath(opts), NPM_CLAUDE_EXE);
  });

  it("skips a listed claude.exe that no longer exists and keeps probing", () => {
    const opts = commonOpts({
      spawnSync: makeSpawnSync([{ command: "where", args: WHERE_ARGS, stdout: `${NATIVE_CLAUDE_EXE}\r\n${NPM_CLAUDE_CMD}\r\n` }]),
      existsSync: makeExistsSync([NPM_CLAUDE_EXE]),
    });
    assert.equal(claudeBinPath(opts), NPM_CLAUDE_EXE);
  });

  it("ignores blank / whitespace-only `where` output lines", () => {
    const opts = commonOpts({
      spawnSync: makeSpawnSync([{ command: "where", stdout: "\r\n   \r\n" }]),
    });
    assert.throws(() => claudeBinPath(opts), ClaudeCliNotFoundError);
  });

  it("falls back to %USERPROFILE%\\.local\\bin\\claude.exe when PATH has no claude", () => {
    const opts = commonOpts({
      env: { USERPROFILE: FAKE_PROFILE },
      existsSync: makeExistsSync([NATIVE_CLAUDE_EXE]),
    });
    assert.equal(claudeBinPath(opts), NATIVE_CLAUDE_EXE);
  });

  it("lists the native installer path in the not-found error", () => {
    const opts = commonOpts({ env: { USERPROFILE: FAKE_PROFILE } });
    assert.throws(() => claudeBinPath(opts), /\.local\\bin\\claude\.exe/);
  });
});

describe("claudeBinPath — pnpm version-agnostic global probe", () => {
  // Regression for the hard-coded `5/6/7` pnpm version list (Codex
  // review on PR #1769): enumerate `<root>/global/` via readdirSync
  // so a current pnpm install with `global/15/` is picked up.
  it("resolves a pnpm v15 layout (`%LOCALAPPDATA%\\pnpm\\global\\15\\node_modules\\…`)", () => {
    const pnpmRoot = "C:\\Users\\test\\AppData\\Local\\pnpm";
    const pnpmGlobal = winPath.join(pnpmRoot, "global");
    const claudeExe = winPath.join(pnpmGlobal, "15", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    const opts = commonOpts({
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      existsSync: makeExistsSync([claudeExe]),
      readdirSync: makeReaddirSync({ [pnpmGlobal]: ["15"] }),
    });
    assert.equal(claudeBinPath(opts), claudeExe);
  });

  it("resolves a pnpm v8 layout when readdir yields multiple majors", () => {
    const pnpmRoot = "C:\\Users\\test\\AppData\\Local\\pnpm";
    const pnpmGlobal = winPath.join(pnpmRoot, "global");
    const claudeExe = winPath.join(pnpmGlobal, "8", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    const opts = commonOpts({
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      existsSync: makeExistsSync([claudeExe]),
      // Stale directories from older majors stick around — probe must
      // try every entry and pick the one that has the binary on disk.
      readdirSync: makeReaddirSync({ [pnpmGlobal]: ["5", "6", "7", "8"] }),
    });
    assert.equal(claudeBinPath(opts), claudeExe);
  });

  it("silently skips pnpm enumeration when `<root>/global` is missing", () => {
    // No env, no spawn hits, no readdir entries — the probe must fall
    // through to the descriptive "not found" error without crashing on
    // a missing pnpm install.
    const opts = commonOpts({
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    });
    assert.throws(() => claudeBinPath(opts), /claude CLI binary not found/);
  });
});

describe("claudeBinPath — caching", () => {
  it("caches the resolved path on Windows — second call doesn't re-probe", () => {
    let spawnCalls = 0;
    const spawnSync = ((cmd: string): SpawnSyncReturns<string> => {
      spawnCalls++;
      if (cmd === "where") {
        return { pid: 0, output: [], stdout: winPath.join(FAKE_NPM_PREFIX, "claude.cmd"), stderr: "", status: 0, signal: null } as never;
      }
      return { pid: 0, output: [], stdout: "", stderr: "", status: 1, signal: null } as never;
    }) as never;
    const opts = commonOpts({
      spawnSync,
      existsSync: makeExistsSync([NPM_CLAUDE_EXE]),
      resetCache: true,
    });
    assert.equal(claudeBinPath(opts), NPM_CLAUDE_EXE);
    const callsAfterFirst = spawnCalls;
    // Second call without resetCache should hit the module-level cache.
    assert.equal(claudeBinPath({ ...opts, resetCache: false }), NPM_CLAUDE_EXE);
    assert.equal(spawnCalls, callsAfterFirst, "spawnSync should NOT be called again after the first resolution");
  });
});
