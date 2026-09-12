import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

// The config module reads workspacePath at the time of each call,
// so we swap HOME to a temp dir BEFORE importing it. Inline dynamic
// import keeps the module under test pinned to this suite's HOME.
let tmpRoot: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

type ConfigModule = typeof import("../../server/system/config.js");
let mod: ConfigModule;

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-config-test-"));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  // homedir() uses HOME on POSIX and USERPROFILE on Windows; set both
  // so the test's temp workspace is picked up regardless of platform.
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  // Pre-create the workspace root that workspace.ts expects.
  mkdirSync(path.join(tmpRoot, "mulmoclaude"), { recursive: true });
  mod = await import("../../server/system/config.js");
});

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("isAppSettings", () => {
  it("accepts a well-formed settings object", () => {
    assert.ok(
      mod.isAppSettings({
        extraAllowedTools: ["mcp__claude_ai_Gmail"],
      }),
    );
    assert.ok(mod.isAppSettings({ extraAllowedTools: [] }));
  });

  it("rejects non-objects", () => {
    assert.equal(mod.isAppSettings(null), false);
    assert.equal(mod.isAppSettings(undefined), false);
    assert.equal(mod.isAppSettings("hello"), false);
    assert.equal(mod.isAppSettings(42), false);
    assert.equal(mod.isAppSettings([]), false);
  });

  it("rejects missing or non-array extraAllowedTools", () => {
    assert.equal(mod.isAppSettings({}), false);
    assert.equal(mod.isAppSettings({ extraAllowedTools: "nope" }), false);
    assert.equal(mod.isAppSettings({ extraAllowedTools: null }), false);
  });

  it("rejects arrays containing non-strings", () => {
    assert.equal(mod.isAppSettings({ extraAllowedTools: ["ok", 42] }), false);
    assert.equal(mod.isAppSettings({ extraAllowedTools: [null] }), false);
  });

  it("accepts known effortLevel values", () => {
    for (const level of mod.EFFORT_LEVELS) {
      assert.ok(mod.isAppSettings({ extraAllowedTools: [], effortLevel: level }), `expected ${level} to be accepted`);
    }
  });

  it("rejects unknown effortLevel values", () => {
    assert.equal(mod.isAppSettings({ extraAllowedTools: [], effortLevel: "ultra" }), false);
    assert.equal(mod.isAppSettings({ extraAllowedTools: [], effortLevel: "" }), false);
    assert.equal(mod.isAppSettings({ extraAllowedTools: [], effortLevel: 42 }), false);
    assert.equal(mod.isAppSettings({ extraAllowedTools: [], effortLevel: null }), false);
  });

  // #2923: family aliases only. A pinned id must be rejected — the whole
  // point of storing an alias is that the saved choice follows the next
  // generation instead of quietly keeping the user on a retired model.
  it("accepts known chatModel values", () => {
    for (const model of mod.CHAT_MODELS) {
      assert.ok(mod.isAppSettings({ extraAllowedTools: [], chatModel: model }), `expected ${model} to be accepted`);
    }
  });

  it("rejects pinned model ids and other unknown chatModel values", () => {
    assert.equal(mod.isAppSettings({ extraAllowedTools: [], chatModel: "claude-opus-4-8" }), false);
    assert.equal(mod.isAppSettings({ extraAllowedTools: [], chatModel: "opus[1m]" }), false);
    assert.equal(mod.isAppSettings({ extraAllowedTools: [], chatModel: "" }), false);
    assert.equal(mod.isAppSettings({ extraAllowedTools: [], chatModel: 42 }), false);
    assert.equal(mod.isAppSettings({ extraAllowedTools: [], chatModel: null }), false);
  });
});

