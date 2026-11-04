// Reads `SANDBOX_ENV_FILE` and logs the outcome of `planSandboxEnv` (#3617). The
// decision itself lives in `sandboxEnvPlan.ts`.
//
// The accepted file lines reach docker through a pipe, never through a file:
// the caller writes `envFileText` to the child's fd 3 and docker reads it as
// `--env-file /dev/fd/3`. A copy on disk would need a place only this user can
// read on every platform, and a cleanup that survives a killed server.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { log } from "../system/logger/index.js";
import { errorMessage } from "../utils/errors.js";
import type { Platform } from "./config.js";
import { planSandboxEnv, type EnvFileInput, type SandboxEnvPlan } from "./sandboxEnvPlan.js";

// An env file is a handful of lines; anything this large is not one.
const ENV_FILE_MAX_BYTES = 64 * 1024;

/** The child's file descriptor that carries the env file. */
export const ENV_FILE_FD = 3;
const ENV_FILE_FD_PATH = `/dev/fd/${ENV_FILE_FD}`;

// `O_NONBLOCK` so a FIFO opens at once and is then refused by the `isFile`
// check, instead of blocking the spawn until a writer appears. Absent on
// Windows, where it falls out of the mask.
function readBoundedText(filePath: string): string {
  const handle = openSync(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > ENV_FILE_MAX_BYTES) throw new Error(`larger than ${ENV_FILE_MAX_BYTES} bytes`);
    const buffer = Buffer.alloc(stat.size);
    const bytes = readSync(handle, buffer, 0, stat.size, 0);
    return buffer.subarray(0, bytes).toString("utf-8");
  } finally {
    closeSync(handle);
  }
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

/** The file, unless it sits where the container can read it: the agent could
 *  then see every value — refused ones included — and rewrite the next turn's. */
export function readEnvFileInput(filePath: string | undefined, mountedHostPaths: readonly string[]): EnvFileInput | null {
  if (filePath === undefined || filePath === "") return null;
  const absolutePath = path.resolve(filePath);
  try {
    const realPath = canonicalPath(absolutePath);
    if (mountedHostPaths.some((mounted) => isInside(realPath, realpathOr(mounted)))) throw new Error("inside a directory mounted into the sandbox");
    return { path: absolutePath, text: readBoundedText(realPath) };
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
