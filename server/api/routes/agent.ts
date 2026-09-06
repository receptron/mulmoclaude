import { randomUUID } from "node:crypto";
import { Router, Request, Response } from "express";
import { getSessionQuery } from "../../utils/request.js";
import {
  createSessionMeta,
  backfillFirstUserMessage as backfillMeta,
  backfillOrigin,
  incrementUserQueryCount,
  readSessionMetaFull,
  readSessionMeta,
  setClaudeSessionId as setClaudeId,
  clearClaudeSessionId as clearClaudeId,
  appendSessionLine,
  readSessionJsonl,
  sessionJsonlAbsPath,
  ensureChatDir,
  deleteSessionFiles,
} from "../../utils/files/session-io.js";
import { getRole } from "../../workspace/roles.js";
import { runAgent } from "../../agent/index.js";
import { INJECTED_TEXT } from "../../agent/stream.js";
import { notifyTaskFinished } from "../../agent/webPush.js";
import { buildTranscriptPreamble } from "../../agent/resumeFailover.js";
import {
  abortableSleep,
  awaitBrokerReady,
  BROKER_READY_DECISION_WINDOW_MS,
  BROKER_RECONNECT_WAIT_MS,
  detectRecovery,
  judgeBrokerReplay,
  type RecoveryKind,
  type RetryBudgets,
} from "../../agent/retryPolicy.js";
import { getBrokerReady, getCurrentBrokerSpawn } from "../../agent/brokerReadiness.js";
import {
  recordPushReply,
  splitSkillAndReply,
  updatePendingSkillOnToolCall,
  updatePendingSkillOnToolCallResult,
  type PendingSkill,
} from "../../agent/skillEvents.js";
import { decorateMessageForCli, sanitiseOriginalFilename, type AttachedFile } from "../../agent/messageDecorate.js";
import { getOrCreateSession, beginRun, endRun, cancelRun, pushSessionEvent, pushToolResult, getActiveSessionIds } from "../../events/session-store/index.js";
import { workspacePath } from "../../workspace/workspace.js";
import { discoverSkills } from "../../workspace/skills/discovery.js";
import type { Skill } from "../../workspace/skills/types.js";
import { isNonEmptyString } from "../../utils/types.js";
import { findLastSessionEntry } from "../../utils/sessionJsonl.js";
import { maybeRunJournal } from "../../workspace/journal/index.js";
import { maybeIndexSession } from "../../workspace/chat-index/index.js";
import { maybeAppendWikiBacklinks } from "../../workspace/wiki-backlinks/index.js";
import { log } from "../../system/logger/index.js";
import { logBackgroundError } from "../../utils/logBackgroundError.js";
import { errorMessage } from "../../utils/errors.js";
import { createArgsCache, recordToolEvent } from "../../workspace/tool-trace/index.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { EVENT_TYPES } from "../../../src/types/events.js";
import { isSessionOrigin, SESSION_ORIGINS, type SessionOrigin } from "../../../src/types/session.js";
import {
  tryReserveBackgroundSession,
  releaseBackgroundSession,
  registerCompletionHook,
  runCompletionHook,
  MAX_BACKGROUND_SESSIONS,
  type CompletionHook,
} from "../../agent/backgroundSessions.js";
// Imports kept commented (instead of deleted) alongside the
// publishNotification call in `runPostTurnSideEffects` — see the
// duplicate-notification comment there for context. (`SESSION_ORIGINS`
// is now imported live above — the hidden-worker branch in
// `runAgentInBackground` references it.)
// (by snakajima)
// import { NOTIFICATION_KINDS } from "../../../src/types/notification.js";
// import { publishNotification } from "../../events/notifications.js";
import { getBoundPort } from "../../workspace/serverPort.js";
import type { Attachment } from "@mulmobridge/protocol";
import type { StartChatParams as ChatServiceStartChatParams } from "@mulmobridge/chat-service";
import { isImagePath, loadImageBase64 } from "../../utils/files/image-store.js";
import { isAttachmentPath, loadAttachmentBase64, inferMimeFromExtension, saveAttachment } from "../../utils/files/attachment-store.js";

const router = Router();
// The port the server actually BOUND, read per-call rather than frozen at
// module load: a second instance walks forward off a busy default, and the
// broker we spawn addresses this port (#3055). `env.port` would send it to
// whichever instance owns the requested port instead.

// Short, safe preview of tool args for logs. Full payload may contain
// base64 images or large blobs, so we cap it. The goal is to make a
// line like `mcp__deepwiki__read_wiki_contents` grep-able in logs
// alongside its args shape, not to record the full input.
const TOOL_ARGS_LOG_PREVIEW_MAX = 200;
// Enough of an unexpected injection to recognise its shape in a log line
// without dumping a whole SKILL.md-sized body into it.
const INJECTED_TEXT_LOG_PREVIEW_MAX = 80;
function previewJson(value: unknown): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(value);
  } catch {
    return "[unserialisable]";
  }
  if (serialised === undefined) return "";
  return serialised.length > TOOL_ARGS_LOG_PREVIEW_MAX ? `${serialised.slice(0, TOOL_ARGS_LOG_PREVIEW_MAX)}…` : serialised;
}

// Called by the MCP server to push a ToolResult into the active session.
interface OkResponse {
  ok: boolean;
}

router.post(API_ROUTES.agent.internal.toolResult, async (req: Request<object, unknown, Record<string, unknown>>, res: Response<OkResponse>) => {
  const chatSessionId = getSessionQuery(req);
  const outcome = await pushToolResult(chatSessionId, req.body);
  res.json({ ok: outcome.kind === "processed" });
});

// Cancel a running agent session by killing the Claude CLI process.
interface CancelBody {
  chatSessionId: string;
}

router.post(API_ROUTES.agent.cancel, (req: Request<object, unknown, CancelBody>, res: Response<OkResponse>) => {
  const { chatSessionId } = req.body;
  if (!chatSessionId) {
    res.json({ ok: false });
    return;
  }
  const ok = cancelRun(chatSessionId);
  res.json({ ok });
});

// ── Internal API: startChat ─────────────────────────────────────────
//
// Shared entry point for starting an agent chat. Called by both the
// POST /api/agent route and server-side callers (e.g. debug tasks).

export interface StartChatParams extends ChatServiceStartChatParams {
  /** IANA timezone the user's browser resolved (e.g. "Asia/Tokyo").
   *  Validated server-side before it reaches the system prompt — an
   *  invalid or missing value falls back to server-local time. */
  userTimezone?: string | undefined;
}

export type StartChatResult = { kind: "started"; chatSessionId: string } | { kind: "error"; error: string; status?: number };

/** Outcome of launching a worker session. */
export type SpawnSystemWorkerResult = { ok: true; chatId: string } | { ok: false; error: string };

