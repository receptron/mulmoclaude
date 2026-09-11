import { isNonEmptyString, isRecord } from "../../utils/types.js";
import { Router, Request, Response } from "express";
import { readdir, stat } from "fs/promises";
import { readTextSafe } from "../../utils/files/safe.js";
import { workspacePath } from "../../workspace/workspace.js";
import { WORKSPACE_PATHS } from "../../workspace/paths.js";
import { mulmoScriptOps } from "../../plugins/mulmoscript-server.js";
import {
  readSessionMeta as readSessionMetaIO,
  readSessionJsonl,
  sessionJsonlAbsPath,
  sessionMetaAbsPath,
  updateIsBookmarked,
  deleteSessionFiles,
} from "../../utils/files/session-io.js";
import { readManifest, removeSessionFromIndex } from "../../workspace/chat-index/indexer.js";
import type { ChatIndexEntry } from "../../workspace/chat-index/types.js";
import { markRead, getSession, evictSession, publishSessionsChanged } from "../../events/session-store/index.js";
import { notFound, type ApiResponse, type ErrorBody } from "../../utils/httpError.js";
import { singleLineForLog } from "../../utils/logPreview.js";
import { createStampedCache } from "../../utils/stampedCache.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { EVENT_TYPES } from "../../../src/types/events.js";
import { SESSION_ORIGINS, type SessionOrigin, type SessionSummary } from "../../../src/types/session.js";
import { env } from "../../system/env.js";
import { ONE_DAY_MS } from "../../utils/time.js";
import { encodeCursor, parseCursor, sessionChangeMs } from "./sessionsCursor.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../system/logger/index.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { parseSuppliedRoot } from "./mulmoScriptWriteRoot.js";

interface SessionMeta {
  roleId: string;
  startedAt: string;
  firstUserMessage?: string;
  hasUnread?: boolean;
  isBookmarked?: boolean;
  origin?: SessionOrigin;
  userQueryCount?: number;
}

/** The two fields every caller relies on. Both paths below already tested for
 *  them — one behind an `as` cast, one on a `JSON.parse` result typed `any`, so
 *  neither test actually narrowed anything. Same check, now load-bearing.
 *
 *  `isNonEmptyString`, not `typeof === "string"`: the checks this replaced were
 *  truthy tests, so a corrupt row like `{ roleId: "", startedAt: "" }` was
 *  skipped. A plain type check would start letting those through. */
function isSessionMeta(value: unknown): value is SessionMeta {
  return isRecord(value) && isNonEmptyString(value.roleId) && isNonEmptyString(value.startedAt);
}

