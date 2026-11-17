// A wiki folder or file that leads out of the workspace counts as absent, so nothing outside is listed or read.

import path from "node:path";
import { isWithinRoot, realpathSyncOrNull } from "../../files/containment.js";
import { wikiDirs } from "./paths.js";

export interface WikiReadLocations {
  /** `<workspace>/data/wiki/pages` as the caller spelled it: resolved page paths handed back are joined onto this. */
  pagesDir: string;
  /** The workspace's realpath: every read re-checks against it after opening. */
  workspaceReal: string | null;
  pagesReal: string | null;
  indexReal: string | null;
  logReal: string | null;
}

export function wikiReadLocations(workspace: string): WikiReadLocations {
  const dirs = wikiDirs(workspace);
  const workspaceReal = realpathSyncOrNull(workspace);
  const insideWorkspace = (absPath: string): string | null => {
    const candidateReal = workspaceReal === null ? null : realpathSyncOrNull(path.resolve(workspaceReal, path.relative(workspace, absPath)));
    return workspaceReal !== null && candidateReal !== null && isWithinRoot(workspaceReal, candidateReal) ? candidateReal : null;
  };
  return {
    pagesDir: dirs.pagesDir,
    workspaceReal,
    pagesReal: insideWorkspace(dirs.pagesDir),
    indexReal: insideWorkspace(dirs.indexFile),
    logReal: insideWorkspace(dirs.logFile),
  };
}
