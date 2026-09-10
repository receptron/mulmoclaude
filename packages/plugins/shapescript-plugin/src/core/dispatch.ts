import type { FileOps } from "gui-chat-protocol";
import { isPresentableShapePath, isShapeArtifactPath, toArtifactsRelative } from "./paths";
import type { ShapeScriptDispatchArgs } from "./contract";

/** The three FileOps methods this plugin's file paths actually use. A host's
 *  full `FileOps` satisfies it; so does a three-method object, which is what
 *  lets a host wire the `exportShapeScriptUsdz` MCP tool without reaching into
 *  its plugin runtime for a complete FileOps (that import cycles in MulmoClaude). */
export type ShapeFileOps = Pick<FileOps, "read" | "write" | "exists">;

/** Capabilities the dispatch router needs: the generic, shared
 *  `files.artifacts` FileOps, plus — for hosts that let presentShapeScript
 *  open sources outside `artifacts/shapes/` — `files.byPath`. */
export interface ShapeScriptDispatchContext {
  files: { artifacts: ShapeFileOps; byPath?: ShapeFileOps };
}

/** The FileOps that owns a given source, plus the path in that FileOps' terms.
 *  An `artifacts/shapes/**` source goes through `files.artifacts` — the only
 *  capability an older host provides, and what writes there — while anything
 *  else needs the host's `files.byPath`. */
export function locateShape(context: ShapeScriptDispatchContext, filePath: string): { files: ShapeFileOps; rel: string } | null {
  if (isShapeArtifactPath(filePath)) return { files: context.files.artifacts, rel: toArtifactsRelative(filePath) };
  const byPath = context.files.byPath;
  if (byPath && isPresentableShapePath(filePath)) return { files: byPath, rel: filePath };
  return null;
}

/**
 * Server-side router for the View's `useRuntime().dispatch({ kind, … })` calls.
 * `loadShape` returns the source's current bytes (the View refreshes from disk
 * rather than trusting the copy in the tool result); `saveShape` overwrites one
 * that already exists, and refuses to create. Both validate containment with
 * the same guards as the tool-call path before touching FileOps.
 *
 * Throws on an invalid path / missing file — the host's dispatch route maps a
 * throw to a non-2xx, which the View's `dispatch` rejects on. Geometry is NOT
 * validated here: the View validates before it dispatches (it has the same
 * parser), and a save that refused to persist a work-in-progress source would
 * make the editor unusable.
 */
export async function executeShapeScriptDispatch(
  context: ShapeScriptDispatchContext,
  args: ShapeScriptDispatchArgs,
): Promise<{ script: string } | { path: string }> {
  // `args` is cast from `unknown` in host dispatch wiring, so validate at
  // runtime before touching FileOps — a malformed payload must surface as a
  // clean error, not a TypeError / a write of a non-string body.
  if (typeof args?.path !== "string") {
    throw new Error("path must be an existing .shape file");
  }
  const target = locateShape(context, args.path);
  if (!target) {
    throw new Error("path must be an existing .shape file");
  }
  switch (args.kind) {
    case "loadShape": {
      const script = await target.files.read(target.rel);
      return { script };
    }
    case "saveShape": {
      if (typeof args.script !== "string") {
        throw new Error("saveShape requires `script` as a string");
      }
      // Overwrite-only, the same contract `overwriteDocument` carries: this
      // channel edits a model the user is looking at, so a path that does not
      // exist is a typo or a file deleted mid-edit, not a save. `FileOps.write`
      // would happily create it — and creating `.shape` files at caller-chosen
      // paths is a wider capability than editing one (CodeRabbit on #3056).
      if (!(await target.files.exists(target.rel))) {
        throw new Error(`No ShapeScript exists at ${args.path}`);
      }
      await target.files.write(target.rel, args.script);
      return { path: args.path };
    }
    default: {
      // Exhaustiveness guard: a new kind without a branch trips this at compile time.
      const exhaustive: never = args;
      throw new Error(`shapescript plugin: unknown dispatch kind ${JSON.stringify(exhaustive)}`);
    }
  }
}
