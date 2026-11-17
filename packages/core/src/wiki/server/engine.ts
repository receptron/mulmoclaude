// Workspace-injected wiki read-engine — the filesystem layer that feeds
// the pure helpers in `@mulmoclaude/core/wiki`. Shared by every host so
// the two apps reading the same `data/wiki/` can't disagree on slug
// resolution, graph edges, or lint findings. Mirrors the bodies that
// previously lived in MulmoClaude's `server/api/routes/wiki.ts`; the
// hosts keep only their HTTP response shaping on top.
//
// The read/write WRITE side (writeWikiPage / snapshots) stays host-side
// until a host needs it shared.

import path from "node:path";
import { parseWikiLink } from "../link.js";
import { wikiSlugify } from "../slug.js";
import { matchWikiSlug, slugByIndexTitle } from "../resolve.js";
import { type WikiPageEntry, parseIndexEntries } from "../index-parse.js";
import { findBrokenLinksInPage, findMissingFiles, findOrphanPages, findTagDrift } from "../lint.js";
import { type WikiGraph, buildWikiGraph } from "../graph.js";
import { readTextSafe, readTextSafeSync } from "./fs.js";
import { getPageIndex } from "./pageIndex.js";
import { parseFrontmatterTags } from "./frontmatter.js";
import { type WikiReadLocations, wikiReadLocations } from "./locations.js";

// Below this length the fuzzy `includes` step is skipped — CJK /
// emoji-only / very-short page names slugify down to a short noise
// tail that partial-matches almost anything; the index.md title-match
// fallback still handles the legitimate non-ASCII case (#1194).
const MIN_FUZZY_SLUG_LEN = 6;

function readFileOrEmpty(absPath: string | null, workspaceReal: string | null): string {
  return absPath === null || workspaceReal === null ? "" : (readTextSafeSync(absPath, workspaceReal) ?? "");
}

async function pageSlugs(locations: WikiReadLocations): Promise<Map<string, string>> {
  return locations.pagesReal === null ? new Map() : (await getPageIndex(locations.pagesReal)).slugs;
}

/** Walk every indexed slug for an `includes`-style match. Returns the
 *  single best candidate, or null when the slug is too short OR several
 *  candidates tie at the top score (ambiguous → defer to the caller's
 *  title-match fallback). Score = min/max length, decoupled from Map
 *  iteration order so resolution is deterministic across hosts. */
export function pickFuzzyMatch(slug: string, slugs: ReadonlyMap<string, string>): string | null {
  if (slug.length < MIN_FUZZY_SLUG_LEN) return null;
  let bestFile: string | null = null;
  let bestScore = 0;
  let bestIsTied = false;
  for (const [key, file] of slugs) {
    if (!slug.includes(key) && !key.includes(slug)) continue;
    const shorter = Math.min(slug.length, key.length);
    const longer = Math.max(slug.length, key.length);
    const score = shorter / longer;
    if (score > bestScore) {
      bestScore = score;
      bestFile = file;
      bestIsTied = false;
    } else if (score === bestScore) {
      bestIsTied = true;
    }
  }
  return bestIsTied ? null : bestFile;
}

/** File matching an index.md entry whose title equals `target` — the
 *  last resort for a link written as the display title rather than
 *  the page's own name. */
function fileByIndexTitle(locations: WikiReadLocations, target: string, slugs: ReadonlyMap<string, string>): string | undefined {
  const entries = parseIndexEntries(readFileOrEmpty(locations.indexReal, locations.workspaceReal));
  const trimmed = target.trim();
  const titleMatch = entries.find((entry) => entry.title === trimmed);
  return titleMatch ? slugs.get(titleMatch.slug) : undefined;
}

/** Resolve a page name to an absolute `.md` path: known slug (literal
 *  or slugified) → fuzzy → index-title fallback. `pageName` may carry
 *  the `[[target|display]]` form; `parseWikiLink` strips the display
 *  half so the lookup uses just the target. */
export async function resolvePagePath(workspace: string, pageName: string): Promise<string | null> {
  const locations = wikiReadLocations(workspace);
  const fileName = await resolvePageFile(locations, pageName);
  return fileName === null ? null : path.join(locations.pagesDir, fileName);
}

async function resolvePageFile(locations: WikiReadLocations, pageName: string): Promise<string | null> {
  const slugs = await pageSlugs(locations);
  if (slugs.size === 0) return null;

  const { target } = parseWikiLink(pageName);
  const matched = matchWikiSlug(target, slugs);
  const matchedFile = matched === null ? undefined : slugs.get(matched);
  if (matchedFile) return matchedFile;

  const fuzzy = pickFuzzyMatch(wikiSlugify(target), slugs);
  if (fuzzy) return fuzzy;

  return fileByIndexTitle(locations, target, slugs) ?? null;
}

