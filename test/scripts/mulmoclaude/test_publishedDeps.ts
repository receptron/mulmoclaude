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
  async ({ name }: { name: string }) => {
    const versions = table[name] ?? [];
    return { versions, latest: versions.at(-1) ?? null, reason: null };
  };

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

  it("BLOCKS a declared dep with no workspace twin — it went unverified", async () => {
    // Returning early on a missing twin skipped the registry entirely, so a declared
    // internal dep passed the gate without being checked at all. Every internal scope here
    // is published from this repo, so no twin means the manifest moved or the walk missed
    // it — and in both cases the range is unverified (#3105 round 1, Codex).
    const root = await workspace({ "@mulmoclaude/external": "^2.0.0" }, []);
    const results = await published.checkPublishedDeps({ root, fetchPublishedVersions: registryWith({ "@mulmoclaude/external": ["2.0.0"] }) });
    assert.equal(byName(results, "@mulmoclaude/external")?.status, "not-a-workspace");
    assert.ok(published.BLOCKING.includes("not-a-workspace"), "and that verdict stops a publish");
  });

  it("names the MORE specific reason when a twin-less dep is also not on npm", async () => {
    // Both verdicts block, so the exit code cannot tell them apart — what differs is what
    // the operator is told. Asking the registry before checking for a twin is what lets the
    // report say "never published" instead of the vaguer "no workspace manifest".
    const root = await workspace({ "@mulmoclaude/ghost": "^1.0.0" }, []);
    const results = await published.checkPublishedDeps({ root, fetchPublishedVersions: registryWith({}) });
    assert.equal(byName(results, "@mulmoclaude/ghost")?.status, "not-on-npm");
  });

  it("reports a workspace that is BEHIND npm — the signal the shell loop surfaced", async () => {
    // `local != npm` in the replaced loop covered this too. It cannot cause ETARGET, so it
    // does not block, but losing it in a replacement would be a regression.
    const root = await workspace({ "@mulmobridge/client": "^1.0.2" }, [{ dir: "client", name: "@mulmobridge/client", version: "1.0.2" }]);
    const results = await published.checkPublishedDeps({ root, fetchPublishedVersions: registryWith({ "@mulmobridge/client": ["1.0.2", "1.1.0"] }) });
    const verdict = byName(results, "@mulmobridge/client");
    assert.equal(verdict?.status, "behind");
    assert.equal(verdict?.newestPublished, "1.1.0");
    assert.equal(published.BLOCKING.includes("behind"), false, "being behind cannot cause ETARGET");
  });

  it("finds a manifest nested deeper than any layout here today", async () => {
    // A fixed-depth walk reports a deeper package as "not a workspace package", which is now
    // BLOCKING — so the walk has to be recursive or the gate fails on a legal layout.
    const root = await workspace({ "@mulmoclaude/deep": "^1.0.0" }, [
      { dir: path.join("services", "group", "deep"), name: "@mulmoclaude/deep", version: "1.0.0" },
    ]);
    const results = await published.checkPublishedDeps({ root, fetchPublishedVersions: registryWith({ "@mulmoclaude/deep": ["1.0.0"] }) });
    assert.equal(byName(results, "@mulmoclaude/deep")?.status, "published");
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

describe("isBlocking", () => {
  const verdict = (status: published.PublishedDepResult["status"], field: published.DeclaredDep["field"]): published.PublishedDepResult => ({
    name: "@mulmoclaude/x",
    range: "^1.0.0",
    field,
    workspaceVersion: "1.0.0",
    status,
  });
  const fields: published.DeclaredDep["field"][] = ["dependencies", "optionalDependencies", "peerDependencies"];

  it("stops a publish for a required dep that does not resolve", () => {
    fields
      .filter((field) => field !== "optionalDependencies")
      .forEach((field) => {
        published.BLOCKING.forEach((status) => assert.equal(published.isBlocking(verdict(status, field)), true, `${status} in ${field}`));
      });
  });

  it("does NOT stop a publish for an optional one — npm skips what it cannot resolve", () => {
    // An unresolved optional dependency is not an install failure, so blocking on it would
    // stop a safe release (#3105 round 2, Codex). Still printed, just not fatal.
    published.BLOCKING.forEach((status) => assert.equal(published.isBlocking(verdict(status, "optionalDependencies")), false, status));
  });

  it("never blocks on a verdict that is not in BLOCKING, whatever the field", () => {
    const passing: published.PublishedDepResult["status"][] = ["published", "behind", "unknown"];
    passing.forEach((status) => {
      fields.forEach((field) => assert.equal(published.isBlocking(verdict(status, field)), false, `${status} in ${field}`));
    });
  });
});

/**
 * The real registry reader.
 *
 * Every other test injects a stub, which left the URL this builds and the statuses it maps
 * as the only unverified part of the check — a broken default would have passed the whole
 * suite (#3105 round 2, Codex).
 */
describe("defaultFetchPublishedVersions", () => {
  const respond = (init: { status: number; body?: unknown }) => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return {
        status: init.status,
        ok: init.status >= 200 && init.status < 300,
        json: async () => init.body,
      } as unknown as Response;
    };
    return { calls, fetchImpl };
  };

  it("asks registry.npmjs.org for the encoded package name", async () => {
    const { calls, fetchImpl } = respond({ status: 200, body: { versions: { "1.0.0": {} }, "dist-tags": { latest: "1.0.0" } } });
    await published.defaultFetchPublishedVersions({ name: "@mulmoclaude/core", fetchImpl });
    assert.deepEqual(calls, ["https://registry.npmjs.org/%40mulmoclaude%2Fcore"], "the scope's / must not split the path");
  });

  it("reads the versions and the latest dist-tag", async () => {
    const { fetchImpl } = respond({ status: 200, body: { versions: { "1.0.0": {}, "1.1.0": {} }, "dist-tags": { latest: "1.1.0" } } });
    const result = await published.defaultFetchPublishedVersions({ name: "@mulmoclaude/core", fetchImpl });
    assert.deepEqual(result.versions, ["1.0.0", "1.1.0"]);
    assert.equal(result.latest, "1.1.0");
  });

  it("reads a 404 as 'never published', not as an error", async () => {
    const { fetchImpl } = respond({ status: 404 });
    const result = await published.defaultFetchPublishedVersions({ name: "@mulmoclaude/ghost", fetchImpl });
    assert.deepEqual(result.versions, [], "empty, which classifies as not-on-npm");
    assert.equal(result.reason, null);
  });

  it("reads a 5xx as unknown rather than as an empty package", async () => {
    // The difference matters: empty means "never published" and BLOCKS; null means "could
    // not ask" and does not.
    const { fetchImpl } = respond({ status: 503 });
    const result = await published.defaultFetchPublishedVersions({ name: "@mulmoclaude/core", fetchImpl });
    assert.equal(result.versions, null);
    assert.match(result.reason ?? "", /503/);
  });

  it("reads a thrown request as unknown", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const result = await published.defaultFetchPublishedVersions({ name: "@mulmoclaude/core", fetchImpl });
    assert.equal(result.versions, null);
    assert.match(result.reason ?? "", /ENOTFOUND/);
  });

  it("treats a body with no versions as an empty package, not a crash", async () => {
    const { fetchImpl } = respond({ status: 200, body: {} });
    const result = await published.defaultFetchPublishedVersions({ name: "@mulmoclaude/core", fetchImpl });
    assert.deepEqual(result.versions, []);
    assert.equal(result.latest, null);
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
