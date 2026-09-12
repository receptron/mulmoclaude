// Route-level checks for /api/config.
//
// The route logic itself is a thin wrapper around server/system/config.ts —
// load/save/validate. These tests cover:
//   - GET returns the current settings wrapped in { settings }
//   - PUT /config/settings validates shape + persists + returns the
//     re-read state (not the incoming payload, to catch write/read
//     drift)
//   - PUT rejects malformed bodies with HTTP 400
//
// Heavier integration — round-trips across the real Express stack
// including CSRF — is covered by e2e/tests/settings.spec.ts.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Request, Response } from "express";

type ConfigModule = typeof import("../../server/system/config.js");
type RouteModule = typeof import("../../server/api/routes/config.js");

let tmpRoot: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let configMod: ConfigModule;
let routeMod: RouteModule;

// Extract the two handlers from the Router so we can invoke them
// with plain req/res mocks (no supertest dependency).
type Handler = (req: Request, res: Response) => void;
let getHandler: Handler;
let putSettingsHandler: Handler;
let putConfigHandler: Handler;

interface StackFrame {
  route?: {
    path: string;
    stack: { method: string; handle: Handler }[];
  };
}

interface RouterInternals {
  stack: StackFrame[];
}

function extractRouteHandler(mod: RouteModule, routePath: string, method: "get" | "put"): Handler {
  const router = mod.default as unknown as RouterInternals;
  // Each router.get/put() registers its own stack frame, so find the
  // frame matching BOTH path and method rather than the first path hit.
  for (const frame of router.stack) {
    if (frame.route?.path !== routePath) continue;
    const layer = frame.route.stack.find((stackLayer) => stackLayer.method === method);
    if (layer) return layer.handle;
  }
  throw new Error(`route ${method.toUpperCase()} ${routePath} not registered`);
}

function mockRes() {
  const state: {
    status: number;
    body: unknown;
    ended: boolean;
  } = { status: 200, body: undefined, ended: false };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      state.ended = true;
      return res;
    },
  };
  return { state, res: res as unknown as Response };
}

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-config-route-"));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  // homedir() uses HOME on POSIX and USERPROFILE on Windows.
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  mkdirSync(path.join(tmpRoot, "mulmoclaude"), { recursive: true });
  configMod = await import("../../server/system/config.js");
  routeMod = await import("../../server/api/routes/config.js");
  getHandler = extractRouteHandler(routeMod, "/api/config", "get");
  putSettingsHandler = extractRouteHandler(routeMod, "/api/config/settings", "put");
  putConfigHandler = extractRouteHandler(routeMod, "/api/config", "put");
});

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(tmpRoot, { recursive: true, force: true });
});

// The route reports platform + env context for the macOS Reminders toggle
// (#2617). Both values are properties of the machine running the suite, not
// of the request, so the expectation is derived rather than hard-coded.
const macosRemindersContext = {
  supported: process.platform === "darwin",
  forcedOffByEnv: process.env.DISABLE_MACOS_REMINDER_NOTIFICATIONS === "1",
};

describe("GET /config", () => {
  beforeEach(() => {
    rmSync(configMod.configsDir(), { recursive: true, force: true });
  });

  it("returns defaults when nothing is on disk", () => {
    const { state, res } = mockRes();
    getHandler({} as Request, res);
    assert.equal(state.status, 200);
    assert.deepEqual(state.body, {
      settings: { extraAllowedTools: [] },
      mcp: { servers: [] },
      csp: {},
      macosReminders: macosRemindersContext,
    });
  });

  it("returns the persisted settings", () => {
    configMod.saveSettings({
      extraAllowedTools: ["mcp__claude_ai_Gmail"],
    });
    const { state, res } = mockRes();
    getHandler({} as Request, res);
    assert.deepEqual(state.body, {
      settings: { extraAllowedTools: ["mcp__claude_ai_Gmail"] },
      mcp: { servers: [] },
      csp: {},
      macosReminders: macosRemindersContext,
    });
  });
});

