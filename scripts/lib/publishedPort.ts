// Was `<workspace>/.server-port` written by THIS `yarn dev`, or left behind by a
// dead one? (#2981)
//
// The file is how the backend tells the dev client which port it actually bound
// — `server/index.ts` writes it right after `app.listen`, precisely because "the
// requested PORT may have walked forward off a busy default". Following it is
// what stops the client addressing a port nobody is on (#2650).
//
// Following it safely needs one guarantee, though: that the number belongs to
// the run doing the following. A graceful shutdown removes `.server-port` since
// #3082, but a crash does not, so a stale one can still outlive its writer — and
// the two dev panes start concurrently with no ordering guarantee — a file
// already on disk when the client snapshots it could be either. `yarn dev`
// settles that by clearing the file before either pane starts
// (`wait:backend --reset`); this module is the part that reads the evidence
// afterwards.

export interface FileSnapshot {
  exists: boolean;
  /** Meaningless when `exists` is false. */
  mtimeMs: number;
}

/**
 * Did the backend this run started publish its port?
 *
 * mtime rather than content, because a restart that lands on the same port
 * writes the SAME bytes — the write still happened, and it is the write that
 * marks the file as speaking for this run.
 */
export function wasRepublished(before: FileSnapshot, after: FileSnapshot): boolean {
  if (!after.exists) return false;
  if (!before.exists) return true;
  return after.mtimeMs !== before.mtimeMs;
}