// The optional-field validation moved from a chain of ifs to a table keyed by
// `OptionalAppSettingsKey` (#2923 — the chain had hit the complexity ceiling).
// A differential run of the old chain against the new table agreed on 203,242
// generated inputs; what survives that harness is the generator below (which
// input shapes matter for these fields) and the property it proved: every
// optional key accepts absence and its own valid values, rejects every
// abnormal shape, and one bad field rejects the whole object however valid
// its neighbours are. The table itself is the thing that could silently lose
// a row, so the last case pins its coverage at runtime too.
describe("optional AppSettings fields", () => {
  // Built inside a function, not at suite-construction time: `mod` is only
  // imported in the `before` hook above (HOME must be swapped first).
  const pools = () => ({
    valid: {
      googleMapsApiKey: ["", "AIza-key"],
      photoExif: [{ autoCapture: true }, { autoCapture: false }],
      effortLevel: [...mod.EFFORT_LEVELS],
      chatModel: [...mod.CHAT_MODELS],
      voiceInput: [{ enabled: true }, { enabled: false, model: "base.en" }],
      chatIndex: [...mod.CHAT_INDEX_MODES],
      journal: [...mod.JOURNAL_MODES],
      pushEnabled: [true, false],
      macosRemindersEnabled: [true, false],
    } as Record<string, unknown[]>,
    invalid: {
      googleMapsApiKey: [42, null, {}, [], true],
      photoExif: [{ autoCapture: "yes" }, {}, null, 42, "x", []],
      effortLevel: ["ultra", "", null, 42, {}, ["high"], "HIGH"],
      chatModel: ["claude-opus-4-8", "opus[1m]", "", null, 42, {}, []],
      voiceInput: [{ enabled: true, model: 42 }, { enabled: "yes" }, {}, null, "x", []],
      chatIndex: ["opus", "", null, 42, {}, []],
      journal: ["opus", "", null, 42, {}, []],
      pushEnabled: ["true", null, 0, 1, {}, []],
      macosRemindersEnabled: ["false", null, 0, 1, {}, []],
    } as Record<string, unknown[]>,
  });

  it("accepts absence and every valid value, on both the full and patch shapes", () => {
    const { valid } = pools();
    assert.ok(mod.isAppSettings({ extraAllowedTools: [] }), "all-absent must be valid");
    Object.keys(valid).forEach((key) => {
      valid[key]?.forEach((value) => {
        assert.ok(mod.isAppSettings({ extraAllowedTools: [], [key]: value }), `${key}=${JSON.stringify(value)} must be accepted`);
        assert.ok(mod.isAppSettingsPatch({ [key]: value }), `${key}=${JSON.stringify(value)} must be accepted on the patch path`);
      });
    });
  });

  it("rejects every abnormal value, even beside otherwise valid fields", () => {
    const { valid, invalid } = pools();
    const goodNeighbours = Object.fromEntries(Object.keys(valid).map((key) => [key, valid[key]?.[0]]));
    Object.keys(invalid).forEach((key) => {
      invalid[key]?.forEach((value) => {
        assert.equal(mod.isAppSettings({ extraAllowedTools: [], [key]: value }), false, `${key}=${JSON.stringify(value)} must be rejected`);
        assert.equal(
          mod.isAppSettings({ extraAllowedTools: [], ...goodNeighbours, [key]: value }),
          false,
          `${key}=${JSON.stringify(value)} must still be rejected beside valid neighbours`,
        );
      });
    });
  });

  it("validates every optional key in AppSettings — a field with no validator would be accepted in any shape", () => {
    const optionalKeys = mod.APP_SETTINGS_KEYS.filter((key) => key !== "extraAllowedTools");
    assert.deepEqual(
      [...optionalKeys].sort(),
      Object.keys(pools().valid).sort(),
      "an optional setting is missing from the validator table (or from this test)",
    );
  });
});

