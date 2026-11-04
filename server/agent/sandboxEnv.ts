// Reads `SANDBOX_ENV_FILE`, stages what `planSandboxEnv` accepted, and logs the
// outcome (#3617). The decision itself lives in `sandboxEnvPlan.ts`.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { log } from "../system/logger/index.js";
import { errorMessage } from "../utils/errors.js";
import { writeFileAtomicSync } from "../utils/files/atomic.js";
import { isPrivateStagingRoot, planSandboxEnv, stagingDirPrefix, staleStagingDirs, type EnvFileInput, type SandboxEnvPlan } from "./sandboxEnvPlan.js";

// An env file is a handful of lines; anything this large is not one.
const ENV_FILE_MAX_BYTES = 64 * 1024;
const STAGED_ENV_FILE = "sandbox.env";
export const SANDBOX_ENV_STAGING_ROOT = "mulmoclaude-sandbox-env";

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

const realpathOr = (target: string): string => {
  try {
    return realpathSync(target);
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
    const realPath = realpathSync(absolutePath);
    if (mountedHostPaths.some((mounted) => isInside(realPath, realpathOr(mounted)))) throw new Error("inside a directory mounted into the sandbox");
    return { path: absolutePath, text: readBoundedText(realPath) };
  } catch (err) {
    return { path: absolutePath, error: errorMessage(err) };
  }
}

export function removeSandboxEnvStaging(stagingDir: string): void {
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch (error) {
    log.warn("sandbox", "could not remove sandbox env staging dir", { path: stagingDir, error: errorMessage(error) });
  }
}

const isErrorCode = (error: unknown, code: string): boolean => error instanceof Error && "code" in error && error.code === code;

// `kill(pid, 0)` delivers nothing; it only asks whether the process exists. EPERM
// means it does, under another user.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

/** Where staged copies live, or null when it is not ours alone — then nothing is
 *  staged, since a root someone else controls could read or swap the copy. */
export function sandboxEnvStagingRoot(): string | null {
  const root = path.join(tmpdir(), SANDBOX_ENV_STAGING_ROOT);
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) return null;
  }
  const stat = lstatSync(root);
  const owned = isPrivateStagingRoot(
    { isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink(), uid: stat.uid, mode: stat.mode },
    process.getuid?.(),
  );
  return owned ? root : null;
}

// A server killed while its container ran never saw `close`, so its copy is
// still on disk; the next run that stages one removes it. Only our private root
// is swept, never the shared temp directory.
function removeStaleStaging(root: string): void {
  try {
    staleStagingDirs(readdirSync(root), isProcessAlive).forEach((entry) => removeSandboxEnvStaging(path.join(root, entry)));
  } catch (error) {
    log.warn("sandbox", "could not sweep stale sandbox env staging", { error: errorMessage(error) });
  }
}

function stagingRootOrWarn(): string | null {
  try {
    const root = sandboxEnvStagingRoot();
    if (root === null)
      log.warn("sandbox", "sandbox env staging root is not private to this user; SANDBOX_ENV_FILE not passed", {
        root: path.join(tmpdir(), SANDBOX_ENV_STAGING_ROOT),
      });
    return root;
  } catch (error) {
    log.warn("sandbox", "could not prepare sandbox env staging root; SANDBOX_ENV_FILE not passed", { error: errorMessage(error) });
    return null;
  }
}

// `mkdtemp` creates the directory owner-only, so the staged values are no more
// readable than the user's own file; it lives for one spawn. Never throws: a
// sandbox that starts without the file beats one that does not start.
function stageEnvFile(text: string): string | null {
  const root = stagingRootOrWarn();
  if (root === null) return null;
  removeStaleStaging(root);
  const created: string[] = [];
  try {
    const stagingDir = mkdtempSync(path.join(root, stagingDirPrefix(process.pid)));
    created.push(stagingDir);
    writeFileAtomicSync(path.join(stagingDir, STAGED_ENV_FILE), text);
    return stagingDir;
  } catch (error) {
    log.warn("sandbox", "could not stage SANDBOX_ENV_FILE; not passed to the container", { error: errorMessage(error) });
    created.forEach(removeSandboxEnvStaging);
    return null;
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
}

export interface ResolvedSandboxEnv {
  /** `--env-file` (when staged) then `-e NAME` pairs, for just before the image. */
  args: string[];
  /** The caller MUST remove this with `removeSandboxEnvStaging` once docker exits. */
  stagingDir: string | null;
}

export function resolveSandboxEnv(params: ResolveSandboxEnvParams): ResolvedSandboxEnv {
  const envFile = readEnvFileInput(params.envFilePath, params.mountedHostPaths);
  const plan = planSandboxEnv({ names: params.names, envFile, hostEnv: params.hostEnv, reservedNames: params.reservedNames });
  logSandboxEnvPlan(plan, envFile);
  const stagingDir = plan.stagedEnvFileText === null ? null : stageEnvFile(plan.stagedEnvFileText);
  const fileArgs = stagingDir === null ? [] : ["--env-file", path.join(stagingDir, STAGED_ENV_FILE)];
  const passedNames = [...new Set([...(stagingDir === null ? [] : plan.fileNames), ...plan.namedNames])];
  if (passedNames.length > 0) log.info("sandbox", "host env passed to container", { names: passedNames });
  return { args: [...fileArgs, ...plan.nameArgs], stagingDir };
}
