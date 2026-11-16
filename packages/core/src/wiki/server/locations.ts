// A wiki folder or file that leads out of the workspace counts as absent, so nothing outside is listed or read.

import { realpathSync } from "node:fs";
import path from "node:path";
import { isEnoent } from "../../files/safe.js";
import { wikiDirs } from "./paths.js";

export interface WikiReadLocations {
  /** `<workspace>/data/wiki/pages` as the caller spelled it: resolved page paths handed back are joined onto this. */
  pagesDir: string;
  pagesReal: string | null;
  indexReal: string | null;
  logReal: string | null;
}

// `path.relative` rather than a `rootReal + sep` prefix, which a workspace at a filesystem root (`/`, `C:\`) would fail.
export function isWithin(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(rootReal, candidateReal);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

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

// Native first: the JS realpath keeps a link's letter case, so on a case-insensitive disk an inside link looks outside.
// The JS one is the fallback for drives where the native call throws (EISDIR on some Windows RAM disks).
function realpathOrNull(absPath: string): string | null {
  try {
    return realpathSync.native(absPath);
  } catch (err) {
    return isEnoent(err) ? null : jsRealpathOrNull(absPath);
  }
}

function jsRealpathOrNull(absPath: string): string | null {
  try {
    return realpathSync(absPath);
  } catch {
    return null;
  }
}
