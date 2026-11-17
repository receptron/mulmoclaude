// Reads of workspace files whose contents reach the agent (the system prompt, memory): only a regular file inside the
// workspace is read, so a file or folder linked to somewhere else on the host hands nothing over, sandboxed or not.

import { isInsideRoot, readTextWithinRoot, readTextWithinRootSync, realpathSyncOrNull } from "@mulmoclaude/core/files";

export interface WorkspaceLocation {
  workspaceReal: string;
  fileReal: string;
}

/** Both realpaths when `absPath` leads to something inside the workspace, else null. Resolved first, so a file linked
 *  to another file inside the workspace is read at its target. */
export function locateWithinWorkspace(workspacePath: string, absPath: string): WorkspaceLocation | null {
  const workspaceReal = realpathSyncOrNull(workspacePath);
  const fileReal = workspaceReal === null ? null : realpathSyncOrNull(absPath);
  return workspaceReal !== null && fileReal !== null && isInsideRoot(workspaceReal, fileReal) ? { workspaceReal, fileReal } : null;
}

/** Text of a regular file inside the workspace, or null when it is missing, leads outside, is a FIFO or other
 *  non-file, or is unreadable. */
export async function readTextWithinWorkspace(workspacePath: string, absPath: string): Promise<string | null> {
  const located = locateWithinWorkspace(workspacePath, absPath);
  return located === null ? null : readTextWithinRoot(located.workspaceReal, located.fileReal);
}

/** Sync twin of `readTextWithinWorkspace`, for prompt assembly. */
export function readTextWithinWorkspaceSync(workspacePath: string, absPath: string): string | null {
  const located = locateWithinWorkspace(workspacePath, absPath);
  return located === null ? null : readTextWithinRootSync(located.workspaceReal, located.fileReal);
}