async function readSessionMeta(__chatDir: string, sessionId: string): Promise<SessionMeta | null> {
  // Try new-style .json meta first
  const meta = await readSessionMetaIO(sessionId);
  if (isSessionMeta(meta)) return meta;
  // Legacy: read first line of .jsonl
  const jsonl = await readSessionJsonl(sessionId);
  if (jsonl) {
    const first = jsonl.split("\n").find(Boolean);
    if (first) {
      try {
        const parsed: unknown = JSON.parse(first);
        if (isSessionMeta(parsed)) return parsed;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

// Public response envelope for GET /api/sessions (issue #205).
//
// `cursor`     — opaque string clients echo back as `?since=` on the
//                next call to receive only sessions that have changed.
// `deletedIds` — always `[]` for now (no session-delete code path
//                exists yet). Kept in the shape so the client already
//                merges it; when deletion lands, populating this will
//                be a server-only change.
interface SessionsResponse {
  sessions: SessionSummary[];
  cursor: string;
  deletedIds: string[];
}

interface SessionsQuery {
  since?: string;
}

const router = Router();

// Sessions older than this are excluded from the listing. Set
// SESSIONS_LIST_WINDOW_DAYS to override (0 = no cutoff).
const WINDOW_MS = env.sessionsListWindowDays * ONE_DAY_MS;

interface SessionRowContext {
  chatDir: string;
  cutoff: number;
  indexById: Map<string, ChatIndexEntry>;
}

interface SessionRow {
  summary: SessionSummary;
  changeMs: number;
}

// Fold the live in-memory session state onto a summary. Extracted so
// `buildSessionSummary` stays under the cognitive-complexity threshold.
function applyLiveState(summary: SessionSummary, live: NonNullable<ReturnType<typeof getSession>>): void {
  // Background generations (image/audio/movie) keep the session "busy"
  // even when the agent turn has ended, so the sidebar indicator stays
  // lit across view navigation.
  summary.isRunning = live.isRunning || Object.keys(live.pendingGenerations).length > 0;
  // Narrow predicate — must stay byte-identical to the DELETE 409 gate
  // (`getSession(sessionId)?.isRunning`) so a caller polling this can
  // trust "false ⇒ DELETE will be accepted".
  summary.liveIsRunning = live.isRunning;
  summary.statusMessage = live.statusMessage;
}

// Build a SessionSummary from the gathered inputs. Conditional spreads
// honour the server tsconfig's `exactOptionalPropertyTypes`; that's
// why each optional field is set with `if (… !== undefined)` rather
// than spread into the object literal directly.
function buildSessionSummary(
  sessionId: string,
  meta: SessionMeta,
  indexEntry: ChatIndexEntry | undefined,
  fileStat: { mtimeMs: number },
  live: ReturnType<typeof getSession>,
): SessionSummary {
  // Prefer AI title → meta.firstUserMessage → empty.
  const preview = indexEntry?.title ?? meta.firstUserMessage ?? "";
  const summary: SessionSummary = {
    id: sessionId,
    roleId: meta.roleId,
    startedAt: meta.startedAt,
    updatedAt: new Date(fileStat.mtimeMs).toISOString(),
    preview,
    hasUnread: live?.hasUnread ?? meta.hasUnread ?? false,
  };
  if (meta.origin) summary.origin = meta.origin;
  if (meta.isBookmarked) summary.isBookmarked = true;
  if (typeof meta.userQueryCount === "number") summary.userQueryCount = meta.userQueryCount;
  if (indexEntry?.summary !== undefined) summary.summary = indexEntry.summary;
  if (indexEntry?.keywords !== undefined) summary.keywords = indexEntry.keywords;
  if (live) applyLiveState(summary, live);
  return summary;
}

// Load one session's row, or null when the session should be skipped
// (cutoff window, missing meta, any I/O error). The `metaMtimeMs`
// fallback lets a brand-new session contribute 0 to its changeMs
// instead of crashing the whole listing.
// Cached per session, keyed by the mtimes the scan stats anyway — a hit
// skips the meta read + JSON parse, and cannot serve a value the
// filesystem has changed underneath. Only the FILE-derived part is
// cached: `live` state and the chat-index entry move independently of
// those mtimes and are re-applied on every scan (#2588).
const metaCache = createStampedCache<SessionMeta>();

const metaStamp = (jsonlMtimeMs: number, metaMtimeMs: number): string => `${jsonlMtimeMs}:${metaMtimeMs}`;

/** Test seam. The cache outlives the chat directory, so a suite that wipes its
 *  fixtures between cases and rewrites the same session id at the same mtime
 *  would be served the previous case's meta — a stamp repeat that cannot
 *  happen in production, where every write moves the mtime forward. */
export function clearSessionMetaCache(): void {
  metaCache.clear();
}

/** The meta for one session, read only when its stamp has moved.
 *
 *  Both mtimes are in the stamp because `readSessionMeta` has two
 *  sources: the `.json` sidecar, and — when that is missing or corrupt —
 *  the first line of the `.jsonl`, which costs a read of the WHOLE
 *  transcript. Keying on the sidecar alone would leave that fallback
 *  paying full price on every request. */
async function cachedSessionMeta(sessionId: string, ctx: SessionRowContext, stamp: string): Promise<SessionMeta | null> {
  const hit = metaCache.get(sessionId, stamp);
  if (hit !== undefined) return hit;
  const meta = await readSessionMeta(ctx.chatDir, sessionId);
  // A null result is NOT cached: it means the sidecar is missing or
  // corrupt, and the mtimes that produced it may never move again, so a
  // negative entry could outlive a repair that rewrote neither file.
  if (meta) metaCache.set(sessionId, stamp, meta);
  return meta;
}

async function loadSessionRow(sessionId: string, ctx: SessionRowContext): Promise<SessionRow | null> {
  try {
    // stat only — no readFile on .jsonl content
    const fileStat = await stat(sessionJsonlAbsPath(sessionId));
    if (ctx.cutoff > 0 && fileStat.mtimeMs < ctx.cutoff) return null;

    // The meta sidecar bumps its mtime on hasUnread / origin writes —
    // feed it into changeMs so cursor-based refetches pick up drains
    // of background generations (which only touch meta, not the
    // jsonl). Stat'ed BEFORE the read so it can key the cache.
    const metaMtimeMs = await stat(sessionMetaAbsPath(sessionId))
      .then((stats) => stats.mtimeMs)
      .catch(() => 0);

    const meta = await cachedSessionMeta(sessionId, ctx, metaStamp(fileStat.mtimeMs, metaMtimeMs));
    if (!meta) return null;

    // Hidden worker sessions (spawnBackgroundChat `hidden: true`) are
    // internal plumbing, not conversations — exclude them from every
    // listing. This is the single choke point feeding both the list
    // route and the cursor diff (`loadAllSessions`).
    if (meta.origin === SESSION_ORIGINS.system) return null;

    const indexEntry = ctx.indexById.get(sessionId);
    const live = getSession(sessionId);
    return {
      summary: buildSessionSummary(sessionId, meta, indexEntry, fileStat, live),
      changeMs: sessionChangeMs(fileStat.mtimeMs, indexEntry?.indexedAt, metaMtimeMs),
    };
  } catch {
    return null;
  }
}

// Read the full session list off disk. Each row carries its
// `changeMs` — the later of the jsonl mtime and the chat-index
// `indexedAt` — so the handler can filter against `?since=` and
// compute the new cursor without re-statting anything.
export async function loadAllSessions(): Promise<SessionRow[]> {
  const chatDir = WORKSPACE_PATHS.chat;
  const manifest = await readManifest(workspacePath);
  const indexById = new Map<string, ChatIndexEntry>(manifest.entries.map((entry) => [entry.id, entry]));
  const cutoff = WINDOW_MS > 0 ? Date.now() - WINDOW_MS : 0;
  const ctx: SessionRowContext = { chatDir, cutoff, indexById };

  const files = (await readdir(chatDir)).filter((fileName) => fileName.endsWith(".jsonl"));
  const ids = files.map((file) => file.replace(".jsonl", ""));
  const rows = await Promise.all(ids.map((sessionId) => loadSessionRow(sessionId, ctx)));
  // Bound the cache by what is actually on disk, so a long-lived server
  // doesn't retain an entry per session ever deleted.
  metaCache.retainOnly(ids);
  return rows.filter((row): row is SessionRow => row !== null);
}

router.get(API_ROUTES.sessions.list, async (req: Request<object, SessionsResponse, object, SessionsQuery>, res: Response<SessionsResponse>) => {
  try {
    const sinceMs = parseCursor(req.query.since);
    log.info("sessions", "list: start", { sinceMs: sinceMs > 0 ? sinceMs : undefined });
    const rows = await loadAllSessions();

    // Cursor = max(changeMs) across every visible session, regardless
    // of whether it's in the diff. Echoing the same cursor back on an
    // empty diff (nothing changed since `?since=`) is fine; the
    // client no-ops.
    const maxChangeMs = rows.reduce((acc, row) => Math.max(acc, row.changeMs), 0);

    const filtered = sinceMs > 0 ? rows.filter((row) => row.changeMs > sinceMs) : rows;

    const sessions = filtered.map((row) => row.summary);
    sessions.sort((leftSession, rightSession) => {
      const byUpdated = new Date(rightSession.updatedAt).getTime() - new Date(leftSession.updatedAt).getTime();
      if (byUpdated !== 0) return byUpdated;
      return new Date(rightSession.startedAt).getTime() - new Date(leftSession.startedAt).getTime();
    });

    log.info("sessions", "list: ok", { total: sessions.length, returned: filtered.length });
    res.json({
      sessions,
      cursor: encodeCursor(maxChangeMs),
      // No session-delete code path exists today — issue #205 picked
      // approach A (tombstones) so the client already merges this
      // field; populating it becomes a server-only change when
      // deletion lands.
      deletedIds: [],
    });
  } catch (err) {
    log.error("sessions", "list: threw", { error: errorMessage(err) });
    res.json({ sessions: [], cursor: encodeCursor(0), deletedIds: [] });
  }
});

interface SessionIdParams {
  id: string;
}

// Narrow type predicate for the presentMulmoScript tool-result shape
// the enrichment helper inspects. Returning `entry is …` lets the
// caller drop the redundant nested checks once the predicate passes.
type PresentMulmoScriptToolResult = {
  source: "tool";
  type: string;
  result: { toolName: "presentMulmoScript"; data: { filePath: string } & Record<string, unknown> } & Record<string, unknown>;
} & Record<string, unknown>;

function isPresentMulmoScriptToolResult(entry: unknown): entry is PresentMulmoScriptToolResult {
  if (!isRecord(entry) || entry.source !== "tool" || entry.type !== EVENT_TYPES.toolResult) return false;
  const { result } = entry;
  if (!isRecord(result) || result.toolName !== "presentMulmoScript") return false;
  const { data } = result;
  // `root` is optional and stays UNTYPED here on purpose: this predicate decides whether an
  // entry is a mulmoScript result at all, and a corrupt root does not stop it being one. The
  // root is judged where it is used — `enrichWithMulmoScript` parses it and, when it is corrupt,
  // replays the entry as stored rather than filling it from the default root's deck.
  return isRecord(data) && typeof data.filePath === "string";
}

// Re-read the MulmoScript JSON pointed at by `entry.result.data.filePath`
// and merge it into a copy of the entry. Returns the original entry on
// any failure (missing file, traversal escape, parse error) so the detail
// route never breaks because of a single rotted link.
//
// Resolution goes through `mulmoScriptOps.resolveStory` rather than a
// second hand-rolled copy of the rules: it is what every other mulmoScript
// endpoint uses, so the file this refresh reads is by construction the file
// the tool would open — including for the absolute `filePath` form, whose
// edits would otherwise never survive a reload (the entry would keep
// replaying the script as it was when the tool call ran).
async function enrichWithMulmoScript(entry: PresentMulmoScriptToolResult): Promise<unknown> {
  try {
    // The PAIR, not the path: `stories/deck.json` exists in every registered stories root, so
    // rehydrating by path alone re-reads the DEFAULT root's file of that name and replays a
    // different deck into the session (#3014). `root` is what the card carries; absent = default.
    //
    // A stored root that is not a string is CORRUPT, not absent, so the entry is replayed as it
    // was rather than filled from the default root's identically-named deck — the same refusal
    // the REST readers make (#3077), reached here by this function's existing "return the entry
    // unchanged on any failure" contract rather than by an HTTP status.
    const { filePath, root } = entry.result.data;
    const parsedRoot = parseSuppliedRoot(root);
    if (!parsedRoot.ok) return entry;
    const resolved = mulmoScriptOps.resolveStory(filePath, parsedRoot.root);
    if (!resolved.ok) return entry;
    const scriptJson = (await readTextSafe(resolved.absolutePath)) ?? "";
    const script: unknown = JSON.parse(scriptJson);
    return {
      ...entry,
      result: {
        ...entry.result,
        data: {
          ...entry.result.data,
          script,
        },
      },
    };
  } catch {
    return entry;
  }
}

// Parse one JSONL line into a session entry, applying the legacy-meta
// skip and the presentMulmoScript enrichment in one place. Returns
// null when the line should not appear in the response (parse error
// or legacy meta).
async function parseSessionEntry(line: string): Promise<unknown> {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  // Skip legacy metadata entries now stored in .json. A non-object line
  // (JSON.parse can return a bare number/string) has no type field, so it
  // falls through unchanged — same as the previous optional-chaining path.
  if (isRecord(entry) && (entry.type === EVENT_TYPES.sessionMeta || entry.type === EVENT_TYPES.claudeSessionId)) return null;
  if (isPresentMulmoScriptToolResult(entry)) return enrichWithMulmoScript(entry);
  return entry;
}

router.get(API_ROUTES.sessions.detail, async (req: Request<SessionIdParams>, res: ApiResponse<unknown[]>) => {
  const { id: sessionId } = req.params;
  const sessionIdForLog = singleLineForLog(sessionId);
  const chatDir = WORKSPACE_PATHS.chat;
  log.info("sessions", "detail: start", { sessionId: sessionIdForLog });
  try {
    const meta = await readSessionMeta(chatDir, sessionId);
    const content = await readSessionJsonl(sessionId);
    if (!content) {
      log.warn("sessions", "detail: not found", { sessionId: sessionIdForLog });
      notFound(res, `Session ${sessionId} not found`);
      return;
    }
    const entries = (await Promise.all(content.split("\n").filter(Boolean).map(parseSessionEntry))).filter(Boolean);
    // Prepend metadata as session_meta entry for the frontend
    const result = meta ? [{ type: EVENT_TYPES.sessionMeta, ...meta }, ...entries] : entries;
    log.info("sessions", "detail: ok", { sessionId: sessionIdForLog, entries: result.length });
    res.json(result);
  } catch (err) {
    log.error("sessions", "detail: threw", { sessionId: sessionIdForLog, error: errorMessage(err) });
    notFound(res, "Session not found");
  }
});

// Mark a session as read (clears the hasUnread flag in the session store).
// Awaits persistence so the response only arrives after the disk write
// completes — prevents the client from refetching stale hasUnread values.
router.post(API_ROUTES.sessions.markRead, async (req: Request<SessionIdParams>, res: Response<{ ok: boolean }>) => {
  log.info("sessions", "mark-read: start", { sessionId: singleLineForLog(req.params.id) });
  await markRead(req.params.id);
  log.info("sessions", "mark-read: ok", { sessionId: singleLineForLog(req.params.id) });
  res.json({ ok: true });
});

// Toggle the user-set bookmark flag on a session's meta sidecar.
router.post(
  API_ROUTES.sessions.bookmark,
  asyncHandler<Request<SessionIdParams, { ok: boolean } | ErrorBody, { bookmarked: boolean }>, ApiResponse<{ ok: boolean }>>(
    "sessions",
    "Failed to update bookmark",
    async (req, res) => {
      const { id: sessionId } = req.params;
      const sessionIdForLog = singleLineForLog(sessionId);
      const bookmarked = Boolean(req.body?.bookmarked);
      log.info("sessions", "bookmark: start", { sessionId: sessionIdForLog, bookmarked });
      await updateIsBookmarked(sessionId, bookmarked);
      // Meta-mtime bumps on the write — cursor diff will pick up the
      // change on the next refetch — but every other tab also needs
      // to know to refetch right now.
      publishSessionsChanged();
      log.info("sessions", "bookmark: ok", { sessionId: sessionIdForLog, bookmarked });
      res.json({ ok: true });
    },
  ),
);

// Hard-delete a session: remove the jsonl, meta sidecar, AND the
// chat-index per-session file + manifest entry, then evict the
// in-memory store entry and broadcast `deletedIds` so every tab
// prunes its caches.
//
// Order matters:
//   1. Refuse if the session is currently running. The agent route
//      (server/api/routes/agent.ts) writes via `appendSessionLine` /
//      `endRun`; deleting the files out from under a live run would
//      either resurrect them or corrupt mid-stream state. Caller
//      should cancel first, then retry the delete.
//   2. Delete the on-disk artifacts (jsonl + meta + index entry +
//      manifest prune). If any of these throw we abort BEFORE
//      evicting / broadcasting, so clients don't see "session gone"
//      while the file lingers.
//   3. Only after disk is clean do we evict from the store and fire
//      `notifySessionsChanged({ deletedIds })`. Now the broadcast is
//      a truthful statement.
router.delete(
  API_ROUTES.sessions.detail,
  asyncHandler<Request<SessionIdParams>, ApiResponse<{ ok: boolean }>>("sessions", "Failed to delete session", async (req, res) => {
    const { id: sessionId } = req.params;
    const sessionIdForLog = singleLineForLog(sessionId);
    log.info("sessions", "delete: start", { sessionId: sessionIdForLog });
    if (getSession(sessionId)?.isRunning) {
      log.warn("sessions", "delete: refused — session running", { sessionId: sessionIdForLog });
      res.status(409).json({ error: "Session is running. Cancel the run before deleting." });
      return;
    }
    await deleteSessionFiles(sessionId);
    await removeSessionFromIndex(workspacePath, sessionId);
    evictSession(sessionId);
    log.info("sessions", "delete: ok", { sessionId: sessionIdForLog });
    res.json({ ok: true });
  }),
);

export default router;