describe("PUT /config/settings", () => {
  beforeEach(() => {
    rmSync(configMod.configsDir(), { recursive: true, force: true });
  });

  it("persists a well-formed payload and echoes the re-read state", () => {
    const body = { extraAllowedTools: ["alpha", "beta"] };
    const { state, res } = mockRes();
    putSettingsHandler({ body } as Request, res);
    assert.equal(state.status, 200);
    assert.deepEqual(state.body, { settings: body, mcp: { servers: [] }, csp: {}, macosReminders: macosRemindersContext });
    assert.deepEqual(configMod.loadSettings(), body);
  });

  it("rejects invalid shape with 400", () => {
    const { state, res } = mockRes();
    putSettingsHandler({ body: { extraAllowedTools: "not-an-array" } } as Request, res);
    assert.equal(state.status, 400);
    const body = state.body as { error: string };
    assert.match(body.error, /Invalid/);
  });

  it("rejects null body with 400", () => {
    const { state, res } = mockRes();
    putSettingsHandler({ body: null } as Request, res);
    assert.equal(state.status, 400);
  });

  it("rejects arrays containing non-strings", () => {
    const { state, res } = mockRes();
    putSettingsHandler({ body: { extraAllowedTools: ["ok", 42] } } as Request, res);
    assert.equal(state.status, 400);
  });

  it("overwrites a prior save", () => {
    configMod.saveSettings({ extraAllowedTools: ["old"] });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { extraAllowedTools: ["new"] } } as Request, res);
    assert.equal(state.status, 200);
    assert.deepEqual(configMod.loadSettings().extraAllowedTools, ["new"]);
  });

  // Patch-merge regression coverage. Each tab in the Settings UI
  // owns a subset of `AppSettings` and PUTs only its own fields.
  // Without merge support, a Tools-only save would wipe the Map
  // tab's googleMapsApiKey (and vice versa). Codex review on PR
  // #1241 surfaced this; these tests pin the contract.

  it("preserves googleMapsApiKey when a tools-only patch is sent", () => {
    configMod.saveSettings({ extraAllowedTools: ["before"], googleMapsApiKey: "AIza-keep-me" });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { extraAllowedTools: ["after"] } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.deepEqual(persisted.extraAllowedTools, ["after"]);
    assert.equal(persisted.googleMapsApiKey, "AIza-keep-me");
  });

  it("preserves extraAllowedTools when a map-only patch is sent", () => {
    configMod.saveSettings({ extraAllowedTools: ["mcp__example"], googleMapsApiKey: "AIza-old" });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { googleMapsApiKey: "AIza-new" } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.deepEqual(persisted.extraAllowedTools, ["mcp__example"]);
    assert.equal(persisted.googleMapsApiKey, "AIza-new");
  });

  it("clears googleMapsApiKey when an explicit empty string is sent (boundary)", () => {
    configMod.saveSettings({ extraAllowedTools: ["mcp__keep"], googleMapsApiKey: "AIza-doomed" });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { googleMapsApiKey: "" } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.deepEqual(persisted.extraAllowedTools, ["mcp__keep"]);
    assert.equal(persisted.googleMapsApiKey, "");
  });

  it("rejects non-string googleMapsApiKey with 400", () => {
    const { state, res } = mockRes();
    putSettingsHandler({ body: { googleMapsApiKey: 12345 } } as Request, res);
    assert.equal(state.status, 400);
  });

  it("sets effortLevel from a patch", () => {
    configMod.saveSettings({ extraAllowedTools: ["mcp__keep"] });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { effortLevel: "high" } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.equal(persisted.effortLevel, "high");
    assert.deepEqual(persisted.extraAllowedTools, ["mcp__keep"]);
  });

  it("clears effortLevel when patch sends null", () => {
    configMod.saveSettings({ extraAllowedTools: ["mcp__keep"], effortLevel: "max" });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { effortLevel: null } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.equal(persisted.effortLevel, undefined);
    assert.deepEqual(persisted.extraAllowedTools, ["mcp__keep"]);
  });

  // #2923: the chatModel patch lifecycle mirrors effortLevel's — set,
  // clear via the null sentinel, reject anything outside the alias set.
  it("sets chatModel from a patch", () => {
    configMod.saveSettings({ extraAllowedTools: ["mcp__keep"] });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { chatModel: "sonnet" } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.equal(persisted.chatModel, "sonnet");
    assert.deepEqual(persisted.extraAllowedTools, ["mcp__keep"]);
  });

  it("clears chatModel when patch sends null", () => {
    configMod.saveSettings({ extraAllowedTools: ["mcp__keep"], chatModel: "opus" });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { chatModel: null } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.equal(persisted.chatModel, undefined);
    assert.deepEqual(persisted.extraAllowedTools, ["mcp__keep"]);
  });

  it("rejects pinned model ids with 400", () => {
    const { state, res } = mockRes();
    putSettingsHandler({ body: { chatModel: "claude-opus-4-8" } } as Request, res);
    assert.equal(state.status, 400);
  });

  // The two selects live in one tab but patch independently, so saving one
  // must not disturb the other (the Model tab sends a single-key payload).
  it("leaves effortLevel untouched when only chatModel is patched", () => {
    configMod.saveSettings({ extraAllowedTools: [], effortLevel: "high" });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { chatModel: "haiku" } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.equal(persisted.effortLevel, "high");
    assert.equal(persisted.chatModel, "haiku");
  });

  it("rejects unknown effortLevel values with 400", () => {
    const { state, res } = mockRes();
    putSettingsHandler({ body: { effortLevel: "ultra" } } as Request, res);
    assert.equal(state.status, 400);
  });

  // #1944: the chatIndex patch lifecycle mirrors effortLevel's — set,
  // clear via null, reject garbage. Round-tripping via loadSettings
  // catches the first-round bug where the mode was accepted but
  // silently dropped on write.
  it("sets chatIndex from a patch and roundtrips it", () => {
    configMod.saveSettings({ extraAllowedTools: ["mcp__keep"] });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { chatIndex: "haiku" } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.equal(persisted.chatIndex, "haiku");
    assert.deepEqual(persisted.extraAllowedTools, ["mcp__keep"]);
  });

  it("clears chatIndex when the patch sends null", () => {
    configMod.saveSettings({ extraAllowedTools: ["mcp__keep"], chatIndex: "sonnet" });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { chatIndex: null } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.equal(persisted.chatIndex, undefined);
    assert.deepEqual(persisted.extraAllowedTools, ["mcp__keep"]);
  });

  it("rejects unknown chatIndex values with 400", () => {
    const { state, res } = mockRes();
    putSettingsHandler({ body: { chatIndex: "opus" } } as Request, res);
    assert.equal(state.status, 400);
  });

  it("sets journal from a patch and roundtrips it", () => {
    configMod.saveSettings({ extraAllowedTools: ["mcp__keep"] });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { journal: "sonnet" } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.equal(persisted.journal, "sonnet");
    assert.deepEqual(persisted.extraAllowedTools, ["mcp__keep"]);
  });

  it("clears journal when the patch sends null", () => {
    configMod.saveSettings({ extraAllowedTools: ["mcp__keep"], journal: "haiku" });
    const { state, res } = mockRes();
    putSettingsHandler({ body: { journal: null } } as Request, res);
    assert.equal(state.status, 200);
    const persisted = configMod.loadSettings();
    assert.equal(persisted.journal, undefined);
    assert.deepEqual(persisted.extraAllowedTools, ["mcp__keep"]);
  });

  it("rejects unknown journal values with 400", () => {
    const { state, res } = mockRes();
    putSettingsHandler({ body: { journal: "opus" } } as Request, res);
    assert.equal(state.status, 400);
  });
});