describe("isAppSettingsPatch", () => {
  it("allows null effortLevel as the clear-me sentinel", () => {
    assert.ok(mod.isAppSettingsPatch({ effortLevel: null }));
    assert.ok(mod.isAppSettingsPatch({ effortLevel: "high" }));
    assert.ok(mod.isAppSettingsPatch({}));
  });

  it("rejects garbage effortLevel even on the patch path", () => {
    assert.equal(mod.isAppSettingsPatch({ effortLevel: "ultra" }), false);
    assert.equal(mod.isAppSettingsPatch({ effortLevel: 42 }), false);
  });

  // #2923: same null-sentinel + strict-value contract as effortLevel.
  it("accepts every known chatModel and the null clear-sentinel", () => {
    for (const model of mod.CHAT_MODELS) {
      assert.ok(mod.isAppSettingsPatch({ chatModel: model }), `expected ${model} to be accepted`);
    }
    assert.ok(mod.isAppSettingsPatch({ chatModel: null }));
  });

  it("rejects unknown chatModel values on the patch path", () => {
    assert.equal(mod.isAppSettingsPatch({ chatModel: "claude-opus-4-8" }), false);
    assert.equal(mod.isAppSettingsPatch({ chatModel: "" }), false);
    assert.equal(mod.isAppSettingsPatch({ chatModel: 42 }), false);
  });

  // #1944: same null-sentinel + strict-value pattern as effortLevel
  // for the new chatIndex field.
  it("accepts every known chatIndex mode and the null clear-sentinel", () => {
    for (const mode of mod.CHAT_INDEX_MODES) {
      assert.ok(mod.isAppSettingsPatch({ chatIndex: mode }), `expected ${mode} to be accepted`);
    }
    assert.ok(mod.isAppSettingsPatch({ chatIndex: null }));
  });

  it("rejects unknown chatIndex values on the patch path", () => {
    assert.equal(mod.isAppSettingsPatch({ chatIndex: "opus" }), false);
    assert.equal(mod.isAppSettingsPatch({ chatIndex: "" }), false);
    assert.equal(mod.isAppSettingsPatch({ chatIndex: 42 }), false);
  });

  // Same null-sentinel + strict-value contract for `journal` (follow-up
  // to #1944, mirroring chatIndex).
  it("accepts every known journal mode and the null clear-sentinel", () => {
    for (const mode of mod.JOURNAL_MODES) {
      assert.ok(mod.isAppSettingsPatch({ journal: mode }), `expected ${mode} to be accepted`);
    }
    assert.ok(mod.isAppSettingsPatch({ journal: null }));
  });

  it("rejects unknown journal values on the patch path", () => {
    assert.equal(mod.isAppSettingsPatch({ journal: "opus" }), false);
    assert.equal(mod.isAppSettingsPatch({ journal: "" }), false);
    assert.equal(mod.isAppSettingsPatch({ journal: 42 }), false);
  });
});

describe("normaliseAppSettingsPatch", () => {
  it("strips null effortLevel", () => {
    assert.deepEqual(mod.normaliseAppSettingsPatch({ effortLevel: null }), {});
  });

  it("preserves a present effortLevel", () => {
    assert.deepEqual(mod.normaliseAppSettingsPatch({ effortLevel: "high" }), { effortLevel: "high" });
  });

  it("preserves other fields untouched", () => {
    assert.deepEqual(mod.normaliseAppSettingsPatch({ extraAllowedTools: ["a"], effortLevel: null }), { extraAllowedTools: ["a"] });
  });

  // #2923: chatModel null-sentinel mirrors effortLevel.
  it("strips null chatModel", () => {
    assert.deepEqual(mod.normaliseAppSettingsPatch({ chatModel: null }), {});
  });

  it("preserves a present chatModel", () => {
    assert.deepEqual(mod.normaliseAppSettingsPatch({ chatModel: "sonnet" }), { chatModel: "sonnet" });
  });

  // #1944: chatIndex null-sentinel mirrors effortLevel.
  it("strips null chatIndex", () => {
    assert.deepEqual(mod.normaliseAppSettingsPatch({ chatIndex: null }), {});
  });

  it("preserves a present chatIndex", () => {
    assert.deepEqual(mod.normaliseAppSettingsPatch({ chatIndex: "haiku" }), { chatIndex: "haiku" });
    assert.deepEqual(mod.normaliseAppSettingsPatch({ chatIndex: "sonnet" }), { chatIndex: "sonnet" });
  });

  it("strips null journal", () => {
    assert.deepEqual(mod.normaliseAppSettingsPatch({ journal: null }), {});
  });

  it("preserves a present journal", () => {
    assert.deepEqual(mod.normaliseAppSettingsPatch({ journal: "haiku" }), { journal: "haiku" });
    assert.deepEqual(mod.normaliseAppSettingsPatch({ journal: "sonnet" }), { journal: "sonnet" });
  });
});

