import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

import { readTextWithinRootSync } from "@mulmoclaude/core/files";
import { WORKSPACE_DIRS, WORKSPACE_FILES } from "../paths.js";
import { locateWithinWorkspace } from "../../utils/files/within-workspace.js";
import { MEMORY_TYPES } from "./types.js";
import { shouldSeedTopicLayout, type MemoryLayoutState } from "./seed-topic-layout.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../system/logger/index.js";

// `undefined` = could not be read for a reason other than absence.
type ReadResult<T> = T | null | undefined;

function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function readOrMissing<T>(read: () => T): ReadResult<T> {
  try {
    return read();
  } catch (err) {
    return isNotFound(err) ? null : undefined;
  }
}

// Read as the prompt reads it: a memory.md leading outside the workspace counts as absent, and one inside that is not a
// readable regular file stays unreadable, so boot never seeds over memory it could not see.
function readLegacyMemoryText(workspaceRoot: string): ReadResult<string> {
  const located = locateWithinWorkspace(workspaceRoot, path.join(workspaceRoot, WORKSPACE_FILES.memory));
  if (located === null) return null;
  return readTextWithinRootSync(located.workspaceReal, located.fileReal) ?? undefined;
}

function readMemoryLayoutState(workspaceRoot: string): MemoryLayoutState {
  const entries = readOrMissing(() => readdirSync(path.join(workspaceRoot, WORKSPACE_DIRS.memoryDir)));
  const legacyText = readLegacyMemoryText(workspaceRoot);
  // lstat, not existsSync: a broken symlink or a permission error must not read as "no staging".
  const staging = readOrMissing(() => lstatSync(path.join(workspaceRoot, WORKSPACE_DIRS.memoryStaging)));
  return {
    memoryDirEntries: entries ?? [],
    legacyMemoryText: legacyText ?? null,
    stagingExists: staging !== null,
    unreadable: entries === undefined || legacyText === undefined || staging === undefined,
  };
}

/** Create the topic-layout type directories when the workspace has no memory to lose. Returns whether it did.
 *  Never throws: boot must not depend on it. */
export function seedTopicLayoutIfFresh(workspaceRoot: string): boolean {
  if (!shouldSeedTopicLayout(readMemoryLayoutState(workspaceRoot))) return false;
  const memoryRoot = path.join(workspaceRoot, WORKSPACE_DIRS.memoryDir);
  try {
    MEMORY_TYPES.forEach((type) => mkdirSync(path.join(memoryRoot, type), { recursive: true }));
    return true;
  } catch (err) {
    log.warn("memory", "could not create the topic memory layout; staying on the atomic one", { memoryRoot, error: errorMessage(err) });
    return false;
  }
}