describe("PUT /config (atomic)", () => {
  beforeEach(() => {
    rmSync(configMod.configsDir(), { recursive: true, force: true });
  });

  it("persists settings and mcp together in a single call", () => {
    const body = {
      settings: { extraAllowedTools: ["alpha"] },
      mcp: {
        servers: [
          {
            id: "gh",
            spec: { type: "http", url: "https://example.com", enabled: true },
          },
        ],
      },
    };
    const { state, res } = mockRes();
    putConfigHandler({ body } as Request, res);
    assert.equal(state.status, 200);
    assert.deepEqual((state.body as { settings: { extraAllowedTools: string[] } }).settings.extraAllowedTools, ["alpha"]);
    assert.deepEqual(configMod.loadSettings().extraAllowedTools, ["alpha"]);
  });

  it("rejects when settings shape is invalid", () => {
    const body = {
      settings: { extraAllowedTools: "not-an-array" },
      mcp: { servers: [] },
    };
    const { state, res } = mockRes();
    putConfigHandler({ body } as Request, res);
    assert.equal(state.status, 400);
  });

  it("rejects when mcp shape is invalid", () => {
    const body = {
      settings: { extraAllowedTools: [] },
      mcp: { servers: "nope" },
    };
    const { state, res } = mockRes();
    putConfigHandler({ body } as Request, res);
    assert.equal(state.status, 400);
  });

  it("does not persist settings when mcp payload fails validation", () => {
    configMod.saveSettings({ extraAllowedTools: ["before"] });
    const body = {
      settings: { extraAllowedTools: ["after"] },
      // Missing required fields → fromMcpEntries throws
      mcp: { servers: [{ id: "x", spec: { type: "bogus" } }] },
    };
    const { state, res } = mockRes();
    putConfigHandler({ body } as Request, res);
    assert.equal(state.status, 400);
    // Validation happens before any write — previous state unchanged
    assert.deepEqual(configMod.loadSettings().extraAllowedTools, ["before"]);
  });
});