describe("loadSettings", () => {
  afterEach(() => {
    // Always start each test with a clean configs dir.
    rmSync(mod.configsDir(), { recursive: true, force: true });
  });

  it("returns defaults when the file is missing", () => {
    const cfg = mod.loadSettings();
    assert.deepEqual(cfg, { extraAllowedTools: [] });
  });

  it("reads a well-formed file", () => {
    mod.saveSettings({ extraAllowedTools: ["a", "b"] });
    assert.deepEqual(mod.loadSettings(), { extraAllowedTools: ["a", "b"] });
  });

  it("returns defaults and warns on malformed JSON", () => {
    mod.ensureConfigsDir();
    writeFileSync(mod.settingsPath(), "not json");
    const cfg = mod.loadSettings();
    assert.deepEqual(cfg, { extraAllowedTools: [] });
  });

  it("returns defaults when shape does not match", () => {
    mod.ensureConfigsDir();
    writeFileSync(mod.settingsPath(), JSON.stringify({ extraAllowedTools: [1, 2, 3] }));
    assert.deepEqual(mod.loadSettings(), { extraAllowedTools: [] });
  });

  // Codex review on PR #1247: a hand-edited partial settings file
  // (`{ "photoExif": { "autoCapture": false } }`) was previously
  // rejected by `loadSettings` because `extraAllowedTools` was
  // mandatory in the schema, silently re-enabling auto-capture. The
  // loader now accepts the patch shape and merges with defaults.
  it("accepts a hand-edited partial file with photoExif but no extraAllowedTools", () => {
    mod.ensureConfigsDir();
    writeFileSync(mod.settingsPath(), JSON.stringify({ photoExif: { autoCapture: false } }));
    const cfg = mod.loadSettings();
    assert.deepEqual(cfg, {
      extraAllowedTools: [],
      photoExif: { autoCapture: false },
    });
    assert.equal(mod.isPhotoExifAutoCaptureEnabled(cfg), false);
  });

  it("accepts a hand-edited partial file with only googleMapsApiKey", () => {
    mod.ensureConfigsDir();
    writeFileSync(mod.settingsPath(), JSON.stringify({ googleMapsApiKey: "AIza..." }));
    assert.deepEqual(mod.loadSettings(), {
      extraAllowedTools: [],
      googleMapsApiKey: "AIza...",
    });
  });

  it("still falls back when a present field has the wrong type", () => {
    mod.ensureConfigsDir();
    writeFileSync(mod.settingsPath(), JSON.stringify({ extraAllowedTools: "not-array" }));
    assert.deepEqual(mod.loadSettings(), { extraAllowedTools: [] });
  });

  it("returns a defensive copy — mutating the result does not affect disk", () => {
    mod.saveSettings({ extraAllowedTools: ["x"] });
    const first = mod.loadSettings();
    first.extraAllowedTools.push("y");
    const second = mod.loadSettings();
    assert.deepEqual(second.extraAllowedTools, ["x"]);
  });
});

describe("pushEnabled (Web Push on task finish)", () => {
  it("validates a boolean pushEnabled on both the full and patch shapes", () => {
    assert.ok(mod.isAppSettings({ extraAllowedTools: [], pushEnabled: true }));
    assert.equal(mod.isAppSettings({ extraAllowedTools: [], pushEnabled: "yes" }), false);
    assert.ok(mod.isAppSettingsPatch({ pushEnabled: false }));
    assert.equal(mod.isAppSettingsPatch({ pushEnabled: 1 }), false);
  });

  it("round-trips through save/load", () => {
    mod.saveSettings({ extraAllowedTools: [], pushEnabled: true });
    assert.equal(mod.loadSettings().pushEnabled, true);
  });

  it("defaults to off when unset and reads back what was set", () => {
    assert.equal(mod.isPushEnabled({ extraAllowedTools: [] }), false);
    assert.equal(mod.isPushEnabled({ extraAllowedTools: [], pushEnabled: false }), false);
    assert.equal(mod.isPushEnabled({ extraAllowedTools: [], pushEnabled: true }), true);
  });
});