// Launch a host-side worker session. `hidden` decides visibility:
//   - true  → origin `system`: never appears in the session list, runaway-cap
//             reserved, `finalizeRun` invokes the completion hook + cleans up.
//             Used for SCHEDULED agent-ingest refreshes (no one is watching).
//   - false → origin `skill`: a normal visible chat the user can open from
//             history, no cap, NO completion hook (the user watches it run
//             directly). Used for a MANUAL Refresh-button refresh so it's
//             debuggable.
// Exported so non-MCP host callers (the agent-ingest engine, wired in via
// `setAgentWorkerRunner`) can spawn one without going through the tool layer.
export async function spawnSystemWorker(args: {
  message: string;
  roleId: string;
  hidden: boolean;
  /** Path-bearing attachments to hand the spawned chat (e.g. files the mobile
   *  remote attached, ingested into the workspace). Forwarded to `startChat`,
   *  which loads their bytes for the model like any other attachment. */
  attachments?: Attachment[] | undefined;
  onComplete?: CompletionHook | undefined;
}): Promise<SpawnSystemWorkerResult> {
  const chatId = randomUUID();
  const origin: SessionOrigin = args.hidden ? SESSION_ORIGINS.system : SESSION_ORIGINS.skill;
  // The runaway cap guards hidden workers only — a visible run is user-initiated
  // and self-limiting. Reserve ATOMICALLY before launching; rolled back below if
  // the launch fails (otherwise released in `runAgentInBackground`'s finally).
  if (args.hidden && !tryReserveBackgroundSession(chatId)) {
    return { ok: false, error: `too many background sessions already in flight (max ${MAX_BACKGROUND_SESSIONS})` };
  }
  let result: StartChatResult;
  try {
    result = await startChat({ message: args.message, roleId: args.roleId, chatSessionId: chatId, origin, attachments: args.attachments });
  } catch (err) {
    // `startChat` is normally fire-and-forget, but a synchronous setup failure
    // can reject — release the reservation so the slot isn't leaked until restart.
    if (args.hidden) releaseBackgroundSession(chatId);
    return { ok: false, error: errorMessage(err) };
  }
  if (result.kind === "error") {
    if (args.hidden) releaseBackgroundSession(chatId); // roll back the reservation
    return { ok: false, error: result.error };
  }
  // Register the completion hook AFTER a successful launch (the subprocess can't
  // finish before this synchronous code returns, so `finalizeRun` won't miss
  // it). Only hidden (system) sessions run it — `finalizeRun` skips the hook for
  // visible origins, which take the normal post-turn path instead.
  if (args.hidden && args.onComplete) registerCompletionHook(chatId, args.onComplete);
  return { ok: true, chatId };
}

export async function startChat(params: StartChatParams): Promise<StartChatResult> {
  const { message, roleId, chatSessionId, selectedImageData, attachments } = params;
  // Bridge-only compat: external bridge clients may still populate
  // `selectedImageData`. Fold it into `attachments` so the rest of
  // this function only deals with one input shape.
  const normalisedAttachments = mergeBridgeSelectedImage(selectedImageData, attachments);

  if (!message || !roleId || !chatSessionId) {
    return {
      kind: "error",
      error: "message, roleId, and chatSessionId are required",
      status: 400,
    };
  }

  ensureChatDir();
  const resultsFilePath = sessionJsonlAbsPath(chatSessionId);

  // Discriminate missing (first turn) from corrupt (warn, don't clobber).
  const metaResult = await readSessionMetaFull(chatSessionId);
  const isFirstTurn = metaResult.kind === "missing";
  if (metaResult.kind === "corrupt") {
    log.warn("agent", "session meta is corrupt — treating as existing", {
      chatSessionId,
    });
  }
  const persistedHasUnread = metaResult.kind === "ok" && metaResult.meta.hasUnread === true ? true : undefined;

  const now = new Date().toISOString();
  getOrCreateSession(chatSessionId, {
    roleId,
    resultsFilePath,
    startedAt: now,
    updatedAt: now,
    hasUnread: persistedHasUnread,
  });

  // Register abort callback and mark running FIRST. If the session
  // is already running, reject with 409 before we persist anything.
  // Writing the user message to jsonl or broadcasting it before this
  // check leaves an orphan message on disk + in every viewing tab
  // when the run is rejected — see #281.
  const abortController = new AbortController();
  const started = beginRun(chatSessionId, () => abortController.abort());
  if (!started) {
    return { kind: "error", error: "Session is already running", status: 409 };
  }

  // Run is committed. Process attachments next so any failure here
  // rolls the run back via `endRun` before we persist or broadcast a
  // user message — leaving an orphan turn on disk when the request
  // ultimately rejects would mislead every viewer of this session.
  // Three things happen in this block, all guarded together:
  //   1. Bridge inline-bytes (`{ data, mimeType }`) get saved to
  //      `data/attachments/YYYY/MM/` and rewritten as path-bearing
  //      attachments. After this every Attachment has a `path`.
  //   2. `collectAttachedPaths` extracts the workspace paths to
  //      persist on the user JSONL line and broadcast on the SSE
  //      event so the UI can render chips for the turn.
  //   3. `prepareRequestExtras` loads bytes off disk for the LLM
  //      request. With (1) above this is now a pure path-only walk.
  // A malformed body (e.g. `attachments` not an array) or a
  // filesystem I/O failure is logged and converted to a 400 here;
  // beginRun is rolled back so subsequent turns aren't rejected with
  // 409 forever.
  let attachedFiles: AttachedFile[];
  let extras: RequestExtras;
  try {
    const persistedAttachments = await persistInlineBytesAsPaths(normalisedAttachments);
    attachedFiles = collectAttachedFiles(persistedAttachments);
    extras = await prepareRequestExtras(persistedAttachments);
  } catch (err) {
    log.warn("agent", "attachment processing failed — rolling back run", { chatSessionId, error: errorMessage(err) });
    abortController.abort();
    endRun(chatSessionId);
    return { kind: "error", error: "Invalid attachments payload", status: 400 };
  }

  const validOrigin = await persistUserTurn(params, { isFirstTurn, attachedFiles });
  await dispatchAgentRun(params, { extras, resultsFilePath, abortController, validOrigin });

  return { kind: "started", chatSessionId };
}

// ── Helpers ──────────────────────────────────────────────────────────

// Persist the user turn: write session metadata, count the query,
// append the user message to the jsonl, and broadcast it to other
// tabs viewing this session. Returns the validated origin so the
// dispatch phase can reuse it.
async function persistUserTurn(params: StartChatParams, ctx: { isFirstTurn: boolean; attachedFiles: AttachedFile[] }): Promise<SessionOrigin | undefined> {
  const { message, roleId, chatSessionId } = params;
  const { isFirstTurn, attachedFiles } = ctx;

  // Now persist the user message so callers (and other tabs) see the
  // turn. Metadata first — it powers the sidebar title cache; the
  // append follows so the jsonl is always a superset of what metadata
  // advertised.
  const validOrigin = isSessionOrigin(params.origin) ? params.origin : undefined;
  if (isFirstTurn) {
    await createSessionMeta(chatSessionId, roleId, message, undefined, validOrigin);
  } else {
    await backfillMeta(chatSessionId, message);
    if (validOrigin) {
      await backfillOrigin(chatSessionId, validOrigin);
    }
  }
  // Count this user turn (createSessionMeta seeds no count, so the first
  // turn bumps undefined→1). Lets the sidebar tell a one-shot apart from
  // a long conversation.
  await incrementUserQueryCount(chatSessionId);

  // Append user message for this turn. `attachments` holds objects since
  // #2308; a session written before that holds bare path strings, which is
  // why every reader goes through `normalizeAttachments` rather than
  // indexing the array.
  const attachmentsField = attachedFiles.length > 0 ? { attachments: attachedFiles } : {};
  await appendSessionLine(chatSessionId, JSON.stringify({ source: "user", type: EVENT_TYPES.text, message, ...attachmentsField }));

  // Broadcast the user message so other tabs viewing this session
  // see the input in real time. Runs AFTER beginRun so a 409 never
  // produces a phantom user message in other clients.
  pushSessionEvent(chatSessionId, {
    type: EVENT_TYPES.text,
    source: "user",
    message,
    ...attachmentsField,
  });

  return validOrigin;
}

