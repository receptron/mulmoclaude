// Regression tests for the asset-route anchor on
// `/api/plugins/runtime/:pkg/:version/{*splat}` (#1043 C-2).
//
// The route is bearer-auth-exempt so the browser can dynamic-import
// plugin assets, which means it has to defend against percent-
// encoded `../` arriving in `pkg` / `version`. The current model is
// registry-membership: only (pkg, version) pairs that are present in
// the in-process runtime registry resolve to a real path, and those
// pairs are written by trusted code (preset list / workspace ledger).
// Anything else is a 404.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import runtimePluginRouter, { pluginAssetScope } from "../../../server/api/routes/runtime-plugin.ts";
import { scopeRealpath } from "@mulmoclaude/core/files";
import { workspacePath } from "../../../server/workspace/workspace.ts";
import { registerRuntimePlugins, _resetRuntimeRegistryForTest } from "../../../server/plugins/runtime-registry.ts";
import type { RuntimePlugin } from "../../../server/plugins/runtime-loader.ts";

let fixtureDir: string;
let outsideDir: string;

beforeEach(() => {
  _resetRuntimeRegistryForTest();
  fixtureDir = mkdtempSync(path.join(tmpdir(), "mulmo-asset-anchor-fixture-"));
  // A directory the test plants OUTSIDE the registry's known roots.
  // The route must never serve from here regardless of URL shape.
  outsideDir = mkdtempSync(path.join(tmpdir(), "mulmo-asset-anchor-outside-"));
  writeFileSync(path.join(outsideDir, "secret.txt"), "should-not-leak");
  mkdirSync(path.join(fixtureDir, "dist"), { recursive: true });
  writeFileSync(path.join(fixtureDir, "dist", "ok.js"), "// ok");
});

