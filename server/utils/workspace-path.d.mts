// Type declarations for workspace-path.mjs. See the .mjs file for rationale
// on why the shared rule lives in plain JS.

export interface WorkspacePathSources {
  processEnv?: Record<string, string | undefined>;
  /** `.env` as the launcher's `parseEnvFile` parsed it — NOT raw file text. */
  envFileValues?: Record<string, string> | null;
}

export function resolveWorkspacePath(sources?: WorkspacePathSources): string;
