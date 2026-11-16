// Where a workspace's wiki sits on disk right now, as realpaths that stay inside the workspace. A folder or file that
// leads out of the workspace — a link, there from the start or swapped in — counts as absent, so the read engine
// never lists or reads anything outside it.

import { realpathSync } from "node:fs";
import path from "node:path";
import { wikiDirs } from "./paths.js";

export interface WikiReadLocations {
  /** `<workspace>/data/wiki/pages` as the caller spelled it: resolved page paths handed back are joined onto this. */
  pagesDir: string;
  pagesReal: string | null;
  indexReal: string | null;
  logReal: string | null;
}

const isWithin = (rootReal: string, candidateReal: string): boolean => candidateReal === rootReal || candidateReal.startsWith(rootReal + path.sep);

export function wikiReadLocations(workspace: string): WikiReadLocations {
  const dirs = wikiDirs(workspace);
  const workspaceReal = realpathOrNull(workspace);
  const insideWorkspace = (absPath: string): string | null => {
    const candidateReal = workspaceReal === null ? null : realpathOrNull(path.resolve(workspaceReal, path.relative(workspace, absPath)));
    return workspaceReal !== null && candidateReal !== null && isWithin(workspaceReal, candidateReal) ? candidateReal : null;
  };
  return {
    pagesDir: dirs.pagesDir,
    pagesReal: insideWorkspace(dirs.pagesDir),
    indexReal: insideWorkspace(dirs.indexFile),
    logReal: insideWorkspace(dirs.logFile),
  };
}

// The native realpath, because the JS one keeps the letter case a link was written with: on a case-insensitive disk a
// link inside the workspace spelled `repo/…` under a workspace spelled `Repo` would otherwise look like it leads out.
function realpathOrNull(absPath: string): string | null {
  try {
    return realpathSync.native(absPath);
  } catch {
    return null;
  }
}
