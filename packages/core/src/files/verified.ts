// Containment that survives a path swapped between the check and the use (#3573). Node fs has no
// openat, so a read opens first and then proves the handle is the in-root file, and a write
// verifies its staging file before renaming within that same directory. See
// plans/fix-3573-verified-open.md for what is closed and what stays best-effort.

import { constants, promises, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { renameWithWindowsRetry } from "./atomic.js";
import { isEnoent } from "./safe.js";

// O_NOFOLLOW / O_NONBLOCK are undefined on Windows; a FIFO planted in the workspace must not block the read.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const STAGING_SUFFIX_BYTES = 6;

/** Test seams at the points where a real race would swap a path. */
export interface VerifiedFileHooks {
  beforeOpen?: () => Promise<void>;
  afterOpen?: () => Promise<void>;
  beforeRename?: () => Promise<void>;
}

/** Only a missing path reads as null; EACCES, ELOOP, ENOTDIR … propagate. */
export async function realpathIfPresent(absPath: string): Promise<string | null> {
  try {
    return await promises.realpath(absPath);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

const isWithin = (rootReal: string, candidateReal: string): boolean => candidateReal === rootReal || candidateReal.startsWith(rootReal + path.sep);

/** Real location of `relative` (host-native) if it exists inside `rootReal`; null when missing or outside. `rootReal` MUST be a realpath. */
export async function resolveExistingWithinRoot(rootReal: string, relative: string): Promise<string | null> {
  const candidateReal = await realpathIfPresent(path.resolve(rootReal, relative));
  return candidateReal !== null && isWithin(rootReal, candidateReal) ? candidateReal : null;
}

const sameFile = (onDisk: BigIntStats, opened: BigIntStats): boolean => onDisk.dev === opened.dev && onDisk.ino === opened.ino;

async function lstatIfPresent(absPath: string): Promise<BigIntStats | null> {
  try {
    return await promises.lstat(absPath, { bigint: true });
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function openIfPresent(absPath: string, flags: number): Promise<FileHandle | null> {
  try {
    return await promises.open(absPath, flags);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** A scope folder under a trusted anchor. `trustedReal` MUST be a realpath that the party being defended
 *  against cannot replace (the workspace: in Docker it is the mount root). The scope is re-resolved under
 *  it at every check, so a scope replaced by a link out is refused; a real directory moved into the
 *  scope's place from inside the anchor is simply the scope from then on. */
export interface VerifiedScope {
  trustedReal: string;
  scopeWithinTrusted: string;
}

/** The scope's realpath if it exists inside the anchor now; null when absent or led outside. */
export const scopeRealpath = async (scope: VerifiedScope): Promise<string | null> => resolveExistingWithinRoot(scope.trustedReal, scope.scopeWithinTrusted);

interface BoundScope {
  scope: VerifiedScope;
  anchorIdentity: BigIntStats;
}

async function bindScope(scope: VerifiedScope): Promise<BoundScope | null> {
  const anchorIdentity = await lstatIfPresent(scope.trustedReal);
  return anchorIdentity === null ? null : { scope, anchorIdentity };
}

/** The scope's realpath at this moment, provided the anchor is still the directory bound at the start. */
async function scopeRealNow(bound: BoundScope): Promise<string | null> {
  const anchorNow = await lstatIfPresent(bound.scope.trustedReal);
  return anchorNow !== null && sameFile(anchorNow, bound.anchorIdentity) ? scopeRealpath(bound.scope) : null;
}

async function isInScopeFile(bound: BoundScope, candidateReal: string, handle: FileHandle): Promise<boolean> {
  const scopeReal = await scopeRealNow(bound);
  const again = scopeReal === null ? null : await resolveExistingWithinRoot(scopeReal, candidateReal);
  if (again === null) return false;
  const onDisk = await lstatIfPresent(again);
  return onDisk !== null && sameFile(onDisk, await handle.stat({ bigint: true }));
}

/** Opens `relative` under the scope for reading and proves, after opening, that the handle is the file
 *  the scope holds now. Null when missing, outside, or swapped during the call. The caller owns the handle. */
export async function openVerifiedWithinScope(scope: VerifiedScope, relative: string, hooks: VerifiedFileHooks = {}): Promise<FileHandle | null> {
  const bound = await bindScope(scope);
  const scopeReal = bound === null ? null : await scopeRealNow(bound);
  const candidateReal = scopeReal === null ? null : await resolveExistingWithinRoot(scopeReal, relative);
  if (bound === null || candidateReal === null) return null;
  await hooks.beforeOpen?.();
  const handle = await openIfPresent(candidateReal, READ_FLAGS);
  if (handle === null) return null;
  try {
    await hooks.afterOpen?.();
    if (await isInScopeFile(bound, candidateReal, handle)) return handle;
  } catch (err) {
    await handle.close();
    throw err;
  }
  await handle.close();
  return null;
}

/** The directory of a file this call created, re-resolved, if it is inside the scope now and holds exactly the opened file. */
async function verifiedCreatedFileDir(bound: BoundScope, dirReal: string, staging: string, handle: FileHandle): Promise<string | null> {
  const scopeReal = await scopeRealNow(bound);
  const dirAgain = scopeReal === null ? null : await resolveExistingWithinRoot(scopeReal, dirReal);
  if (dirAgain === null) return null;
  const entry = await lstatIfPresent(path.join(dirAgain, staging));
  return entry !== null && sameFile(entry, await handle.stat({ bigint: true })) ? dirAgain : null;
}

async function writeStaging(bound: BoundScope, dirReal: string, staging: string, content: string | Uint8Array, hooks: VerifiedFileHooks): Promise<string> {
  await hooks.beforeOpen?.();
  const handle = await promises.open(path.join(dirReal, staging), CREATE_FLAGS);
  try {
    await hooks.afterOpen?.();
    const stagingDir = await verifiedCreatedFileDir(bound, dirReal, staging, handle);
    if (stagingDir === null) throw new Error(`refusing to write: ${dirReal} left the scope during the write`);
    await handle.writeFile(content);
    return stagingDir;
  } finally {
    await handle.close();
  }
}

// `leaf` is joined to a verified directory, so a separator or `..` in it would step out of what was verified.
const assertSingleName = (leaf: string): void => {
  if (leaf === "" || leaf === "." || leaf === ".." || path.basename(leaf) !== leaf || leaf.includes("/")) {
    throw new Error(`refusing to write: ${JSON.stringify(leaf)} is not a single file name`);
  }
};

const stagingNameFor = (leaf: string): string => `${leaf}.${randomBytes(STAGING_SUFFIX_BYTES).toString("hex")}.tmp`;

const removeQuietly = async (absPath: string): Promise<void> => {
  await promises.unlink(absPath).catch(() => {});
};

// The rename's source is the verified staging file under its random name, so it succeeds only where that
// name reaches it: the verified directory (wherever moved since), or a directory the actor could already
// write and planted the name in. No renameat in Node fs; see plans/fix-3573-verified-open.md.
async function renameIntoPlace(stagingDir: string, staging: string, leaf: string, hooks: VerifiedFileHooks): Promise<void> {
  try {
    await hooks.beforeRename?.();
    await renameWithWindowsRetry(path.join(stagingDir, staging), path.join(stagingDir, leaf));
  } catch (err) {
    await removeQuietly(path.join(stagingDir, staging));
    throw err;
  }
}

/** Atomic write of `leaf` into `dirReal` (an already-confined directory of the scope). The staging file is
 *  verified to sit inside the scope before any byte is written, and a parent swapped for a link mid-call
 *  makes the write fail — unless the link's target is a directory the actor could already write. */
export async function writeFileVerifiedInScope(
  scope: VerifiedScope,
  dirReal: string,
  leaf: string,
  content: string | Uint8Array,
  hooks: VerifiedFileHooks = {},
): Promise<void> {
  assertSingleName(leaf);
  const bound = await bindScope(scope);
  if (bound === null) throw new Error(`refusing to write: the trusted root ${scope.trustedReal} is gone`);
  const staging = stagingNameFor(leaf);
  const stagingDir = await writeStaging(bound, dirReal, staging, content, hooks).catch(async (err: unknown) => {
    await removeQuietly(path.join(dirReal, staging));
    throw err;
  });
  await renameIntoPlace(stagingDir, staging, leaf, hooks);
}

/** Exclusive create of `leaf` in `dirReal` (an already-confined directory of the scope): throws EEXIST when `leaf`
 *  exists, as `writeFile(…, { flag: "wx" })` does. The new file is verified to sit inside the scope before any byte is
 *  written, and the bytes go through its handle. A parent swapped for a link before the create leaves an empty file
 *  in the link's target and makes the call fail; it is not removed, because by then the name may be someone else's. */
export async function createFileVerifiedInScope(
  scope: VerifiedScope,
  dirReal: string,
  leaf: string,
  content: string | Uint8Array,
  hooks: VerifiedFileHooks = {},
): Promise<void> {
  assertSingleName(leaf);
  const bound = await bindScope(scope);
  if (bound === null) throw new Error(`refusing to write: the trusted root ${scope.trustedReal} is gone`);
  await hooks.beforeOpen?.();
  const handle = await promises.open(path.join(dirReal, leaf), CREATE_FLAGS);
  try {
    await hooks.afterOpen?.();
    if ((await verifiedCreatedFileDir(bound, dirReal, leaf, handle)) === null) throw new Error(`refusing to write: ${dirReal} left the scope during the write`);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}
