// Type declarations for publishedDeps.mjs. Sidecar keeps the script plain JS
// (no build step on the CI/script path) while tests get a typed surface.

/** One internal dependency as the launcher declares it. */
export interface DeclaredDep {
  name: string;
  range: string;
  field: "dependencies" | "optionalDependencies" | "peerDependencies";
}

/**
 * The verdict for one internal dep.
 *
 * `unpublished` is what this check exists for: the workspace holds a version the registry
 * has never seen, so the launcher's `^<that version>` has no lower bound to resolve to.
 * `unknown` means the registry could not be asked and is deliberately non-blocking.
 */
export interface PublishedDepResult extends DeclaredDep {
  workspaceVersion: string | null;
  status: "published" | "unpublished" | "not-on-npm" | "not-a-workspace" | "behind" | "unknown";
  /** The registry's `latest` dist-tag. Present once the registry answered. */
  newestPublished?: string | null;
  reason?: string;
}

export interface PublishedVersions {
  /** Null when the registry could not be asked; empty when the package is not on npm. */
  versions: string[] | null;
  /** The `latest` dist-tag — the registry's own answer for "newest", which the key order
   *  of `versions` is not. */
  latest?: string | null;
  reason: string | null;
}

/** Injectable registry reader — tests supply a stub, real runs hit registry.npmjs.org. */
export type FetchPublishedVersions = (args: { name: string; timeoutMs?: number }) => Promise<PublishedVersions>;

export interface CheckOptions {
  root?: string;
  fetchPublishedVersions?: FetchPublishedVersions;
  /** Workspace manifest paths relative to `root`. Defaults to a RECURSIVE walk of
   *  `packages/` (skipping `node_modules`), which deliberately excludes the test fixtures a
   *  `git ls-files` would match. */
  manifestPaths?: string[];
}

export function declaredInternalDeps(options?: { root?: string }): Promise<DeclaredDep[]>;
export function workspaceVersions(options?: { root?: string; manifestPaths?: string[] }): Promise<Map<string, string>>;
export function checkPublishedDeps(options?: CheckOptions): Promise<PublishedDepResult[]>;

/** Statuses that can stop a launcher publish. Consult `isBlocking` rather than this set
 *  directly — the field matters too. */
export const BLOCKING: PublishedDepResult["status"][];

/** Whether one verdict stops a publish. A blocking status in `optionalDependencies` does
 *  not: npm skips an optional dep it cannot resolve instead of failing the install, so it
 *  cannot produce the ETARGET this gate prevents. */
export function isBlocking(result: PublishedDepResult): boolean;

/** The real registry reader. `fetchImpl` is injectable so the URL it builds and the
 *  statuses it maps are testable — every other test stubs this function out entirely. */
export function defaultFetchPublishedVersions(args: { name: string; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<PublishedVersions>;

/** CLI entry point. Returns 0 when every dep resolves, 1 otherwise. */
export function main(): Promise<number>;
