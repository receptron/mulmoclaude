// Export a workspace collection into the curated registry's contribution layout
// (collections/<author>/<slug>/ + meta.json + optional seed/) under
// data/registry-export/, so the user can open a PR to the registry. The producer
// side of the registry loop.
//
// writeCollectionExport takes explicit dirs + a workspace root so it is unit-testable
// against temp dirs with no discovery/network; performExport (separate file) is the
// thin glue that resolves the collection from the live workspace.

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { log } from "../../server/host.js";
import { isWithinRoot } from "../../../files/containment.js";
import { toPosixRelPath } from "../../../files/relPath.js";

export const EXPORT_BASE = "data/registry-export";
const BUNDLE_FILES = ["SKILL.md", "schema.json"] as const;
const OPTIONAL_FILES = ["screenshot.png"] as const;
const BUNDLE_DIRS = ["views", "templates"] as const;
const AUTHOR_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const STATUS_BAD_REQUEST = 400;
// Block obvious credentials from being published in seed data; PII is only warned.
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /sk-[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];
const hasSecret = (text: string): boolean => SECRET_PATTERNS.some((pattern) => pattern.test(text));
// Bounded + non-overlapping (no ReDoS): local@label.tld with single quantifier runs.
const EMAIL_RE = /[\w.%+-]{1,64}@[\w-]{1,255}\.[a-z]{2,24}/i;

export interface ExportMeta {
  author: string;
  slug: string;
  version: string;
  title: string;
  description: string;
  tags: string[];
  license: string;
}

export type ExportResult =
  | { ok: true; outputPath: string; fileCount: number; seedCount: number; seedSkipped: number; warnings: string[] }
  | { ok: false; status: number; error: string };

async function pathKind(target: string): Promise<"dir" | "file" | "absent"> {
  try {
    return (await stat(target)).isDirectory() ? "dir" : "file";
  } catch {
    return "absent";
  }
}

async function copyBundle(skillDir: string, outDir: string): Promise<number> {
  let count = 0;
  for (const file of [...BUNDLE_FILES, ...OPTIONAL_FILES]) {
    const src = path.join(skillDir, file);
    if ((await pathKind(src)) !== "file") continue;
    await cp(src, path.join(outDir, file));
    count += 1;
  }
  for (const dir of BUNDLE_DIRS) {
    const src = path.join(skillDir, dir);
    if ((await pathKind(src)) !== "dir") continue;
    await cp(src, path.join(outDir, dir), { recursive: true });
    count += (await readdir(src)).filter((name) => !name.startsWith(".")).length;
  }
  return count;
}

async function exportSeed(dataDir: string, outDir: string): Promise<{ count: number; skipped: number; warnings: string[] }> {
  let names: string[];
  try {
    // Dot-prefixed files are NOT records — the same rule every other reader of
    // a data dir applies (`io.ts#listItems`, `ontology.ts`, the store watcher,
    // `validate.ts`), and the bundle-dir count above. Sync state lives here too
    // (`.calendar-sync.json`), and shipping it would put the user's calendar id
    // in a published bundle and count it toward `dataConsent` (Codex review
    // #2853).
    names = (await readdir(dataDir)).filter((name) => name.endsWith(".json") && !name.startsWith("."));
  } catch {
    return { count: 0, skipped: 0, warnings: [] };
  }
  if (names.length === 0) return { count: 0, skipped: 0, warnings: [] };
  const seedDir = path.join(outDir, "seed", "items");
  await mkdir(seedDir, { recursive: true });
  const warnings: string[] = [];
  let count = 0;
  let skipped = 0;
  for (const name of names) {
    const base = path.basename(name);
    const text = await readFile(path.join(dataDir, base), "utf-8");
    if (hasSecret(text)) {
      warnings.push(`skipped ${base}: contains a possible credential`);
      skipped += 1;
      continue;
    }
    if (EMAIL_RE.test(text)) warnings.push(`${base}: contains a possible email/PII (kept — your responsibility)`);
    await writeFile(path.join(seedDir, base), text, "utf-8");
    count += 1;
  }
  return { count, skipped, warnings };
}

// Resolve `segments` under `root` and return the absolute path only when it stays
// inside `root` — a containment barrier for the user-derived author/slug and the
// collection dirs, on top of the AUTHOR_RE/SLUG_RE format checks. `..` or an
// absolute escape resolves outside `root` and yields null (rejected upstream).
function resolveWithin(root: string, ...segments: string[]): string | null {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  return isWithinRoot(resolvedRoot, target) ? target : null;
}

// Required bundle files (SKILL.md, schema.json) must be present — exporting an
// incomplete bundle would pass here but fail downstream registry curation.
// Returns the first missing required file, or null when all are present.
async function findMissingRequired(skillDir: string): Promise<string | null> {
  for (const file of BUNDLE_FILES) {
    if ((await pathKind(path.join(skillDir, file))) !== "file") return file;
  }
  return null;
}

export async function writeCollectionExport(params: {
  workspaceRoot: string;
  skillDir: string;
  dataDir: string;
  meta: ExportMeta;
  includeSeed: boolean;
}): Promise<ExportResult> {
  const { workspaceRoot, skillDir, dataDir, meta, includeSeed } = params;
  if (!AUTHOR_RE.test(meta.author)) return { ok: false, status: STATUS_BAD_REQUEST, error: `author '${meta.author}' is not a valid GitHub login` };
  if (!SLUG_RE.test(meta.slug)) return { ok: false, status: STATUS_BAD_REQUEST, error: `slug '${meta.slug}' is invalid` };

  const wsRoot = path.resolve(workspaceRoot);
  const exportRoot = path.join(wsRoot, ...EXPORT_BASE.split("/"));
  const outDir = resolveWithin(exportRoot, meta.author, meta.slug);
  const safeSkillDir = resolveWithin(wsRoot, skillDir);
  const safeDataDir = resolveWithin(wsRoot, dataDir);
  if (!outDir || !safeSkillDir || !safeDataDir) {
    return { ok: false, status: STATUS_BAD_REQUEST, error: "resolved path escapes the workspace" };
  }

  const missing = await findMissingRequired(safeSkillDir);
  if (missing) {
    return { ok: false, status: STATUS_BAD_REQUEST, error: `required bundle file missing: ${missing}` };
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const bundleCount = await copyBundle(safeSkillDir, outDir);
  const seed = includeSeed ? await exportSeed(safeDataDir, outDir) : { count: 0, skipped: 0, warnings: [] };
  const metaOut = { ...meta, ...(seed.count > 0 ? { dataConsent: true } : {}) };
  await writeFile(path.join(outDir, "meta.json"), `${JSON.stringify(metaOut, null, 2)}\n`, "utf-8");
  log.info("collections-registry", "exported collection", { slug: meta.slug, author: meta.author, seedCount: seed.count });
  const outRel = toPosixRelPath(path.relative(wsRoot, outDir));
  return { ok: true, outputPath: outRel, fileCount: bundleCount + 1, seedCount: seed.count, seedSkipped: seed.skipped, warnings: seed.warnings };
}
