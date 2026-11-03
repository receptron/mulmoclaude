// Reads `SANDBOX_ENV_FILE` and logs the outcome of `planSandboxEnv` (#3617).
// The decision itself lives in `sandboxEnvPlan.ts`.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { log } from "../system/logger/index.js";
import { errorMessage } from "../utils/errors.js";
import { planSandboxEnv, type EnvFileInput, type SandboxEnvPlan } from "./sandboxEnvPlan.js";

// An env file is a handful of lines; anything this large is not one.
const ENV_FILE_MAX_BYTES = 64 * 1024;

function readBoundedText(filePath: string): string {
  const handle = openSync(filePath, "r");
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

export function readEnvFileInput(filePath: string | undefined): EnvFileInput | null {
  if (filePath === undefined || filePath === "") return null;
  // docker resolves a relative `--env-file` against its own cwd; resolving here
  // makes the file we validated the file docker reads.
  const absolutePath = path.resolve(filePath);
  try {
    return { path: absolutePath, text: readBoundedText(absolutePath) };
  } catch (err) {
    return { path: absolutePath, error: errorMessage(err) };
  }
}

function logSandboxEnvPlan(plan: SandboxEnvPlan, envFile: EnvFileInput | null): void {
  if (envFile !== null && "error" in envFile) {
    log.warn("sandbox", "SANDBOX_ENV_FILE could not be read; not passed to the container", { path: envFile.path, error: envFile.error });
  } else if (plan.envFileProblem !== null) {
    log.warn("sandbox", "SANDBOX_ENV_FILE not passed to the container", plan.envFileProblem);
  }
  if (plan.skipped.length > 0) log.warn("sandbox", "sandbox env entries ignored", { skipped: plan.skipped });
  if (plan.passedNames.length > 0) log.info("sandbox", "host env passed to container", { names: plan.passedNames });
}

export interface ResolveSandboxEnvParams {
  names: readonly string[];
  envFilePath: string | undefined;
  hostEnv: Readonly<Record<string, string | undefined>>;
  reservedNames: ReadonlySet<string>;
}

export function resolveSandboxEnv(params: ResolveSandboxEnvParams): SandboxEnvPlan {
  const envFile = readEnvFileInput(params.envFilePath);
  const plan = planSandboxEnv({ names: params.names, envFile, hostEnv: params.hostEnv, reservedNames: params.reservedNames });
  logSandboxEnvPlan(plan, envFile);
  return plan;
}
