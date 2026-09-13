// "The backend can't serve this right now" — as distinct from "the record
// isn't there" or "the stored record is malformed".
//
// Both non-file backends have such a state, and neither is a data problem:
//
//   - sqlite: `node:sqlite` needs Node >= 22.5, which the app's floor (>=22.19)
//     clears — so this is defensive, for a Node built without it (sqliteStore.ts).
//   - csv/dataSource: `@duckdb/node-api` is a native module whose prebuilt
//     binding can be missing for the platform (csvStore.ts).
//
// The distinction matters because the layers above catch broadly. Without a
// type to test, `store.read(...).catch(() => null)` reports "record missing",
// a merge reports "malformed stored file", and an ontology count reports 0 —
// each of which sends the agent after a data problem that does not exist, and
// the last of which can have it offer to recreate records that are intact.
//
// Anything that summarises or swallows a store error MUST re-check with
// `isBackendUnavailable` and let it through.

/** Thrown by a store when its engine or session cannot serve the request. */
export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

export function isBackendUnavailable(err: unknown): err is BackendUnavailableError {
  return err instanceof BackendUnavailableError;
}