// Build the LLM-bound message (see decorateMessageForCli) and kick
// off the detached background agent run. The background run itself is
// fire-and-forget; this awaits only the claudeSessionId read that must
// precede it (its presence decides whether the journal pointer is added).
async function dispatchAgentRun(
  params: StartChatParams,
  ctx: { extras: RequestExtras; resultsFilePath: string; abortController: AbortController; validOrigin: SessionOrigin | undefined },
): Promise<void> {
  const { message, roleId, chatSessionId, userTimezone } = params;
  const { extras, resultsFilePath, abortController, validOrigin } = ctx;

  const role = getRole(roleId);
  const claudeSessionId = await readClaudeSessionIdFromSession(chatSessionId);

  const requestStartedAt = Date.now();
  log.info("agent", "request received", {
    chatSessionId,
    roleId,
    messageLen: message.length,
    resumed: Boolean(claudeSessionId),
  });

  const decoratedMessage = decorateMessageForCli({
    message,
    workspaceDir: workspacePath,
    attachedFiles: extras.attachedFiles,
    resumed: Boolean(claudeSessionId),
  });

  // Deliberately not awaited — the request returns the SSE stream immediately
  // and the run continues past it. The terminal `.catch` is the safety net for
  // anything its own try/catch/finally misses; a bare `void` would only hide
  // such a failure from the linter, not from the process.
  //
  // BEHAVIOUR NOTE, revisit if the supervisor story changes: before this
  // `.catch` existed, a rejection escaping `runAgentInBackground` reached the
  // process-level `unhandledRejection` handler in server/index.ts, which logs
  // and `process.exit(1)` — one failed background run bounced the whole
  // server, taking every other session's SSE stream with it. Catching keeps
  // those sessions alive, at the cost of staying up after a failure a
  // supervisor restart would have cleared. To return to fail-fast, rethrow
  // from the handler.
  runAgentInBackground({
    decoratedMessage,
    role,
    chatSessionId,
    claudeSessionId,
    abortSignal: abortController.signal,
    resultsFilePath,
    requestStartedAt,
    toolArgsCache: createArgsCache(),
    attachments: extras.attachments,
    userTimezone,
    origin: validOrigin,
  }).catch(logBackgroundError("agent", "background agent run failed"));
}

interface RequestExtras {
  attachments: Attachment[] | undefined;
  /** Every file the user attached or selected for this turn, in
   *  declaration order. Surfaced to the LLM via one
   *  `[Attached file: <path>]` line per entry, prepended to the user
   *  message so path-passing tools (e.g. `editImages`) and the LLM
   *  itself can reference each file by path. Entries that carry the
   *  name the file had on the user's machine also announce it, so the
   *  model can save a result back under that name (#2308).
   *  `persistInlineBytesAsPaths` ensures every well-formed attachment
   *  carries a path before this runs, so this is empty only when the
   *  request had no attachments at all (or every entry was malformed
   *  and dropped). */
  attachedFiles: AttachedFile[];
}

/** Pluck the attached files out of `attachments[]`. Used for
 *  persistence + broadcast of the user message: the Vue UI renders
 *  these as attachment chips next to the chat bubble, labelled with
 *  `filename` when the upload carried one — the stored basename is a
 *  hex id, so without it the history shows `b458a5d0.csv` for a file
 *  the user knows as `商品カタログ_v2.csv` (#2308).
 *  `persistInlineBytesAsPaths` runs first, so by the time we get
 *  here every well-formed entry already carries a `path` and chips
 *  round-trip for bridge attachments too — not just Vue uploads.
 *  Order matches declaration order so chip order matches the order
 *  the user attached them.
 *
 *  Each path is validated against the same allow-list `loadFromPath`
 *  uses (`data/attachments/...` or `artifacts/images/...png`). A
 *  request can otherwise pin a bogus path on the chat record + SSE
 *  + LLM marker even though `loadFromPath` would refuse to read it
 *  (#1052 review).
 *
 *  Defensive: `Array.isArray` guards against a malformed HTTP body
 *  where `attachments` is a truthy non-array. Without it `for...of`
 *  would throw and bypass the rollback path that calls `endRun`,
 *  leaving the session locked as running (#1052 review). */
export function collectAttachedFiles(attachments: Attachment[] | undefined): AttachedFile[] {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const files: AttachedFile[] = [];
  for (const att of attachments) {
    if (typeof att.path !== "string" || att.path.length === 0) continue;
    if (!isAttachmentPath(att.path) && !isImagePath(att.path)) continue;
    // Same gate as the LLM marker, deliberately: a name we refuse to tell
    // the model must not be what the chip claims the file is called, or
    // the user and the agent end up discussing different filenames.
    const filename = sanitiseOriginalFilename(att.filename);
    files.push({ path: att.path, ...(filename ? { filename } : {}) });
  }
  return files;
}

/** Bridge-only compat: external bridge clients may still ship a
 *  picked image via `StartChatParams.selectedImageData`. Convert
 *  that single value to a synthetic `Attachment` and prepend it to
 *  the explicit `attachments` array so downstream code only has to
 *  understand one input shape. The Vue UI never reaches this branch
 *  — it sends path-only attachments directly. */
function mergeBridgeSelectedImage(selectedImageData: string | undefined, attachments: Attachment[] | undefined): Attachment[] | undefined {
  const synthetic = synthesiseBridgeAttachment(selectedImageData);
  if (!synthetic) return Array.isArray(attachments) ? attachments : undefined;
  return Array.isArray(attachments) && attachments.length > 0 ? [synthetic, ...attachments] : [synthetic];
}

/** Convert a legacy `selectedImageData` carrier to an `Attachment`.
 *  Only workspace paths (`data/attachments/...` or `artifacts/images/
 *  ...`) are accepted — `data:` URLs are no longer supported. A
 *  bridge that still wants to ship raw bytes should populate the
 *  modern `attachments[]` field with `{ mimeType, data }` instead;
 *  `persistInlineBytesAsPaths` then writes those to
 *  `data/attachments/YYYY/MM/` and turns them into path-bearing
 *  entries before any other processing. */
function synthesiseBridgeAttachment(selectedImageData: string | undefined): Attachment | undefined {
  if (!selectedImageData) return undefined;
  if (isAttachmentPath(selectedImageData) || isImagePath(selectedImageData)) {
    return { path: selectedImageData };
  }
  log.warn("agent", "bridge selectedImageData is not a workspace path — dropping (data: URLs are no longer supported)", {
    valuePreview: selectedImageData.slice(0, 64),
  });
  return undefined;
}

