// Unit tests for the bridge's server-address resolution (#3078).
//
// Two halves: `parsePublishedPort` is pure and gets a table, while
// `resolveApiUrl` reads `process.env` and the real `.server-port` file, so
// it runs against a tmp workspace pointed at by `MULMOCLAUDE_WORKSPACE_PATH`.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface ApiUrlModule {
  resolveApiUrl: (explicit?: string) => string;
  resolvePublishedApiUrl: (explicit?: string) => string | null;
  readPublishedApiUrl: () => string | null;
  parsePublishedPort: (raw: string | null) => number | null;
  DEFAULT_API_URL: string;
}

// `workspaceRoot()` reads the env var on every call, but `resolveApiUrl`
// is imported once — a fresh import per test keeps each case independent
// of any module-level state a future edit might introduce.
let cacheBuster = 0;
async function loadFresh(): Promise<ApiUrlModule> {
  cacheBuster++;
  const mod = await import(`../src/apiUrl.ts?t=${cacheBuster}`);
  return mod as ApiUrlModule;
}

let tmpDir = "";
let savedWorkspace: string | undefined;
let savedApiUrl: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mulmo-bridge-apiurl-test-"));
  savedWorkspace = process.env.MULMOCLAUDE_WORKSPACE_PATH;
  savedApiUrl = process.env.MULMOCLAUDE_API_URL;
  process.env.MULMOCLAUDE_WORKSPACE_PATH = tmpDir;
  delete process.env.MULMOCLAUDE_API_URL;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedWorkspace === undefined) delete process.env.MULMOCLAUDE_WORKSPACE_PATH;
  else process.env.MULMOCLAUDE_WORKSPACE_PATH = savedWorkspace;
  if (savedApiUrl === undefined) delete process.env.MULMOCLAUDE_API_URL;
  else process.env.MULMOCLAUDE_API_URL = savedApiUrl;
});

function publishPort(value: string): void {
  fs.writeFileSync(path.join(tmpDir, ".server-port"), value, "utf-8");
}

describe("parsePublishedPort", () => {
  const accepted: [string, number][] = [
    ["3002", 3002],
    ["3002\n", 3002],
    ["  3099  ", 3099],
    ["1", 1],
    ["65535", 65535],
    // The server never writes one, but a leading zero is still a decimal port.
    ["03002", 3002],
  ];
  accepted.forEach(([raw, expected]) => {
    it(`accepts ${JSON.stringify(raw)} → ${expected}`, async () => {
      const { parsePublishedPort } = await loadFresh();
      assert.equal(parsePublishedPort(raw), expected);
    });
  });

  // A port nothing can be addressed on, text a corrupted file might hold, and
  // the shapes `Number.parseInt` would happily truncate into a valid port.
  const rejected = [
    null,
    "",
    "   ",
    "0",
    "65536",
    "999999999999",
    "-1",
    "3002abc",
    "80@attacker.example",
    "0x1f",
    "3e3",
    "3002.0",
    "+3002",
    "NaN",
    // Full-width digits. `\d` matches ASCII 0-9 only — it does NOT become
    // Unicode-aware the way `\p{Nd}` under the `u` flag would — so this pins
    // that the rule is deliberately ASCII-restricted.
    "３００２",
  ];
  rejected.forEach((raw) => {
    it(`rejects ${JSON.stringify(raw)}`, async () => {
      const { parsePublishedPort } = await loadFresh();
      assert.equal(parsePublishedPort(raw), null);
    });
  });
});

describe("readPublishedApiUrl", () => {
  it("returns null when the server published nothing", async () => {
    const { readPublishedApiUrl } = await loadFresh();
    assert.equal(readPublishedApiUrl(), null);
  });

  it("addresses 127.0.0.1 — the loopback the server binds — not localhost", async () => {
    publishPort("3002\n");
    const { readPublishedApiUrl } = await loadFresh();
    assert.equal(readPublishedApiUrl(), "http://127.0.0.1:3002");
  });

  it("returns null when the published value is not a port", async () => {
    publishPort("not-a-port\n");
    const { readPublishedApiUrl } = await loadFresh();
    assert.equal(readPublishedApiUrl(), null);
  });
});

