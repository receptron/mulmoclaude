// Wiki page edit-history routes (#763 PR 2). Three endpoints:
//
//   GET  /api/wiki/pages/:slug/history             — list snapshots (meta-only)
//   GET  /api/wiki/pages/:slug/history/:stamp      — read one snapshot
//   POST /api/wiki/pages/:slug/history/:stamp/restore — round-trip the
//     snapshot through `writeWikiPage` (which snapshots the restore
//     itself, so undo stays cheap).
//
// Path safety: both `:slug` and `:stamp` are validated *before*
// they are joined with the workspace root. The slug check is the
// shared `isSafeSlug` from `@mulmoclaude/core/wiki`; the stamp
// check is the `FILENAME_RE` shape exposed via `isSafeStamp`.

import { Router, type Request, type Response } from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TOOL_NAMES } from "../../../../src/config/toolNames.js";
import { hasMeaningfulChange, readWikiPage, writeWikiPage } from "../../../workspace/wiki-pages/io.js";
import { WORKSPACE_DIRS } from "../../../workspace/paths.js";
import { isSafeStamp, listSnapshots, readSnapshot, stripSnapshotMeta, type SnapshotContent } from "../../../workspace/wiki-pages/snapshot.js";
import { mergeFrontmatter, serializeWithFrontmatter } from "@mulmoclaude/markdown-utils/markdown/frontmatter";
import { badRequest, notFound } from "../../../utils/httpError.js";
import { workspacePath } from "../../../workspace/workspace.js";
import { pushToolResult } from "../../../events/session-store/index.js";
import { log } from "../../../system/logger/index.js";
import { singleLineForLog } from "../../../utils/logPreview.js";
import { errorMessage } from "../../../utils/errors.js";
import { isSafeSlug } from "@mulmoclaude/core/wiki";

const router = Router();

// Restore is a write under the user's workspace; record a short
// reason on the new snapshot so the history reads "Restored from
// 2026-04-28T01-23-45-789Z" rather than an empty cell. Editor stays
// `user` because the human triggered the restore — same shape as
// every other UI-driven save today.
function restoreReason(stamp: string): string {
  return `Restored from ${stamp}`;
}

// Re-build the previous snapshot's content as a single
// frontmatter+body string for `hasMeaningfulChange` to compare
// against. `_snapshot_*` keys are stripped first — those are
// snapshot-event metadata, not part of the page itself, and
// keeping them in the diff would always flag a difference.
async function loadPreviousSnapshotContent(slug: string): Promise<string | null> {
  const [mostRecent] = await listSnapshots(slug, { workspaceRoot: workspacePath });
  if (mostRecent === undefined) return null;
  const latest = await readSnapshot(slug, mostRecent.stamp, { workspaceRoot: workspacePath });
  if (latest === null) return null;
  return serializeWithFrontmatter(stripSnapshotMeta(latest.meta), latest.body);
}

router.get("/pages/:slug/history", async (req: Request<{ slug: string }>, res: Response) => {
  const { slug } = req.params;
  if (!isSafeSlug(slug)) {
    badRequest(res, "Unsafe slug");
    return;
  }
  // Don't gate on the live page existing. Snapshots are non-destructive
  // and outlive their page — gating here would make history disappear
  // exactly when the user needs it (deleted/renamed page → can't see
  // history → can't restore). An empty list still answers "no history"
  // unambiguously (codex review iter-2 #917).
  const snapshots = await listSnapshots(slug);
  res.json({ slug, snapshots });
});

// Validate `:slug`/`:stamp` and load the snapshot, or respond (400 for
// an unsafe param, 404 for a missing snapshot) and return null. Shared
// by the read and restore routes so the guard lives in one place.
async function resolveSnapshotOr4xx(req: Request<{ slug: string; stamp: string }>, res: Response): Promise<SnapshotContent | null> {
  const { slug, stamp } = req.params;
  if (!isSafeSlug(slug)) {
    badRequest(res, "Unsafe slug");
    return null;
  }
  if (!isSafeStamp(stamp)) {
    badRequest(res, "Unsafe stamp");
    return null;
  }
  const snapshot = await readSnapshot(slug, stamp);
  if (snapshot === null) {
    notFound(res, `snapshot not found: ${slug}/${stamp}`);
    return null;
  }
  return snapshot;
}

router.get("/pages/:slug/history/:stamp", async (req: Request<{ slug: string; stamp: string }>, res: Response) => {
  const snapshot = await resolveSnapshotOr4xx(req, res);
  if (!snapshot) return;
  res.json({ slug: req.params.slug, snapshot });
});

router.post("/pages/:slug/history/:stamp/restore", async (req: Request<{ slug: string; stamp: string }>, res: Response) => {
  const snapshot = await resolveSnapshotOr4xx(req, res);
  if (!snapshot) return;
  const { slug, stamp } = req.params;

  // Strip `_snapshot_*` keys before writing — they describe the
  // *original* save event and would be misleading on the restored
  // page. `writeWikiPage` will re-stamp `updated` and the new
  // snapshot will get a fresh `_snapshot_ts` for the restore event.
  const liveMeta = stripSnapshotMeta(snapshot.meta);
  const restoredContent = serializeWithFrontmatter(mergeFrontmatter({}, liveMeta), snapshot.body);

  // forceSnapshot=true so a "restore to identical content" still
  // produces an audit entry — without it the no-op gate in
  // writeWikiPage would swallow the restore silently.
  await writeWikiPage(slug, restoredContent, {
    editor: "user",
    reason: restoreReason(stamp),
    forceSnapshot: true,
  });
  log.info("wiki", "history restore", { slug: singleLineForLog(slug), stamp: singleLineForLog(stamp) });
  res.json({ slug, restored: { fromStamp: stamp } });
});

