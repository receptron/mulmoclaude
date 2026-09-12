import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as published from "../../../scripts/mulmoclaude/publishedDeps.mjs";

/**
 * "Is the version the launcher depends on actually on npm?"
 *
 * Three checks look at the launcher's internal deps and each asks a different question —
 * `drift.mjs` about missing exports, `launcherSync.mjs` about the range against the
 * workspace, this one about the registry. Only the third catches an unpublished bump, and
 * nothing asked it until `mulmoclaude@1.16.0`, where `@mulmobridge/client` was 1.1.0
 * locally with 1.0.2 on npm and the launcher declared `^1.1.0` (#3099).
 *
 * The registry reader is injected, so these run offline and pin the classification rather
 * than the network.
 */

/** A throwaway workspace: a launcher manifest plus the package manifests it names. */
async function workspace(launcherDeps: Record<string, string>, packages: { dir: string; name: string; version: string }[]) {
  const root = await mkdtemp(path.join(tmpdir(), "mc-published-"));
  await mkdir(path.join(root, "packages", "mulmoclaude"), { recursive: true });
  await writeFile(
    path.join(root, "packages", "mulmoclaude", "package.json"),
    JSON.stringify({ name: "mulmoclaude", version: "1.16.0", dependencies: launcherDeps }),
  );
  for (const pkg of packages) {
    await mkdir(path.join(root, "packages", pkg.dir), { recursive: true });
    await writeFile(path.join(root, "packages", pkg.dir, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version }));
  }
  return root;
}

const registryWith =
  (table: Record<string, string[]>) =>
  async ({ name }: { name: string }) => ({ versions: table[name] ?? [], reason: null });

const byName = (results: published.PublishedDepResult[], name: string) => results.find((result) => result.name === name);

describe("checkPublishedDeps", () => {
  it("reproduces the 1.16.0 blocker: a workspace bump the registry has never seen", async () => {
    const root = await workspace({ "@mulmobridge/client": "^1.1.0" }, [{ dir: "client", name: "@mulmobridge/client", version: "1.1.0" }]);
    const results = await published.checkPublishedDeps({ root, fetchPublishedVersions: registryWith({ "@mulmobridge/client": ["1.0.0", "1.0.1", "1.0.2"] }) });
    assert.equal(byName(results, "@mulmobridge/client")?.status, "unpublished");
    assert.ok(published.BLOCKING.includes("unpublished"), "and that verdict stops a publish");
  });

  it("passes the same shape once the version is on npm", async () => {
    const root = await workspace({ "@mulmobridge/client": "^1.1.0" }, [{ dir: "client", name: "@mulmobridge/client", version: "1.1.0" }]);
    const results = await published.checkPublishedDeps({ root, fetchPublishedVersions: registryWith({ "@mulmobridge/client": ["1.0.2", "1.1.0"] }) });
    assert.equal(byName(results, "@mulmobridge/client")?.status, "published");
  });

  it("finds packages wherever they live — the workspace is not flat", async () => {
    // `@mulmoclaude/core` is `packages/core` while the plugins are under `packages/plugins/`.
    // Deriving a path from the package NAME reports the nested ones as missing.
    const root = await workspace({ "@mulmoclaude/core": "^4.8.0", "@mulmoclaude/x-plugin": "^1.0.3" }, [
      { dir: "core", name: "@mulmoclaude/core", version: "4.8.0" },
      { dir: path.join("plugins", "x-plugin"), name: "@mulmoclaude/x-plugin", version: "1.0.3" },
    ]);
    const results = await published.checkPublishedDeps({
      root,
      fetchPublishedVersions: registryWith({ "@mulmoclaude/core": ["4.8.0"], "@mulmoclaude/x-plugin": ["1.0.3"] }),
    });
    assert.deepEqual(
      results.map((result) => result.status),
      ["published", "published"],
    );
  });

  it("reports a package that was never published at all", async () => {
    const root = await workspace({ "@mulmoclaude/new-plugin": "^0.1.0" }, [{ dir: "new-plugin", name: "@mulmoclaude/new-plugin", version: "0.1.0" }]);
    const results = await published.checkPublishedDeps({ root, fetchPublishedVersions: registryWith({}) });
    assert.equal(byName(results, "@mulmoclaude/new-plugin")?.status, "not-on-npm");
  });

  it("does not block on an unreachable registry — that is not evidence of anything", async () => {
    const root = await workspace({ "@mulmobridge/client": "^1.1.0" }, [{ dir: "client", name: "@mulmobridge/client", version: "1.1.0" }]);
    const offline = async () => ({ versions: null, reason: "network: getaddrinfo ENOTFOUND" });
    const results = await published.checkPublishedDeps({ root, fetchPublishedVersions: offline });
    const verdict = byName(results, "@mulmobridge/client");
    assert.equal(verdict?.status, "unknown");
    assert.equal(published.BLOCKING.includes("unknown"), false, "a flaky network must not stop a release");
  });

  it("says so when a declared dep has no workspace twin, instead of guessing", async () => {
    const root = await workspace({ "@mulmoclaude/external": "^2.0.0" }, []);
    const results = await published.checkPublishedDeps({ root, fetchPublishedVersions: registryWith({}) });
    assert.equal(byName(results, "@mulmoclaude/external")?.status, "not-a-workspace");
  });

  it("ignores third-party deps — only the scopes this repo publishes", async () => {
    const root = await workspace({ express: "^5.0.0", "@mulmoclaude/core": "^4.8.0" }, [{ dir: "core", name: "@mulmoclaude/core", version: "4.8.0" }]);
    const results = await published.checkPublishedDeps({ root, fetchPublishedVersions: registryWith({ "@mulmoclaude/core": ["4.8.0"] }) });
    assert.deepEqual(
      results.map((result) => result.name),
      ["@mulmoclaude/core"],
    );
  });
});

describe("declaredInternalDeps", () => {
  it("reads peer and optional fields too — a peer range can ETARGET just as well", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mc-published-"));
    await mkdir(path.join(root, "packages", "mulmoclaude"), { recursive: true });
    await writeFile(
      path.join(root, "packages", "mulmoclaude", "package.json"),
      JSON.stringify({
        name: "mulmoclaude",
        dependencies: { "@mulmoclaude/core": "^4.8.0" },
        optionalDependencies: { "@mulmobridge/web-push": "^1.1.0" },
        peerDependencies: { "@mulmobridge/protocol": "^1.0.1" },
      }),
    );
    const deps = await published.declaredInternalDeps({ root });
    assert.deepEqual(
      deps.map((dep) => `${dep.name} (${dep.field})`),
      // Codepoint order: `@mulmobridge` sorts before `@mulmoclaude` ('b' < 'c').
      ["@mulmobridge/protocol (peerDependencies)", "@mulmobridge/web-push (optionalDependencies)", "@mulmoclaude/core (dependencies)"],
    );
  });
});