/** Persist any inline-bytes attachment to disk as a path-bearing
 *  entry. Bridges over the socket transport (Telegram, LINE, ...)
 *  ship raw bytes via `Attachment.data` + `Attachment.mimeType`; the
 *  Vue UI uploads to disk before posting and already carries a
 *  `path`. By rewriting inline bytes into
 *  `data/attachments/YYYY/MM/<id>.<ext>` here we get two properties
 *  the rest of the pipeline relies on:
 *
 *    1. Every well-formed attachment carries a workspace path, so
 *       chips can round-trip for bridge turns the same way they do
 *       for Vue paste/drop turns (no `data:` chips, no special
 *       cases downstream).
 *    2. `prepareRequestExtras` becomes a path-only walk — the inline
 *       (`{ data, mimeType }`) shape no longer flows past this layer.
 *
 *  Defensive: `Array.isArray` mirrors the guard in
 *  `collectAttachedPaths` so a malformed payload doesn't throw and
 *  bypass `endRun`. A failed save bubbles up so the caller can
 *  reject the turn — silently dropping the file would persist the
 *  user message without the attachment they sent and breaks the
 *  persistence/broadcast contract this layer is enforcing (#1052
 *  review). The caller's try/catch wraps the whole attachment-prep
 *  block and rolls the run back via `endRun`, so the failure path
 *  is well-defined: the user gets a 400, the session unlocks, and
 *  no orphan turn lands in jsonl. Entries with neither path nor
 *  inline bytes are still dropped (warn) — that's a malformed entry,
 *  not an I/O failure. */
async function persistInlineBytesAsPaths(attachments: Attachment[] | undefined): Promise<Attachment[] | undefined> {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  const result: Attachment[] = [];
  for (const att of attachments) {
    if (typeof att.path === "string" && att.path.length > 0) {
      result.push(att);
      continue;
    }
    if (typeof att.data === "string" && att.data.length > 0 && typeof att.mimeType === "string" && att.mimeType.length > 0) {
      const saved = await saveAttachment(att.data, att.mimeType);
      // Carry `filename` across the rewrite. Bridges that know the
      // sender's filename already send it (Telegram documents pass
      // `doc.file_name`), and dropping it here is what kept the name
      // from ever reaching the model (#2308).
      result.push({ path: saved.relativePath, mimeType: saved.mimeType, ...(att.filename ? { filename: att.filename } : {}) });
      continue;
    }
    log.warn("agent", "attachment has neither path nor inline bytes — dropping");
  }
  return result.length > 0 ? result : undefined;
}

/** Walk `attachments[]` once, loading bytes from disk for every
 *  path-bearing entry, and collect every path so the caller can emit
 *  one `[Attached file: <path>]` marker per file. Two path roots
 *  are accepted:
 *
 *    - `data/attachments/...` — paste/drop/file-picker uploads (any
 *      MIME type from the chat input's accept list) and the persisted
 *      form of bridge inline-bytes attachments. MIME is inferred from
 *      the extension chosen at save time.
 *    - `artifacts/images/...png` — generated / canvas / edited images
 *      a user picked from the sidebar. Always image/png.
 *
 *  Bytes are loaded so Claude still "sees" each file as a content
 *  block on this turn, AND every path is returned separately so the
 *  caller marks them in the LLM-bound message. If a file can't be
 *  read, its path hint is still emitted — the LLM knows what was
 *  attached and can call Read to load it. Multi-file flows (e.g.
 *  paste one image + pick another in the sidebar → "combine these")
 *  rely on every path showing up in the marker so `editImages` can
 *  receive the full list in `imagePaths`.
 *
 *  Inline (`{ data, mimeType }`) entries no longer reach this layer —
 *  `persistInlineBytesAsPaths` rewrites them as path-bearing entries
 *  before this runs. */
export async function prepareRequestExtras(attachments: Attachment[] | undefined): Promise<RequestExtras> {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { attachments: undefined, attachedFiles: [] };
  }
  const result: Attachment[] = [];
  const attachedFiles: AttachedFile[] = [];
  for (const att of attachments) {
    if (typeof att.path !== "string" || att.path.length === 0) {
      log.warn("agent", "attachment has no path after normalisation — dropping");
      continue;
    }
    const resolved = await loadFromPath(att.path, att.mimeType);
    if (!resolved) continue;
    // Only emit the `[Attached file: …]` marker when the file was
    // actually loaded — otherwise the LLM gets told a bogus path
    // exists (Codex review on PR #1084 follow-up to #1052).
    result.push(resolved);
    attachedFiles.push({ path: att.path, ...(att.filename ? { filename: att.filename } : {}) });
  }
  return {
    attachments: result.length > 0 ? result : undefined,
    attachedFiles,
  };
}

async function loadFromPath(value: string, declaredMimeType: string | undefined): Promise<Attachment | undefined> {
  if (isAttachmentPath(value)) return loadAttachmentFromPath(value, declaredMimeType);
  if (isImagePath(value)) return loadImageFromPath(value, declaredMimeType);
  log.warn("agent", "attachment path is outside allowed roots — dropping", { path: value });
  return undefined;
}

async function loadAttachmentFromPath(value: string, declaredMimeType: string | undefined): Promise<Attachment | undefined> {
  const mimeType = declaredMimeType ?? inferMimeFromExtension(value);
  if (!mimeType) {
    log.warn("agent", "attachment path has unknown extension — skipping bytes", { path: value });
    return undefined;
  }
  try {
    const data = await loadAttachmentBase64(value);
    return { mimeType, data, path: value };
  } catch (err) {
    log.warn("agent", "failed to load attachment bytes from path", { path: value, error: errorMessage(err) });
    return undefined;
  }
}

async function loadImageFromPath(value: string, declaredMimeType: string | undefined): Promise<Attachment | undefined> {
  try {
    const data = await loadImageBase64(value);
    return { mimeType: declaredMimeType ?? "image/png", data, path: value };
  } catch (err) {
    log.warn("agent", "failed to load selected-image bytes from path", { path: value, error: errorMessage(err) });
    return undefined;
  }
}

// ── HTTP route ──────────────────────────────────────────────────────

// HTTP route body — used by the Vue UI only. Paste/drop and sidebar
// pick both ride on `attachments[]` as path-only entries; the server
// reads bytes from disk and emits the `[Attached file: <path>]`
// marker. Bridges go through the socket relay (see chat-service)
// and supply attachments with inline base64 bytes; both shapes
// share the same `Attachment` type. See plans/done/refactor-edit-images-array.md.
interface AgentBody {
  message: string;
  roleId: string;
  chatSessionId: string;
  attachments?: Attachment[];
  userTimezone?: string;
}

interface ErrorResponse {
  error: string;
}

interface AcceptedResponse {
  chatSessionId: string;
}

router.post(API_ROUTES.agent.run, async (req: Request<object, unknown, AgentBody>, res: Response<ErrorResponse | AcceptedResponse>) => {
  const result = await startChat(req.body);
  if (result.kind === "error") {
    res.status(result.status ?? 500).json({ error: result.error });
    return;
  }
  res.status(202).json({ chatSessionId: result.chatSessionId });
});

// Runs the agent loop as a detached async task. Events are published
// to the session's pub/sub channel. When the loop ends, `endRun` is
// called to mark the session as finished and publish `session_finished`.
interface BackgroundRunParams {
  decoratedMessage: string;
  role: ReturnType<typeof getRole>;
  chatSessionId: string;
  claudeSessionId: string | undefined;
  abortSignal: AbortSignal;
  resultsFilePath: string;
  requestStartedAt: number;
  toolArgsCache: ReturnType<typeof createArgsCache>;
  attachments: Attachment[] | undefined;
  userTimezone: string | undefined;
  // Where this run was triggered from. Used to decide whether to
  // fire a completion notification: human-initiated runs don't (the
  // user is right there in the UI), but scheduler / bridge / skill
  // runs do (the user is probably away from the keyboard).
  origin: SessionOrigin | undefined;
}

