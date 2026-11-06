// What a client token's scopes let it reach (#3636). `full` is stage 1's reach;
// otherwise `read` limits the methods and `collection:<slug>` limits the paths
// to those collections. Pure. Every doubtful request is refused, never guessed.

import { isSafeSlug } from "@mulmoclaude/core/collection";
import { isReadMethod, type ApiRequestLine } from "./bearerExemption.js";

export const FULL_SCOPE = "full";
export const READ_SCOPE = "read";
const COLLECTION_SCOPE_PREFIX = "collection:";
const COLLECTIONS_SEGMENT = "collections";
// A static route under `/collections`, matched before `:slug`, that spans every collection.
const ONTOLOGY_SEGMENT = "ontology";

export type ClientTokenScope = typeof FULL_SCOPE | typeof READ_SCOPE | `${typeof COLLECTION_SCOPE_PREFIX}${string}`;

const isCollectionScope = (value: string): value is `${typeof COLLECTION_SCOPE_PREFIX}${string}` =>
  value.startsWith(COLLECTION_SCOPE_PREFIX) && isSafeSlug(value.slice(COLLECTION_SCOPE_PREFIX.length));

export const isClientTokenScope = (value: unknown): value is ClientTokenScope =>
  typeof value === "string" && (value === FULL_SCOPE || value === READ_SCOPE || isCollectionScope(value));

/** At least one scope, and `full` only on its own. */
export const isValidScopeSet = (scopes: readonly ClientTokenScope[]): boolean => scopes.length > 0 && (!scopes.includes(FULL_SCOPE) || scopes.length === 1);

export const hasFullScope = (scopes: readonly ClientTokenScope[]): boolean => scopes.includes(FULL_SCOPE);

function scopedCollections(scopes: readonly ClientTokenScope[]): string[] {
  return scopes.filter(isCollectionScope).map((scope) => scope.slice(COLLECTION_SCOPE_PREFIX.length));
}

/** Whether a collection may be shown to this token, e.g. in the collection list. */
export function isCollectionInScope(scopes: readonly ClientTokenScope[], slug: string): boolean {
  const collections = scopedCollections(scopes);
  return collections.length === 0 || collections.includes(slug);
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

// The path's segments, decoded one by one so an encoded `/` stays inside its
// segment; null for an undecodable or dot segment.
function pathSegments(rawPath: string): string[] | null {
  const decoded = rawPath.split("/").slice(1).map(decodeSegment);
  if (decoded.some((segment) => segment === null || segment === "." || segment === "..")) return null;
  const segments = decoded.filter((segment): segment is string => segment !== null);
  return segments.length > 1 && segments.at(-1) === "" ? segments.slice(0, -1) : segments;
}

// Express matches the static part case-insensitively; the slug it hands the
// handler keeps its case, so the slug is compared exactly.
function isCollectionPathInScope({ method, path }: ApiRequestLine, collections: readonly string[]): boolean {
  const segments = pathSegments(path);
  if (segments === null || segments[0]?.toLowerCase() !== COLLECTIONS_SEGMENT) return false;
  const [, slug] = segments;
  if (slug === undefined) return isReadMethod(method);
  if (slug.toLowerCase() === ONTOLOGY_SEGMENT) return false;
  return collections.includes(slug);
}

/** Whether a client token's scopes cover this `/api` request (relative to the mount). */
export function isWithinClientTokenScopes(scopes: readonly ClientTokenScope[], request: ApiRequestLine): boolean {
  if (!isValidScopeSet(scopes)) return false;
  if (hasFullScope(scopes)) return true;
  if (scopes.includes(READ_SCOPE) && !isReadMethod(request.method)) return false;
  const collections = scopedCollections(scopes);
  return collections.length === 0 || isCollectionPathInScope(request, collections);
}
