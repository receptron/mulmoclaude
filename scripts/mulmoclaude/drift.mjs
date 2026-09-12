// Workspace publish-drift check (§2 of the publish-mulmoclaude skill).
//
// Problem: a local `packages/<x>/src/` file adds a new runtime export without a
// version bump. The tarball a real user installs from the registry ships the OLD
// dist, so consumers crash with:
//   does not provide an export named X
// at runtime — invisible to lint, typecheck, or local dev, because in a yarn
// workspace `node_modules/<name>` is a symlink into `packages/<x>/` and the local
// dist is always freshly built.
//
// Three things about the shape of this check were measured, not assumed (#3116):
//
//  1. WHICH PACKAGES. It used to read the launcher's `dependencies` and keep the
//     `@mulmobridge/*` ones, which is four packages: chat-service, client,
//     protocol, web-push. That missed `@mulmoclaude/common` (declared by 32 other
//     workspaces), `@mulmobridge/webhook-runtime` (9), `@mulmoclaude/core` (8),
//     `@mulmoclaude/markdown-utils` (2) and `@receptron/task-scheduler` (1) — and
//     #3109 shipped new exports in two of those with no version bump, past a green
//     gate. The set is now every publishable workspace that another workspace
//     declares, whatever its scope and wherever it sits in the tree.
//
//  2. WHAT TO COMPARE. It used to compare the local `src/index.ts` against the
//     published `dist`. That only holds when dist mirrors src one-to-one, i.e. a
//     tsc build. For a vite-bundled package it is nonsense: `x-plugin`'s src has 6
//     export lines and its dist has 1, so the old metric called it DRIFTED when it
//     was identical to what npm serves; `core` came out 229 against 30. The
//     comparison is now local BUILT dist against published dist — same relative
//     path on both sides, so the build system cannot skew it. The smoke workflow
//     runs `yarn build:packages && yarn build` first, so CI's dist is current; a
//     missing local dist is reported as `skipped`, never as clean.
//
//  3. WHAT TO COUNT. Lines cannot see a bundle's exports. `x-plugin`'s whole
//     public surface is one line — `export { extractTweetId, formatTweet,
//     readUrlArg, readXPost, searchX, tweetBody };` — so a seventh name added there
//     keeps the count at 1 and the old metric passes. The unit is now the set of
//     exported NAMES, per `exports` subpath.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_BASE = "https://registry.npmjs.org";
const UNPKG_BASE = "https://unpkg.com";
const REGISTRY_TIMEOUT_MS = 15_000;

/** Statements that begin with `export`, with newlines inside a brace group
 *  flattened so a wrapped list is one statement, and `;`-separated statements on
 *  one line split apart. Parsing per LINE instead of per statement silently
 *  returned zero names for both shapes, which reads as "nothing exported" and so
 *  as "no drift" — the exact failure this gate exists to prevent. */
export function exportStatements(source) {
  const flattened = [];
  let depth = 0;
  for (const char of source) {
    if (char === "{") depth += 1;
    else if (char === "}") depth = depth > 0 ? depth - 1 : 0;
    flattened.push(depth > 0 && (char === "\n" || char === "\r") ? " " : char);
  }
  const statements = [];
  for (const line of flattened.join("").split("\n")) {
    // Column 0 only. An indented `export` is not a module-level export in a built
    // file — it is text inside a template literal, a comment, or a namespace — and
    // counting it would invent names the package does not have.
    if (!line.startsWith("export")) continue;
    for (const piece of line.split(";")) {
      const chunk = piece.trim();
      // `export` must be a complete token — `exported = 1` is not an export — but
      // anything else that IS one is kept even when it looks unparseable
      // (`export/*c*/{a}`), because the parser marks what it cannot model opaque.
      // Dropping it here instead would be a silent miss, which reads as "clean".
      if (chunk.startsWith("export") && !/^export[\w$]/.test(chunk)) statements.push(chunk);
    }
  }
  return statements;
}

