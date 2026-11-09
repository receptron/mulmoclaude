// Tests for `server/utils/launcher/preflight.mjs`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  formatEnginesRange,
  formatRequiredNode,
  isCommandAvailable,
  isNodeVersionSupported,
  parseNodeVersion,
  runPreflight,
} from "../../../server/utils/launcher/preflight.mjs";
import { launcherMessages } from "../../../server/utils/launcher/messages.mjs";

describe("parseNodeVersion", () => {
  it("reads process.version-shaped input", () => {
    assert.deepEqual(parseNodeVersion("v24.12.0"), { major: 24, minor: 12, patch: 0 });
    assert.deepEqual(parseNodeVersion("20.12.2"), { major: 20, minor: 12, patch: 2 });
  });

  it("returns null rather than guessing at junk", () => {
    ["", "vNext", "20", "v20.12", "v20.x.0", "v20.12.x"].forEach((raw) => assert.equal(parseNodeVersion(raw), null, raw));
  });
});

describe("isNodeVersionSupported", () => {
  it("accepts each major's floor and anything above it", () => {
    ["v24.15.0", "v24.16.1", "v26.0.0", "v27.3.1", "v30.0.0"].forEach((raw) => assert.ok(isNodeVersionSupported(raw), raw));
  });

  it("rejects below a major's floor, down to the patch", () => {
    ["v24.14.9", "v24.0.0"].forEach((raw) => assert.ok(!isNodeVersionSupported(raw), raw));
  });

  it("rejects a major with no floor of its own, and anything older than the oldest", () => {
    ["v22.22.2", "v23.11.0", "v25.9.0", "v20.19.0", "v18.20.0", "v21.7.3"].forEach((raw) => assert.ok(!isNodeVersionSupported(raw), raw));
  });

  it("treats an unparseable version as unsupported", () => {
    assert.ok(!isNodeVersionSupported("who knows"));
  });
});

describe("REQUIRED_NODE", () => {
  it("matches engines.node in the published launcher package and the root", () => {
    [join("packages", "mulmoclaude", "package.json"), "package.json"].forEach((pkgPath) => {
      const engines = JSON.parse(readFileSync(join(process.cwd(), pkgPath), "utf8")).engines.node as string;
      assert.equal(engines, formatEnginesRange(), `preflight requirement drifted from ${pkgPath} engines`);
    });
  });

  it("formats as an engines range and as a readable list", () => {
    assert.equal(formatEnginesRange(), "^24.15.0 || >=26.0.0");
    assert.equal(formatRequiredNode(), "24.15.0 / 26.0.0");
  });
});

describe("isCommandAvailable", () => {
  it("is true when the probe succeeds", () => {
    assert.ok(isCommandAvailable("anything", { run: () => "1.0.0" }));
  });

  it("is false when the probe throws — a missing binary must not crash the launcher", () => {
    assert.ok(
      !isCommandAvailable("anything", {
        run: () => {
          throw new Error("ENOENT");
        },
      }),
    );
  });
});

describe("runPreflight", () => {
  const allPresent = () => true;

  it("passes when node is new enough and both commands are present", () => {
    assert.equal(runPreflight({ nodeVersion: "v24.15.0", commandAvailable: allPresent }), null);
  });

  it("reports the node version first, since nothing else can be trusted without it", () => {
    const failure = runPreflight({ nodeVersion: "v18.0.0", commandAvailable: () => false });
    assert.equal(failure?.key, "nodeTooOld");
    assert.deepEqual(failure?.values, { required: "24.15.0 / 26.0.0", found: "v18.0.0" });
  });

  it("reports npx before claude — npx is what actually gets spawned", () => {
    const failure = runPreflight({ nodeVersion: "v24.15.0", commandAvailable: (command) => command !== "npx" });
    assert.equal(failure?.key, "npxMissing");
  });

  it("reports a missing Claude Code", () => {
    const failure = runPreflight({ nodeVersion: "v24.15.0", commandAvailable: (command) => command !== "claude" });
    assert.equal(failure?.key, "claudeMissing");
  });

  it("only ever names a key the catalog can render", () => {
    const messages = launcherMessages("en");
    const failures = [
      runPreflight({ nodeVersion: "v18.0.0", commandAvailable: allPresent }),
      runPreflight({ nodeVersion: "v24.15.0", commandAvailable: (command) => command !== "npx" }),
      runPreflight({ nodeVersion: "v24.15.0", commandAvailable: (command) => command !== "claude" }),
    ];
    failures.forEach((failure) => {
      assert.ok(failure !== null);
      assert.ok(failure.key in messages, `no message for ${failure.key}`);
    });
  });
});