describe("macosRemindersEnabled (#2617)", () => {
  it("validates a boolean on both the full and patch shapes", () => {
    assert.ok(mod.isAppSettings({ extraAllowedTools: [], macosRemindersEnabled: false }));
    assert.equal(mod.isAppSettings({ extraAllowedTools: [], macosRemindersEnabled: "no" }), false);
    assert.ok(mod.isAppSettingsPatch({ macosRemindersEnabled: true }));
    assert.equal(mod.isAppSettingsPatch({ macosRemindersEnabled: 0 }), false);
  });

  it("round-trips through save/load", () => {
    // `cloneAppSettings` on the read path is a separate choke point from the
    // `saveSettings` projection — a field registered in only one of them
    // survives the write and vanishes on the next read.
    mod.saveSettings({ extraAllowedTools: [], macosRemindersEnabled: false });
    assert.equal(mod.loadSettings().macosRemindersEnabled, false);
  });

  it("defaults to ON when unset — the sink shipped enabled, so an older settings file keeps firing", () => {
    assert.equal(mod.isMacosRemindersEnabled({ extraAllowedTools: [] }), true);
    assert.equal(mod.isMacosRemindersEnabled({ extraAllowedTools: [], macosRemindersEnabled: false }), false);
    assert.equal(mod.isMacosRemindersEnabled({ extraAllowedTools: [], macosRemindersEnabled: true }), true);
  });
});

describe("isMcpServerSpec", () => {
  it("accepts valid http specs", () => {
    assert.ok(mod.isMcpServerSpec({ type: "http", url: "https://example.com/mcp" }));
    assert.ok(
      mod.isMcpServerSpec({
        type: "http",
        url: "http://localhost:9000",
        headers: { Authorization: "Bearer x" },
        enabled: false,
      }),
    );
  });

  it("rejects http specs with a missing or empty url", () => {
    assert.equal(mod.isMcpServerSpec({ type: "http", url: "" }), false);
    assert.equal(mod.isMcpServerSpec({ type: "http" }), false);
  });

  it("accepts stdio specs using the command allowlist", () => {
    assert.ok(mod.isMcpServerSpec({ type: "stdio", command: "npx", args: ["-y"] }));
    assert.ok(mod.isMcpServerSpec({ type: "stdio", command: "node" }));
    assert.ok(mod.isMcpServerSpec({ type: "stdio", command: "tsx" }));
  });

  it("rejects stdio specs with a disallowed command", () => {
    assert.equal(mod.isMcpServerSpec({ type: "stdio", command: "bash" }), false);
    assert.equal(mod.isMcpServerSpec({ type: "stdio", command: "python3" }), false);
    assert.equal(mod.isMcpServerSpec({ type: "stdio", command: "/usr/bin/node" }), false);
  });

  it("rejects stdio specs with non-string args or env values", () => {
    assert.equal(
      mod.isMcpServerSpec({
        type: "stdio",
        command: "npx",
        args: [1, 2],
      }),
      false,
    );
    assert.equal(
      mod.isMcpServerSpec({
        type: "stdio",
        command: "npx",
        env: { K: 42 },
      }),
      false,
    );
  });

  it("accepts the optional hostExecInDocker boolean on stdio specs (#1421 Phase B)", () => {
    assert.ok(mod.isMcpServerSpec({ type: "stdio", command: "npx", hostExecInDocker: true }));
    assert.ok(mod.isMcpServerSpec({ type: "stdio", command: "npx", hostExecInDocker: false }));
  });

  it("rejects a non-boolean hostExecInDocker", () => {
    assert.equal(mod.isMcpServerSpec({ type: "stdio", command: "npx", hostExecInDocker: "yes" }), false);
    assert.equal(mod.isMcpServerSpec({ type: "stdio", command: "npx", hostExecInDocker: 1 }), false);
  });

  it("rejects unknown type", () => {
    assert.equal(mod.isMcpServerSpec({ type: "unix", path: "/x" }), false);
  });
});

describe("isMcpServerId", () => {
  it("accepts slug-shaped ids", () => {
    assert.ok(mod.isMcpServerId("gmail"));
    assert.ok(mod.isMcpServerId("my-server"));
    assert.ok(mod.isMcpServerId("a1_b2-c3"));
  });

  it("rejects ids starting with non-letter or containing uppercase", () => {
    assert.equal(mod.isMcpServerId(""), false);
    assert.equal(mod.isMcpServerId("1foo"), false);
    assert.equal(mod.isMcpServerId("-foo"), false);
    assert.equal(mod.isMcpServerId("Foo"), false);
    assert.equal(mod.isMcpServerId("has space"), false);
  });

  // Codex iter-2 on #1356: consecutive `__` is forbidden because the
  // tool-naming encoding (`mcp__<server>__<tool>`) uses `__` as the
  // delimiter — a server id like `foo__bar` produces a tool name
  // ambiguous between server `foo` and server `foo__bar`. Single `_`
  // is still allowed.
  it("rejects ids containing consecutive `__` (delimiter collision)", () => {
    assert.equal(mod.isMcpServerId("foo__bar"), false);
    assert.equal(mod.isMcpServerId("a__b"), false);
    assert.equal(mod.isMcpServerId("__leading"), false);
    assert.equal(mod.isMcpServerId("trailing__"), false);
    // Single `_` still accepted (regression guard).
    assert.ok(mod.isMcpServerId("foo_bar"));
    assert.ok(mod.isMcpServerId("a_b_c"));
  });
});

