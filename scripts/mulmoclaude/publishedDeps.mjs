// "Is the version the launcher depends on actually PUBLISHED?" (§6 of the
// publish-mulmoclaude skill, #3099).
//
// Three checks look at the launcher's internal deps and each asks a
// different question. Only the third one catches an unpublished bump:
//
//   drift.mjs        — are the src exports missing from the published dist?
//   launcherSync.mjs — does the workspace version satisfy the launcher's range?
//   this file        — is that workspace version ON the registry at all?
//
// Nothing checked the third until `mulmoclaude@1.16.0`, where
// `@mulmobridge/client` sat at 1.1.0 locally with 1.0.2 on npm while the
// launcher declared `^1.1.0`. `npx mulmoclaude@1.16.0` would have failed with
// ETARGET on the first install. A hand-run shell loop in the skill caught it.
//
// No semver dependency: the launcher declares `^<latest published>` by
// convention (CLAUDE.md) and launcherSync enforces the range against the
// workspace, so what is left is an EXISTENCE question — is this exact version
// in the registry's version list — not range arithmetic.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTERNAL_SCOPES = ["@mulmoclaude/", "@mulmobridge/"];
const REGISTRY_BASE = "https://registry.npmjs.org";
const REGISTRY_TIMEOUT_MS = 15_000;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

const isInternal = (name) => INTERNAL_SCOPES.some((scope) => name.startsWith(scope));

/** Every internal package the launcher declares, with the field and range it was declared in. */
export async function declaredInternalDeps({ root = process.cwd() } = {}) {
  const manifest = JSON.parse(await readFile(path.join(root, "packages", "mulmoclaude", "package.json"), "utf8"));
  return DEPENDENCY_FIELDS.flatMap(
    (field) =>
      Object.entries(manifest[field] ?? {})
        .filter(([name]) => isInternal(name))
        .map(([name, range]) => ({ name, range, field })),
    // Plain codepoint order, not `localeCompare`: that is locale-sensitive, so the report
    // would come out in a different order on a runner with a different ICU default.
  ).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * Every workspace package's declared version, by name.
 *
 * Read from the manifests themselves rather than derived from directory names: the
 * workspace is not flat — `@mulmoclaude/core` is `packages/core` while the plugins live
 * under `packages/plugins/` — and a name-to-path guess silently produces "not in the
 * workspace" for the ones it gets wrong.
 */
export async function workspaceVersions({ root = process.cwd(), manifestPaths } = {}) {
  const paths = manifestPaths ?? (await defaultManifestPaths(root));
  const entries = await Promise.all(
    paths.map(async (relative) => {
      try {
        const manifest = JSON.parse(await readFile(path.join(root, relative), "utf8"));
        return typeof manifest.name === "string" && typeof manifest.version === "string" ? [manifest.name, manifest.version] : null;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
}

/**
 * Workspace manifests, found by walking `packages/` two levels deep.
 *
 * Deliberately NOT `git ls-files packages`: that also matches the drift fixtures nested
 * under `test/scripts/mulmoclaude/fixtures/`, whose deliberately-stale versions would
 * overwrite the real entries and invent drift that is not there.
 */
async function defaultManifestPaths(root) {
  const { readdir } = await import("node:fs/promises");
  const packagesDir = path.join(root, "packages");
  const found = [];
  const entries = await readdir(packagesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    found.push(path.join("packages", entry.name, "package.json"));
    const nested = await readdir(path.join(packagesDir, entry.name), { withFileTypes: true }).catch(() => []);
    nested.filter((candidate) => candidate.isDirectory()).forEach((candidate) => found.push(path.join("packages", entry.name, candidate.name, "package.json")));
  }
  return found;
}

/** The versions the registry lists for `name`, or null when the package is not on npm. */
async function defaultFetchPublishedVersions({ name, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${REGISTRY_BASE}/${encodeURIComponent(name)}`, { signal: controller.signal });
    if (response.status === 404) return { versions: [], reason: null };
    if (!response.ok) return { versions: null, reason: `registry ${response.status}` };
    const meta = await response.json();
    return { versions: Object.keys(meta.versions ?? {}), reason: null };
  } catch (err) {
    return { versions: null, reason: `network: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(killer);
  }
}

/**
 * One verdict per internal dep.
 *
 * `unpublished` is the finding this file exists for: the workspace has a version the
 * registry has never seen, so the launcher's `^<that version>` cannot resolve.
 */
export async function checkPublishedDeps({ root = process.cwd(), fetchPublishedVersions = defaultFetchPublishedVersions, manifestPaths } = {}) {
  const [deps, versions] = await Promise.all([declaredInternalDeps({ root }), workspaceVersions({ root, manifestPaths })]);
  return Promise.all(
    deps.map(async ({ name, range, field }) => {
      const workspaceVersion = versions.get(name) ?? null;
      if (workspaceVersion === null) return { name, range, field, workspaceVersion, status: "not-a-workspace" };
      const { versions: published, reason } = await fetchPublishedVersions({ name });
      if (published === null) return { name, range, field, workspaceVersion, status: "unknown", reason };
      if (published.length === 0) return { name, range, field, workspaceVersion, status: "not-on-npm" };
      return { name, range, field, workspaceVersion, status: published.includes(workspaceVersion) ? "published" : "unpublished" };
    }),
  );
}

/** Verdicts that stop a launcher publish. `unknown` does not: an unreachable registry is
 *  not evidence of an unpublished version, and failing on it would block on a flaky network. */
export const BLOCKING = ["unpublished", "not-on-npm"];

function formatLine(result) {
  const { name, range, workspaceVersion, status, reason } = result;
  if (status === "unpublished")
    return `  ⚠ ${name} workspace ${workspaceVersion} is NOT on npm — the launcher declares ${range}, whose lower bound does not exist`;
  if (status === "not-on-npm") return `  ⚠ ${name} has never been published — the launcher declares ${range}`;
  if (status === "unknown") return `  · ${name}: could not ask the registry — ${reason}`;
  if (status === "not-a-workspace") return `  · ${name}: declared ${range} but not a workspace package here — nothing to compare`;
  return `  ✓ ${name} ${workspaceVersion} is published`;
}

export async function main() {
  const results = await checkPublishedDeps();
  results.forEach((result) => console.log(formatLine(result)));
  const blocking = results.filter((result) => BLOCKING.includes(result.status));
  if (blocking.length === 0) {
    console.log("[mulmoclaude:published-deps] OK — every launcher dep resolves to a published version.");
    return 0;
  }
  console.error("");
  console.error(`[mulmoclaude:published-deps] ${blocking.length} dep(s) would make \`npx mulmoclaude@<next>\` fail with ETARGET.`);
  console.error("Publish each from its own package directory BEFORE publishing the launcher (bottom-up).");
  console.error("See .claude/skills/publish-mulmoclaude/SKILL.md §6.");
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const code = await main();
  process.exit(code);
}