// Names a module exports, or `opaque: true` when a statement re-exports a whole
// module (`export * from "./chunk.js"`) or cannot be parsed at all. Opaque falls
// back to line counting — weaker, but it FAILS CLOSED: an export shape nobody
// anticipated shows up as a coarser comparison, never as an empty name set that
// would pass as clean.
export function parseExportedNames(source) {
  const names = new Set();
  let opaque = false;
  const IDENT = /^[A-Za-z_$][\w$]*/;
  const DECLARERS = new Set(["function", "function*", "class", "const", "let", "var"]);
  const NO_NAME_FORMS = new Set(["type", "interface"]);
  const firstWord = (text) => {
    const cut = text.search(/[^\w$*]/);
    return cut === -1 ? text : text.slice(0, cut === 0 ? 1 : cut);
  };
  // One name from a brace specifier: `a` -> a, `a as b` -> b, `type T` -> none.
  const specifierName = (raw) => {
    const spec = raw.trim();
    if (spec === "" || spec.startsWith("type ")) return null;
    const parts = spec.split(/\s+/);
    const picked = parts.length >= 3 && parts[parts.length - 2] === "as" ? parts[parts.length - 1] : parts[0];
    // `default` counts: a default-import consumer breaks the same way when the
    // published tarball lacks it, which is the failure this gate exists for.
    const match = IDENT.exec(picked);
    return match === null ? null : match[0];
  };

  // The rule is INVERTED on purpose: these four shapes are what this parser claims
  // to understand, and every other `export` statement is opaque. Three separate
  // findings in one review were each "it silently drops <one more shape>" — a
  // language always has one more way to say a thing than a ban-list will name, and
  // a dropped statement reads as "nothing exported", i.e. as "no drift". This
  // direction rejects some perfectly safe code into the coarser line-count
  // comparison, which is the trade worth making for a release gate.
  for (const statement of exportStatements(source)) {
    let rest = statement.slice("export".length).trim();
    if (rest.startsWith("*")) {
      opaque = true;
      continue;
    }
    if (rest.startsWith("{")) {
      const close = rest.indexOf("}");
      const body = close === -1 ? null : rest.slice(1, close);
      // A brace that never closes, or one carrying a comment (whose text could hide
      // or invent a name once newlines are flattened), is not a shape this models.
      if (body === null || body.includes("//") || body.includes("/*")) {
        opaque = true;
        continue;
      }
      for (const piece of body.split(",")) {
        const name = specifierName(piece);
        if (name !== null) names.add(name);
      }
      continue;
    }
    // Strip modifiers one word at a time — cheaper and safer than one regex with
    // nested optional groups, which eslint's ReDoS rules reject outright.
    let head = firstWord(rest);
    while (head === "declare" || head === "async") {
      rest = rest.slice(head.length).trim();
      head = firstWord(rest);
    }
    if (head === "default") {
      names.add("default");
      continue;
    }
    if (NO_NAME_FORMS.has(head)) continue;
    if (!DECLARERS.has(head)) {
      // `export <something we do not model>` — fail closed rather than drop it.
      opaque = true;
      continue;
    }
    const match = IDENT.exec(rest.slice(head.length).trim());
    if (match === null) opaque = true;
    else names.add(match[0]);
  }
  return { names, opaque };
}

// Kept from the line-counting era: it is the fallback for an opaque entry, and
// the only metric available when a `export * from` hides the real surface.
//
// "Value export LINES" = every `^export …` line except ones that are entirely
// type-only (`export type …`, `export interface …`, `export { type … }`).
export function countValueExportLines(source) {
  const lines = source.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (!line.startsWith("export")) continue;
    if (/^export\s+(?:type|interface)\b/.test(line)) continue;
    if (/^export\s*\{\s*type\b/.test(line)) continue;
    count += 1;
  }
  return count;
}

