import { Router, Request, Response } from "express";
import {
  STORY_SCRIPT_EXTENSIONS,
  executeMulmoScriptSave,
  executeUpdateBeat,
  executeUpdateScript,
  type MulmoScriptFailure,
  type SaveMulmoScriptArgs,
} from "@mulmoclaude/mulmoscript-plugin";
import { makeArtifactsFileOps } from "../../plugins/runtime.js";
import { makeByPathFileOps } from "../../utils/files/by-path.js";
import { buildContext } from "@mulmoclaude/mulmoscript-plugin/server";
import { mulmoScriptOps } from "../../plugins/mulmoscript-server.js";
import { errorMessage } from "../../utils/errors.js";
import { badRequest, notFound } from "../../utils/httpError.js";
import { getOptionalStringQuery, getSessionQuery } from "../../utils/request.js";
import { requestBodyRecord } from "../../utils/requestBody.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { bindRoute } from "../../utils/router.js";
import { GENERATION_KINDS } from "../../../src/types/events.js";
import { makeBeatOpHandler, sendOpFailure, validBeatIndex, type ErrorResponse } from "./mulmoScriptBeatOp.js";
import { parseSuppliedRoot, resolveStoryWriteTarget, type StoryWriteGuards } from "./mulmoScriptWriteRoot.js";

// Express adapters over the shared ops instance from
// `server/plugins/mulmoscript-server.ts`. Every op body lives in
// @mulmoclaude/mulmoscript-plugin/server (phase 3 — single source of
// truth, shared with the plugin dispatch handler and, in phase 3b, with
// MulmoTerminal); these routes only validate request shapes and map
// `OpFailure.code` back onto the pre-extraction HTTP statuses. The
// save / reopen / update slice additionally delegates to the package's
// phase-1 core executes.

const router = Router();