describe("resolveApiUrl — precedence", () => {
  it("an explicit argument wins over everything", async () => {
    process.env.MULMOCLAUDE_API_URL = "http://env.example:1234";
    publishPort("3002\n");
    const { resolveApiUrl } = await loadFresh();
    assert.equal(resolveApiUrl("http://explicit.example:9999"), "http://explicit.example:9999");
  });

  it("MULMOCLAUDE_API_URL wins over the published port", async () => {
    process.env.MULMOCLAUDE_API_URL = "http://env.example:1234";
    publishPort("3002\n");
    const { resolveApiUrl } = await loadFresh();
    assert.equal(resolveApiUrl(), "http://env.example:1234");
  });

  it("follows the published port when nothing is configured", async () => {
    publishPort("3099\n");
    const { resolveApiUrl } = await loadFresh();
    assert.equal(resolveApiUrl(), "http://127.0.0.1:3099");
  });

  it("falls back to the default when nothing is published", async () => {
    const { resolveApiUrl, DEFAULT_API_URL } = await loadFresh();
    assert.equal(resolveApiUrl(), DEFAULT_API_URL);
  });

  it("falls back to the default when the published value is unusable", async () => {
    publishPort("   \n");
    const { resolveApiUrl, DEFAULT_API_URL } = await loadFresh();
    assert.equal(resolveApiUrl(), DEFAULT_API_URL);
  });
});

describe("resolveApiUrl — empty values mean 'unset'", () => {
  it("an empty explicit argument falls through to the published port", async () => {
    publishPort("3002\n");
    const { resolveApiUrl } = await loadFresh();
    assert.equal(resolveApiUrl(""), "http://127.0.0.1:3002");
  });

  it("an empty MULMOCLAUDE_API_URL falls through to the published port", async () => {
    process.env.MULMOCLAUDE_API_URL = "";
    publishPort("3002\n");
    const { resolveApiUrl } = await loadFresh();
    assert.equal(resolveApiUrl(), "http://127.0.0.1:3002");
  });
});

// The runtime/startup split is a security boundary, not a convenience (#3078).
// A reconnecting client must be able to tell "nothing published yet" from "here
// is a port": the server clears `.server-port` at startup and writes the new
// token BEFORE republishing, so "token, no port" is a real and frequent state,
// and resolving it through the default would carry a freshly minted bearer
// token to whatever holds 3001 (Codex).
describe("resolvePublishedApiUrl — the same order, without the default", () => {
  it("reports null when nothing is published, where resolveApiUrl gives the default", async () => {
    const { resolveApiUrl, resolvePublishedApiUrl, DEFAULT_API_URL } = await loadFresh();
    assert.equal(resolvePublishedApiUrl(), null);
    assert.equal(resolveApiUrl(), DEFAULT_API_URL);
  });

  it("reports null when the published value is unusable", async () => {
    publishPort("not-a-port\n");
    const { resolvePublishedApiUrl } = await loadFresh();
    assert.equal(resolvePublishedApiUrl(), null);
  });

  it("returns the published origin when there is one", async () => {
    publishPort("3099\n");
    const { resolvePublishedApiUrl } = await loadFresh();
    assert.equal(resolvePublishedApiUrl(), "http://127.0.0.1:3099");
  });

  it("an explicit argument still wins, and is never null", async () => {
    const { resolvePublishedApiUrl } = await loadFresh();
    assert.equal(resolvePublishedApiUrl("http://explicit.example:9999"), "http://explicit.example:9999");
  });

  it("MULMOCLAUDE_API_URL still wins, and is never null", async () => {
    process.env.MULMOCLAUDE_API_URL = "http://env.example:1234";
    const { resolvePublishedApiUrl } = await loadFresh();
    assert.equal(resolvePublishedApiUrl(), "http://env.example:1234");
  });

  it("and the two agree whenever a value exists at all", async () => {
    publishPort("3002\n");
    const { resolveApiUrl, resolvePublishedApiUrl } = await loadFresh();
    assert.equal(resolvePublishedApiUrl(), resolveApiUrl());
  });
});
