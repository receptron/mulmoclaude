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
 * Workspace manifests under `packages/`, at ANY depth.
 *
 * Recursive rather than a fixed two levels: this repo is two and three deep today
 * (`packages/core`, `packages/plugins/x-plugin`), and a depth limit would report a deeper
 * one as "not a workspace package" — the silent-pass shape this whole check exists to remove.
 *
 * Deliberately NOT `git ls-files packages`: that also matches the drift fixtures nested
 * under `test/scripts/mulmoclaude/fixtures/`, whose deliberately-stale versions would
 * overwrite the real entries and invent drift that is not there. `node_modules` is skipped
 * for the same reason — an installed copy is not a workspace package.
 */
async function defaultManifestPaths(root) {
  const { readdir } = await import("node:fs/promises");
  const walk = async (relative) => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
    const here = entries.some((entry) => entry.isFile() && entry.name === "package.json") ? [path.join(relative, "package.json")] : [];
    const deeper = await Promise.all(
      entries.filter((entry) => entry.isDirectory() && entry.name !== "node_modules").map((entry) => walk(path.join(relative, entry.name))),
    );
    return [...here, ...deeper.flat()];
  };
  return walk("packages");
}

/** The versions the registry lists for `name`, plus its `latest` dist-tag. `versions` is
 *  null when the registry could not be asked, and empty when the package is not on npm.
 *  `latest` comes from the dist-tag rather than the last key of `versions`: key order is
 *  not a documented guarantee, and "newest" is exactly what the tag means. */
async function defaultFetchPublishedVersions({ name, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${REGISTRY_BASE}/${encodeURIComponent(name)}`, { signal: controller.signal });
    if (response.status === 404) return { versions: [], latest: null, reason: null };
    if (!response.ok) return { versions: null, latest: null, reason: `registry ${response.status}` };
    const meta = await response.json();
    return { versions: Object.keys(meta.versions ?? {}), latest: meta["dist-tags"]?.latest ?? null, reason: null };
  } catch (err) {
    return { versions: null, latest: null, reason: `network: ${err instanceof Error ? err.message : String(err)}` };
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
      const { versions: published, latest = null, reason } = await fetchPublishedVersions({ name });
      if (published === null) return { name, range, field, workspaceVersion, status: "unknown", reason };
      if (published.length === 0) return { name, range, field, workspaceVersion, status: "not-on-npm" };
      // The registry is asked FIRST, so a dep with no workspace twin is still verified.
      // Returning early on a missing twin let a declared internal dep through unchecked —
      // the one thing this gate exists to stop (#3105 round 1, Codex).
      if (workspaceVersion === null) return { name, range, field, workspaceVersion, status: "not-a-workspace" };
      if (!published.includes(workspaceVersion)) return { name, range, field, workspaceVersion, status: "unpublished" };
      // `behind` cannot cause ETARGET, so it does not block — but the shell loop this
      // replaced surfaced it (as `local != npm`), and dropping a signal in a replacement is
      // a regression even when the signal is not fatal.
      const behind = latest !== null && latest !== workspaceVersion;
      return { name, range, field, workspaceVersion, newestPublished: latest, status: behind ? "behind" : "published" };
    }),
  );
}

/**
 * Verdicts that stop a launcher publish.
 *
 * `not-a-workspace` blocks. Every `@mulmoclaude/*` / `@mulmobridge/*` the launcher declares
 * is published from this repo, so a missing twin means the manifest moved or the walk missed
 * it — and either way the declared range went UNVERIFIED. A gate that passes what it could
 * not check is the shape this file replaced.
 *
 * `unknown` does not block: an unreachable registry is not evidence of an unpublished
 * version, and a gate that fails on a flaky network is one people learn to skip. It is
 * printed, and the summary says how many went unchecked.
 *
 * `behind` does not block: the workspace being older than npm cannot cause ETARGET.
 */
export const BLOCKING = ["unpublished", "not-on-npm", "not-a-workspace"];

function formatLine(result) {
  const { name, range, workspaceVersion, status, reason } = result;
  if (status === "unpublished")
    return `  ⚠ ${name} workspace ${workspaceVersion} is NOT on npm — the launcher declares ${range}, whose lower bound does not exist`;
  if (status === "not-on-npm") return `  ⚠ ${name} has never been published — the launcher declares ${range}`;
  if (status === "unknown") return `  · ${name}: could not ask the registry — ${reason}`;
  if (status === "not-a-workspace") return `  ⚠ ${name} is declared ${range} but has no workspace manifest here — the range went UNVERIFIED`;
  if (status === "behind") return `  · ${name} ${workspaceVersion} is published, but npm already has ${result.newestPublished} — the workspace is behind`;
  return `  ✓ ${name} ${workspaceVersion} is published`;
}

export async function main() {
  const results = await checkPublishedDeps();
  results.forEach((result) => console.log(formatLine(result)));
  const blocking = results.filter((result) => BLOCKING.includes(result.status));
  const unchecked = results.filter((result) => result.status === "unknown");
  if (blocking.length === 0) {
    const caveat = unchecked.length > 0 ? ` (${unchecked.length} could not be checked — the registry was unreachable)` : "";
    console.log(`[mulmoclaude:published-deps] OK — every launcher dep resolves to a published version${caveat}.`);
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