describe("loadMcpConfig / saveMcpConfig", () => {
  beforeEach(() => {
    rmSync(mod.configsDir(), { recursive: true, force: true });
  });

  it("returns empty mcpServers when missing", () => {
    assert.deepEqual(mod.loadMcpConfig(), { mcpServers: {} });
  });

  it("round-trips a typical config file", () => {
    const cfg: import("../../server/system/config.js").McpConfigFile = {
      mcpServers: {
        gmail: {
          type: "http",
          url: "https://gmail.mcp.claude.com/mcp",
          enabled: true,
        },
        files: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
        },
      },
    };
    mod.saveMcpConfig(cfg);
    assert.deepEqual(mod.loadMcpConfig(), cfg);
  });

  it("returns defaults on malformed JSON", () => {
    mod.ensureConfigsDir();
    writeFileSync(mod.mcpConfigPath(), "{broken");
    assert.deepEqual(mod.loadMcpConfig(), { mcpServers: {} });
  });

  it("returns defaults when schema does not match", () => {
    mod.ensureConfigsDir();
    writeFileSync(mod.mcpConfigPath(), JSON.stringify({ mcpServers: { BAD: { type: "http", url: "x" } } }));
    assert.deepEqual(mod.loadMcpConfig(), { mcpServers: {} });
  });

  it("saveMcpConfig rejects malformed input without touching disk", () => {
    assert.throws(() =>
      mod.saveMcpConfig({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mcpServers: { ok: { type: "nope" } as any },
      }),
    );
    assert.equal(existsSync(mod.mcpConfigPath()), false);
  });
});

describe("toMcpEntries / fromMcpEntries", () => {
  it("flattens and re-inflates without loss", () => {
    const cfg: import("../../server/system/config.js").McpConfigFile = {
      mcpServers: {
        a: { type: "http", url: "https://a.example/mcp" },
        b: { type: "http", url: "https://b.example/mcp" },
      },
    };
    const entries = mod.toMcpEntries(cfg);
    assert.equal(entries.length, 2);
    const restored = mod.fromMcpEntries(entries);
    assert.deepEqual(restored, cfg);
  });

  it("throws on duplicate ids", () => {
    assert.throws(() =>
      mod.fromMcpEntries([
        { id: "dup", spec: { type: "http", url: "https://x" } },
        { id: "dup", spec: { type: "http", url: "https://y" } },
      ]),
    );
  });

  it("throws on invalid id shape", () => {
    assert.throws(() => mod.fromMcpEntries([{ id: "BAD", spec: { type: "http", url: "https://x" } }]));
  });
});

