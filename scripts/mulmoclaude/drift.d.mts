// Type declarations for drift.mjs. Sidecar keeps the script plain
// JS (no build step for the CI/script path) while tests + the
// future smoke driver still get a typed import surface.

/** One entry from a successful drift scan. `status` encodes the verdict. */
export interface PackageDriftResult {
  packageBaseName: string;
  localVersion: string | null;
  /** The version the `latest` dist-tag resolved to on the registry. Null when
   * the fetch failed and we fell back to the local installed dist. */
  publishedVersion?: string | null;
  /** `pending-publish` means the src has new exports AND the local
   *  package.json version is ahead of the registry — i.e. the bump
   *  is already in place, the cascade publish just hasn't landed
   *  yet. Smoke treats this as non-fatal. */
  status: "ok" | "drifted" | "pending-publish" | "skipped";
  /** Present when `status` is "ok", "drifted", or "pending-publish". */
  localCount?: number;
  /** Present when `status` is "ok", "drifted", or "pending-publish". */
  distCount?: number;
  /** Present when `status` is "skipped" — human-readable explanation. */
  reason?: string;
  /** Present when the registry was unreachable and we compared against
   * the local installed dist instead. */
  fallbackReason?: string;
}

/** Outcome of the registry fetch — raw source plus the resolved version. */
export interface PublishedSource {
  version: string | null;
  source: string | null;
  reason: string | null;
}

/** Injectable fetcher — tests supply a stub, real runs use the registry. */
export type FetchPublishedSource = (args: { packageBaseName: string; timeoutMs?: number }) => Promise<PublishedSource>;

export function countValueExportLines(source: string): number;

/**
 * Returns true when `local` (a semver-ish string) is strictly
 * greater than `published`. Ignores prerelease / build suffixes.
 * Returns false for any malformed / missing input.
 */
export function isLocalVersionAhead(local: string | null | undefined, published: string | null | undefined): boolean;

export interface CheckPackageDriftOptions {
  root?: string;
  /** Required at runtime — throws if omitted. Typed as optional so
   * tests can assert the throw without a `@ts-expect-error`. */
  packageBaseName?: string;
  srcRelative?: string;
  distRelative?: string;
  /** Override the `node_modules` path (used by fixtures that
   * can't ship a real node_modules/ — globally gitignored). */
  installedRoot?: string;
  /** Injectable published-source fetcher. Defaults to the real
   * registry+unpkg implementation; tests pass a stub. */
  fetchPublishedSource?: FetchPublishedSource;
}

export function checkPackageDrift(options: CheckPackageDriftOptions): Promise<PackageDriftResult>;

export interface DetectOptions {
  root?: string;
}

export function detectMulmobridgeDeps(options?: DetectOptions): Promise<string[]>;

export interface CheckWorkspaceDriftOptions {
  root?: string;
  /** Overrides auto-detection when provided. */
  packageBaseNames?: string[];
  /** Override the `node_modules` path — passed through to every
   * per-package check. */
  installedRoot?: string;
  srcRelative?: string;
  distRelative?: string;
  fetchPublishedSource?: FetchPublishedSource;
}

export function checkWorkspaceDrift(options?: CheckWorkspaceDriftOptions): Promise<PackageDriftResult[]>;

/**
 * One console line for a result. Exported so every status the audit can return
 * is checkable: `pending-publish` used to render as the clean `✓` line, which
 * stated the counts matched when they did not (#3099).
 */
export function formatLine(result: PackageDriftResult): string;

/** CLI entry point. Returns 0 on clean, 1 if any package drifted. */
export function main(): Promise<number>;