// Per-event side-effect context passed to `handleAgentEvent`.
// `textAccumulator` collects streaming text chunks so we write
// one consolidated line to the jsonl instead of per-chunk lines
// (which would appear as separate cards on session reload).
//
// `pendingSkill` is set when a `tool_call` with `toolName === "Skill"`
// arrives. The SKILL.md body Claude CLI synthesises then follows as an
// `INJECTED_TEXT` event and consumes the flag — see `handleInjectedText`,
// which turns it into a `type: "skill"` entry. (#1218, #2821)
//
// `toolUseId` is tracked alongside the slug so we can recognise the
// matching `tool_call_result` (which Claude CLI emits between the
// Skill tool_call and the body) and let it pass without clearing.
// Any OTHER non-text event between the Skill tool_call and the body
// flush is treated as a sequence break and clears the flag — covers
// the leak path Codex iter-2 flagged where a tool_call_result with
// a different `toolUseId` (or a `claudeSessionId`, or a flush at
// run-end) would otherwise leave `pendingSkill` set so a much-later
// unrelated assistant text gets mis-tagged as `type: "skill"`.
interface EventContext {
  chatSessionId: string;
  resultsFilePath: string;
  toolArgsCache: ReturnType<typeof createArgsCache>;
  textAccumulator: string[];
  pendingSkill: PendingSkill | null;
  // The most recent assistant burst, kept for the turn-end Web Push. Each flush
  // overwrites it, so at run-end it holds the reply the user is waiting on —
  // the only thing that knows WHAT finished (#2901). Held here rather than
  // re-read from the jsonl, which would mean reading a whole long session back
  // just to quote its last paragraph.
  lastAssistantText: string;
}

const CLAUDE_CLI_SKILL_BODY_PREFIX = "Base directory for this skill: ";

// Returns true if the event was handled "out of band" (no pub-sub
// broadcast, no jsonl append). Right now only `claudeSessionId`
// events fall into that bucket — they update meta and are otherwise
// invisible to clients. Everything else is treated as "normal flow":
// broadcast + optional jsonl append + optional tool-trace side effect.
type AgentStreamEvent = Awaited<ReturnType<typeof runAgent>> extends AsyncGenerator<infer E> ? E : never;

async function handleAgentEvent(event: AgentStreamEvent, ctx: EventContext): Promise<void> {
  if (event.type === EVENT_TYPES.claudeSessionId) {
    await flushTextAccumulator(ctx);
    // claudeSessionId is a meta event — never part of a Skill→body
    // sequence. Clear pendingSkill so a flag set earlier in the run
    // can't leak into a later unrelated assistant text.
    ctx.pendingSkill = null;
    await setClaudeId(ctx.chatSessionId, event.id);
    return;
  }
  if (event.type === INJECTED_TEXT) {
    await handleInjectedText(ctx, event.message);
    return;
  }
  pushSessionEvent(ctx.chatSessionId, event);

  if (event.type === EVENT_TYPES.text) {
    // Accumulate text chunks instead of writing each one to jsonl.
    // Flushed when a non-text event arrives (preserving jsonl order
    // relative to tool events) or when the run ends.
    ctx.textAccumulator.push(event.message);
    return;
  }
  // Any non-text event marks the end of a text burst — flush so
  // jsonl order matches the live stream and crashes mid-run don't
  // lose already-streamed text.
  await flushTextAccumulator(ctx);
  if (event.type === EVENT_TYPES.toolCall) {
    updatePendingSkillOnToolCall(ctx, event);
    log.info("agent-tool", "call", {
      chatSessionId: ctx.chatSessionId,
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      argsPreview: previewJson(event.args),
    });
  } else if (event.type === EVENT_TYPES.toolCallResult) {
    updatePendingSkillOnToolCallResult(ctx, event.toolUseId);
    // Look up the toolName from the cache *before* recordToolEvent
    // runs (it deletes the cache entry on result).
    const cached = ctx.toolArgsCache.get(event.toolUseId);
    log.info("agent-tool", "result", {
      chatSessionId: ctx.chatSessionId,
      toolName: cached?.toolName,
      toolUseId: event.toolUseId,
      contentBytes: event.content.length,
    });
  } else {
    return;
  }
  // Fire-and-forget: tool-trace persistence failures must not block
  // the agent loop. Errors are log.warn'd by recordToolEvent itself.
  recordToolEvent(event, {
    workspaceRoot: workspacePath,
    chatSessionId: ctx.chatSessionId,
    resultsFilePath: ctx.resultsFilePath,
    argsCache: ctx.toolArgsCache,
  }).catch(logBackgroundError("tool-trace"));
}

// Text the CLI injected as a `user`-role message. With a Skill call pending
// this IS the SKILL.md body, so it becomes a `skill` entry right here instead
// of being broadcast as `text` and re-classified at the next flush. Publishing
// it as `text` first is what put SKILL.md bodies into bridge replies (#2821):
// the canvas could undo it by replacing the trailing card, but a consumer that
// accumulates text events — every bridge — cannot.
//
// Without a pending Skill the injection is something we have not seen the CLI
// do. Fall back to the old treatment (broadcast + accumulate) so no content is
// lost, and warn so the new shape is discoverable.
async function handleInjectedText(ctx: EventContext, message: string): Promise<void> {
  if (!message) return;
  const skill = ctx.pendingSkill;
  if (!skill) {
    log.warn("agent", "user-role text arrived with no Skill call pending — treating it as assistant text", {
      preview: message.slice(0, INJECTED_TEXT_LOG_PREVIEW_MAX),
    });
    pushSessionEvent(ctx.chatSessionId, { type: EVENT_TYPES.text, message });
    ctx.textAccumulator.push(message);
    return;
  }
  ctx.pendingSkill = null;
  // Whatever streamed before the body is the assistant's own prose; flush it
  // (as plain text, the flag is already cleared) so jsonl order is preserved.
  await flushTextAccumulator(ctx);
  await writeSkillEntry(ctx, skill.skillName, message);
}

// Write the accumulated streaming text chunks as one consolidated
// jsonl line. Called at the end of each agent run (success or error)
// so the session transcript has exactly one assistant text entry
// per response, not N per-chunk entries.
//
// `ctx.pendingSkill` still being set here means the SKILL.md body reached us as
// ASSISTANT text rather than the injected `user`-role message `handleInjectedText`
// expects. No CLI version we have measured does that, so this is the degradation
// path for a future one: tag the flush as `type: "skill"` (#1218) and consume the
// flag, accepting that the body was already broadcast as text (#2821).
async function flushTextAccumulator(ctx: EventContext): Promise<void> {
  if (ctx.textAccumulator.length === 0) return;
  const fullText = ctx.textAccumulator.join("");
  ctx.textAccumulator.length = 0;
  if (!fullText) return;

  // Empty-string flushes (already handled above) don't consume
  // pendingSkill — only the actual skill body should clear it.
  const skill = ctx.pendingSkill;
  ctx.pendingSkill = null;

  if (skill) {
    // Only the part after the SKILL.md body is something the user said to
    // them; the body itself is instruction content for the model.
    recordPushReply(ctx, await writeSkillEntry(ctx, skill.skillName, fullText));
    return;
  }
  recordPushReply(ctx, fullText);
  await appendSessionLine(
    ctx.chatSessionId,
    JSON.stringify({
      source: "assistant",
      type: EVENT_TYPES.text,
      message: fullText,
    }),
  );
}