describe("saveSettings", () => {
  beforeEach(() => {
    rmSync(mod.configsDir(), { recursive: true, force: true });
  });

  it("creates config/ if missing and writes JSON", () => {
    mod.saveSettings({ extraAllowedTools: ["mcp__claude_ai_Gmail"] });
    const raw = readFileSync(mod.settingsPath(), "utf-8");
    assert.deepEqual(JSON.parse(raw), {
      extraAllowedTools: ["mcp__claude_ai_Gmail"],
    });
  });

  it("writes trailing newline and restrictive permissions", () => {
    mod.saveSettings({ extraAllowedTools: [] });
    const raw = readFileSync(mod.settingsPath(), "utf-8");
    assert.ok(raw.endsWith("\n"));
    if (process.platform !== "win32") {
      const stat = statSync(mod.settingsPath());
      // Low 9 bits = owner/group/other perms; expect 0o600.
      assert.equal(stat.mode & 0o777, 0o600);
    }
  });

  it("rejects invalid shapes", () => {
    assert.throws(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mod.saveSettings({ extraAllowedTools: 42 } as any);
    });
  });

  it("replaces existing file atomically (no .tmp leftover)", () => {
    mod.saveSettings({ extraAllowedTools: ["first"] });
    mod.saveSettings({ extraAllowedTools: ["second"] });
    const entries = readdirSync(mod.configsDir());
    const leftover = entries.filter((entry) => entry.endsWith(".tmp"));
    assert.deepEqual(leftover, []);
    assert.deepEqual(mod.loadSettings(), { extraAllowedTools: ["second"] });
  });

  // #1944: without this test the earlier bug (saveSettings dropping
  // chatIndex on write, so the mode reverted on reload) would slip
  // past. Roundtrips both non-default modes.
  it("persists chatIndex and roundtrips it through loadSettings", () => {
    mod.saveSettings({ extraAllowedTools: [], chatIndex: "haiku" });
    assert.deepEqual(mod.loadSettings(), { extraAllowedTools: [], chatIndex: "haiku" });
    mod.saveSettings({ extraAllowedTools: [], chatIndex: "sonnet" });
    assert.deepEqual(mod.loadSettings(), { extraAllowedTools: [], chatIndex: "sonnet" });
  });

  it("omits chatIndex when unset so settings.json stays default-clean", () => {
    mod.saveSettings({ extraAllowedTools: [] });
    const raw = readFileSync(mod.settingsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal("chatIndex" in parsed, false);
  });

  it("persists journal and roundtrips it through loadSettings", () => {
    mod.saveSettings({ extraAllowedTools: [], journal: "haiku" });
    assert.deepEqual(mod.loadSettings(), { extraAllowedTools: [], journal: "haiku" });
    mod.saveSettings({ extraAllowedTools: [], journal: "sonnet" });
    assert.deepEqual(mod.loadSettings(), { extraAllowedTools: [], journal: "sonnet" });
  });

  it("omits journal when unset so settings.json stays default-clean", () => {
    mod.saveSettings({ extraAllowedTools: [] });
    const raw = readFileSync(mod.settingsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal("journal" in parsed, false);
  });

  it("persists chatModel and roundtrips it through loadSettings", () => {
    mod.saveSettings({ extraAllowedTools: [], chatModel: "sonnet" });
    assert.deepEqual(mod.loadSettings(), { extraAllowedTools: [], chatModel: "sonnet" });
    mod.saveSettings({ extraAllowedTools: [], chatModel: "haiku" });
    assert.deepEqual(mod.loadSettings(), { extraAllowedTools: [], chatModel: "haiku" });
  });

  // Key-absent, not "key present with a falsy value": absent is what makes
  // the CLI fall back to ~/.claude/settings.json, which is the documented
  // default behaviour (#2923).
  it("omits chatModel when unset so settings.json stays default-clean", () => {
    mod.saveSettings({ extraAllowedTools: [] });
    const raw = readFileSync(mod.settingsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal("chatModel" in parsed, false);
  });
});

// #1944: the resolver is the single choke point every reader
// (indexer, backfill, settings tab) uses to translate the on-disk
// value into a mode literal. Belt-and-braces test that undefined /
// missing → "off" so the docs stay honest.
describe("chatIndexMode resolver", () => {
  it("returns 'off' when the field is undefined (default)", () => {
    assert.equal(mod.chatIndexMode({ extraAllowedTools: [] }), "off");
  });

  it("returns the stored value when set", () => {
    assert.equal(mod.chatIndexMode({ extraAllowedTools: [], chatIndex: "haiku" }), "haiku");
    assert.equal(mod.chatIndexMode({ extraAllowedTools: [], chatIndex: "sonnet" }), "sonnet");
    assert.equal(mod.chatIndexMode({ extraAllowedTools: [], chatIndex: "off" }), "off");
  });
});

describe("journalMode resolver", () => {
  it("returns 'off' when the field is undefined (default)", () => {
    assert.equal(mod.journalMode({ extraAllowedTools: [] }), "off");
  });

  it("returns the stored value when set", () => {
    assert.equal(mod.journalMode({ extraAllowedTools: [], journal: "haiku" }), "haiku");
    assert.equal(mod.journalMode({ extraAllowedTools: [], journal: "sonnet" }), "sonnet");
    assert.equal(mod.journalMode({ extraAllowedTools: [], journal: "off" }), "off");
  });
});
