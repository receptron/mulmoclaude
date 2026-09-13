// Type declarations for drift.mjs. Sidecar keeps the script plain
// JS (no build step for the CI/script path) while tests + the smoke
// driver still get a typed import surface.

/** The runtime names a module exports. `opaque` is true when the file
 *  re-exports a whole module (`export * from`), so the set is incomplete and
 *  the caller falls back to line counting. */
export interface ExportedNames {
  names: Set<string>;
  opaque: boolean;
}

/** Statements beginning with `export`, with a brace group's newlines flattened so
 *  a wrapped list is one statement, and `;`-separated statements split apart.
 *  Column 0 only — an indented `export` in a built file is text, not an export. */
export function exportStatements(source: string): string[];

export function parseExportedNames(source: string): ExportedNames;

/** Line-count fallback, used only for an opaque entry. */
export function countValueExportLines(source: string): number;

/** The runtime target behind one `exports` value, descending through condition
 *  objects. Null when no string target resolves — reported as unresolved rather
 *  than replaced with a guess. */
export function resolveConditionTarget(value: unknown, depth?: number): string | null;

/** Maps each `exports` subpath to the file it serves (relative to the package
 *  directory), or to null when no runtime target resolves. A package with no
 *  `exports` map at all falls back to `module` / `main` / `dist/index.js` for `.`;
 *  that fallback never applies per subpath. */
export function entryTargets(pkg: unknown): Map<string, string | null>;

export interface EntryComparison {
  /** Runtime names present locally and absent from the published build. */
  added: string[];
  localCount: number;
  distCount: number;
  opaque: boolean;
  drifted: boolean;
}

export function compareEntry(localSource: string, publishedSource: string): EntryComparison;

/**
 * Returns true when `local` (a semver-ish string) is strictly greater than
 * `published`. Ignores prerelease / build suffixes. Returns false for any
 * malformed / missing input.
 */
export function isLocalVersionAhead(local: string | null | undefined, published: string | null | undefined): boolean;

/** One publishable workspace in the scan set. */
export interface WorkspaceLibrary {
  name: string;
  /** Directory relative to the repo root — read from the workspace globs, never
   *  guessed from the package name. */
  dir: string;
  pkg: Record<string, unknown>;
  /** Other workspaces that declare this one, in any dependency field. */
  consumers: string[];
}

export function discoverWorkspaceLibraries(options?: { root?: string }): Promise<WorkspaceLibrary[]>;

export interface PublishedVersion {
  version: string | null;
  reason: string | null;
}

export interface PublishedEntry {
  source: string | null;
  reason: string | null;
}

export type FetchPublishedVersion = (args: { name: string; timeoutMs?: number }) => Promise<PublishedVersion>;
export type FetchPublishedEntry = (args: { name: string; version: string; entryPath: string; timeoutMs?: number }) => Promise<PublishedEntry>;

export function defaultFetchPublishedVersion(args: { name: string; timeoutMs?: number }): Promise<PublishedVersion>;
export function defaultFetchPublishedEntry(args: { name: string; version: string; entryPath: string; timeoutMs?: number }): Promise<PublishedEntry>;

/** One entry from a drift scan. `status` encodes the verdict. */
export interface PackageDriftResult {
  /** The full package name. (It held the scope-less base name before #3116, when
   *  every scanned package was `@mulmobridge/*`.) */
  packageBaseName: string;
  localVersion: string | null;
  publishedVersion?: string | null;
  /** `pending-publish` means the local build has new exports AND the local
   *  version is ahead of the registry — the bump is in place, the cascade
   *  publish just has not landed. Smoke treats it as non-fatal. */
  status: "ok" | "drifted" | "pending-publish" | "skipped";
  /** Total exported names in the local build, summed over compared entries. */
  localCount?: number;
  /** Total exported names in the published build. */
  distCount?: number;
  /** `<subpath>:<name>` for each runtime name the local build adds. */
  added?: string[];
  entriesCompared?: number;
  /** Present when some entries could not be compared (missing local build,
   *  wildcard subpath, published file 404) — the rest still were. */
  partialReason?: string;
  /** Subpaths whose export set could not be enumerated (`export * from`), where
   *  the weaker line-count comparison was used instead. */
  opaqueEntries?: string[];
  /** Present when `status` is "skipped" — human-readable explanation. */
  reason?: string;
}

export interface CheckPackageDriftOptions {
  root?: string;
  /** Required at runtime — throws if omitted. Typed optional so tests can assert
   *  the throw without a `@ts-expect-error`. */
  name?: string;
  dir?: string;
  pkg?: Record<string, unknown>;
  installedRoot?: string;
  fetchPublishedVersion?: FetchPublishedVersion;
  fetchPublishedEntry?: FetchPublishedEntry;
}

export function checkPackageDrift(options: CheckPackageDriftOptions): Promise<PackageDriftResult>;

export interface CheckWorkspaceDriftOptions extends Omit<CheckPackageDriftOptions, "name" | "dir" | "pkg"> {
  /** Restricts the discovered set to these package names. */
  packageNames?: string[];
}

export function checkWorkspaceDrift(options?: CheckWorkspaceDriftOptions): Promise<PackageDriftResult[]>;

/**
 * One console line for a result. Exported so every status the audit can return
 * is checkable: `pending-publish` used to render as the clean `✓` line, which
 * stated the counts matched when they did not (#3099).
 */
export function formatLine(result: PackageDriftResult): string;

/** Statuses that fail the run. `pending-publish` joins the list only at release
 *  time: non-fatal on an ordinary PR, fatal when publishing, because the declared
 *  range's lower bound is then missing from the registry (#3099). */
export function failingStatuses(release: boolean): PackageDriftResult["status"][];

/** CLI entry point. Returns 0 on clean, 1 if any package blocks publishing.
 *  `release: true` (CLI: `--release`) also fails on `pending-publish`. */
export function main(options?: { release?: boolean }): Promise<number>;
