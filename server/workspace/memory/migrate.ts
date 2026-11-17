// Migration of legacy `conversations/memory.md` into the typed
// directory layout (#1029 PR-A). This module is a library — it does
// NOT decide when to run. PR-B wires it into `workspace.ts`'s init
// path so the conversion happens once on first start after the new
// layout ships.
//
// CLEANUP 2026-07-01: see `run.ts` — this file is part of the
// one-shot `memory.md` → atomic migration chain and goes when the
// chain goes.
//
// Steps:
//   1. Read existing `conversations/memory.md`. Absent → no-op.
//   2. Split by `## ` (H2). Each H2 block becomes a candidate entry
//      (one per top-level bullet).
//   3. Ask the supplied classifier "preference / interest / fact /
//      reference?" per candidate. Null verdict → skip + count.
//   4. Write each kept candidate as `<type>_<slug>.md`.
//   5. Rebuild `MEMORY.md`.
//   6. Rename source to `memory.md.backup` (never deleted).

import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../../utils/files/atomic.js";
import { readTextWithinWorkspace } from "../../utils/files/within-workspace.js";
import { log } from "../../system/logger/index.js";
import { errorMessage } from "../../utils/errors.js";
import { truncate } from "../../utils/text.js";
import { ClaudeCliNotFoundError } from "../journal/archivist-cli.js";
import { WORKSPACE_FILES } from "../paths.js";
import { regenerateIndex, writeMemoryEntry } from "./io.js";
import { isMemoryType, slugifyMemoryName, type MemoryEntry, type MemoryType } from "./types.js";

export interface MemoryClassification {
  type: MemoryType;
  /** Optional one-line description. Falls back to a truncated body. */
  description?: string;
}

export type MemoryClassifier = (candidate: MemoryCandidate) => Promise<MemoryClassification | null>;

export interface MemoryCandidate {
  /** H2 section header the bullet was found under. Empty string for
   *  bullets that appeared before any H2. */
  section: string;
  /** Single-line text of the bullet (lead-in `- ` already stripped). */
  body: string;
}

export interface MigrationResult {
  /** Set when there was nothing to migrate (no `memory.md`). */
  noop: boolean;
  /** Count of candidates accepted, broken down by type. */
  written: Record<MemoryType, number>;
  /** Candidates the classifier returned `null` for. */
  skippedByClassifier: number;
  /** Candidates that errored on write — caller may want to retry or
   *  surface to the user. The migration continues past write errors
   *  so a single bad entry doesn't strand the whole batch. */
  writeErrors: number;
  /** Candidates whose classifier call failed. Any failure aborts before writing or renaming,
   *  so `memory.md` stays readable and the next start retries. */
  classifierFailures: number;
}

type ClassifyOutcome = { kind: "classified"; classification: MemoryClassification } | { kind: "skipped" } | { kind: "failed" };

// Number of in-flight `classify` calls. Each call spawns the Claude
// CLI, so there's a real cost to going wide; 4 is empirically a
// sweet spot — well above the 1-at-a-time baseline (~10× faster on
// real legacy files) while staying polite to the user's machine and
// to Claude's quota. The classifier callback is the only awaited
// step, so this is the dominant knob.
const CLASSIFY_CONCURRENCY = 4;

// Progress logs emitted every N processed candidates. A long legacy
// file (50+ bullets) takes minutes; without periodic logging it
// looks frozen.
const PROGRESS_LOG_INTERVAL = 5;

export async function migrateLegacyMemory(workspaceRoot: string, classify: MemoryClassifier): Promise<MigrationResult> {
  const sourcePath = path.join(workspaceRoot, WORKSPACE_FILES.memory);
  const raw = await readTextWithinWorkspace(workspaceRoot, sourcePath);
  if (raw === null) {
    return emptyResult(true);
  }

  const candidates = parseCandidates(raw);
  log.info("memory", "migration: classifying candidates", {
    candidateCount: candidates.length,
    concurrency: CLASSIFY_CONCURRENCY,
  });
  const outcomes = await classifyInParallel(classify, candidates);

  const result = emptyResult(false);
  result.classifierFailures = outcomes.filter((outcome) => outcome.kind === "failed").length;
  if (result.classifierFailures > 0) {
    log.warn("memory", "migration: classifier failed, leaving memory.md in place for the next start", {
      classifierFailures: result.classifierFailures,
      candidateCount: candidates.length,
    });
    return result;
  }
  await writeClassifiedEntries(workspaceRoot, candidates, outcomes, result);

  await regenerateIndex(workspaceRoot);
  await renameToBackup(sourcePath);
  return result;
}

async function writeClassifiedEntries(
  workspaceRoot: string,
  candidates: readonly MemoryCandidate[],
  outcomes: readonly ClassifyOutcome[],
  result: MigrationResult,
): Promise<void> {
  const usedSlugs = new Set<string>();

  for (const [index, candidate] of candidates.entries()) {
    const outcome = outcomes[index];
    const classification = outcome?.kind === "classified" ? outcome.classification : null;
    if (!classification) {
      result.skippedByClassifier += 1;
    } else {
      const entry = buildEntry(candidate, classification, usedSlugs);
      try {
        await writeMemoryEntry(workspaceRoot, entry);
        usedSlugs.add(entry.slug);
        result.written[entry.type] += 1;
      } catch (err) {
        log.warn("memory", "migration: write failed", {
          slug: entry.slug,
          error: errorMessage(err),
        });
        result.writeErrors += 1;
      }
    }
    const processed = index + 1;
    if (processed % PROGRESS_LOG_INTERVAL === 0 || processed === candidates.length) {
      log.info("memory", "migration: progress", {
        processed,
        total: candidates.length,
        written: result.written,
        skippedByClassifier: result.skippedByClassifier,
        writeErrors: result.writeErrors,
      });
    }
  }
}

