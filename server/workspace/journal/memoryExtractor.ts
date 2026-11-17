// Run at end of the journal daily pass so durable user facts are picked up even if the agent didn't memo them in-conversation.
// LLM receives existing memory.md as context and is instructed to return ONLY new facts (we still de-dupe defensively).

import { existsSync } from "fs";
import path from "path";
import { WORKSPACE_FILES } from "../paths.js";
import { writeFileAtomic } from "../../utils/files/atomic.js";
import { readTextWithinWorkspaceSync } from "../../utils/files/within-workspace.js";
import { log } from "../../system/logger/index.js";
import { ClaudeCliNotFoundError } from "./archivist-cli.js";
import { hasTopicFormat } from "../memory/topic-detect.js";

const EXTRACTION_SYSTEM_PROMPT = `You are a personal-fact extractor. Given a batch of chat excerpts between a user and an AI assistant, extract ONLY durable facts about the USER — things that would still be true next week.

Categories to look for:
- Food preferences (likes, dislikes, allergies, diet)
- Daily routines & habits (exercise, hobbies, recurring activities)
- Possessions (car, devices, tools)
- Family & pets (members, names, ages)
- Location (city, commute, travel patterns)
- Interests & hobbies (topics they follow, activities)
- Schedule patterns (weekly meetings, monthly tasks)
- Health (conditions, habits)
- Work (job, role, company, work style)
- Coding preferences (tools, conventions, style preferences)
- Communication style (language, verbosity, formality)

Rules:
- Extract ONLY what the user explicitly stated — never infer or guess.
- Each fact should be one concise bullet point.
- If the user corrected a previous fact, output the corrected version only.
- Do NOT extract facts about the AI, the app, or technical implementation details.
- Do NOT extract ephemeral information (today's weather, a specific bug being debugged).
- Output ONLY the bullet points, one per line, prefixed with "- ". No headers, no categories, no explanation.
- If there are no new user facts, output exactly: NONE`;

export interface MemoryExtractionDeps {
  workspaceRoot: string;
  excerpts: string;
  summarize: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

export async function extractAndAppendMemory(deps: MemoryExtractionDeps): Promise<number> {
  // Same predicate the prompt reader uses: in topic format memory.md is never read, so writing it only grows a dead file.
  if (hasTopicFormat(deps.workspaceRoot)) {
    log.debug("memory-extractor", "topic-format workspace, skipping legacy memory.md extraction");
    return 0;
  }
  const memoryPath = path.join(deps.workspaceRoot, WORKSPACE_FILES.memory);
  const existingMemory = readExistingMemory(deps.workspaceRoot, memoryPath);
  if (existingMemory === null) {
    log.warn("memory-extractor", "memory.md is not a readable file inside the workspace, skipping extraction", { path: memoryPath });
    return 0;
  }

  const userPrompt = buildUserPrompt(existingMemory, deps.excerpts);
  let raw: string;
  try {
    raw = await deps.summarize(EXTRACTION_SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    if (err instanceof ClaudeCliNotFoundError) throw err;
    log.warn("memory-extractor", "LLM call failed", {
      error: String(err),
    });
    return 0;
  }

  const newFacts = parseExtractedFacts(raw);
  if (newFacts.length === 0) return 0;

  const factsToAppend = filterNewFacts(existingMemory, newFacts);
  if (factsToAppend.length === 0) return 0;

  const updatedContent = appendFacts(existingMemory, factsToAppend);
  await writeFileAtomic(memoryPath, updatedContent);
  log.info("memory-extractor", "appended new facts", {
    count: factsToAppend.length,
  });
  return factsToAppend.length;
}

// Null, never "", for a memory.md that exists but is not readable inside the workspace: extraction rewrites the file,
// so treating it as empty would replace a link with whatever it pointed at, or wipe a file it could not read.
function readExistingMemory(workspaceRoot: string, memoryPath: string): string | null {
  if (!existsSync(memoryPath)) return "";
  return readTextWithinWorkspaceSync(workspaceRoot, memoryPath);
}

export function buildUserPrompt(existingMemory: string, excerpts: string): string {
  const parts: string[] = [];
  if (existingMemory.trim()) {
    parts.push(`## Already known (do NOT repeat these):\n\n${existingMemory}`);
  }
  parts.push(`## New chat excerpts:\n\n${excerpts}`);
  parts.push("\nExtract any NEW user facts not already in the 'Already known' section above. If none, output: NONE");
  return parts.join("\n\n");
}

export function parseExtractedFacts(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "NONE" || trimmed === "") return [];
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .filter((line) => line.length > 3);
}

function normalizeFact(fact: string): string {
  return fact.replace(/^- /, "").trim().toLowerCase();
}

export function filterNewFacts(existingMemory: string, facts: readonly string[]): string[] {
  const seen = new Set(parseExtractedFacts(existingMemory).map(normalizeFact));
  const out: string[] = [];
  for (const fact of facts) {
    const key = normalizeFact(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

export function appendFacts(existing: string, facts: string[]): string {
  const trimmed = existing.trimEnd();
  const factsBlock = facts.join("\n");
  if (!trimmed) {
    return `# Memory\n\nDistilled facts about you and your work.\n\n${factsBlock}\n`;
  }
  return `${trimmed}\n${factsBlock}\n`;
}
