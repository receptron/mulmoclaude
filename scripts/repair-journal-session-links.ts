// Manual one-off (#3417): rewrites session links in existing journal summaries that were written as
// `/chat/<id>.jsonl` and therefore resolve to `<workspace>/chat/`, which does not exist.
// Usage: yarn journal:repair-links --workspace <dir> | --dry-run [--workspace <dir>]; any other argument is an error, and writing requires --workspace. Stop the MulmoClaude server first so a journal pass cannot write the same files.

import path from "node:path";
import fsp from "node:fs/promises";
import { errorMessage } from "../server/utils/errors.js";
import { WORKSPACE_DIRS, workspacePath } from "../server/workspace/paths.js";
import { repairSessionLinks } from "../server/workspace/journal/sessionLinkRepair.js";
import { replaceIfUnchanged } from "../server/workspace/journal/replaceIfUnchanged.js";

const JSONL_SUFFIX = ".jsonl";

const FLAG_PREFIX = "--";
const DRY_RUN_FLAG = "--dry-run";
const WORKSPACE_FLAG = "--workspace";

interface ParsedArgs {
  dryRun: boolean;
  workspaceRoot: string;
  workspaceGiven: boolean;
}

// Strict on purpose: this rewrites files in place, so a typo or a flag without its value must stop the run, never fall back to a default.
function parseArgs(args: string[], parsed: ParsedArgs = { dryRun: false, workspaceRoot: workspacePath, workspaceGiven: false }): ParsedArgs {
  const [arg, ...rest] = args;
  if (arg === undefined) return parsed;
  if (arg === DRY_RUN_FLAG) return parseArgs(rest, { ...parsed, dryRun: true });
  if (arg !== WORKSPACE_FLAG) throw new Error(`unknown argument "${arg}" (expected ${DRY_RUN_FLAG} or ${WORKSPACE_FLAG} <dir>)`);
  const [value, ...afterValue] = rest;
  if (value === undefined || value.trim() === "" || value.startsWith(FLAG_PREFIX)) throw new Error(`${WORKSPACE_FLAG} needs a directory`);
  return parseArgs(afterValue, { ...parsed, workspaceRoot: path.resolve(value), workspaceGiven: true });
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? listMarkdownFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)])),
  );
  return nested.flat().filter((filePath) => filePath.endsWith(".md"));
}

async function loadSessionIds(workspaceRoot: string): Promise<Set<string>> {
  const names = await fsp.readdir(path.join(workspaceRoot, WORKSPACE_DIRS.chat));
  return new Set(names.filter((name) => name.endsWith(JSONL_SUFFIX)).map((name) => name.slice(0, -JSONL_SUFFIX.length)));
}

interface FileOutcome {
  repaired: number;
  skipped: number;
}

const UNTOUCHED: FileOutcome = { repaired: 0, skipped: 0 };

async function repairFile(workspaceRoot: string, filePath: string, sessionIds: Set<string>, dryRun: boolean): Promise<FileOutcome> {
  const originalBytes = await fsp.readFile(filePath);
  const original = originalBytes.toString("utf-8");
  const wsPath = path.relative(workspaceRoot, filePath).split(path.sep).join("/");
  if (!Buffer.from(original, "utf-8").equals(originalBytes)) {
    console.warn(`skipped ${wsPath}: not valid UTF-8, left untouched`);
    return UNTOUCHED;
  }
  const { content, repairedCount, skippedCount } = repairSessionLinks(wsPath, original, (sessionId) => sessionIds.has(sessionId));
  if (skippedCount > 0) console.warn(`left ${skippedCount} broken link(s) in ${wsPath}: their paragraph holds raw HTML or starts indented, fix by hand`);
  if (repairedCount === 0) return { repaired: 0, skipped: skippedCount };
  if (!dryRun && !(await replaceIfUnchanged(filePath, originalBytes, content))) {
    console.warn(`skipped ${wsPath}: changed while the script ran, rerun to repair it`);
    return { repaired: 0, skipped: skippedCount };
  }
  console.log(`${dryRun ? "would repair" : "repaired"} ${repairedCount} link(s) in ${wsPath}`);
  return { repaired: repairedCount, skipped: skippedCount };
}

interface RunOutcome {
  total: number;
  skipped: number;
  touchedFiles: number;
  failed: string[];
}

async function repairAll(workspaceRoot: string, files: string[], sessionIds: Set<string>, dryRun: boolean): Promise<RunOutcome> {
  const outcome: RunOutcome = { total: 0, skipped: 0, touchedFiles: 0, failed: [] };
  for (const filePath of files) {
    try {
      const { repaired, skipped } = await repairFile(workspaceRoot, filePath, sessionIds, dryRun);
      outcome.total += repaired;
      outcome.skipped += skipped;
      if (repaired > 0) outcome.touchedFiles += 1;
    } catch (err) {
      outcome.failed.push(filePath);
      console.error(`failed ${filePath}: ${errorMessage(err)}`);
    }
  }
  return outcome;
}

async function main(): Promise<void> {
  const { dryRun, workspaceRoot, workspaceGiven } = parseArgs(process.argv.slice(2));
  // Only a preview may fall back to the default workspace; a real run must name its target, whatever the environment says.
  if (!dryRun && !workspaceGiven) throw new Error(`a real run needs ${WORKSPACE_FLAG} <dir> (${DRY_RUN_FLAG} previews the default workspace)`);
  console.log(`journal:repair-links — workspace ${workspaceRoot}${dryRun ? " (dry run)" : ""}`);
  const sessionIds = await loadSessionIds(workspaceRoot);
  const files = await listMarkdownFiles(path.join(workspaceRoot, WORKSPACE_DIRS.summaries));
  const { total, skipped, touchedFiles, failed } = await repairAll(workspaceRoot, files, sessionIds, dryRun);
  console.log(
    `journal:repair-links — ${dryRun ? "would repair" : "repaired"} ${total} link(s) in ${touchedFiles} file(s), left ${skipped} unrepaired (${files.length} scanned, ${failed.length} failed)`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`journal:repair-links — failed: ${errorMessage(err)}`);
  process.exitCode = 1;
});