// Resolve the loaded skill against `discoverSkills()` to attach
// scope + path metadata, then write the consolidated assistant entry
// as `type: "skill"`. The body's full text is preserved in `message`
// (archival + the canvas's expand-on-click affordance). A live SSE
// `type: "skill"` event is also broadcast so observing tabs can
// replace the streamed text bubble with a collapsed skill card
// without waiting for a session reload.
//
// Claude CLI sometimes concatenates the LLM's actual reply to the
// synthesised SKILL.md body in the same text block (no `tool_call`
// or `content_block_stop` boundary between them — see PR #1220
// comment for the shiritori reproducer). We split that here using
// the SKILL.md body on disk as a structural delimiter; the reply
// portion gets persisted as a SECOND entry of `type: "text"` so it
// stays visible after the user collapses the skill card.
/** Writes the skill entry and, when the CLI emitted a genuine reply in the same
 *  burst, that reply too. Returns the reply so the caller can decide what the
 *  completion push quotes — it is the only user-facing part of a Skill burst
 *  (Codex review on #2909). */
async function writeSkillEntry(ctx: EventContext, skillName: string, body: string): Promise<string> {
  const resolved = await resolveSkillMetadata(skillName);
  // Canary: skill detection is sequence-based (not body-prefix based),
  // but we still cross-check the prefix as a format-drift signal.
  // If Claude CLI ever changes its synthesised body shape, this warn
  // surfaces before any user-visible regression.
  if (!body.startsWith(CLAUDE_CLI_SKILL_BODY_PREFIX)) {
    log.warn("agent", "Skill tool followed by text NOT starting with the expected Claude CLI prefix — body shape may have changed", {
      skillName,
      expectedPrefix: CLAUDE_CLI_SKILL_BODY_PREFIX,
      actualPreview: body.slice(0, 80),
    });
  }
  // A second canary: the SKILL.md body should appear verbatim inside
  // the synthesised text. Failure means either discovery missed the
  // skill (already logged by `resolveSkillMetadata`) or Claude CLI
  // changed how it inlines the body (worth investigating).
  if (resolved.body && !body.includes(resolved.body.trim())) {
    log.warn("agent", "Claude CLI text does not contain the SKILL.md body verbatim — body split may be incorrect", {
      skillName,
      bodyBytes: body.length,
      skillFileBytes: resolved.body.length,
    });
  }
  const { skillPart, replyPart } = splitSkillAndReply(body, resolved.body);

  const skillPayload = {
    source: "assistant",
    type: EVENT_TYPES.skill,
    skillName,
    skillScope: resolved.scope,
    skillPath: resolved.path,
    skillDescription: resolved.description,
    message: skillPart,
  };
  pushSessionEvent(ctx.chatSessionId, skillPayload);
  await appendSessionLine(ctx.chatSessionId, JSON.stringify(skillPayload));

  if (replyPart) {
    const textPayload = { source: "assistant", type: EVENT_TYPES.text, message: replyPart };
    pushSessionEvent(ctx.chatSessionId, textPayload);
    await appendSessionLine(ctx.chatSessionId, JSON.stringify(textPayload));
  }
  return replyPart;
}

interface SkillMetadata {
  scope: "user" | "project" | "unknown";
  path: string | null;
  /** From the SKILL.md frontmatter `description:` field. Used by the
   *  host's collapsed-skill card — Claude CLI strips frontmatter from
   *  the synthesised body, so the renderer can't re-extract this from
   *  `message`. Resolved here from `discoverSkills()` instead. */
  description: string | null;
  /** SKILL.md body (frontmatter already stripped by `discoverSkills`).
   *  Used as a structural delimiter to split the text Claude CLI
   *  emits — the body Claude CLI inlines is character-for-character
   *  this same string, with the LLM's actual reply concatenated
   *  after. */
  body: string | null;
}

async function resolveSkillMetadata(skillName: string): Promise<SkillMetadata> {
  try {
    const skills: Skill[] = await discoverSkills({ workspaceRoot: workspacePath });
    const found = skills.find((skill) => skill.name === skillName);
    if (!found) return { scope: "unknown", path: null, description: null, body: null };
    return { scope: found.source, path: found.path, description: found.description, body: found.body };
  } catch (err) {
    // Discovery failure is benign — keep tagging the entry so the UI
    // can still collapse it; just leave metadata empty.
    log.warn("agent", "skill metadata lookup failed — emitting entry without scope/path/description/body", {
      skillName,
      error: errorMessage(err),
    });
    return { scope: "unknown", path: null, description: null, body: null };
  }
}

// Helper kept commented (instead of deleted) alongside the
// publishNotification call below — see the duplicate-notification
// comment near `endRun()` in `runAgentInBackground` for context.
// (by snakajima)
//
// // Build the title used for the agent-completion notification on
// // non-human runs. Surfaces both the role name and the trigger so
// // the user can read it in passing on a phone lock screen.
// function completionNotificationTitle(roleName: string, origin: SessionOrigin): string {
//   switch (origin) {
//     case SESSION_ORIGINS.scheduler:
//       return `✅ ${roleName} (scheduler) finished`;
//     case SESSION_ORIGINS.skill:
//       return `✅ ${roleName} (skill) finished`;
//     case SESSION_ORIGINS.bridge:
//       return `✅ ${roleName} reply ready`;
//     default:
//       return `✅ ${roleName} finished`;
//   }
// }

// Clear the stale `--resume` id and rebuild the turn from the local jsonl so the
// replay carries context without the bad session id (#211). Returns the message
// to replay; the caller drops the claude session id.
async function recoverStaleSession(chatSessionId: string, decoratedMessage: string): Promise<string> {
  log.warn("agent", "stale claude session id — retrying without --resume", { chatSessionId });
  await clearClaudeId(chatSessionId);
  const preamble = await readTranscriptPreamble(chatSessionId);
  pushSessionEvent(chatSessionId, {
    type: EVENT_TYPES.status,
    message: "Previous session unavailable — continuing with local transcript.",
  });
  return preamble ? `${preamble}${decoratedMessage}` : decoratedMessage;
}

// Wait for the broker to connect, then say whether replaying the same turn can
// still succeed (#2057, #2842). Surfaces a status event so the pause isn't read
// as a hang.
//
// The startup beacon (#2898) is read on both sides of the wait, because only
// the SECOND reading separates the two failures that produce one identical CLI
// error: a broker that lost the race by a moment sends its beacon during the
// wait and is fixed by a replay, while one that never came up sends nothing and
// a replay merely buys another full connect-wait before the same error — the
// 100 s the reporter measured.
type BrokerRecoveryOutcome = "replay" | "give-up" | "aborted";

