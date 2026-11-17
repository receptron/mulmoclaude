// Topic-based memory IO (#1070 PR-A).
//
// Reads and writes `<type>/<topic>.md` topic files. The directory
// layout is:
//
//   conversations/memory/
//     preference/dev.md
//     interest/music.md
//     ...
//     MEMORY.md       # auto-generated index (sibling of the type subdirs)
//
// The async loader is for migration / batch use; the sync loader is
// for the agent prompt builder, which runs in a sync code path.
// Both loaders share the same parse helper so a malformed file
// produces the same warning regardless of caller.

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { parseFrontmatter, serializeWithFrontmatter } from "@mulmoclaude/markdown-utils/markdown/frontmatter";
import { writeFileAtomic } from "../../utils/files/atomic.js";
import { readDirSafeAsync } from "../../utils/files/safe.js";
import { readTextWithinWorkspace } from "../../utils/files/within-workspace.js";
import { log } from "../../system/logger/index.js";
import { WORKSPACE_DIRS, WORKSPACE_FILES } from "../paths.js";
import { isMemoryType, MEMORY_TYPES, type MemoryType } from "./types.js";
import { extractH2Sections, isSafeTopicSlug, type TopicMemoryFile } from "./topic-types.js";

export function topicMemoryRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, WORKSPACE_DIRS.memoryDir);
}

export function topicMemoryIndexPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, WORKSPACE_FILES.memoryIndex);
}

// Both loaders walk types in `MEMORY_TYPES` order (a stable
// constant) and sort filenames within each type by name. This pins
// the order of entries in the agent's system prompt so a `readdir`
// reshuffle on a different filesystem or after a restart can't
// destabilise the prompt content (and trash prompt cache hit rates).
export async function loadAllTopicFiles(workspaceRoot: string): Promise<TopicMemoryFile[]> {
  const root = topicMemoryRoot(workspaceRoot);
  const collected: TopicMemoryFile[] = [];
  for (const type of MEMORY_TYPES) {
    const typeDir = path.join(root, type);
    const dirents = await readDirSafeAsync(typeDir);
    const filenames = candidateFilenamesSorted(dirents);
    for (const name of filenames) {
      const absPath = path.join(typeDir, name);
      const raw = await readTextWithinWorkspace(workspaceRoot, absPath);
      const file = parseTopicFile(absPath, raw, type);
      if (file) collected.push(file);
    }
  }
  return collected;
}

function candidateFilenamesSorted(dirents: readonly { name: string }[]): string[] {
  const names: string[] = [];
  for (const dirent of dirents) {
    if (isCandidateFilename(dirent.name)) names.push(dirent.name);
  }
  return names.sort();
}

export async function writeTopicFile(workspaceRoot: string, file: TopicMemoryFile): Promise<string> {
  if (!isSafeTopicSlug(file.topic)) {
    throw new Error(`refusing to write topic file with unsafe topic slug: ${JSON.stringify(file.topic)}`);
  }
  const dir = path.join(topicMemoryRoot(workspaceRoot), file.type);
  await mkdir(dir, { recursive: true });
  const absPath = path.join(dir, `${file.topic}.md`);
  const content = serializeWithFrontmatter({ type: file.type, topic: file.topic }, file.body);
  await writeFileAtomic(absPath, content, { uniqueTmp: true });
  return path.posix.join(WORKSPACE_DIRS.memoryDir, file.type, `${file.topic}.md`);
}

// Rebuild `MEMORY.md` from the live topic files. Sorted by type
// (preference / interest / fact / reference) then by topic name.
// Each file renders as `- <type>/<topic>.md — <H2 csv>` (or just
// the path when there are no H2 sections yet).
export async function regenerateTopicIndex(workspaceRoot: string): Promise<void> {
  await mkdir(topicMemoryRoot(workspaceRoot), { recursive: true });
  const files = await loadAllTopicFiles(workspaceRoot);
  const sorted = [...files].sort(compareFiles);
  const lines: string[] = ["# Memory Index", ""];
  for (const type of MEMORY_TYPES) {
    const inType = sorted.filter((file) => file.type === type);
    if (inType.length === 0) continue;
    lines.push(`## ${type}`);
    lines.push("");
    for (const file of inType) {
      lines.push(formatIndexLine(file));
    }
    lines.push("");
  }
  if (sorted.length === 0) lines.push("_(no entries yet)_", "");
  await writeFileAtomic(topicMemoryIndexPath(workspaceRoot), lines.join("\n"), { uniqueTmp: true });
}

export function formatIndexLine(file: TopicMemoryFile): string {
  const link = `${file.type}/${file.topic}.md`;
  if (file.sections.length === 0) return `- ${link}`;
  return `- ${link} — ${file.sections.join(", ")}`;
}

function compareFiles(left: TopicMemoryFile, right: TopicMemoryFile): number {
  const typeDelta = MEMORY_TYPES.indexOf(left.type) - MEMORY_TYPES.indexOf(right.type);
  if (typeDelta !== 0) return typeDelta;
  return left.topic.localeCompare(right.topic);
}

function isCandidateFilename(name: string): boolean {
  if (!name.endsWith(".md")) return false;
  if (name.startsWith(".")) return false;
  if (name === "MEMORY.md") return false;
  return true;
}

function parseTopicFile(absPath: string, raw: string | null, expectedType: MemoryType): TopicMemoryFile | null {
  if (raw === null) {
    log.warn("memory", "topic-io: failed to read file", { path: absPath });
    return null;
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed.hasHeader) {
    log.warn("memory", "topic-io: missing frontmatter", { path: absPath });
    return null;
  }
  const { type, topic } = parsed.meta;
  if (!isMemoryType(type)) {
    log.warn("memory", "topic-io: unknown type", { path: absPath, type: String(type) });
    return null;
  }
  if (type !== expectedType) {
    log.warn("memory", "topic-io: type / directory mismatch", { path: absPath, type, expectedType });
    return null;
  }
  if (typeof topic !== "string" || topic.trim().length === 0) {
    log.warn("memory", "topic-io: missing topic", { path: absPath });
    return null;
  }
  const topicTrimmed = topic.trim();
  if (!isSafeTopicSlug(topicTrimmed)) {
    log.warn("memory", "topic-io: unsafe topic slug", { path: absPath, topic });
    return null;
  }
  // Filename is the source of truth — the index links to it.
  // A frontmatter `topic` that disagrees with the basename produces
  // dangling index entries (`type/topic.md` doesn't exist on disk),
  // which the swap promotes verbatim.
  const fileTopic = path.basename(absPath, ".md");
  if (topicTrimmed !== fileTopic) {
    log.warn("memory", "topic-io: topic / filename mismatch", { path: absPath, topic: topicTrimmed, fileTopic });
    return null;
  }
  const sections = extractH2Sections(parsed.body);
  return { type, topic: topicTrimmed, body: parsed.body, sections };
}