/** The `exports` subpaths of a manifest, mapped to the file each one serves.
 *  Falls back to `module` / `main` / `dist/index.js` for a package with no
 *  `exports` map, which is what the single-entry packages relied on. */
export function entryTargets(pkg) {
  const out = new Map();
  const exp = pkg?.exports;
  if (exp !== null && typeof exp === "object") {
    for (const [subpath, value] of Object.entries(exp)) {
      const target = typeof value === "string" ? value : (value?.import ?? value?.default ?? value?.require ?? null);
      if (typeof target === "string") out.set(subpath, target.replace(/^\.\/+/, ""));
    }
  }
  if (out.size === 0) {
    const target = pkg?.module ?? pkg?.main ?? "dist/index.js";
    out.set(".", String(target).replace(/^\.\/+/, ""));
  }
  return out;
}

async function readManifest(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// Every publishable workspace, by name, with the directory it lives in. Walks
// the root manifest's `workspaces` globs rather than assuming `packages/<name>`:
// the bridges sit under `packages/bridges/<name>` and the plugins under
// `packages/plugins/<name>`, and `@receptron/task-scheduler` lives in
// `packages/scheduler` — a name-to-path guess is wrong for most of the tree.
async function readWorkspaces(root) {
  const rootPkg = await readManifest(path.join(root, "package.json"));
  const patterns = Array.isArray(rootPkg?.workspaces) ? rootPkg.workspaces : (rootPkg?.workspaces?.packages ?? []);
  const { glob } = await import("node:fs/promises");
  const found = new Map();
  for (const pattern of patterns) {
    for await (const dir of glob(pattern, { cwd: root })) {
      const pkg = await readManifest(path.join(root, dir, "package.json"));
      if (pkg === null || typeof pkg.name !== "string") continue;
      if (pkg.private === true) continue;
      found.set(pkg.name, { name: pkg.name, dir, pkg });
    }
  }
  return found;
}

/** The scan set: publishable workspaces that at least one other workspace
 *  declares, in any dependency field. A package nothing imports cannot break a
 *  consumer by lacking an export; one the launcher alone imports can, because the
 *  launcher's own published `server/` and `src/` call into it. */
export async function discoverWorkspaceLibraries({ root = process.cwd() } = {}) {
  const workspaces = await readWorkspaces(root);
  const consumers = new Map();
  for (const { name, pkg } of workspaces.values()) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        if (!workspaces.has(dep) || dep === name) continue;
        const seen = consumers.get(dep) ?? new Set();
        seen.add(name);
        consumers.set(dep, seen);
      }
    }
  }
  return [...workspaces.values()]
    .filter((entry) => (consumers.get(entry.name)?.size ?? 0) > 0)
    .map((entry) => ({ ...entry, consumers: [...(consumers.get(entry.name) ?? [])].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The registry's `latest` version for a package, or null with a reason. */
export async function defaultFetchPublishedVersion({ name, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${REGISTRY_BASE}/${encodeURIComponent(name)}/latest`, { signal: controller.signal });
    if (!res.ok) return { version: null, reason: `registry ${res.status}` };
    const meta = await res.json();
    const version = typeof meta.version === "string" ? meta.version : null;
    return version === null ? { version: null, reason: "registry meta missing version" } : { version, reason: null };
  } catch (err) {
    return { version: null, reason: `network: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(killer);
  }
}

/** One published file, by the same relative path the local dist uses. */
export async function defaultFetchPublishedEntry({ name, version, entryPath, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${UNPKG_BASE}/${name}@${version}/${entryPath}`, { signal: controller.signal });
    if (!res.ok) return { source: null, reason: `unpkg ${res.status}` };
    return { source: await res.text(), reason: null };
  } catch (err) {
    return { source: null, reason: `network: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(killer);
  }
}

// Compare two module sources and say which runtime names the local one adds.
// An opaque entry on either side falls back to line counting, and says so.
export function compareEntry(localSource, publishedSource) {
  const local = parseExportedNames(localSource);
  const published = parseExportedNames(publishedSource);
  if (local.opaque || published.opaque) {
    const localCount = countValueExportLines(localSource);
    const distCount = countValueExportLines(publishedSource);
    return { added: [], localCount, distCount, opaque: true, drifted: localCount > distCount };
  }
  const added = [...local.names].filter((name) => !published.names.has(name)).sort();
  return { added, localCount: local.names.size, distCount: published.names.size, opaque: false, drifted: added.length > 0 };
}

/**
 * Compare two semver-ish version strings and return true when `local` is
 * strictly ahead of `published`. Ignores pre-release / build suffixes — this
 * monorepo only bumps majors / minors / patches, and a prerelease drift is
 * intentional anyway. Returns false on malformed input so the check errs strict.
 */
export function isLocalVersionAhead(local, published) {
  const parse = (value) => {
    if (typeof value !== "string") return null;
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(local);
  const b = parse(published);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/**
 * Inspect one workspace: for every `exports` subpath, compare the local built
 * dist against the published one. Returns
 * `{ status: "ok" | "drifted" | "pending-publish" | "skipped", ... }`.
 *
 * A bumped version downgrades drift to `pending-publish`: the registry still
 * serves the old dist, but consumers of the NEW version will get the new exports
 * once it is published, so from here it is "pending publish", not broken. That is
 * also what unblocks a PR that adds exports, bumps, and waits for the cascade.
 */
export async function checkPackageDrift({
  root = process.cwd(),
  name,
  dir,
  pkg,
  fetchPublishedVersion = defaultFetchPublishedVersion,
  fetchPublishedEntry = defaultFetchPublishedEntry,
} = {}) {
  if (typeof name !== "string" || name === "") throw new Error("checkPackageDrift: `name` is required");
  const manifest = pkg ?? (await readManifest(path.join(root, dir ?? "", "package.json")));
  if (manifest === null) return { packageBaseName: name, localVersion: null, status: "skipped", reason: `no manifest under ${dir}` };
  const localVersion = typeof manifest.version === "string" ? manifest.version : null;

  const published = await fetchPublishedVersion({ name });
  if (published.version === null) {
    return {
      packageBaseName: name,
      localVersion,
      publishedVersion: null,
      status: "skipped",
      reason: `no published version — ${published.reason ?? "unknown"}`,
    };
  }

  const entries = entryTargets(manifest);
  const added = [];
  const opaqueEntries = [];
  const skipped = [];
  let localCount = 0;
  let distCount = 0;
  let compared = 0;

  for (const [subpath, entryPath] of entries) {
    if (subpath.includes("*") || entryPath.includes("*")) {
      // A wildcard subpath (`"./*": "./dist/*.js"`) names a family, not a file.
      // Enumerating it would mean walking the published tarball; say so rather
      // than reporting the unresolvable path as a missing build.
      skipped.push(`${subpath} (wildcard subpath — not enumerable)`);
      continue;
    }
    let localSource;
    try {
      localSource = await readFile(path.join(root, dir ?? "", entryPath), "utf8");
    } catch {
      // The dist file the manifest promises is not there. Reported, never silent:
      // a missing local build is the one state that could make drift look clean.
      skipped.push(`${subpath} (local ${entryPath} missing — build first)`);
      continue;
    }
    const remote = await fetchPublishedEntry({ name, version: published.version, entryPath });
    if (remote.source === null) {
      // A 404 on a CONCRETE target means the published package does not serve this
      // path at all — `import "pkg/new"` fails after a plain install. That is the
      // drift, not a gap in the check, so it counts rather than being skipped.
      // Transport failures (5xx, 429, timeouts) stay skipped: they say nothing
      // about the package.
      if ((remote.reason ?? "").includes("404")) {
        added.push(`${subpath}:ENTIRE SUBPATH absent from the published package (${entryPath})`);
        compared += 1;
        localCount += parseExportedNames(localSource).names.size;
        continue;
      }
      skipped.push(`${subpath} (published ${entryPath}: ${remote.reason ?? "unavailable"})`);
      continue;
    }
    const result = compareEntry(localSource, remote.source);
    compared += 1;
    localCount += result.localCount;
    distCount += result.distCount;
    if (result.opaque) opaqueEntries.push(subpath);
    for (const exportName of result.added) added.push(`${subpath}:${exportName}`);
    if (result.opaque && result.drifted) added.push(`${subpath}:+${result.localCount - result.distCount} export line(s)`);
  }

  if (compared === 0) {
    return {
      packageBaseName: name,
      localVersion,
      publishedVersion: published.version,
      status: "skipped",
      reason: `no entry could be compared — ${skipped.join("; ") || "no exports"}`,
    };
  }

  const drifted = added.length > 0;
  const status = drifted ? (isLocalVersionAhead(localVersion, published.version) ? "pending-publish" : "drifted") : "ok";
  return {
    packageBaseName: name,
    localVersion,
    publishedVersion: published.version,
    status,
    localCount,
    distCount,
    added,
    entriesCompared: compared,
    ...(skipped.length > 0 ? { partialReason: skipped.join("; ") } : {}),
    ...(opaqueEntries.length > 0 ? { opaqueEntries } : {}),
  };
}

/** Run `checkPackageDrift` across the discovered scan set (or an explicit list). */
export async function checkWorkspaceDrift({ root = process.cwd(), packageNames, ...rest } = {}) {
  const discovered = await discoverWorkspaceLibraries({ root });
  const targets = packageNames === undefined ? discovered : discovered.filter((entry) => packageNames.includes(entry.name));
  const results = [];
  for (const target of targets) {
    results.push(await checkPackageDrift({ root, name: target.name, dir: target.dir, pkg: target.pkg, ...rest }));
  }
  return results;
}

export function formatLine(result) {
  const { packageBaseName, localVersion, publishedVersion, status } = result;
  const local = localVersion ? `v${localVersion}` : "(no local version)";
  const published = publishedVersion ? `→ published v${publishedVersion}` : "";
  const partial = result.partialReason ? ` [partial: ${result.partialReason}]` : "";
  const opaque = result.opaqueEntries ? ` [opaque: ${result.opaqueEntries.join(", ")}]` : "";
  const counts = `local dist exports ${result.localCount} name(s), published ${result.distCount}`;
  if (status === "drifted") {
    return `  ⚠ ${packageBaseName} ${local} ${published}: ${counts} — adds ${result.added.join(", ")}${partial}${opaque}`;
  }
  if (status === "pending-publish") {
    return `  ⧗ ${packageBaseName} ${local} ${published}: ${counts} — adds ${result.added.join(", ")}, bumped but NOT published yet${partial}${opaque}`;
  }
  if (status === "skipped") {
    return `  · ${packageBaseName} ${local}: skipped — ${result.reason}`;
  }
  return `  ✓ ${packageBaseName} ${local} ${published}: ${result.localCount} export name(s) match across ${result.entriesCompared} entry(ies)${partial}${opaque}`;
}

/**
 * Which statuses fail the run.
 *
 * `pending-publish` is deliberately non-fatal on an ordinary PR — the version bump is the
 * developer's acknowledgement, and blocking would stop a PR that adds exports and bumps
 * correctly while the cascade publish is still pending.
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
// decide if they should retry after a build.
export async function main({ release = false } = {}) {
  const results = await checkWorkspaceDrift();
  for (const result of results) console.log(formatLine(result));
  const fails = failingStatuses(release);
  const blocking = results.filter((result) => fails.includes(result.status));
  if (blocking.length === 0) {
    console.log(`[mulmoclaude:drift] OK — no workspace drift across ${results.length} package(s)${release ? ", and nothing is waiting to be published" : ""}.`);
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
