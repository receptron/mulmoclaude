// @mulmobridge/* drift check (§2 of publish-mulmoclaude skill).
//
// Problem: a local `packages/<name>/src/` file adds a new runtime
// export without a version bump. The tarball a real user installs
// from the registry ships the OLD dist/, so consumers crash with:
//   does not provide an export named X
// at runtime — invisible to lint, typecheck, or local dev.
//
// Detection strategy: count value-export LINES in src/index.ts and
// in the currently-published dist (fetched from the npm registry),
// flag when src > published.
//
// Why the registry and not `node_modules/.../dist`: in a yarn-
// workspace repo, `node_modules/@mulmobridge/<name>` is a symlink
// into `packages/<name>/`. `yarn build:packages` then rebuilds that
// symlinked dist from the current src, making `src == dist` in CI
// regardless of whether the published version lags behind — the
// whole point of the check. Compare against the registry payload
// instead so the drift picks up exactly what a fresh
// `npm install mulmoclaude` would see at runtime.
//
// "Value export LINES" = every `^export …` line except ones that
// are entirely type-only (`export type …`, `export interface …`,
// `export { type … }`). Counting lines (not individual specifiers)
// matches the original skill heuristic and has caught every real
// drift we've seen.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MULMOBRIDGE_SCOPE = "@mulmobridge/";
const DEFAULT_INSTALLED_ROOT = "node_modules";
const REGISTRY_BASE = "https://registry.npmjs.org";
const UNPKG_BASE = "https://unpkg.com";
const REGISTRY_TIMEOUT_MS = 15_000;

// Returns how many `^export …` lines in `source` declare at least
// one runtime (value) export. Type-only lines are filtered.
//
// Matches only when `export` is at column 0 (no leading whitespace)
// to mirror the skill's `grep -E '^export'` exactly — indented
// `export` tokens inside namespaces or conditional blocks aren't
// module-level re-exports and shouldn't count.
export function countValueExportLines(source) {
  const lines = source.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (!line.startsWith("export")) continue;
    // `export type Foo = …` / `export interface Foo { … }`
    if (/^export\s+(?:type|interface)\b/.test(line)) continue;
    // `export { type Foo, type Bar }` — brace starts with `type`.
    // Matches the skill's heuristic even when the brace also has
    // runtime bindings (rare in practice).
    if (/^export\s*\{\s*type\b/.test(line)) continue;
    count += 1;
  }
  return count;
}

