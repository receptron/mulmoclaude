// Where a workspace's wiki sits on disk right now, as realpaths that stay inside the workspace. A folder or file that
// leads out of the workspace — a link, there from the start or swapped in — counts as absent, so the read engine
// never lists or reads anything outside it.

import { realpathSync } from "node:fs";
import path from "node:path";
import { resolveWithinRoot } from "../../files/safe.js";
import { wikiDirs } from "./paths.js";

export interface WikiReadLocations {
  /** `<workspace>/data/wiki/pages` as the caller spelled it: resolved page paths handed back are joined onto this. */
  pagesDir: string;
  pagesReal: string | null;
  indexReal: string | null;
  logReal: string | null;
}

export function wikiReadLocations(workspace: string): WikiReadLocations {
  const dirs = wikiDirs(workspace);
  const workspaceReal = realpathOrNull(workspace);
  const insideWorkspace = (absPath: string): string | null =>
    workspaceReal === null ? null : resolveWithinRoot(workspaceReal, path.relative(workspace, absPath));
  return {
    pagesDir: dirs.pagesDir,
    pagesReal: insideWorkspace(dirs.pagesDir),
    indexReal: insideWorkspace(dirs.indexFile),
    logReal: insideWorkspace(dirs.logFile),
  };
}

function realpathOrNull(absPath: string): string | null {
  try {
    return realpathSync(absPath);
  } catch {
    return null;
  }
}
