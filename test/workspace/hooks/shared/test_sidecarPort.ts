// The accepted set of `.server-port` values (#3084).
//
// `readPort` bounded the value with two hardcoded literals (`> 0 && < 65536`).
// They now come from `PORT_RANGE` in `@mulmoclaude/common` — the same constant
// the server, the dev proxy and the bridges bound against — so this pins the
// accepted set, which must NOT have changed: the hook reads this value to REACH
// the server, and 0 (valid to bind, "ask the OS") is not a port to connect to.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readPort } from "../../../../server/workspace/hooks/shared/sidecar.ts";

const PORT_FILE = ".server-port";
let workspace = "";
let savedProjectDir: string | undefined;

before(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "sidecar-port-"));
  savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = workspace;
});

after(() => {
  if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  rmSync(workspace, { recursive: true, force: true });
});

const withPortFile = (raw: string | null): number | null => {
  const file = path.join(workspace, PORT_FILE);
  if (raw === null) {
    try {
      unlinkSync(file);
    } catch {
      // already absent — that is the case under test
    }
  } else {
    writeFileSync(file, raw, "utf-8");
  }
  return readPort();
};

describe("readPort — accepted", () => {
  it("a published port is read as written", () => {
    assert.equal(withPortFile("3002"), 3002);
    assert.equal(withPortFile("3021"), 3021);
  });

  it("surrounding whitespace is trimmed", () => {
    assert.equal(withPortFile("  3100 \n"), 3100);
  });

  it("the top of the range is inclusive", () => {
    assert.equal(withPortFile("65535"), 65535);
  });
});

describe("readPort — rejected", () => {
  it("no file and an empty file both mean 'the server has not published one'", () => {
    assert.equal(withPortFile(null), null);
    assert.equal(withPortFile(""), null);
    assert.equal(withPortFile("   \n"), null);
  });

  it("0 is refused — valid to bind, never to connect to", () => {
    assert.equal(withPortFile("0"), null);
  });

  it("out of range at either end is refused", () => {
    assert.equal(withPortFile("-1"), null);
    assert.equal(withPortFile("65536"), null);
    assert.equal(withPortFile("99999"), null);
  });

  it("a non-numeric value is refused", () => {
    ["abc", "port", "NaN", "Infinity", "[]", "{}"].forEach((raw) => {
      assert.equal(withPortFile(raw), null, `expected null for ${JSON.stringify(raw)}`);
    });
  });
});