// Classify candidates with bounded concurrency. Workers pull
// indices off a shared cursor and write into a pre-allocated array
// so `result[i]` matches `candidates[i]`. Each await falls inside
// `safeClassify`, which turns an individual classifier throw into a
// `failed` outcome (logging once); a concurrent failure can therefore
// not poison the rest of the batch.
async function classifyInParallel(classify: MemoryClassifier, candidates: readonly MemoryCandidate[]): Promise<ClassifyOutcome[]> {
  const results: ClassifyOutcome[] = Array.from({ length: candidates.length }, (): ClassifyOutcome => ({ kind: "skipped" }));
  let nextIndex = 0;
  // One failure already aborts the migration, so stop spending classifier calls on the rest.
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      // Absent element == the shared cursor ran past the end.
      if (candidate === undefined) return;
      let outcome: ClassifyOutcome;
      try {
        outcome = await safeClassify(classify, candidate);
      } catch (err) {
        failed = true;
        throw err;
      }
      results[index] = outcome;
      if (outcome.kind === "failed") failed = true;
    }
  };
  const workers = Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, candidates.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function emptyResult(noop: boolean): MigrationResult {
  return {
    noop,
    written: { preference: 0, interest: 0, fact: 0, reference: 0 },
    skippedByClassifier: 0,
    writeErrors: 0,
    classifierFailures: 0,
  };
}

// Split the legacy file into candidate bullets. We accept either
// `- ` or `* ` as bullet markers and ignore continuation lines (a
// candidate is one bullet line). The H2 header — when present —
// rides along as `section` so the classifier can use it as context.
// Parsing is character-driven (no regex) to keep sonar happy and to
// make the bullet-vs-header classification obvious from the code.
export function parseCandidates(raw: string): MemoryCandidate[] {
  const lines = raw.split("\n");
  let section = "";
  const out: MemoryCandidate[] = [];
  for (const lineRaw of lines) {
    const line = stripCarriageReturn(lineRaw);
    const header = extractHeader(line);
    if (header !== null) {
      section = header;
      continue;
    }
    const bullet = extractBullet(line);
    if (bullet) out.push({ section, body: bullet });
  }
  return out;
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function extractHeader(line: string): string | null {
  if (!line.startsWith("## ")) return null;
  return line.slice(3).trim();
}

function extractBullet(line: string): string | null {
  const trimmedLeft = line.replace(/^[\t ]+/, "");
  if (!trimmedLeft.startsWith("- ") && !trimmedLeft.startsWith("* ")) return null;
  const body = trimmedLeft.slice(2).trim();
  return body.length > 0 ? body : null;
}

async function safeClassify(classify: MemoryClassifier, candidate: MemoryCandidate): Promise<ClassifyOutcome> {
  try {
    const verdict = await classify(candidate);
    if (verdict && isMemoryType(verdict.type)) return { kind: "classified", classification: verdict };
    return { kind: "skipped" };
  } catch (err) {
    // Startup-wide failures (CLI missing) MUST escape so
    // `runMemoryMigrationOnce` can log once + leave the legacy file
    // for retry. Without this, every candidate would silently degrade
    // to `null` and look like normal classifier disagreement
    // (#1061 review).
    if (err instanceof ClaudeCliNotFoundError) throw err;
    log.warn("memory", "migration: classifier threw", {
      preview: candidate.body.slice(0, 80),
      error: errorMessage(err),
    });
    return { kind: "failed" };
  }
}

function buildEntry(candidate: MemoryCandidate, classification: MemoryClassification, usedSlugs: Set<string>): MemoryEntry {
  const name = candidate.body.length > 80 ? `${candidate.body.slice(0, 77)}…` : candidate.body;
  const description = classification.description?.trim() || truncateForDescription(candidate.body);
  const baseSlug = slugifyMemoryName(candidate.body, classification.type);
  const slug = uniqueSlug(baseSlug, usedSlugs);
  return {
    name,
    description,
    type: classification.type,
    body: candidate.body,
    slug,
  };
}

function truncateForDescription(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return truncate(oneLine, 120);
}

function uniqueSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let counter = 2;
  while (used.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

async function renameToBackup(sourcePath: string): Promise<void> {
  const backupPath = `${sourcePath}.backup`;
  try {
    await rename(sourcePath, backupPath);
  } catch (err) {
    log.warn("memory", "migration: backup rename failed", {
      sourcePath,
      error: errorMessage(err),
    });
  }
}

// Bare write of the source file used in tests for setup. Production
// callers don't need this — `memory.md` is created by user activity
// or by an older mulmoclaude version.
export async function writeLegacyMemoryForTest(workspaceRoot: string, content: string): Promise<void> {
  const sourcePath = path.join(workspaceRoot, WORKSPACE_FILES.memory);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFileAtomic(sourcePath, content);
}