afterEach(() => {
  _resetRuntimeRegistryForTest();
  try {
    rmSync(fixtureDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  try {
    rmSync(outsideDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

const fakePlugin = (name: string, version: string, cachePath: string): RuntimePlugin => ({
  name,
  version,
  cachePath,
  definition: {
    type: "function",
    name: `tool_${name}`,
    description: "fixture",
    parameters: { type: "object", properties: {}, required: [] },
  },
  execute: null,
  oauthCallbackAlias: null,
});

// The realpath assets of (pkg, version) are served from, or null.
const resolvePluginRoot = async (pkg: string, version: string): Promise<string | null> => {
  const scope = await pluginAssetScope(pkg, version);
  return scope === null ? null : scopeRealpath(scope);
};

describe("pluginAssetScope — registry membership", async () => {
  it("returns the cachePath realpath for a registered (pkg, version)", async () => {
    registerRuntimePlugins(new Set(), [fakePlugin("@fixture/anchor", "1.0.0", fixtureDir)]);
    const result = await resolvePluginRoot("@fixture/anchor", "1.0.0");
    assert.ok(result, "expected a realpath for a registered plugin");
    // realpath may resolve OS-level symlinks (e.g. macOS /var → /private/var),
    // so just assert the returned path ends in the fixture's basename.
    assert.match(result ?? "", new RegExp(`${path.basename(fixtureDir)}$`));
  });

  it("returns null when the (pkg, version) pair is not registered", async () => {
    registerRuntimePlugins(new Set(), [fakePlugin("@fixture/anchor", "1.0.0", fixtureDir)]);
    assert.equal(await resolvePluginRoot("@fixture/anchor", "9.9.9"), null, "wrong version → 404");
    assert.equal(await resolvePluginRoot("@other/never-installed", "1.0.0"), null, "unknown package → 404");
  });

  it("returns null when registered cachePath does not exist on disk", async () => {
    const ghost = path.join(fixtureDir, "vanished");
    registerRuntimePlugins(new Set(), [fakePlugin("@fixture/ghost", "1.0.0", ghost)]);
    assert.equal(await resolvePluginRoot("@fixture/ghost", "1.0.0"), null);
  });

  it("encoded `../` in pkg cannot match a registered name", async () => {
    // Even with a directory traversal that points at `outsideDir` on
    // disk, the registry lookup uses the literal name string. The
    // pkg `..` is not a registered name, so 404.
    registerRuntimePlugins(new Set(), [fakePlugin("@fixture/anchor", "1.0.0", fixtureDir)]);
    assert.equal(await resolvePluginRoot("../../../../etc", "passwd"), null);
    assert.equal(await resolvePluginRoot("..", "1.0.0"), null);
    assert.equal(await resolvePluginRoot("", "1.0.0"), null);
  });

  it("encoded `../` in version cannot match a registered version", async () => {
    registerRuntimePlugins(new Set(), [fakePlugin("@fixture/anchor", "1.0.0", fixtureDir)]);
    assert.equal(await resolvePluginRoot("@fixture/anchor", "../../tmp"), null);
    assert.equal(await resolvePluginRoot("@fixture/anchor", ""), null);
  });

  it("an attacker registering a cachePath outside the workspace can only serve from THAT path", async () => {
    // The trust model: registry membership is the boundary. If a
    // server-side caller (preset list, ledger) registers a cachePath
    // pointing outside the workspace, that's by design (presets live
    // in node_modules). The route's job is to ensure NO OTHER path
    // is reachable — verified by the negative cases above.
    registerRuntimePlugins(new Set(), [fakePlugin("@fixture/outside", "1.0.0", outsideDir)]);
    const result = await resolvePluginRoot("@fixture/outside", "1.0.0");
    assert.ok(result, "registered cachePath resolves regardless of where on disk it points");
    // But a different (pkg, version) still doesn't reach it.
    assert.equal(await resolvePluginRoot(`../${path.basename(outsideDir)}`, "1.0.0"), null);
  });
});

// A plugin installed into the workspace's cache is served only while its folder sits inside the workspace (#3573).
describe("GET /api/plugins/runtime/:pkg/:version/* — a workspace-installed plugin", () => {
  const name = "@fixture/installed";
  let cache = "";

  const serve = async (relPath: string): Promise<{ status: number; type: string | null; body: string }> => {
    const app = express();
    app.use(runtimePluginRouter);
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/plugins/runtime/${encodeURIComponent(name)}/1.0.0/${relPath}`);
      return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  beforeEach(() => {
    cache = path.join(workspacePath, "plugins", ".cache", "@fixture", `installed-${randomBytes(4).toString("hex")}`, "1.0.0");
    mkdirSync(path.join(cache, "dist"), { recursive: true });
    writeFileSync(path.join(cache, "dist", "index.js"), "// installed");
    writeFileSync(path.join(outsideDir, "dist.js"), "should-not-leak");
    registerRuntimePlugins(new Set(), [fakePlugin(name, "1.0.0", cache)]);
  });

  afterEach(() => rmSync(path.dirname(cache), { recursive: true, force: true }));

  it("serves an asset with its content type", async () => {
    assert.deepEqual(await serve("dist/index.js"), { status: 200, type: "application/javascript; charset=utf-8", body: "// installed" });
  });

  it("answers 404 for a folder, a missing file and an escaping path", async () => {
    assert.equal((await serve("dist")).status, 404);
    assert.equal((await serve("dist/missing.js")).status, 404);
    assert.equal((await serve("..%2F..%2Fsecret.txt")).status, 404);
  });

  const posixOnly = { skip: process.platform === "win32" ? "symlinks need POSIX" : false };

  it("does not serve from a cache folder replaced by a link out of the workspace", posixOnly, async () => {
    renameSync(cache, `${cache}.parked`);
    symlinkSync(outsideDir, cache);
    const reply = await serve("secret.txt");
    assert.equal(reply.status, 404);
    assert.ok(!reply.body.includes("should-not-leak"), reply.body);
  });

  it("does not serve a link inside the tree that points out of it", posixOnly, async () => {
    symlinkSync(path.join(outsideDir, "secret.txt"), path.join(cache, "dist", "leak.js"));
    assert.equal((await serve("dist/leak.js")).status, 404);
  });
});

// gui-chat-protocol's `ToolPluginCore.execute` signature is
// `(context: ToolContext, args) => Promise<ToolResult>`. The dispatch
// route MUST call it with both args in that order — when callers
// passed only the args object, plugins like @gui-chat-plugin/weather
// crashed inside their handler with "Cannot destructure property
// 'areaCode' of '<arg>' as it is undefined" because the destructured
// arg landed in the unused first slot and the real args slot was
// undefined.
describe("POST /api/plugins/runtime/:pkg/dispatch — call signature", () => {
  it("invokes plugin.execute with (context, args) in order", async () => {
    const calls: { context: unknown; args: unknown }[] = [];
    const spyPlugin: RuntimePlugin = {
      name: "@fixture/spy",
      version: "1.0.0",
      cachePath: fixtureDir,
      definition: {
        type: "function",
        name: "tool_spy",
        description: "fixture",
        parameters: { type: "object", properties: {}, required: [] },
      },
      execute: async (context: unknown, args: unknown) => {
        calls.push({ context, args });
        return { ok: true };
      },
      oauthCallbackAlias: null,
    };
    registerRuntimePlugins(new Set(), [spyPlugin]);

    const app = express();
    app.disable("x-powered-by");
    app.use(express.json());
    app.use(runtimePluginRouter);
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/plugins/runtime/${encodeURIComponent("@fixture/spy")}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ areaCode: "130000" }),
      });
      assert.equal(res.status, 200, await res.text());
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.ok(call);
      assert.deepEqual(call.args, { areaCode: "130000" }, "args must arrive as the SECOND parameter");
      assert.ok(call.context !== undefined, "context must be a defined value (empty object is fine), not omitted");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Generic OAuth callback endpoint (#1162). Hosts the redirect URI
// registered with any OAuth provider; routes by `:alias` (plugin-
// declared via `OAUTH_CALLBACK_ALIAS`) to the matching runtime
// plugin's `kind: "oauthCallback"` dispatch. The alias indirection
// exists because Spotify's Dashboard rejects redirect URIs containing
// percent-encoded `@` / `/` characters from the npm scoped name.
describe("GET /api/plugins/runtime/oauth-callback/:alias", () => {
  it("forwards code/state/error to the plugin registered under the alias and renders the plugin's HTML", async () => {
    const calls: { args: unknown }[] = [];
    const oauthPlugin: RuntimePlugin = {
      name: "@fixture/oauth-plugin",
      version: "1.0.0",
      cachePath: fixtureDir,
      definition: {
        type: "function",
        name: "tool_oauth",
        description: "fixture",
        parameters: { type: "object", properties: {}, required: [] },
      },
      execute: async (_context: unknown, args: unknown) => {
        calls.push({ args });
        return { ok: true, message: "Connected.", html: "<h1>Connected!</h1>" };
      },
      oauthCallbackAlias: "fixture-alias",
    };
    registerRuntimePlugins(new Set(), [oauthPlugin]);

    const app = express();
    app.disable("x-powered-by");
    app.use(runtimePluginRouter);
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/api/plugins/runtime/oauth-callback/fixture-alias?code=auth-code-123&state=state-xyz`;
      const res = await fetch(url);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await res.text(), /Connected!/);
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.ok(call);
      assert.deepEqual(call.args, {
        kind: "oauthCallback",
        code: "auth-code-123",
        state: "state-xyz",
        error: undefined,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns 404 when no plugin claims the alias (other plugins can't impersonate)", async () => {
    registerRuntimePlugins(new Set(), [
      {
        name: "@fixture/registered",
        version: "1.0.0",
        cachePath: fixtureDir,
        definition: { type: "function", name: "tool", description: "x", parameters: { type: "object", properties: {}, required: [] } },
        execute: async () => ({ ok: true }),
        oauthCallbackAlias: "registered-alias",
      },
    ]);
    const app = express();
    app.disable("x-powered-by");
    app.use(runtimePluginRouter);
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/plugins/runtime/oauth-callback/never-claimed?code=x&state=y`);
      assert.equal(res.status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("forwards `error` query (user-denied path) without crashing", async () => {
    const calls: { args: unknown }[] = [];
    registerRuntimePlugins(new Set(), [
      {
        name: "@fixture/oauth-plugin",
        version: "1.0.0",
        cachePath: fixtureDir,
        definition: { type: "function", name: "tool", description: "x", parameters: { type: "object", properties: {}, required: [] } },
        execute: async (_context: unknown, args: unknown) => {
          calls.push({ args });
          return { ok: false, message: "User denied." };
        },
        oauthCallbackAlias: "fixture-alias",
      },
    ]);
    const app = express();
    app.disable("x-powered-by");
    app.use(runtimePluginRouter);
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/plugins/runtime/oauth-callback/fixture-alias?error=access_denied`);
      assert.equal(res.status, 400);
      const [call] = calls;
      assert.ok(call);
      assert.deepEqual(call.args, { kind: "oauthCallback", code: undefined, state: undefined, error: "access_denied" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("falls back to a default HTML page when the plugin returns no `html` field", async () => {
    registerRuntimePlugins(new Set(), [
      {
        name: "@fixture/no-html",
        version: "1.0.0",
        cachePath: fixtureDir,
        definition: { type: "function", name: "tool", description: "x", parameters: { type: "object", properties: {}, required: [] } },
        execute: async () => ({ ok: true, message: "Connected without custom HTML." }),
        oauthCallbackAlias: "no-html-alias",
      },
    ]);
    const app = express();
    app.disable("x-powered-by");
    app.use(runtimePluginRouter);
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/plugins/runtime/oauth-callback/no-html-alias?code=c&state=s`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /OAuth complete/);
      assert.match(body, /Connected without custom HTML\./);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("first-registered plugin keeps an OAuth alias on collision; second is reported in oauthAliasCollisions", () => {
    const result = registerRuntimePlugins(new Set(), [
      {
        name: "@fixture/first",
        version: "1.0.0",
        cachePath: fixtureDir,
        definition: { type: "function", name: "tool_first", description: "x", parameters: { type: "object", properties: {}, required: [] } },
        execute: async () => ({ ok: true }),
        oauthCallbackAlias: "shared",
      },
      {
        name: "@fixture/second",
        version: "1.0.0",
        cachePath: fixtureDir,
        definition: { type: "function", name: "tool_second", description: "x", parameters: { type: "object", properties: {}, required: [] } },
        execute: async () => ({ ok: true }),
        oauthCallbackAlias: "shared",
      },
    ]);
    // Both plugins still register (tool names differ); only the
    // second's alias is dropped.
    assert.equal(result.registered.length, 2);
    assert.equal(result.oauthAliasCollisions.length, 1);
    const [collision] = result.oauthAliasCollisions;
    assert.ok(collision);
    assert.equal(collision.plugin.name, "@fixture/second");
    assert.equal(collision.alias, "shared");
    assert.equal(collision.existingPlugin, "@fixture/first");
  });
});
