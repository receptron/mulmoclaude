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
// directory do not justify it.

import {
  executeExportShapeScriptUsdz,
  EXPORT_USDZ_DESCRIPTION,
  EXPORT_USDZ_PROMPT,
  EXPORT_USDZ_SCHEMA,
  EXPORT_USDZ_TOOL_NAME,
  SHAPE_EXTENSIONS,
  type ShapeFileOps,
} from "@mulmoclaude/shapescript-plugin";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../../utils/files/atomic.js";
import { makeByPathFileOps } from "../../utils/files/by-path.js";
import { workspacePath } from "../../workspace/workspace.js";
import { log } from "../../system/logger/index.js";
import type { McpTool } from "./index.js";

/** Absolute path for an artifacts-relative one, refusing anything that
 *  resolves outside `<workspace>/artifacts`. The plugin already rejects
 *  traversal lexically; this is the belt to that brace. */
function withinArtifacts(rel: string): string {
  const root = path.join(workspacePath, "artifacts");
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path escapes artifacts/: ${rel}`);
  return abs;
}

const artifacts: ShapeFileOps = {
  read: (rel) => readFile(withinArtifacts(rel), "utf-8"),
  write: (rel, content) => writeFileAtomic(withinArtifacts(rel), content),
  exists: async (rel) => {
    try {
      return (await stat(withinArtifacts(rel))).isFile();
    } catch {
      return false;
    }
  },
};

const shapeFiles = { artifacts, byPath: makeByPathFileOps(SHAPE_EXTENSIONS) };

export const exportShapeScriptUsdz: McpTool = {
  definition: {
    name: EXPORT_USDZ_TOOL_NAME,
    description: EXPORT_USDZ_DESCRIPTION,
    inputSchema: EXPORT_USDZ_SCHEMA,
  },
  prompt: EXPORT_USDZ_PROMPT,
  handler: async (args: Record<string, unknown>): Promise<string> => {
    log.info("render", "exportShapeScriptUsdz: start", { args: Object.keys(args).join(",") });
    const { message, filePath, bytes } = await executeExportShapeScriptUsdz({ files: shapeFiles }, args);
    log.info("render", "exportShapeScriptUsdz: ok", { filePath, bytes });
    return message;
  },
};
