// Reads `SANDBOX_ENV_FILE` and logs the outcome of `planSandboxEnv` (#3617). The
// decision itself lives in `sandboxEnvPlan.ts`.
//
// The accepted file lines reach docker through a pipe, never through a file:
// the caller writes `envFileText` to the child's fd 3 and docker reads it as
// `--env-file /dev/fd/3`. A copy on disk would need a place only this user can
// read on every platform, and a cleanup that survives a killed server.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { log } from "../system/logger/index.js";
import { errorMessage } from "../utils/errors.js";
import type { Platform } from "./config.js";
import { pathAncestors, planSandboxEnv, type EnvFileInput, type SandboxEnvPlan } from "./sandboxEnvPlan.js";

// An env file is a handful of lines; anything this large is not one.
const ENV_FILE_MAX_BYTES = 64 * 1024;

/** The child's file descriptor that carries the env file. */
export const ENV_FILE_FD = 3;
const ENV_FILE_FD_PATH = `/dev/fd/${ENV_FILE_FD}`;

// Docker refuses the whole env file on invalid UTF-8, where `toString` would
// quietly substitute U+FFFD and hand docker a file that fails the run.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

function readBoundedText(handle: number, size: number): string {
  const buffer = Buffer.alloc(size);
  const bytes = readSync(handle, buffer, 0, size, 0);
  return STRICT_UTF8.decode(buffer.subarray(0, bytes));
}

// `.native`: the JS `realpathSync` keeps the caller's letter case, so on a
// case-insensitive volume `/Users/ME/ws` and `/Users/me/ws` would compare as two
// places. The native call returns the on-disk spelling; folding case ourselves
// would be wrong on a case-sensitive volume.
const canonicalPath = (target: string): string => realpathSync.native(target);

const realpathOr = (target: string): string => {
  try {
    return canonicalPath(target);
  } catch {
    return path.resolve(target);
  }
};

// `..` as a whole segment, not as a prefix: `..secrets.env` is a file INSIDE.
const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// Every step of the path, as written and as resolved, must lie outside every
// mount: a symlink inside one is the agent's to retarget — at the user's own
// file, or at any host file whose lines would then reach the container.
function reachableFromSandbox(paths: readonly string[], mountedHostPaths: readonly string[]): boolean {
  const roots = mountedHostPaths.flatMap((mounted) => [path.resolve(mounted), realpathOr(mounted)]);
  const steps = paths.flatMap((target) => pathAncestors(target, path.sep)).flatMap((step) => [step, realpathOr(step)]);
  return steps.some((step) => roots.some((root) => isInside(step, root)));
}

type StatAtPath = (target: string) => Stats;

// The opened object must be the one now at the resolved path, so a swap between
// the checks and the read cannot change what is passed. A second hard link may
// sit inside a mount, where no path check can see it, so the file must have one.
function checkOpenedFile(opened: Stats, absolutePath: string, mountedHostPaths: readonly string[], statAtPath: StatAtPath): void {
  if (!opened.isFile()) throw new Error("not a regular file");
  if (opened.size > ENV_FILE_MAX_BYTES) throw new Error(`larger than ${ENV_FILE_MAX_BYTES} bytes`);
  if (opened.nlink > 1) throw new Error("has more than one hard link");
  const realPath = canonicalPath(absolutePath);
  const atRealPath = statAtPath(realPath);
  if (atRealPath.dev !== opened.dev || atRealPath.ino !== opened.ino) throw new Error("changed while being read");
  if (reachableFromSandbox([absolutePath, realPath], mountedHostPaths)) throw new Error("inside a directory mounted into the sandbox");
}

// The descriptor opened first is the only one read. `O_NONBLOCK` so a FIFO opens
// at once and is then refused by `isFile` instead of blocking the spawn; absent
// on Windows, it falls out of the mask.
function readCheckedFile(absolutePath: string, mountedHostPaths: readonly string[], statAtPath: StatAtPath): string {
  const handle = openSync(absolutePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(handle);
    checkOpenedFile(opened, absolutePath, mountedHostPaths, statAtPath);
    return readBoundedText(handle, opened.size);
  } finally {
    closeSync(handle);
  }
}

/** The file, unless the container can reach it: the agent could then see every
 *  value — refused ones included — and rewrite the next turn's. `statAtPath` is a
 *  test seam for a file swapped between the open and the check. */
export function readEnvFileInput(
  filePath: string | undefined,
  mountedHostPaths: readonly string[],
  statAtPath: StatAtPath = (target) => statSync(target),
): EnvFileInput | null {
  if (filePath === undefined || filePath === "") return null;
  const absolutePath = path.resolve(filePath);
  try {
    return { path: absolutePath, text: readCheckedFile(absolutePath, mountedHostPaths, statAtPath) };
  } catch (err) {
    return { path: absolutePath, error: errorMessage(err) };
  }
}

function logSandboxEnvPlan(plan: SandboxEnvPlan, envFile: EnvFileInput | null): void {
  if (envFile !== null && "error" in envFile) {
    log.warn("sandbox", "SANDBOX_ENV_FILE not passed to the container", { path: envFile.path, error: envFile.error });
  }
  if (plan.skipped.length > 0) log.warn("sandbox", "sandbox env entries ignored", { skipped: plan.skipped });
}

export interface ResolveSandboxEnvParams {
  names: readonly string[];
  envFilePath: string | undefined;
  hostEnv: Readonly<Record<string, string | undefined>>;
  reservedNames: ReadonlySet<string>;
  mountedHostPaths: readonly string[];
  /** Test seam; production gets the host platform. */
  platform?: Platform | undefined;
}

export interface ResolvedSandboxEnv {
  /** `--env-file /dev/fd/3` (when there is file text) then `-e NAME` pairs, for just before the image. */
  args: string[];
  /** What the caller MUST write to the child's `ENV_FILE_FD`, or null for no extra fd. */
  envFileText: string | null;
}

// Windows has no `/dev/fd`; until it has a pipe of its own, the file is not
// passed there rather than written to disk.
function envFileForPlatform(envFilePath: string | undefined, platform: Platform): string | undefined {
  if (envFilePath === undefined || envFilePath === "" || platform !== "win32") return envFilePath;
  log.warn("sandbox", "SANDBOX_ENV_FILE is not supported on Windows hosts; use SANDBOX_ENV to pass variables by name");
  return undefined;
}

export function resolveSandboxEnv(params: ResolveSandboxEnvParams): ResolvedSandboxEnv {
  const envFile = readEnvFileInput(envFileForPlatform(params.envFilePath, params.platform ?? process.platform), params.mountedHostPaths);
  const plan = planSandboxEnv({ names: params.names, envFile, hostEnv: params.hostEnv, reservedNames: params.reservedNames });
  logSandboxEnvPlan(plan, envFile);
  const passedNames = [...new Set([...plan.fileNames, ...plan.namedNames])];
  if (passedNames.length > 0) log.info("sandbox", "host env passed to container", { names: passedNames });
  const fileArgs = plan.envFileText === null ? [] : ["--env-file", ENV_FILE_FD_PATH];
  return { args: [...fileArgs, ...plan.nameArgs], envFileText: plan.envFileText };
}