/** Raw `index.md` content + its parsed entries. */
export function readWikiIndex(workspace: string): { content: string; entries: WikiPageEntry[] } {
  const locations = wikiReadLocations(workspace);
  const content = readFileOrEmpty(locations.indexReal, locations.workspaceReal);
  return { content, entries: parseIndexEntries(content) };
}

/** Raw `log.md` content (empty string if absent). */
export function readWikiLog(workspace: string): string {
  const locations = wikiReadLocations(workspace);
  return readFileOrEmpty(locations.logReal, locations.workspaceReal);
}

export interface WikiPageRead {
  /** Absolute path of the resolved file, or null when nothing matched. */
  filePath: string | null;
  /** File body (empty when missing OR when the file is an empty placeholder). */
  content: string;
  /** True iff a page file resolved (distinct from empty content). */
  exists: boolean;
  /** Title to display — the resolved filename stem, or the raw pageName. */
  resolvedTitle: string;
}

/** Resolve + read a page. Distinguishes missing (`exists: false`) from
 *  empty-but-present (`exists: true`, `content: ""`). */
export async function readWikiPage(workspace: string, pageName: string): Promise<WikiPageRead> {
  const locations = wikiReadLocations(workspace);
  const fileName = await resolvePageFile(locations, pageName);
  if (fileName === null || locations.pagesReal === null) return { filePath: null, content: "", exists: false, resolvedTitle: pageName };
  const content = readFileOrEmpty(path.join(locations.pagesReal, fileName), locations.workspaceReal);
  return { filePath: path.join(locations.pagesDir, fileName), content, exists: true, resolvedTitle: path.basename(fileName, ".md") };
}

/** Page body, or "" when the file vanished between indexing and reading. */
async function readPageBody(locations: WikiReadLocations, fileName: string): Promise<string> {
  const { pagesReal, workspaceReal } = locations;
  return pagesReal === null || workspaceReal === null ? "" : ((await readTextSafe(path.join(pagesReal, fileName), workspaceReal)) ?? "");
}

/** Read every page + the index and build the page→page link graph.
 *  No cache: the graph is requested explicitly and a content edit does
 *  not advance the pagesDir mtime the page index caches on. */
export async function loadWikiGraph(workspace: string): Promise<WikiGraph> {
  const locations = wikiReadLocations(workspace);
  const slugs = await pageSlugs(locations);
  const pages = await Promise.all([...slugs.entries()].map(async ([slug, fileName]) => ({ slug, content: await readPageBody(locations, fileName) })));
  const indexEntries = parseIndexEntries(readFileOrEmpty(locations.indexReal, locations.workspaceReal));
  return buildWikiGraph(pages, indexEntries);
}

export interface PageBody {
  fileName: string;
  content: string;
}

async function readPageBodies(locations: WikiReadLocations, fileNames: readonly string[]): Promise<PageBody[]> {
  return Promise.all(fileNames.map(async (fileName) => ({ fileName, content: await readPageBody(locations, fileName) })));
}

/** Frontmatter `tags:` per page, keyed for `findTagDrift`. Lowercased so
 *  a `MyPage.md` filename matches an `entry.slug` of `mypage`, which is
 *  what the drift rule looks up. */
export function frontmatterTagIndex(bodies: readonly PageBody[]): Map<string, string[]> {
  const tagsBySlug = new Map<string, string[]>();
  bodies.forEach(({ fileName, content }) => {
    tagsBySlug.set(fileName.replace(/\.md$/i, "").toLowerCase(), parseFrontmatterTags(content));
  });
  return tagsBySlug;
}

/** Run every lint rule over the on-disk wiki, returning issue strings. */
export async function collectLintIssues(workspace: string): Promise<string[]> {
  const locations = wikiReadLocations(workspace);
  const slugs = await pageSlugs(locations);
  if (slugs.size === 0 || locations.pagesReal === null) {
    return ["- Wiki `pages/` directory does not exist yet. Start ingesting sources."];
  }
  const pageEntries = parseIndexEntries(readFileOrEmpty(locations.indexReal, locations.workspaceReal));
  const fileSlugs = new Set(slugs.keys());
  const slugByTitle = slugByIndexTitle(pageEntries);
  const bodies = await readPageBodies(locations, [...slugs.values()]);
  return [
    ...findOrphanPages(fileSlugs, new Set(pageEntries.map((entry) => entry.slug))),
    ...findMissingFiles(pageEntries, fileSlugs),
    ...bodies.flatMap(({ fileName, content }) => findBrokenLinksInPage(fileName, content, fileSlugs, slugByTitle)),
    ...findTagDrift(pageEntries, frontmatterTagIndex(bodies)),
  ];
}
