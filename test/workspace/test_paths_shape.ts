import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";
import {
  WORKSPACE_DIRS,
  WORKSPACE_PATHS,
  WORKSPACE_FILES,
  EAGER_WORKSPACE_DIRS,
  workspacePath,
  isTestEnv,
  detectTestEnv,
} from "../../server/workspace/paths.js";

const expectedWorkspacePath = path.join(homedir(), "mulmoclaude");

describe("workspacePath", () => {
  it("points to ~/mulmoclaude or the test/env override", () => {
    const realUserHome = (() => {
      try {
        return userInfo().homedir;
      } catch {
        return homedir();
      }
    })();
    const isHomeOverridden = homedir() !== realUserHome;

    const expected =
      process.env.MULMOCLAUDE_WORKSPACE_PATH || (isTestEnv && !isHomeOverridden ? path.join(tmpdir(), "mulmoclaude-test") : expectedWorkspacePath);
    assert.equal(workspacePath, expected);
  });
});

describe("detectTestEnv (#1596)", () => {
  const cleanEnv: Record<string, string | undefined> = {};

  it("does NOT flag `yarn dev` launched from a path containing 'test'", () => {
    const argv = ["/usr/bin/node", "/home/u/worktrees/e2e-live-docker-test-fixes/node_modules/.bin/tsx", "server/index.ts"];
    assert.equal(detectTestEnv(argv, [], cleanEnv), false);
  });

  it("flags `node --test` (flag in execArgv)", () => {
    assert.equal(detectTestEnv(["node", "x.ts"], ["--test"], cleanEnv), true);
  });

  it("flags `--test` passed as an argv flag", () => {
    assert.equal(detectTestEnv(["node", "--test", "x.ts"], [], cleanEnv), true);
  });

  it("flags `playwright test` (exact 'test' subcommand)", () => {
    assert.equal(detectTestEnv(["node", "playwright", "test", "--config", "e2e"], [], cleanEnv), true);
  });

  it("flags the Node test runner via NODE_TEST_CONTEXT", () => {
    assert.equal(detectTestEnv(["node", "x.ts"], [], { NODE_TEST_CONTEXT: "child-v8" }), true);
  });

  it("flags NODE_ENV=test", () => {
    assert.equal(detectTestEnv(["node", "x.ts"], [], { NODE_ENV: "test" }), true);
  });
});

// Snapshot guard: adding/removing a key from WORKSPACE_DIRS must be
// deliberate. If a key is accidentally deleted, this test fails and
// the author knows to update EAGER_WORKSPACE_DIRS / consumers.
describe("WORKSPACE_DIRS expected keys", () => {
  const expectedKeys = [
    "accounting",
    "accountingBooks",
    "archive",
    "attachments",
    "brep",
    "calendar",
    "charts",
    "chat",
    "claudeSkills",
    "clients",
    "configs",
    "contacts",
    "cookingRecipes",
    "feeds",
    "github",
    "helps",
    "html",
    "htmls",
    "images",
    "ingestState",
    "locations",
    "markdowns",
    "marpThemes",
    "memoryDir",
    "memoryStaging",
    "models",
    "notifier",
    "pluginCache",
    "plugins",
    "pluginsConfig",
    "pluginsData",
    "roles",
    "scheduler",
    "searches",
    "shapes",
    "skillsCatalog",
    "skillsCatalogPreset",
    "skillsStaging",
    "spreadsheets",
    "stories",
    "summaries",
    "svgs",
    "translation",
    "transports",
    "wiki",
    "wikiHistory",
    "wikiPages",
    "wikiSources",
  ];

  it("has all expected keys", () => {
    const actual = Object.keys(WORKSPACE_DIRS).sort();
    assert.deepEqual(actual, expectedKeys);
  });

  it("every value is a non-empty string", () => {
    Object.entries(WORKSPACE_DIRS).forEach(([key, val]) => {
      assert.equal(typeof val, "string", `${key} should be a string`);
      assert.ok(val.length > 0, `${key} should not be empty`);
    });
  });
});

describe("WORKSPACE_PATHS mirrors WORKSPACE_DIRS + WORKSPACE_FILES", () => {
  it("every WORKSPACE_DIRS key has a matching WORKSPACE_PATHS entry", () => {
    Object.keys(WORKSPACE_DIRS).forEach((key) => {
      assert.ok(key in WORKSPACE_PATHS, `WORKSPACE_PATHS missing key: ${key}`);
    });
  });

  it("every WORKSPACE_FILES key has a matching WORKSPACE_PATHS entry", () => {
    Object.keys(WORKSPACE_FILES).forEach((key) => {
      assert.ok(key in WORKSPACE_PATHS, `WORKSPACE_PATHS missing key: ${key}`);
    });
  });

  it("WORKSPACE_PATHS values are absolute paths under workspacePath", () => {
    Object.entries(WORKSPACE_PATHS).forEach(([key, absPath]) => {
      assert.equal(typeof absPath, "string", `${key} should be a string`);
      assert.ok(absPath.startsWith(workspacePath), `${key}: ${absPath} should start with ${workspacePath}`);
    });
  });
});

describe("EAGER_WORKSPACE_DIRS", () => {
  it("is a non-empty array", () => {
    assert.ok(Array.isArray(EAGER_WORKSPACE_DIRS));
    assert.ok(EAGER_WORKSPACE_DIRS.length > 0);
  });

  it("every entry is a valid WORKSPACE_DIRS key", () => {
    const validKeys = new Set(Object.keys(WORKSPACE_DIRS));
    EAGER_WORKSPACE_DIRS.forEach((key) => {
      assert.ok(validKeys.has(key), `EAGER key "${key}" not in WORKSPACE_DIRS`);
    });
  });
});
