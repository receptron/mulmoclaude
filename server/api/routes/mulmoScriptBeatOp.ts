// Shared plumbing for the beat-scoped mulmoScript REST endpoints.
//
// Extracted from `mulmo-script.ts` (#2368): the beat POST handlers all
// repeated the same skeleton — validate `{ filePath, beatIndex }`, run one
// op, map a failure onto its HTTP status, respond with a single key. That
// skeleton carries the array-index guard, so every copy was a place the
// guard could be forgotten when the next beat endpoint (caption, subtitle,
// …) is added.
//
// Living in its own module also keeps the guard + factory testable without
// booting the plugin runtime that `mulmo-script.ts` imports.

import type { Request, Response } from "express";
import type { OpFailure } from "@mulmoclaude/mulmoscript-plugin/server";
import { badRequest, sendError } from "../../utils/httpError.js";

export interface ErrorResponse {
  error: string;
}

const OP_FAILURE_STATUS: Record<OpFailure["code"], number> = {
  bad_request: 400,
  not_found: 404,
  unavailable: 503,
  server_error: 500,
};

export function sendOpFailure(res: Response, failure: OpFailure): void {
  sendError(res, OP_FAILURE_STATUS[failure.code], failure.error);
}

// Beat indexes must be non-negative integers — `-1` / `1.5` must fail as a
// deterministic 400 instead of indexing undefined beats downstream. The
// upper bound is deliberately NOT checked here: the beat count is only
// known once the op has loaded the script, so an in-range-but-too-large
// index is the op's `not_found`, not this guard's 400.
export function validBeatIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Arguments every beat op takes — the validated pair plus the two
 *  optional passthroughs the generation ops use. */
export interface BeatOpArgs {
  filePath: string;
  beatIndex: number;
  force?: boolean | undefined;
  chatSessionId?: string | undefined;
  /** Which registered stories root `filePath` is relative to (#3014); absent = the default.
   *  Without it every beat op here resolved the DEFAULT root's file of that name, because the
   *  same `stories/…` spelling exists in each one (#3077). */
  root?: string | undefined;
}

/** Untrusted request body: `filePath` / `beatIndex` are whatever JSON the
 *  client sent, so they stay `unknown` until the guards run. */
export interface BeatOpBody {
  filePath?: unknown | undefined;
  beatIndex?: unknown | undefined;
  force?: boolean | undefined;
  chatSessionId?: string | undefined;
  root?: unknown | undefined;
}

export type BeatOpHandler<TBody> = (req: Request<object, unknown, BeatOpBody>, res: Response<TBody | ErrorResponse>) => Promise<void>;

/**
 * Build the handler for one beat endpoint. `runOp` is the only thing that
 * generates, and `toResponse` is the only thing that names the success key
 * (`audio`, `image`, …) — validation, failure mapping, and the 200 shape
 * are shared.
 */
export function makeBeatOpHandler<TResult extends { ok: true }, TBody extends object>(
  runOp: (args: BeatOpArgs) => Promise<TResult | OpFailure>,
  toResponse: (result: TResult) => TBody,
): BeatOpHandler<TBody> {
  return async (req, res) => {
    const { filePath, beatIndex, force, chatSessionId, root } = req.body;
    if (typeof filePath !== "string" || !filePath || !validBeatIndex(beatIndex)) {
      badRequest(res, "filePath and beatIndex are required");
      return;
    }
    // Absent, empty, or the wrong TYPE all read as the default root — the same rule the
    // package's dispatch applies, so one request means one thing on either transport (#3014).
    const suppliedRoot = typeof root === "string" && root !== "" ? root : undefined;
    const result = await runOp({ filePath, beatIndex, force, chatSessionId, root: suppliedRoot });
    if (!result.ok) {
      sendOpFailure(res, result);
      return;
    }
    res.json(toResponse(result));
  };
}