// Read the local workspace package.json for `<packageBaseName>` to
// surface its version string. Returns `null` if the file can't be
// read — not every @mulmobridge/* dep has a local workspace twin.
async function readLocalVersion(root, packageBaseName) {
  const pkgPath = path.join(root, "packages", packageBaseName, "package.json");
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// Default published-source fetcher: queries the npm registry for
// the package's `latest` dist-tag version, then pulls the `main` /
// `module` entry from unpkg. Returns `null` on any network / 404
// failure so the caller can skip rather than crash.
async function defaultFetchPublishedSource({ packageBaseName, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  const fullName = MULMOBRIDGE_SCOPE + packageBaseName;
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const metaRes = await fetch(`${REGISTRY_BASE}/${encodeURIComponent(fullName)}/latest`, {
      signal: controller.signal,
    });
    if (!metaRes.ok) return { version: null, source: null, reason: `registry ${metaRes.status}` };
    const meta = await metaRes.json();
    const version = typeof meta.version === "string" ? meta.version : null;
    if (!version) return { version: null, source: null, reason: "registry meta missing version" };
    // Prefer the package's declared `main` / `module` entry rather
    // than assuming `dist/index.js` — a future refactor of the
    // @mulmobridge/* packages could move the entry file.
    const entry = typeof meta.module === "string" ? meta.module : typeof meta.main === "string" ? meta.main : "dist/index.js";
    const distRes = await fetch(`${UNPKG_BASE}/${fullName}@${version}/${entry.replace(/^\.?\/+/, "")}`, {
      signal: controller.signal,
    });
    if (!distRes.ok) return { version, source: null, reason: `unpkg ${distRes.status}` };
    const source = await distRes.text();
    return { version, source, reason: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { version: null, source: null, reason: `network: ${message}` };
  } finally {
    clearTimeout(killer);
  }
}

// Read installed-dist source (the pre-registry behaviour). Kept as
// a fallback so offline / registry-unreachable callers still get a
// signal, and the existing fixture-based tests keep working.
async function readInstalledDistSource({ root, packageBaseName, installedRoot, distRelative }) {
  const distPath = path.join(root, installedRoot, MULMOBRIDGE_SCOPE + packageBaseName, distRelative);
  try {
    return await readFile(distPath, "utf8");
  } catch {
    return null;
  }
}

// Inspect one package: compare local src value-export count with
// the currently-published dist (fetched from the registry). Returns
// `{ status: "ok"|"drifted"|"skipped", ... }`.
//
// Options:
//   fetchPublishedSource: override for the registry fetcher; must
//     resolve to `{ version, source, reason }` shape. Tests pass a
//     fake; real runs use defaultFetchPublishedSource.
//   installedRoot / distRelative: legacy local-dist fallback, used
//     when `fetchPublishedSource` returns no source (offline CI,
//     package not on registry, etc.). Also kept so the existing
//     fixture tests can exercise the local-dist path without hitting
//     the network.
export async function checkPackageDrift({
  root = process.cwd(),
  packageBaseName,
  srcRelative = "src/index.ts",
  distRelative = "dist/index.js",
  installedRoot = DEFAULT_INSTALLED_ROOT,
  fetchPublishedSource = defaultFetchPublishedSource,
} = {}) {
  if (!packageBaseName) {
    throw new Error("checkPackageDrift: packageBaseName is required");
  }
  const srcPath = path.join(root, "packages", packageBaseName, srcRelative);
  const localVersion = await readLocalVersion(root, packageBaseName);

  let srcSource;
  try {
    srcSource = await readFile(srcPath, "utf8");
  } catch {
    return { packageBaseName, localVersion, status: "skipped", reason: `local src not found at ${srcRelative}` };
  }

  const published = await fetchPublishedSource({ packageBaseName });
  let distSource = published.source;
  const publishedVersion = published.version;
  let fallbackReason = null;
  if (distSource === null) {
    distSource = await readInstalledDistSource({ root, packageBaseName, installedRoot, distRelative });
    if (distSource !== null) {
      fallbackReason = `registry unreachable (${published.reason ?? "unknown"}) — compared against local ${installedRoot}/.../${distRelative}`;
    }
  }

  if (distSource === null) {
    return {
      packageBaseName,
      localVersion,
      status: "skipped",
      reason: `no dist to compare — registry: ${published.reason ?? "unknown"}, local dist not found either`,
    };
  }

  const localCount = countValueExportLines(srcSource);
  const distCount = countValueExportLines(distSource);
  const drifted = localCount > distCount;

  // A bumped version is the developer's acknowledgement that the new
  // exports land under a new release. The registry still ships the
  // old dist, but consumers of the NEW version will get the new
  // exports once it's published — so from the drift-check's POV this
  // is "pending publish", not "broken". Downgrading to non-failing
  // also unblocks PRs that add exports + bump version + await the
  // cascade publish to land after merge.
  const isBumped = drifted && isLocalVersionAhead(localVersion, publishedVersion);

  const status = drifted ? (isBumped ? "pending-publish" : "drifted") : "ok";
  return {
    packageBaseName,
    localVersion,
    publishedVersion,
    status,
    localCount,
    distCount,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

// Compare two semver-ish version strings and return true when
// `local` is strictly ahead of `published`. Ignores pre-release /
// build suffixes — we only bump majors / minors / patches in this
// monorepo, and a prerelease drift is still "intentional" anyway.
// Returns false on any malformed input so the drift check errs on
// the strict side (caller's old behaviour preserved).
export function isLocalVersionAhead(local, published) {
  if (typeof local !== "string" || typeof published !== "string") return false;
  const parse = (str) => {
    const [cleaned] = str.split(/[-+]/);
    const parts = cleaned.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length < 3) return null;
    if (parts.some((part) => !Number.isFinite(part))) return null;
    return parts.slice(0, 3);
  };
  const localParts = parse(local);
  const publishedParts = parse(published);
  if (!localParts || !publishedParts) return false;
  for (let idx = 0; idx < 3; idx++) {
    if (localParts[idx] > publishedParts[idx]) return true;
    if (localParts[idx] < publishedParts[idx]) return false;
  }
  return false;
}

// Auto-detect which @mulmobridge/* packages to check by reading the
// launcher's package.json. Only packages that ALSO exist as a local
// workspace (`packages/<name>/`) are returned — published-only deps
// can't drift against themselves.
export async function detectMulmobridgeDeps({ root = process.cwd() } = {}) {
  const pkgPath = path.join(root, "packages", "mulmoclaude", "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const deps = Object.keys(pkg.dependencies ?? {});
  const bridges = deps.filter((name) => name.startsWith(MULMOBRIDGE_SCOPE)).map((name) => name.slice(MULMOBRIDGE_SCOPE.length));
  const out = [];
  for (const name of bridges) {
    const localVersion = await readLocalVersion(root, name);
    if (localVersion !== null) out.push(name);
  }
  return out;
}

// Run checkPackageDrift against every auto-detected (or explicit)
// @mulmobridge/* workspace dep. Returns one result per package.
export async function checkWorkspaceDrift({
  root = process.cwd(),
  packageBaseNames,
  installedRoot = DEFAULT_INSTALLED_ROOT,
  srcRelative,
  distRelative,
  fetchPublishedSource,
} = {}) {
  const names = packageBaseNames ?? (await detectMulmobridgeDeps({ root }));
  const results = [];
  for (const name of names) {
    results.push(
      await checkPackageDrift({
        root,
        packageBaseName: name,
        installedRoot,
        srcRelative,
        distRelative,
        ...(fetchPublishedSource ? { fetchPublishedSource } : {}),
      }),
    );
  }
  return results;
}

// One console line per result. Every status the audit can return needs its own
// branch: `pending-publish` used to fall through to the `✓ … (src == published)`
// line below, which says the opposite of what happened — the counts DIFFER, the
// bump just means it is intentional. That line read as fully clean while
// @mulmobridge/client sat bumped-but-unpublished, and the launcher release it
// would have broken was caught by a hand-run loop instead (#3099).
export function formatLine(result) {
  const { packageBaseName, localVersion, publishedVersion, status, fallbackReason } = result;
  const local = localVersion ? `v${localVersion}` : "(no local version)";
  const published = publishedVersion ? `→ published v${publishedVersion}` : "";
  const fallback = fallbackReason ? ` [${fallbackReason}]` : "";
  const counts = `src has ${result.localCount} value-export lines, published dist has ${result.distCount}`;
  if (status === "drifted") {
    return `  ⚠ @mulmobridge/${packageBaseName} ${local} ${published}: ${counts}${fallback}`;
  }
  if (status === "pending-publish") {
    return `  ⧗ @mulmobridge/${packageBaseName} ${local} ${published}: ${counts} — bumped but NOT published yet${fallback}`;
  }
  if (status === "skipped") {
    return `  · @mulmobridge/${packageBaseName} ${local}: skipped — ${result.reason}`;
  }
  return `  ✓ @mulmobridge/${packageBaseName} ${local} ${published}: ${result.localCount} value-export lines (src == published)${fallback}`;
}

/**
 * Which statuses fail the run.
 *
 * `pending-publish` is deliberately non-fatal on an ordinary PR — the version bump is the
 * developer's acknowledgement, and blocking would stop a PR that adds exports and bumps
 * correctly while the cascade publish is still pending (see the note on `isBumped` above).
 *
 * At RELEASE time the same state is the blocker itself: a package bumped but not published
 * is a dependency range whose lower bound does not exist on the registry, so
 * `npx mulmoclaude@<next>` fails with ETARGET. That happened on 1.16.0 and was caught by a
 * hand-run loop rather than by this gate (#3099).
 */
/** `name@version`, as its own function so the list can be built without nesting one
 *  template literal inside another. */
const nameAndVersion = (result) => `${result.packageBaseName}@${result.localVersion}`;

export const failingStatuses = (release) => (release ? ["drifted", "pending-publish"] : ["drifted"]);

// CLI: exits 1 if any package drifted, 0 otherwise. "skipped"
// results don't fail the check but are printed so the operator can
// decide if they should retry after `yarn install`.
export async function main({ release = false } = {}) {
  const results = await checkWorkspaceDrift();
  for (const result of results) console.log(formatLine(result));
  const fails = failingStatuses(release);
  const blocking = results.filter((result) => fails.includes(result.status));
  if (blocking.length === 0) {
    console.log(`[mulmoclaude:drift] OK — no workspace drift detected${release ? ", and nothing is waiting to be published" : ""}.`);
    return 0;
  }
  const pending = blocking.filter((result) => result.status === "pending-publish");
  const named = pending.map(nameAndVersion).join(", ");
  console.error("");
  console.error(`[mulmoclaude:drift] ${blocking.length} package(s) block publishing — bump + republish before publishing mulmoclaude.`);
  if (pending.length > 0) {
    console.error(`  ${pending.length} of them are bumped but NOT published: ${named}`);
    console.error("  That is fine on an ordinary PR and fatal here — the declared range's lower bound is not on the registry.");
  }
  console.error("See .claude/skills/publish-mulmoclaude/SKILL.md §2 for the cascade-publish flow.");
  return 1;
}

// CLI entry point — same direct-run guard as deps.mjs so this file
// can be both imported and executed.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const code = await main({ release: process.argv.includes("--release") });
  process.exit(code);
}
