import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { isolateHome } from "../helpers/isolatedHome.js";

// The roles route imports workspacePath at module load. Override HOME
// so homedir() → temp root, then dynamic-import the modules.
let tmpRoot: string;
let restoreHome: () => void = () => {};

type RolesRoute = typeof import("../../server/api/routes/roles.js");
type RolesIo = typeof import("../../server/utils/files/roles-io.js");
let rolesRoute: RolesRoute;
let rolesIo: RolesIo;
let rolesDir: string;

before(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "roles-manage-test-"));
  restoreHome = isolateHome(tmpRoot);
  mkdirSync(path.join(tmpRoot, "mulmoclaude"), { recursive: true });
  rolesRoute = await import("../../server/api/routes/roles.js");
  rolesIo = await import("../../server/utils/files/roles-io.js");
  rolesDir = path.join(tmpRoot, "mulmoclaude", "config", "roles");
});

after(() => {
  restoreHome();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function sampleRole(roleId: string) {
  return {
    id: roleId,
    name: `Role ${roleId}`,
    icon: "person",
    prompt: "You are a test role.",
    availablePlugins: ["wiki"],
    queries: [],
  };
}

describe("executeManageRoles — rename (oldRoleId)", () => {
  it("writes the new-id file and removes the old-id file", async () => {
    rolesIo.saveRole("original", sampleRole("original"));
    assert.equal(rolesIo.roleExists("original"), true);

    const result = await rolesRoute.executeManageRoles(
      {
        action: "update",
        role: sampleRole("renamed"),
        oldRoleId: "original",
      },
      "test-session",
    );

    assert.equal(result.success, true, `result: ${JSON.stringify(result)}`);
    assert.equal(rolesIo.roleExists("renamed"), true, "new role file should exist");
    assert.equal(rolesIo.roleExists("original"), false, "old role file should have been deleted");
  });

  it("rejects a rename into a built-in id", async () => {
    rolesIo.saveRole("tmp", sampleRole("tmp"));
    const result = await rolesRoute.executeManageRoles(
      {
        action: "update",
        role: sampleRole("general"), // "general" is a built-in id
        oldRoleId: "tmp",
      },
      "test-session",
    );
    assert.equal(result.success, false);
    assert.match(String(result.error), /reserved/i);
    // Clean up
    rolesIo.deleteRole("tmp");
    // Ensure we didn't accidentally create the built-in id file
    const generalPath = path.join(rolesDir, "general.json");
    assert.equal(existsSync(generalPath), false);
  });

  it("rejects a rename into an id already in use", async () => {
    rolesIo.saveRole("alpha", sampleRole("alpha"));
    rolesIo.saveRole("beta", sampleRole("beta"));
    const result = await rolesRoute.executeManageRoles(
      {
        action: "update",
        role: sampleRole("beta"),
        oldRoleId: "alpha",
      },
      "test-session",
    );
    assert.equal(result.success, false);
    assert.match(String(result.error), /already exists/i);
    assert.equal(rolesIo.roleExists("alpha"), true, "'alpha' should still exist");
    assert.equal(rolesIo.roleExists("beta"), true, "'beta' should still exist");
    rolesIo.deleteRole("alpha");
    rolesIo.deleteRole("beta");
  });

  it("removes a built-in-id override file when renaming away from it", async () => {
    // A file at config/roles/general.json is a user override of the
    // built-in "general" role. Renaming it to a non-builtin id must
    // remove the override file — otherwise it would continue to shadow
    // the built-in and couldn't be deleted through the manage API.
    rolesIo.saveRole("general", sampleRole("general"));
    assert.equal(rolesIo.roleExists("general"), true);

    const result = await rolesRoute.executeManageRoles(
      {
        action: "update",
        role: sampleRole("general_custom"),
        oldRoleId: "general",
      },
      "test-session",
    );

    assert.equal(result.success, true, `result: ${JSON.stringify(result)}`);
    assert.equal(rolesIo.roleExists("general_custom"), true, "new role file should exist");
    assert.equal(rolesIo.roleExists("general"), false, "built-in override file should have been deleted");
    rolesIo.deleteRole("general_custom");
  });

  it("ignores oldRoleId on a create payload (never runs rename cleanup)", async () => {
    // Defensive: a malformed create payload that includes oldRoleId
    // must not trigger the rename-delete path. Rename detection is
    // gated on action === "update".
    rolesIo.saveRole("victim", sampleRole("victim"));
    const result = await rolesRoute.executeManageRoles(
      {
        action: "create",
        role: sampleRole("fresh"),
        oldRoleId: "victim",
      },
      "test-session",
    );
    assert.equal(result.success, true, `result: ${JSON.stringify(result)}`);
    assert.equal(rolesIo.roleExists("fresh"), true, "'fresh' should have been created");
    assert.equal(rolesIo.roleExists("victim"), true, "'victim' must not be deleted by a create payload");
    rolesIo.deleteRole("fresh");
    rolesIo.deleteRole("victim");
  });

  it("rejects a create whose id collides with an existing custom role", async () => {
    // Defensive: a direct-API or stale-client `create` must not
    // silently overwrite an existing custom role. The client-side
    // validator catches this for the UI path, but the server is the
    // last line of defence.
    rolesIo.saveRole("target", { ...sampleRole("target"), name: "Original" });
    const result = await rolesRoute.executeManageRoles(
      {
        action: "create",
        role: { ...sampleRole("target"), name: "Overwriter" },
      },
      "test-session",
    );
    assert.equal(result.success, false);
    assert.match(String(result.error), /already exists/i);
    // Original content must be intact
    const onDisk = JSON.parse(readFileSync(path.join(rolesDir, "target.json"), "utf-8")) as { name: string };
    assert.equal(onDisk.name, "Original", "existing role must not be overwritten");
    rolesIo.deleteRole("target");
  });

  it("plain update (no oldRoleId) still works and does not delete anything", async () => {
    rolesIo.saveRole("plain", sampleRole("plain"));
    const result = await rolesRoute.executeManageRoles(
      {
        action: "update",
        role: { ...sampleRole("plain"), name: "Renamed Display" },
      },
      "test-session",
    );
    assert.equal(result.success, true);
    assert.equal(rolesIo.roleExists("plain"), true);
    rolesIo.deleteRole("plain");
  });
});
