// Single choke point for `data/wiki/pages/<slug>.md` writes.
//
// Every wiki page write — manageWiki MCP tool, the user editing
// through the file content endpoint, the wiki-backlinks driver
// appending session links — funnels through `writeWikiPage`.
// Centralising here gives:
//
//   - one atomic-write guarantee (was: wiki-backlinks bypassed it)
//   - one place to record edit history (#763 PR 2 — currently a
//     no-op stub; this PR only consolidates the writes)
//   - editor identity captured at the call site (LLM / user /
//     system) where it is actually known. A generic `writeFileAtomic`
//     hook can't tell who originated the edit.
//
// PR 1 scope (this commit): consolidation only, behaviour unchanged.
// PR 2 will fill in `appendSnapshot` with real history pipeline.
//
// `appendSnapshot` is a no-op stub on purpose — keeping the call
// site wired up means PR 2 is purely an internal change.

import path from "node:path";
import { realpath } from "node:fs/promises";
import { readTextSafe } from "../../utils/files/safe.js";
import { writeFileAtomic } from "../../utils/files/atomic.js";
import { writeNewFileExclusive } from "../../utils/files/upload-io.js";
import { mergeFrontmatter, parseFrontmatter, serializeWithFrontmatter } from "@mulmoclaude/markdown-utils/markdown/frontmatter";
import { isSafeSlug } from "@mulmoclaude/core/wiki";
import { wikiSlugFromAbsPath } from "@mulmoclaude/core/wiki/paths";
import { workspacePath as defaultWorkspacePath } from "../workspace.js";
import { WORKSPACE_DIRS } from "../paths.js";
import { appendSnapshot } from "./snapshot.js";
import { logBackgroundError } from "../../utils/logBackgroundError.js";

export type WikiPageEditor = "llm" | "user" | "system";

export interface WikiWriteMeta {
  editor: WikiPageEditor;
  /** Chat session that triggered the edit. Optional — not all
   *  callers know one (e.g. user save through the file editor). */
  sessionId?: string | undefined;
  /** Free-form short reason. LLM-supplied or user-supplied. */
  reason?: string | undefined;
  /** Force a snapshot to be recorded even when the body and
   *  user-supplied meta haven't changed. Used by the restore
   *  route so a "restore to current version" still leaves an
   *  audit trail entry — without this the `hasMeaningfulChange`
   *  gate would silently swallow the restore (codex iter-1
   *  finding). Default: false. */
  forceSnapshot?: boolean | undefined;
}

export interface WikiPageWriteOptions {
  /** Override the workspace root for tests. Defaults to the
   *  process's resolved workspace (`workspace.ts`). */
  workspaceRoot?: string | undefined;
  /** Inject the "now" used for `created` / `updated` frontmatter
   *  injection. Tests pass a fixed `Date` so the round-trip is
   *  deterministic; production uses the wall clock. */
  now?: (() => Date) | undefined;
  /** Create-only mode: write via `O_EXCL` so the
   *  call atomically refuses to overwrite an existing page. The
   *  thrown error has `code: "EEXIST"` — used by the
   *  `POST /api/files/create` route (#1598) to map to a 409 and
   *  close the check-then-write TOCTOU surfaced in Codex review. */
  exclusive?: boolean;
}

/** Absolute path for a slug. Throws on slugs that would escape
 *  `data/wiki/pages/`. Does not check existence. */
export function wikiPagePath(slug: string, opts: WikiPageWriteOptions = {}): string {
  if (!isSafeSlug(slug)) {
    throw new Error(`wiki-pages: refusing unsafe slug ${JSON.stringify(slug)}`);
  }
  const root = opts.workspaceRoot ?? defaultWorkspacePath;
  return path.join(root, WORKSPACE_DIRS.wikiPages, `${slug}.md`);
}

/** Read a wiki page; null if missing. Used internally to capture
 *  the pre-write content for snapshotting (PR 2). Exposed because
 *  some callers want the same null-safe reader. */
export async function readWikiPage(slug: string, opts: WikiPageWriteOptions = {}): Promise<string | null> {
  return readTextSafe(wikiPagePath(slug, opts));
}