// ── Internal endpoint (LLM write hook callback) ────────────────
//
// Hit by `<workspace>/.claude/hooks/wiki-snapshot.mjs` after the
// claude CLI completes a `Write` / `Edit` tool call. The hook
// computes the slug from the file path it just touched and
// passes it here; the server resolves the slug to its OWN
// `data/wiki/pages/` filesystem location, reads disk state, and
// drops a snapshot through the same `appendSnapshot` path the
// in-process writers use. Always tagged `editor: "llm"` —
// user-driven writes go through the regular `writeWikiPage`
// path with their own editor identity.
//
// Why slug-not-absPath: in Docker mode the hook runs inside the
// container where the workspace lives at `/home/node/mulmoclaude/`
// while the server (running on the host) sees the same files at
// `/Users/<user>/mulmoclaude/`. Sending the absolute path forces
// either side to translate; sending the slug lets each side keep
// its own filesystem view.
//
// `sessionId` lets the snapshot carry the chat-session identifier
// that drove the write, surfaced from Claude CLI's `session_id`
// hook payload field. There is no `reason` — the LLM doesn't
// supply one, and in-process callers (writeWikiPage) attach
// their own reasons through `WikiWriteMeta` directly.
//
// Bearer auth applies via the global `app.use("/api", bearerAuth)`
// in server/index.ts; no extra check needed here.

interface InternalSnapshotBody {
  slug?: string;
  sessionId?: string;
}

// Stage 3a (#963): publish a synthetic `manageWiki` toolResult
// into the session timeline so the canvas shows what the LLM
// just wrote. The View dispatch (existing manageWiki plugin)
// picks up the new `page-edit` action and fetches the snapshot
// body via /api/wiki/pages/:slug/history/:stamp on render —
// JSONL stays small (~150 bytes per write) because we store
// the snapshot reference, not the body. `pagePath` is a GC
// fallback: if the snapshot is gc'd before render, the View
// falls back to reading the live page file.
// Wrapped in try/catch so a publish failure (e.g. JSONL append
// throws) doesn't fail the whole route — the snapshot was
// already written, and the hook is fire-and-forget. Without
// this guard the route would 500 even though the wiki write
// itself succeeded; the next save would still snapshot fine,
// but the canvas would silently lose this one preview
// (CodeRabbit review).
async function publishPageEditToolResult(sessionId: string, slug: string, stamp: string): Promise<void> {
  try {
    const outcome = await pushToolResult(sessionId, {
      uuid: randomUUID(),
      toolName: TOOL_NAMES.manageWiki,
      data: {
        // `"page-edit"` is the action discriminator the wiki
        // plugin's `View.vue` switches on. It's repeated in the
        // plugin and in `src/plugins/wiki/pageEditLoader.ts`; a
        // shared `WIKI_ACTIONS` const would be the cleaner home
        // but that's a multi-file refactor — out of scope for
        // this CR follow-up.
        action: "page-edit",
        title: slug,
        slug,
        stamp,
        pagePath: path.posix.join(WORKSPACE_DIRS.wikiPages, `${slug}.md`),
      },
    });
    if (outcome.kind === "skipped") {
      log.warn("wiki", "page-edit toolResult publish skipped", { slug: singleLineForLog(slug), reason: outcome.reason });
    }
  } catch (err) {
    log.warn("wiki", "page-edit toolResult publish failed", {
      slug,
      error: errorMessage(err),
    });
  }
}

async function handleInternalSnapshot(req: Request<object, unknown, InternalSnapshotBody>, res: Response): Promise<void> {
  const { slug, sessionId } = req.body ?? {};
  if (typeof slug !== "string" || slug.length === 0) {
    badRequest(res, "slug required");
    return;
  }
  if (!isSafeSlug(slug)) {
    badRequest(res, "slug is not safe");
    return;
  }

  const content = await readWikiPage(slug, { workspaceRoot: workspacePath });
  if (content === null) {
    notFound(res, "wiki page not found on disk");
    return;
  }

  // Dedupe against the most recent snapshot — Write/Edit hooks
  // fire for every tool call, including ones that only re-stamp
  // `updated` / `editor` without touching the body. Without this
  // guard the history page accumulates duplicate entries (user
  // report 2026-04-30: two identical bodies snapped 2.6s apart).
  // `hasMeaningfulChange` already drives the in-process
  // `writeWikiPage` path; reusing it keeps both paths aligned.
  const previousContent = await loadPreviousSnapshotContent(slug);
  if (previousContent !== null && !hasMeaningfulChange(previousContent, content)) {
    log.info("wiki", "internal snapshot skipped — no meaningful change since previous snapshot", { slug: singleLineForLog(slug) });
    res.json({ slug, ok: true, skipped: "no-meaningful-change" });
    return;
  }

  // The hook only fires for claude-CLI-driven writes — by
  // construction the agent is the actor. User-driven manual saves
  // go through writeWikiPage in-process and never reach here.
  const { appendSnapshot } = await import("../../../workspace/wiki-pages/snapshot.js");
  const stamp = await appendSnapshot(
    slug,
    null,
    content,
    {
      editor: "llm",
      ...(typeof sessionId === "string" && sessionId.length > 0 && { sessionId }),
    },
    { workspaceRoot: workspacePath },
  );
  log.info("wiki", "internal snapshot recorded", { slug: singleLineForLog(slug) });

  if (typeof sessionId === "string" && sessionId.length > 0) {
    await publishPageEditToolResult(sessionId, slug, stamp);
  }

  res.json({ slug, ok: true });
}

router.post("/internal/snapshot", async (req: Request<object, unknown, InternalSnapshotBody>, res: Response) => handleInternalSnapshot(req, res));

export default router;
