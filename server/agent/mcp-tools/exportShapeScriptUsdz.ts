// `exportShapeScriptUsdz` — write a ShapeScript model out as a USDZ file the
// user can open in AR Quick Look or any USD viewer.
//
// A pure MCP tool, like `renderShapeScript`: no View, nothing pushed to the
// canvas, the answer is a file path. Everything about the tool — schema,
// description, the export itself, where under `artifacts/shapes/` the file
// lands — lives in `@mulmoclaude/shapescript-plugin`, and it reaches storage
// only through the generic `files` capability. So this host contributes a
// FileOps rooted at `<workspace>/artifacts`, the same `byPath` capability its
// dispatch handler uses, and its logger; MulmoTerminal wires the identical
// call against its own FileOps.
//
// The artifacts FileOps is built HERE rather than borrowed from
// `server/plugins/runtime.ts`: that module reaches the chat route, which
// reaches the prompt, which reaches this tool list — a cycle that leaves
// `MCP_SERVER_ID` uninitialised at import time. Three methods over one
// directory, on the host's shared containment helpers, do not justify it.

import {
  executeExportShapeScriptUsdz,
  EXPORT_USDZ_DESCRIPTION,
  EXPORT_USDZ_PROMPT,
  EXPORT_USDZ_SCHEMA,
  EXPORT_USDZ_TOOL_NAME,
  EXPORT_USDZ_TOOL_TIMEOUT_MS,
  SHAPE_EXTENSIONS,
  type ShapeFileOps,
} from "@mulmoclaude/shapescript-plugin";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../../utils/files/atomic.js";
import { resolveWithinRoot, resolveWriteWithinRoot } from "../../utils/files/safe.js";
import { makeByPathFileOps } from "../../utils/files/by-path.js";
import { workspacePath } from "../../workspace/workspace.js";
import { log } from "../../system/logger/index.js";
import type { McpTool } from "./index.js";

/** The realpath of the artifacts root, created if it does not exist yet —
 *  both containment checks below require a realpath to compare against, and
 *  a first export on a fresh workspace has no `artifacts/` to realpath. */
async function artifactsRootReal(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  return realpath(root);
}

/**
 * `ShapeFileOps` over one artifacts directory, with the host's realpath-based
 * containment: a symlinked `artifacts/shapes -> /outside` must neither be read
 * through nor written through, which a lexical `path.resolve` check would
 * allow (codex on #3065). Reads use `resolveWithinRoot` (the target's realpath
 * must stay in root); the write uses `resolveWriteWithinRoot`, which verifies
 * the existing ancestors instead, since the `.usdz` does not exist yet.
 *
 * Exported for tests; the tool binds it to `<workspace>/artifacts` below.
 */
export function makeArtifactsShapeFiles(rootFor: () => string): ShapeFileOps {
  const readTarget = async (rel: string): Promise<string | null> => resolveWithinRoot(await artifactsRootReal(rootFor()), rel);
  return {
    read: async (rel) => {
      const abs = await readTarget(rel);
      if (abs === null) throw new Error(`No ShapeScript exists at artifacts/${rel}`);
      return readFile(abs, "utf-8");
    },
    exists: async (rel) => {
      const abs = await readTarget(rel);
      if (abs === null) return false;
      try {
        return (await stat(abs)).isFile();
      } catch {
        return false;
      }
    },
    write: async (rel, content) => {
      const abs = await resolveWriteWithinRoot(await artifactsRootReal(rootFor()), rel);
      if (abs === null) throw new Error(`path escapes artifacts/: ${rel}`);
      await writeFileAtomic(abs, content);
    },
  };
}

const shapeFiles = { artifacts: makeArtifactsShapeFiles(() => path.join(workspacePath, "artifacts")), byPath: makeByPathFileOps(SHAPE_EXTENSIONS) };

export const exportShapeScriptUsdz: McpTool = {
  definition: {
    name: EXPORT_USDZ_TOOL_NAME,
    description: EXPORT_USDZ_DESCRIPTION,
    inputSchema: EXPORT_USDZ_SCHEMA,
  },
  // Conversion alone may spend its full 30 s budget on a near-limit model, and
  // the USDZ serialisation + write come after it; the bridge's 30 s default
  // would abort an export that was about to succeed (codex on #3065).
  bridgeTimeoutMs: EXPORT_USDZ_TOOL_TIMEOUT_MS,
  prompt: EXPORT_USDZ_PROMPT,
  handler: async (args: Record<string, unknown>): Promise<string> => {
    log.info("render", "exportShapeScriptUsdz: start", { args: Object.keys(args).join(",") });
    const { message, filePath, bytes } = await executeExportShapeScriptUsdz({ files: shapeFiles }, args);
    log.info("render", "exportShapeScriptUsdz: ok", { filePath, bytes });
    return message;
  },
};