/** Write a wiki page atomically and stamp it with `created` /
 *  `updated` / `editor` frontmatter (lazy-on-write — #895 PR B).
 *  Existing frontmatter keys are preserved; `created` is set on
 *  first write and never overwritten; `updated` is bumped on every
 *  write. Callers may pass either a body-only string or content
 *  with its own `---\n...\n---` envelope (we re-parse and merge
 *  so the resulting file always has a single canonical envelope).
 *
 *  `uniqueTmp: true` matches what the generic `/api/files/content`
 *  PUT used pre-consolidation — without it two simultaneous writes
 *  to the same page collide on the shared `.tmp` staging file
 *  (the file-content PUT and the wiki-backlinks driver are
 *  independent and may target the same page in the same
 *  millisecond).
 *
 *  The (old, new) pair still flows into `appendSnapshot` — the
 *  no-op stub today, real history pipeline in #763 PR 2. */
export async function writeWikiPage(slug: string, content: string, meta: WikiWriteMeta, opts: WikiPageWriteOptions = {}): Promise<void> {
  const absPath = wikiPagePath(slug, opts);
  // Exclusive mode: don't read first — the `wx` flag itself is what
  // closes the TOCTOU window. `oldContent` is null by definition
  // (the file doesn't exist on the first successful write).
  const oldContent = opts.exclusive ? null : await readTextSafe(absPath);
  const finalContent = stampFrontmatter(oldContent, content, meta, opts);
  if (opts.exclusive) {
    // Re-anchor the absolute path against the workspace root before
    // handing it to the create. `wikiPagePath` already
    // enforces containment via `isSafeSlug` + `path.join`, but
    // CodeQL's `js/path-injection` analysis doesn't trace through
    // those — the explicit `relative` + `startsWith` containment
    // check below is a sanitizer the analyzer recognizes, and it
    // throws (rather than silently passing) on any escape so the
    // route handler maps the throw to a 5xx via its catch.
    const root = opts.workspaceRoot ?? defaultWorkspacePath;
    const relFromRoot = path.relative(root, absPath);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
      throw new Error(`wiki-pages: refusing to write outside workspace root: ${JSON.stringify(absPath)}`);
    }
    const safeAbsPath = path.join(root, relFromRoot);
    // `O_EXCL`: atomic create-or-fail. On a concurrent create race
    // only one call wins; the other throws `EEXIST`, which the route
    // handler maps to HTTP 409. The new file is also proven to sit
    // inside the workspace before any byte is written (#3573).
    await writeNewFileExclusive(await realpath(root), safeAbsPath, finalContent);
  } else {
    await writeFileAtomic(absPath, finalContent, { uniqueTmp: true });
  }
  // Snapshot trigger: only fire when the *body* changed (or the
  // user-supplied meta did) — auto-stamping `updated` on every
  // save would otherwise flood the snapshot store with no-op
  // saves where nothing the user cares about actually changed.
  // Compare bodies after parsing so a frontmatter-only diff in
  // auto-stamped fields doesn't trip the trigger.
  if (meta.forceSnapshot === true || oldContent === null || hasMeaningfulChange(oldContent, finalContent)) {
    // Snapshot failures must NOT fail the page write — the file is
    // already on disk, so surfacing a 500 to the caller would be
    // misleading. Log and move on; the next save will record the
    // next state. Codex review iter-3 #917.
    try {
      await appendSnapshot(slug, oldContent, finalContent, meta, {
        workspaceRoot: opts.workspaceRoot,
        now: opts.now,
      });
    } catch (err) {
      logBackgroundError("wiki-snapshot")(err);
    }
  }
}

/** True iff the diff between `oldContent` and `newContent` is
 *  more than just the auto-stamped `updated` / `editor` fields.
 *  Auto-stamps land on every save; without this guard the
 *  snapshot pipeline (#763 PR 2) would record a snapshot per
 *  no-op save. The check compares (body) and (meta minus the
 *  auto-stamped keys).
 *
 *  Exported so the LLM-write hook callback (`/api/wiki/internal/
 *  snapshot`) can apply the same dedupe before recording a
 *  snapshot — without this, the hook records one snapshot per
 *  Write/Edit even when the LLM only re-stamped `updated`. */