async function recoverBrokerNotReady(chatSessionId: string, abortSignal: AbortSignal): Promise<BrokerRecoveryOutcome> {
  // Capture WHICH spawn this is before waiting, then ask about that one on both
  // sides. The turn's own spawn id is created inside `runAgent` and never leaves
  // it, so "the spawn we are waiting on" has to be read from the readiness
  // state — and reading it once, up front, is what stops the answer from
  // drifting to a later spawn while the wait runs (Codex review on #2932).
  const spawn = getCurrentBrokerSpawn(chatSessionId);
  const readyBeforeWait = spawn?.ready ?? null;
  pushSessionEvent(chatSessionId, {
    type: EVENT_TYPES.status,
    message: "Tools are still starting up…",
  });
  // Two clocks, deliberately. The reconnect pause is the one a REPLAY costs and
  // it is unchanged. The decision window is longer and only the give-up path
  // pays it: concluding "no beacon, so the broker never came up" is unsound
  // until the beacon has run out of delivery attempts, and refusing a replay on
  // a beacon still in flight would break the recovery this wait exists for.
  const paused = abortableSleep(BROKER_RECONNECT_WAIT_MS, abortSignal);
  // Asked about the spawn captured above, so a later one cannot answer for it.
  // With no spawn on record there is nothing to wait for — that is a turn with
  // no broker, and `null` is the honest reading.
  const ready =
    spawn === null ? null : await awaitBrokerReady(() => getBrokerReady(chatSessionId, spawn.spawnId), BROKER_READY_DECISION_WINDOW_MS, abortSignal);
  await paused;
  // A stop cuts both short, so "no beacon yet" says nothing about the broker
  // here. Judging anyway would log a diagnosis for a turn the user cancelled —
  // and the caller ends it either way.
  if (abortSignal.aborted) return "aborted";

  const verdict = judgeBrokerReplay(readyBeforeWait !== null, ready !== null);
  const detail = { chatSessionId, brokerEverReady: ready !== null, reason: verdict.reason, ...(ready ?? {}) };
  if (verdict.replay) {
    log.warn("agent", "mulmoclaude MCP broker was not ready — replaying the turn", detail);
    return "replay";
  }
  log.warn("agent", "mulmoclaude MCP broker never reported ready — not replaying, the same wait would end in the same error", {
    ...detail,
    hint: "Look for `[mcp] broker ready` and `broker=` in server/system/logs/; `broker=tsx` means this install lacks the prebuilt broker bundle.",
  });
  return "give-up";
}

// What the failover stream loop reads to (re)invoke `runAgent`. A
// subset of `BackgroundRunParams` — the per-turn teardown fields
// (resultsFilePath, requestStartedAt, toolArgsCache, origin) stay in
// `runAgentInBackground`.
interface FailoverStreamArgs {
  decoratedMessage: string;
  role: ReturnType<typeof getRole>;
  chatSessionId: string;
  claudeSessionId: string | undefined;
  abortSignal: AbortSignal;
  attachments: Attachment[] | undefined;
  userTimezone: string | undefined;
}

// One pass of `runAgent`: handle every non-recovery event inline and return the
// recovery the stream asked for (or null) plus whether a real error surfaced. A
// recovery-triggering event is swallowed (the caller retries); its error is not
// counted, so a recovered pass reports didError=false.
//
// The swallowed event comes back with it. A recovery can still be REFUSED after
// the fact — the broker one is, when nothing ever reported ready (#2842) — and
// then this is the only copy of the failure left to show the user.
async function streamOnce(
  runArgs: Parameters<typeof runAgent>[0],
  budgets: RetryBudgets,
  eventCtx: EventContext,
): Promise<{ recovery: RecoveryKind; didError: boolean; swallowed: AgentStreamEvent | null }> {
  let recovery: RecoveryKind = null;
  let didError = false;
  let swallowed: AgentStreamEvent | null = null;
  // A broker-not-ready replay is only safe when NOTHING executed — the failing
  // first tool call is blocked at the permission check. Once ANY tool has
  // completed successfully (an auto-approved Bash/Write, or a tool that ran
  // before a later permission check failed), replaying would double-execute it,
  // so downgrade the broker recovery to a plain error at that point (#2057).
  let ranTool = false;
  for await (const event of runAgent(runArgs)) {
    if (event.type === EVENT_TYPES.toolCallResult && event.isError !== true) ranTool = true;
    recovery = detectRecovery(event, budgets);
    if (recovery === "broker" && ranTool) recovery = null;
    // Swallow the error — the caller is about to recover. `break` abandons the
    // generator; the event is only yielded after the CLI exited, so the
    // subprocess is already dead and `for await`'s return() is the only cleanup.
    if (recovery) {
      swallowed = event;
      break;
    }
    // A yielded error event (non-zero exit, missing binary, a tool surfacing an
    // error) is a real failure even though the generator didn't throw.
    if (event.type === EVENT_TYPES.error) didError = true;
    await handleAgentEvent(event, eventCtx);
  }
  return { recovery, didError, swallowed };
}

// A recovery-triggering error is swallowed before `handleAgentEvent`, so it
// skips the boundary flush — the aborted pass's streamed text (and any pending
// skill flag) would otherwise concatenate into the REPLAYED pass's consolidated
// jsonl entry. Discard that partial state so each attempt persists cleanly.
function discardAbortedPass(eventCtx: EventContext): void {
  eventCtx.textAccumulator.length = 0;
  eventCtx.pendingSkill = null;
  // Same reason as the accumulator: the abandoned pass's text must not become
  // the replayed pass's push body.
  eventCtx.lastAssistantText = "";
}

// Drive `runAgent` for one turn, recovering once from a stale `--resume` id
// (#211) and once from the transient broker startup race (#2057). Returns
// whether a real error event was yielded, so the caller's `finally` can decide
// hidden-worker cleanup. Split out of `runAgentInBackground` to keep that
// function under the max-lines-per-function budget.
async function runAgentStreamWithFailover(args: FailoverStreamArgs, eventCtx: EventContext): Promise<boolean> {
  const { decoratedMessage, role, chatSessionId, claudeSessionId, abortSignal, attachments, userTimezone } = args;

  // One retry each. Stale-`--resume` only applies when we entered with an id (a
  // fresh session can't hit it); the broker race can hit a fresh session too.
  // One max apiece so a looping CLI bug can't stack infinite replays.
  const budgets: RetryBudgets = { stale: claudeSessionId ? 1 : 0, broker: 1 };
  let currentMessage = decoratedMessage;
  let currentClaudeSessionId = claudeSessionId;
  let didError = false;

  while (true) {
    // A stop before the (re)spawn must not run another turn. Guards the first
    // pass and both recovery replays — runAgent has no already-aborted guard of
    // its own, and an already-aborted signal never fires the CLI abort handler.
    if (abortSignal.aborted) break;
    const runArgs = {
      message: currentMessage,
      role,
      workspacePath,
      sessionId: chatSessionId,
      port: getBoundPort(),
      claudeSessionId: currentClaudeSessionId,
      abortSignal,
      attachments,
      userTimezone,
    };
    const pass = await streamOnce(runArgs, budgets, eventCtx);
    didError = didError || pass.didError;
    if (!pass.recovery) break;

    if (pass.recovery === "stale") {
      discardAbortedPass(eventCtx);
      budgets.stale--;
      currentMessage = await recoverStaleSession(chatSessionId, decoratedMessage);
      currentClaudeSessionId = undefined;
      continue;
    }

    budgets.broker--;
    const outcome = await recoverBrokerNotReady(chatSessionId, abortSignal);
    if (outcome === "replay") {
      discardAbortedPass(eventCtx);
      continue;
    }
    // Every path below this line ends the turn, so the pass's streamed text is
    // the last there will be and is kept rather than discarded. Discarding is
    // only correct ahead of a replay, whose consolidated jsonl entry it would
    // otherwise be concatenated into.
    //
    // A stop gets the same treatment an ordinary cancel does, which keeps what
    // was streamed before it (`flushTextAccumulator` at the end of the run).
    // Discarding here made a cancel during this particular wait the one cancel
    // that silently dropped the reply (CodeRabbit review on #2931).
    if (outcome === "aborted") break;
    // Refused: the broker never came up, so the error the pass died on was
    // swallowed for a replay that is no longer happening. Surface it (#2842).
    if (pass.swallowed) await handleAgentEvent(pass.swallowed, eventCtx);
    didError = true;
    break;
  }
  return didError;
}