// Shared SSE preamble for the two streaming routes; returns the
// line-writer bound to this response.
function beginSse(res: Response): (data: unknown) => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  return (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

interface UploadBeatImageBody {
  filePath: string;
  beatIndex: number;
  imageData: string; // base64 data URI
  root?: string | undefined;
}

type BeatImageResponse = { image: string | null } | ErrorResponse;
type BeatAudioResponse = { audio: string | null } | ErrorResponse;
type BeatMovieResponse = { moviePath: string | null } | ErrorResponse;
type MovieStatusResponse = { moviePath: string | null } | ErrorResponse;
type PdfStatusResponse = { pdfPath: string | null } | ErrorResponse;

interface BeatQuery {
  filePath?: string | undefined;
  beatIndex?: string | undefined;
  root?: string | undefined;
}

interface FilePathQuery {
  filePath?: string | undefined;
  root?: string | undefined;
}

// Request values arrive untyped at runtime — query params can be arrays
// (repeated `?filePath=` keys) and JSON bodies can carry any shape. The
// guards below reject non-string / non-index values before they can reach
// any path or beat-indexed logic (CodeQL
// js/type-confusion-through-parameter-tampering + Codex review on #2133).
// `validBeatIndex` is shared with the beat POST handlers — see
// `./mulmoScriptBeatOp.ts`.
function stringQuery(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Which registered stories root a request names, from a query param or a body field.
 *
 * `stories/deck.json` exists in EVERY registered root (#3014), so a route that resolves the path
 * alone reads the DEFAULT root's file of that name. Absent and empty mean the default root; a
 * root that is present but NOT A STRING is answered 400 here rather than folded into the default
 * — the same rule the package's dispatch applies at its single entry (`guardSuppliedRoot` in
 * `server/dispatch.ts`), for the reason its comment gives: folding it writes to the default
 * root's identically-named script while the caller believes it named another. Repeating
 * `?root=` in a query produces an array, which is that shape arriving by accident.
 *
 * Returns `null` after answering the response, so a caller stops with `if (root === null) return;`.
 * A root that is a string but not REGISTERED is refused by the ops, not here.
 */
function suppliedRoot(value: unknown, res: Response): string | undefined | null {
  const parsed = parseSuppliedRoot(value);
  if (parsed.ok) return parsed.root;
  badRequest(res, parsed.error);
  return null;
}

function parseBeatQuery<TRes>(
  req: Request<object, TRes, object, BeatQuery>,
  res: Response,
): { filePath: string; beatIndex: number; root: string | undefined } | null {
  const filePath = stringQuery(req.query.filePath);
  const beatIndexStr = stringQuery(req.query.beatIndex);
  // Number() (not parseInt) so "1.5" stays fractional and fails the
  // integer check instead of silently truncating to 1.
  const beatIndex = beatIndexStr !== null ? Number(beatIndexStr) : undefined;
  if (!filePath || !validBeatIndex(beatIndex)) {
    badRequest(res, "filePath and beatIndex are required");
    return null;
  }
  const root = suppliedRoot(req.query.root, res);
  if (root === null) return null;
  return { filePath, beatIndex, root };
}

// The save / reopen / update slice lives in the shared
// @mulmoclaude/mulmoscript-plugin package (single source of truth, also
// consumable by MulmoTerminal — plans/done/feat-mulmoscript-plugin.md). These
// routes are THIN host adapters: they inject the GENERIC `files.artifacts`
// runtime capability, map the package's discriminated failures back onto
// the pre-extraction 400/404 wire contract, and keep the host-only
// `autoGenerateMovie` trigger (movie generation needs mulmocast/ffmpeg,
// which stay host-side until phase 3).
function makeExecuteContext() {
  // `byPath` is what lets presentMulmoScript open a script outside
  // `artifacts/stories/` — the same capability presentDocument / presentHtml
  // take for their `path` argument. A RELATIVE `filePath` never reaches it.
  return { files: { artifacts: makeArtifactsFileOps(), byPath: makeByPathFileOps(STORY_SCRIPT_EXTENSIONS) } };
}

/** The ops primitives the write-target decision needs — see `./mulmoScriptWriteRoot.ts`. */
const WRITE_GUARDS: StoryWriteGuards = {
  guardStoryWriteRoot: (root) => mulmoScriptOps.guardStoryWriteRoot(root),
  guardStoryWirePath: (filePath, root) => mulmoScriptOps.guardStoryWirePath(filePath, root),
  artifactsForRoot: (root) => mulmoScriptOps.artifactsForRoot(root),
};

function sendPackageFailure(res: Response, failure: MulmoScriptFailure): void {
  if (failure.code === "not_found") {
    notFound(res, failure.error);
  } else {
    badRequest(res, failure.error);
  }
}

// Unified entry point — save a fresh `script` OR re-display an existing
// one referenced by `filePath`. Folding both modes into one route lets
// the agent (MCP) and the GUI dispatcher hit the same endpoint without
// either side needing to know which mode the user picked. The MCP layer
// in `server/agent/plugin-names.ts` routes the tool name straight here,
// so any per-mode logic on the client would be invisible to it.
bindRoute(router, API_ROUTES.mulmoScript.save, async (req: Request<object, object, SaveMulmoScriptArgs>, res: Response) => {
  // Realpath symlink containment before the package's lexical guard —
  // see mulmoScriptOps.guardStoryWirePath.
  const guard = mulmoScriptOps.guardStoryWirePath(req.body?.filePath);
  if (guard) {
    sendOpFailure(res, guard);
    return;
  }
  const outcome = await executeMulmoScriptSave(makeExecuteContext(), req.body ?? {});
  if (!outcome.ok) {
    sendPackageFailure(res, outcome);
    return;
  }

  if (req.body?.autoGenerateMovie === true) {
    // The in-flight dedup + background pipeline key on the realpath, so
    // re-resolve the package's wire path host-side.
    //
    // No root, deliberately: this is the AGENT's tool path, and `root` is not in the tool
    // schema so a model cannot name one (#3015). Every save that reaches here is in the
    // default root by construction. Named as an exception in
    // `test/plugins/mulmoscript/test_storyRootSweep.ts`.
    const resolved = mulmoScriptOps.resolveStory(outcome.filePath);
    if (resolved.ok) {
      mulmoScriptOps.triggerAutoBackgroundMovie(resolved.absolutePath, outcome.filePath, getSessionQuery(req) || undefined);
    }
  }

  res.json({
    data: { script: outcome.script, filePath: outcome.filePath },
    message: outcome.message,
    instructions: "Display the storyboard to the user.",
  });
});

// The updateBeat / updateScript routes are identical except for which
// package execute they call: guard the wire path, run the execute, map a
// failure onto the pre-extraction status, else 200. Share the shell.
async function runGuardedUpdate(req: Request<object, object, unknown>, res: Response, execute: typeof executeUpdateBeat): Promise<void> {
  const body = requestBodyRecord(req.body);
  const root = suppliedRoot(body.root, res);
  if (root === null) return;
  const target = resolveStoryWriteTarget(WRITE_GUARDS, body.filePath, root);
  if (!target.ok) {
    if ("failure" in target) {
      sendOpFailure(res, target.failure);
      return;
    }
    badRequest(res, `mulmoScript root is not registered: ${target.unregisteredRoot ?? "(default)"}`);
    return;
  }
  // `byPath` rides along exactly as it does for the agent's save, so the absolute `filePath`
  // form means the same thing on this transport. It is root-independent.
  const outcome = await execute({ files: { artifacts: target.artifacts, byPath: makeByPathFileOps(STORY_SCRIPT_EXTENSIONS) } }, req.body);
  if (!outcome.ok) {
    sendPackageFailure(res, outcome);
    return;
  }
  res.json({ ok: true });
}

bindRoute(router, API_ROUTES.mulmoScript.updateBeat, (req: Request<object, object, unknown>, res: Response) => runGuardedUpdate(req, res, executeUpdateBeat));

bindRoute(router, API_ROUTES.mulmoScript.updateScript, (req: Request<object, object, unknown>, res: Response) =>
  runGuardedUpdate(req, res, executeUpdateScript),
);

bindRoute(router, API_ROUTES.mulmoScript.beatImage, async (req: Request<object, BeatImageResponse, object, BeatQuery>, res: Response<BeatImageResponse>) => {
  const query = parseBeatQuery(req, res);
  if (!query) return;
  const result = await mulmoScriptOps.beatImageOp(query.filePath, query.beatIndex, query.root);
  if (!result.ok) {
    sendOpFailure(res, result);
    return;
  }
  res.json({ image: result.image });
});

bindRoute(
  router,
  API_ROUTES.mulmoScript.movieStatus,
  async (req: Request<object, MovieStatusResponse, object, FilePathQuery>, res: Response<MovieStatusResponse>) => {
    const filePath = stringQuery(req.query.filePath);
    if (!filePath) {
      badRequest(res, "filePath is required");
      return;
    }
    const root = suppliedRoot(req.query.root, res);
    if (root === null) return;
    const result = await mulmoScriptOps.movieStatusOp(filePath, root);
    if (!result.ok) {
      sendOpFailure(res, result);
      return;
    }
    res.json({ moviePath: result.moviePath });
  },
);

bindRoute(router, API_ROUTES.mulmoScript.beatAudio, async (req: Request<object, BeatAudioResponse, object, BeatQuery>, res: Response<BeatAudioResponse>) => {
  const query = parseBeatQuery(req, res);
  if (!query) return;
  const result = await mulmoScriptOps.beatAudioOp(query.filePath, query.beatIndex, query.root);
  if (!result.ok) {
    sendOpFailure(res, result);
    return;
  }
  res.json({ audio: result.audio });
});

bindRoute(router, API_ROUTES.mulmoScript.beatMovie, async (req: Request<object, BeatMovieResponse, object, BeatQuery>, res: Response<BeatMovieResponse>) => {
  const query = parseBeatQuery(req, res);
  if (!query) return;
  const result = await mulmoScriptOps.beatMovieOp(query.filePath, query.beatIndex, query.root);
  if (!result.ok) {
    sendOpFailure(res, result);
    return;
  }
  res.json({ moviePath: result.moviePath });
});

// Beat generation endpoints: same validation, same failure mapping — only
// the op and the success key differ, so they declare just those two.
bindRoute(
  router,
  API_ROUTES.mulmoScript.generateBeatAudio,
  makeBeatOpHandler(mulmoScriptOps.generateBeatAudioOp, (result) => ({ audio: result.audio })),
);

bindRoute(
  router,
  API_ROUTES.mulmoScript.renderBeat,
  makeBeatOpHandler(mulmoScriptOps.renderBeatOp, (result) => ({ image: result.image })),
);

interface GenerationRequestBody {
  filePath: string;
  /** Which registered stories root `filePath` is relative to; absent = the default (#3014).
   *  This host registers no extra roots, so every request it makes today omits it. */
  root?: string | undefined;
  chatSessionId?: string | undefined;
}

// Validate the `{ filePath }` body, run the ffmpeg guard, and resolve the
// script to an absolute path — responding (400 / op-failure) and returning
// null on any failure. Shared by the movie and PDF SSE routes.
function resolveStoryRequest(
  req: Request<object, object, GenerationRequestBody>,
  res: Response,
): { filePath: string; absoluteFilePath: string; root: string | undefined; chatSessionId?: string | undefined } | null {
  const { filePath, chatSessionId } = req.body;
  if (typeof filePath !== "string" || !filePath) {
    badRequest(res, "filePath is required");
    return null;
  }
  // The PAIR, not the path: the same `stories/…` spelling exists in every root (#3014).
  //
  // Parsed and guarded BEFORE `ffmpegGuard` and before any work: `guardStoryGenerationRoot` is
  // the package op that encodes the root-scoped generation rules, and it refuses a named root
  // unless the host declared `rootScopedGenerationState` — because the start event is published
  // before the story is even resolved, so an unsupported root would emit a start/finish pair for
  // work that never existed (#3020). This host declares no extra roots, so in practice every
  // request here is the default; resolving with the root and skipping this guard is how a
  // rooted generation would have run anyway (#3077 round 5, Codex P2).
  const root = suppliedRoot(req.body.root, res);
  if (root === null) return null;
  const generationRootGuard = mulmoScriptOps.guardStoryGenerationRoot(root);
  if (generationRootGuard) {
    sendOpFailure(res, generationRootGuard);
    return null;
  }
  const ffmpeg = mulmoScriptOps.ffmpegGuard();
  if (ffmpeg) {
    sendOpFailure(res, ffmpeg);
    return null;
  }
  const resolved = mulmoScriptOps.resolveStory(filePath, root);
  if (!resolved.ok) {
    sendOpFailure(res, resolved);
    return null;
  }
  return { filePath, absoluteFilePath: resolved.absolutePath, root, chatSessionId };
}

// SSE movie generation. Retained for wire compatibility (the extracted
// View now uses the long-held `generateMovie` dispatch + generation
// pubsub events instead); the pipeline itself is shared via
// `mulmoScriptOps.runMovieGeneration`.
bindRoute(router, API_ROUTES.mulmoScript.generateMovie, async (req: Request<object, object, { filePath: string; chatSessionId?: string }>, res: Response) => {
  const parsed = resolveStoryRequest(req, res);
  if (!parsed) return;
  const { filePath, absoluteFilePath, root, chatSessionId } = parsed;

  if (mulmoScriptOps.inFlightMovies.has(absoluteFilePath)) {
    badRequest(res, "Movie generation is already in progress for this script");
    return;
  }

  const send = beginSse(res);

  mulmoScriptOps.inFlightMovies.add(absoluteFilePath);
  // The root rides on the event and on the artifact ref: a subscriber routes by the PAIR
  // `(root, filePath)`, and `outputRef` relativizes against the root's own directory (#3014).
  mulmoScriptOps.publishGeneration(chatSessionId, GENERATION_KINDS.movie, filePath, "", false, { root });
  let genError: string | undefined;
  try {
    const result = await mulmoScriptOps.runMovieGeneration(absoluteFilePath, (event) => {
      send({ type: `beat_${event.kind}_done`, beatIndex: event.beatIndex });
    });
    if (!result.ok) {
      genError = result.error;
      send({ type: "error", message: result.error });
      return;
    }
    send({ type: "done", moviePath: mulmoScriptOps.outputRef(result.outputPath, filePath, root) });
  } catch (err) {
    genError = errorMessage(err);
    send({ type: "error", message: genError });
  } finally {
    mulmoScriptOps.inFlightMovies.delete(absoluteFilePath);
    mulmoScriptOps.publishGeneration(chatSessionId, GENERATION_KINDS.movie, filePath, "", true, { error: genError, root });
    res.end();
  }
});

interface CharacterImageQuery {
  filePath?: string | undefined;
  key?: string | undefined;
  root?: string | undefined;
}

interface RenderCharacterBody {
  filePath: string;
  key: string;
  force?: boolean | undefined;
  chatSessionId?: string | undefined;
  root?: string | undefined;
}

interface UploadCharacterImageBody {
  filePath: string;
  key: string;
  imageData: string; // base64 data URI
  root?: string | undefined;
}

type CharacterImageResponse = { image: string | null } | ErrorResponse;

bindRoute(
  router,
  API_ROUTES.mulmoScript.characterImage,
  async (req: Request<object, CharacterImageResponse, object, CharacterImageQuery>, res: Response<CharacterImageResponse>) => {
    const filePath = stringQuery(req.query.filePath);
    const key = stringQuery(req.query.key);
    if (!filePath || !key) {
      badRequest(res, "filePath and key are required");
      return;
    }
    const root = suppliedRoot(req.query.root, res);
    if (root === null) return;
    const result = await mulmoScriptOps.characterImageOp(filePath, key, root);
    if (!result.ok) {
      sendOpFailure(res, result);
      return;
    }
    res.json({ image: result.image });
  },
);

bindRoute(
  router,
  API_ROUTES.mulmoScript.uploadBeatImage,
  async (req: Request<object, BeatImageResponse, UploadBeatImageBody>, res: Response<BeatImageResponse>) => {
    const { filePath, beatIndex, imageData } = req.body;
    if (typeof filePath !== "string" || !filePath || !validBeatIndex(beatIndex) || typeof imageData !== "string" || !imageData) {
      badRequest(res, "filePath, beatIndex, and imageData are required");
      return;
    }
    const root = suppliedRoot(req.body.root, res);
    if (root === null) return;
    const result = await mulmoScriptOps.uploadBeatImageOp(filePath, beatIndex, imageData, root);
    if (!result.ok) {
      sendOpFailure(res, result);
      return;
    }
    res.json({ image: result.image });
  },
);

bindRoute(
  router,
  API_ROUTES.mulmoScript.renderCharacter,
  async (req: Request<object, CharacterImageResponse, RenderCharacterBody>, res: Response<CharacterImageResponse>) => {
    const { filePath, key, force, chatSessionId } = req.body;
    if (typeof filePath !== "string" || !filePath || typeof key !== "string" || !key) {
      badRequest(res, "filePath and key are required");
      return;
    }
    const root = suppliedRoot(req.body.root, res);
    if (root === null) return;
    const result = await mulmoScriptOps.renderCharacterOp({ filePath, key, force, chatSessionId, root });
    if (!result.ok) {
      sendOpFailure(res, result);
      return;
    }
    res.json({ image: result.image });
  },
);

bindRoute(
  router,
  API_ROUTES.mulmoScript.uploadCharacterImage,
  async (req: Request<object, CharacterImageResponse, UploadCharacterImageBody>, res: Response<CharacterImageResponse>) => {
    const { filePath, key, imageData } = req.body;
    if (typeof filePath !== "string" || !filePath || typeof key !== "string" || !key || typeof imageData !== "string" || !imageData) {
      badRequest(res, "filePath, key, and imageData are required");
      return;
    }
    const root = suppliedRoot(req.body.root, res);
    if (root === null) return;
    const result = await mulmoScriptOps.uploadCharacterImageOp(filePath, key, imageData, root);
    if (!result.ok) {
      sendOpFailure(res, result);
      return;
    }
    res.json({ image: result.image });
  },
);

bindRoute(router, API_ROUTES.mulmoScript.downloadMovie, (req: Request, res: Response) => {
  const moviePath = getOptionalStringQuery(req, "moviePath");
  if (!moviePath) {
    badRequest(res, "moviePath is required");
    return;
  }
  // An artifact ref is relative to ITS stories root (#3014). Absent = the default root, which
  // is every request this host makes today — it registers no extra roots — so this is
  // unchanged for it and correct for a host that does.
  // Through the parser, not `getOptionalStringQuery`: that folds a repeated `?root=a&root=b`
  // (an ARRAY) into `undefined`, which serves the DEFAULT root's identically-named artifact —
  // the fold this PR removed everywhere else (#3077 round 3, Codex).
  const root = suppliedRoot(req.query.root, res);
  if (root === null) return;
  const resolved = mulmoScriptOps.resolveStory(moviePath, root);
  if (!resolved.ok) {
    sendOpFailure(res, resolved);
    return;
  }
  res.download(resolved.absolutePath);
});

bindRoute(
  router,
  API_ROUTES.mulmoScript.pdfStatus,
  async (req: Request<object, PdfStatusResponse, object, FilePathQuery>, res: Response<PdfStatusResponse>) => {
    const filePath = stringQuery(req.query.filePath);
    if (!filePath) {
      badRequest(res, "filePath is required");
      return;
    }
    const root = suppliedRoot(req.query.root, res);
    if (root === null) return;
    const result = await mulmoScriptOps.pdfStatusOp(filePath, root);
    if (!result.ok) {
      sendOpFailure(res, result);
      return;
    }
    res.json({ pdfPath: result.pdfPath });
  },
);

// SSE PDF generation — retained for wire compatibility, same as the
// movie SSE route above.
async function handleGeneratePdf(req: Request<object, object, { filePath: string; chatSessionId?: string }>, res: Response): Promise<void> {
  const parsed = resolveStoryRequest(req, res);
  if (!parsed) return;
  const { filePath, absoluteFilePath, root, chatSessionId } = parsed;

  if (mulmoScriptOps.inFlightPdfs.has(absoluteFilePath)) {
    badRequest(res, "PDF generation is already in progress for this script");
    return;
  }

  const send = beginSse(res);

  mulmoScriptOps.inFlightPdfs.add(absoluteFilePath);
  mulmoScriptOps.publishGeneration(chatSessionId, GENERATION_KINDS.pdf, filePath, "", false, { root });
  let genError: string | undefined;
  try {
    const context = await buildContext(absoluteFilePath);
    if (!context) {
      genError = "Failed to initialize mulmo context";
      send({ type: "error", message: genError });
      return;
    }
    const result = await mulmoScriptOps.runPdfGeneration(context, (beatIndex) => send({ type: "beat_image_done", beatIndex }));
    if (!result.ok) {
      genError = result.error;
      send({ type: "error", message: genError });
      return;
    }
    send({ type: "done", pdfPath: mulmoScriptOps.outputRef(result.outputPath, filePath, root) });
  } catch (err) {
    genError = errorMessage(err);
    send({ type: "error", message: genError });
  } finally {
    mulmoScriptOps.inFlightPdfs.delete(absoluteFilePath);
    mulmoScriptOps.publishGeneration(chatSessionId, GENERATION_KINDS.pdf, filePath, "", true, { error: genError, root });
    res.end();
  }
}

bindRoute(router, API_ROUTES.mulmoScript.generatePdf, async (req: Request<object, object, { filePath: string; chatSessionId?: string }>, res: Response) =>
  handleGeneratePdf(req, res),
);

bindRoute(router, API_ROUTES.mulmoScript.downloadPdf, (req: Request, res: Response) => {
  const pdfPath = getOptionalStringQuery(req, "pdfPath");
  if (!pdfPath) {
    badRequest(res, "pdfPath is required");
    return;
  }
  // Same as downloadMovie above: the ref is relative to its root (#3014).
  // Through the parser, not `getOptionalStringQuery`: that folds a repeated `?root=a&root=b`
  // (an ARRAY) into `undefined`, which serves the DEFAULT root's identically-named artifact —
  // the fold this PR removed everywhere else (#3077 round 3, Codex).
  const root = suppliedRoot(req.query.root, res);
  if (root === null) return;
  const resolved = mulmoScriptOps.resolveStory(pdfPath, root);
  if (!resolved.ok) {
    sendOpFailure(res, resolved);
    return;
  }
  res.download(resolved.absolutePath);
});

export default router;