export function hasMeaningfulChange(oldContent: string, newContent: string): boolean {
  const oldDoc = parseFrontmatter(oldContent);
  const newDoc = parseFrontmatter(newContent);
  if (oldDoc.body !== newDoc.body) return true;
  const oldMeta = withoutAutoStamps(oldDoc.meta);
  const newMeta = withoutAutoStamps(newDoc.meta);
  return JSON.stringify(oldMeta) !== JSON.stringify(newMeta);
}

const AUTO_STAMP_KEYS = new Set(["updated", "editor"]);

function withoutAutoStamps(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!AUTO_STAMP_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** Internal — merge `created` / `updated` / `editor` into the
 *  outgoing content. Splits the caller's `content` so a body-only
 *  caller and a frontmatter-included caller both produce the
 *  same canonical envelope on disk. */
function stampFrontmatter(oldContent: string | null, newContent: string, meta: WikiWriteMeta, opts: WikiPageWriteOptions): string {
  const existingMeta = oldContent !== null ? parseFrontmatter(oldContent).meta : {};
  const incoming = parseFrontmatter(newContent);
  const now = (opts.now ?? (() => new Date()))();
  const merged = mergeFrontmatter(
    {
      ...existingMeta,
      // Caller's own frontmatter (if they passed any) layers on
      // top of the existing on-disk meta. Callers rarely do this,
      // but when manageWiki sends `---\ntitle: …\n---` we honour it.
      ...incoming.meta,
    },
    {
      // `created` is sticky: keep the existing one if any, else
      // stamp the date (no time — created is "first save day", not
      // "first save instant"). Use `existingMeta.created` so the
      // value isn't reset by an LLM that mistakenly reset it in
      // its incoming frontmatter.
      created: typeof existingMeta.created === "string" && existingMeta.created.length > 0 ? existingMeta.created : toIsoDate(now),
      // `updated` always bumps — full ISO timestamp with ms so
      // same-second writes still order correctly.
      updated: now.toISOString(),
      // `editor` reflects the call-site identity (PR #883). LLM /
      // user disambiguation lives at the API layer; placeholder
      // for now is fine.
      editor: meta.editor,
    },
  );
  return serializeWithFrontmatter(merged, incoming.body);
}

function toIsoDate(date: Date): string {
  // YYYY-MM-DD — sortable, locale-free, matches the issue body's
  // `created: 2026-04-26` example. UTC date deliberately so a
  // session that crosses midnight in the user's TZ doesn't get
  // two different `created` values.
  return date.toISOString().slice(0, 10);
}

/** Routing helper for the generic `/api/files/content` PUT.
 *  Returns `{ wiki: true, slug }` when `absPath` resolves directly
 *  under `data/wiki/pages/` AND ends in `.md`. Anything outside
 *  that exact shape (index.md, sources/, non-md, nested subdirs,
 *  paths that escape pagesDir via `..`) is `{ wiki: false }` and
 *  should fall back to the generic atomic write.
 *
 *  This function is **pure path-string math** — it does no symlink
 *  resolution. Callers MUST pass an already-realpath'd `absPath`
 *  AND an already-realpath'd `workspaceRoot` (or rely on the
 *  default, which mirrors `defaultWorkspacePath`). Mixing one
 *  realpath'd side with a symlinked other side is the trap that
 *  caused #883 review-iter-1 — a symlinked workspace would have
 *  silently routed wiki writes through the generic writer. */
export function classifyAsWikiPage(absPath: string, opts: WikiPageWriteOptions = {}): { wiki: true; slug: string } | { wiki: false } {
  const root = opts.workspaceRoot ?? defaultWorkspacePath;
  const pagesDir = path.join(root, WORKSPACE_DIRS.wikiPages);
  const slug = wikiSlugFromAbsPath(absPath, pagesDir);
  return slug === null ? { wiki: false } : { wiki: true, slug };
}

// Snapshot pipeline lives in `./snapshot.ts` (#763 PR 2). The
// indirection keeps `io.ts` focused on the page write contract;
// snapshot.ts owns retention policy, frontmatter shape, and the
// history dir layout.
