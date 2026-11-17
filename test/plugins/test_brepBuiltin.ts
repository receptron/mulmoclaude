// MulmoClaude's wiring of `@gui-chat-plugin/brep` (presentBrep). The package's
// own behaviour (the build, its checks, the path rules) is tested in its repo;
// what the host owes it is tested here:
//
// - the tool is the package's, under the name the META routes;
// - the browser adapter takes nothing from the package's core entry, which
//   reaches the OpenCascade kernel and `node:vm`;
// - its route is the owner's: it runs a script as code in this process;
// - an agent inside the Docker sandbox is not offered it, because through it
//   the agent would run code on the host, outside the sandbox;
// - the MCP broker bundle, which inlines its dependencies, would leave the
//   kernel out if the build were ever kept in it: the broker only lists the tool.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TOOL_DEFINITION } from "@gui-chat-plugin/brep";
import { META } from "../../src/plugins/presentBrep/meta.js";
import definition from "../../src/plugins/presentBrep/definition.js";
import { isOwnerOnlyApiPath } from "../../server/api/auth/clientTokenAccess.js";
import { isStaticPluginEnabled } from "../../server/agent/activeTools.js";
import { runsOnHost } from "../../server/system/docker.js";
import { API_ROUTES } from "../../src/config/apiRoutes.js";

// Read, not imported: the script builds the broker when it is loaded, and has
// no type declarations for the test project to check against.
const BROKER_BUILD = path.join(import.meta.dirname, "..", "..", "scripts", "build-mcp-broker.mjs");
const ADAPTER = path.join(import.meta.dirname, "..", "..", "src", "plugins", "presentBrep", "index.ts");

describe("presentBrep's host adapter", () => {
  it("offers the package's tool under the name the META routes", () => {
    assert.equal(definition, TOOL_DEFINITION);
    assert.equal(definition.name, META.toolName);
    assert.equal(META.mcpDispatch, "create");
  });

  it("keeps the package's core entry out of the browser", () => {
    const source = readFileSync(ADAPTER, "utf8");
    const imports = [...source.matchAll(/^import (type )?[^;]*? from "([^"]+)";/gm)].map((match) => ({ typeOnly: Boolean(match[1]), from: match[2] }));
    assert.ok(imports.some(({ from }) => from === "@gui-chat-plugin/brep/vue"));
    // The core entry itself, and ./definition (which imports it), only as types.
    for (const { typeOnly, from } of imports) {
      if (from === "@gui-chat-plugin/brep" || from === "./definition") assert.ok(typeOnly, `${from} is imported as a value in the browser adapter`);
    }
  });

  // The route runs the script it is sent as code in the server's process.
  // A client token (issued to an outside service, #3618) must not reach it.
  it("refuses a client token on its route", () => {
    const route = API_ROUTES.brep.create.url;
    assert.equal(route, "/api/brep");
    assert.equal(isOwnerOnlyApiPath(route.slice("/api".length)), true);
    assert.equal(isOwnerOnlyApiPath("/BREP/"), true);
  });

  it("keeps the kernel external to the MCP broker bundle", () => {
    const source = readFileSync(BROKER_BUILD, "utf8");
    assert.match(source, /const KERNEL_EXTERNALS = \["replicad", "replicad-opencascadejs"\];/);
    assert.match(source, /external: \[[^\]]*\.\.\.KERNEL_EXTERNALS[^\]]*\]/);
  });

  // Sourcery and CodeRabbit on #3665: the agent's own calls carry the owner's
  // token, so the owner-only route does not keep a sandboxed agent's script
  // off the host. The tool is for an agent that already runs here unsandboxed.
  describe("with the Docker sandbox", () => {
    it("counts the agent as on the host only when that is known", () => {
      // --disable-sandbox, whatever Docker says.
      assert.equal(runsOnHost(true, true), true);
      assert.equal(runsOnHost(true, null), true);
      // No Docker to sandbox with: the agent runs natively.
      assert.equal(runsOnHost(false, false), true);
      // Sandboxed, or not probed yet: not on the host.
      assert.equal(runsOnHost(false, true), false);
      assert.equal(runsOnHost(false, null), false);
    });

    it("is offered to an agent on the host, and not to a sandboxed one", () => {
      assert.equal(isStaticPluginEnabled("presentBrep", true), true);
      assert.equal(isStaticPluginEnabled("presentBrep", false), false);
    });

    it("leaves the other static plugins as they were, sandboxed or not", () => {
      for (const onHost of [true, false]) assert.equal(isStaticPluginEnabled("presentShapeScript", onHost), true);
    });
  });
});