async function runAgentInBackground(params: BackgroundRunParams): Promise<void> {
  const { decoratedMessage, role, chatSessionId, claudeSessionId, abortSignal, resultsFilePath, requestStartedAt, toolArgsCache, attachments, userTimezone } =
    params;

  const eventCtx: EventContext = {
    chatSessionId,
    resultsFilePath,
    toolArgsCache,
    textAccumulator: [],
    lastAssistantText: "",
    pendingSkill: null,
  };

  // Tracks whether this run threw or yielded an error event, so the
  // finally can decide whether a hidden worker session's files are safe
  // to delete (success) or should be kept for inspection (error).
  let didError = false;

  try {
    didError = await runAgentStreamWithFailover({ decoratedMessage, role, chatSessionId, claudeSessionId, abortSignal, attachments, userTimezone }, eventCtx);
    // Flush any accumulated streaming text as a single consolidated
    // line in the jsonl. This prevents per-chunk lines that would
    // appear as separate cards on session reload.
    await flushTextAccumulator(eventCtx);

    log.info("agent", "request completed", {
      chatSessionId,
      durationMs: Date.now() - requestStartedAt,
    });
  } catch (err) {
    didError = true;
    await flushTextAccumulator(eventCtx);
    log.error("agent", "request failed", {
      chatSessionId,
      error: String(err),
    });
    pushSessionEvent(chatSessionId, {
      type: EVENT_TYPES.error,
      message: String(err),
    });
  } finally {
    await finalizeRun(chatSessionId, params.origin, didError, requestStartedAt, eventCtx.lastAssistantText);
  }
}

// Run the per-turn teardown: mark the run finished, then either clean up
// a hidden worker session or fire the normal post-turn side effects.
// Split out of `runAgentInBackground` to keep that function under the
// cognitive-complexity threshold.
async function finalizeRun(
  chatSessionId: string,
  origin: SessionOrigin | undefined,
  didError: boolean,
  requestStartedAt: number,
  replyText: string,
): Promise<void> {
  endRun(chatSessionId);

  if (origin === SESSION_ORIGINS.system) {
    // Hidden worker session (spawnBackgroundChat `hidden: true`) —
    // plumbing, not a conversation. Release its runaway-guard slot,
    // skip the post-turn side effects (they'd burn tokens summarising
    // plumbing and pollute wiki backlinks), and clean up its files on
    // success — keep them on error so a failed worker stays inspectable.
    releaseBackgroundSession(chatSessionId);
    // Fire any one-shot completion hook (e.g. agent-ingest failure tracking)
    // AFTER the slot is freed, BEFORE files are cleaned up. Best-effort —
    // a throwing hook is logged, never propagated.
    await runCompletionHook(chatSessionId, { didError }).catch(logBackgroundError("background-session-completion-hook"));
    if (!didError) {
      await deleteSessionFiles(chatSessionId).catch(logBackgroundError("background-session-cleanup"));
    }
    return;
  }

  // Visible sessions (scheduler / skill / user chats) may also register a
  // one-shot completion hook — a scheduled run reconciles its recorded outcome
  // against the turn's real result here (#2057). No-op when none is registered.
  await runCompletionHook(chatSessionId, { didError }).catch(logBackgroundError("completion-hook"));
  runPostTurnSideEffects(chatSessionId, requestStartedAt);
  // Web Push (#2086): ping the user's devices when a turn THEY started finishes —
  // they asked a question, walked away, and want to know when the answer is ready.
  // Only human-initiated turns qualify (scheduler / skill / bridge / plugin are
  // excluded — those aren't the user waiting in the browser; missing origin means
  // "human" by convention). No-op unless enabled AND RemoteHost is connected.
  if (origin === undefined || origin === SESSION_ORIGINS.human) {
    notifyTaskFinished(chatSessionId, didError, replyText).catch(logBackgroundError("web-push"));
  }
}

// Fire-and-forget post-turn processing for a normal (user-facing) chat
// session: journal, chat-index, and wiki-backlinks. Hidden worker
// sessions skip this entirely (see `runAgentInBackground`'s finally).
function runPostTurnSideEffects(chatSessionId: string, requestStartedAt: number): void {
  // Commented out: this would create a duplicate notification.
  //
  // `endRun(chatSessionId)` (in the caller) flips `session.hasUnread =
  // true` for every chat-session turn completion regardless of origin,
  // which already lights up the red unread-count badge on the
  // Session History Panel toggle button (driven by `hasUnread` →
  // `useSessionDerived.unreadCount` →
  // `SessionHistoryToggleButton.vue`). Firing
  // `publishNotification` here adds a *second* red badge — on the
  // notification bell — for the exact same event, in the same
  // chrome row. Two indicators, one event = noise.
  //
  // The duplicate occurs whenever a chat session receives a new
  // message, which is exactly what every code path through the
  // `finally` represents. The initiator of the turn (human, bridge
  // user, scheduled job, skill chain, another agent) does not
  // change this — both badges flip together.
  //
  // Other `publishNotification` call sites (news pipeline, `notify`
  // MCP tool, scheduled-test endpoint) do not post a chat-session
  // message at the same time, so they are not duplicates and
  // remain enabled.
  //
  // (by snakajima)
  //
  // if (params.origin && params.origin !== SESSION_ORIGINS.human) {
  //   publishNotification({
  //     kind: NOTIFICATION_KINDS.agent,
  //     title: completionNotificationTitle(params.role.name, params.origin),
  //     sessionId: chatSessionId,
  //   });
  // }
  // Fire-and-forget: journal + chat-index post-processing
  maybeRunJournal({ activeSessionIds: getActiveSessionIds() }).catch(logBackgroundError("journal"));
  maybeIndexSession({
    sessionId: chatSessionId,
    activeSessionIds: getActiveSessionIds(),
  }).catch(logBackgroundError("chat-index"));
  // Walks wiki/pages/ for files modified during this turn and
  // appends a backlink to the originating chat session so the
  // user can jump back from a wiki page to the conversation
  // that created it. See #109.
  maybeAppendWikiBacklinks({
    chatSessionId,
    turnStartedAt: requestStartedAt,
  }).catch(logBackgroundError("wiki-backlinks"));
}

// Read claudeSessionId from meta (primary) or jsonl (legacy fallback).
async function readClaudeSessionIdFromSession(chatSessionId: string): Promise<string | undefined> {
  const meta = await readSessionMeta(chatSessionId);
  if (meta?.claudeSessionId) return meta.claudeSessionId;
  // Legacy scan: search jsonl lines backwards for a claudeSessionId event
  const jsonl = await readSessionJsonl(chatSessionId);
  if (!jsonl) return undefined;
  return findLastSessionEntry(jsonl, (entry) => (entry.type === EVENT_TYPES.claudeSessionId && isNonEmptyString(entry.id) ? entry.id : undefined));
}

// Read the session jsonl and render the transcript preamble used on
// `--resume` fail-over.
async function readTranscriptPreamble(chatSessionId: string): Promise<string> {
  const jsonl = await readSessionJsonl(chatSessionId);
  if (!jsonl) return "";
  return buildTranscriptPreamble(jsonl);
}

export default router;
