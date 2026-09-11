import type { FileOps, ToolContext, ToolPluginCore } from "gui-chat-protocol";
import type { PresentShapeScriptArgs, PresentShapeScriptData, PresentShapeScriptExecutionResult, ShapeScriptDiagnostic } from "./types";
import { TOOL_NAME, TOOL_DEFINITION } from "./definition";
import { isRecord } from "./contract";
import { locateShape } from "./dispatch";
import { shapeArtifactPath } from "./paths";

import { parseShapeScript } from "../shapescript/parser";
import { astToThreeJS, sceneInfoOf, ShapeScriptLimitError, type ShapeScriptSceneInfo } from "../shapescript/toThreeJS";
import { disposeObject3D } from "../shapescript/dispose";
import { ParseError } from "../shapescript/types";

/** Host capabilities the ShapeScript core needs, delivered through the GENERIC
 *  gui-chat-protocol runtime — `files.artifacts` (the shared, user-browsable
 *  output area) for new sources, and `files.byPath` for a `path` outside
 *  `artifacts/shapes/`.
 *
 *  Both are OPTIONAL, and a plain `ToolContext` satisfies this type: a host
 *  with no file layer keeps the pre-1.1 behaviour — the script round-trips
 *  inside the tool result and nothing is written — rather than failing. */
export interface ShapeScriptExecuteContext extends ToolContext {
  files?: {
    /** Rooted at `<workspace>/artifacts` — where NEW sources are written. */
    artifacts: FileOps;
    /** Reads a source the caller named by path: workspace-relative or, where
     *  the host allows it, absolute. */
    byPath?: FileOps;
  };
}

const PRESENT_ACK = "Acknowledge that the 3D visualization has been created and is displayed to the user. They can rotate, zoom, and pan the camera.";

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Build + immediately dispose the model, so an unrenderable script is
 *  reported as a diagnostic instead of a blank viewport. Throws; the caller
 *  maps the cause to a `ShapeScriptDiagnostic`. Returns what the build
 *  reported: commands it skipped and `print` output, both for the agent. */
function validateGeometry(script: string): ShapeScriptSceneInfo {
  const group = astToThreeJS(parseShapeScript(script));
  const info = sceneInfoOf(group);
  disposeObject3D(group);
  return info;
}

/** The tool message's tail: skipped commands and `print` lines, so the agent
 *  learns that a `texture` was not drawn without the user having to say so. */
function describeSceneInfo(info: ShapeScriptSceneInfo): string {
  const parts: string[] = [];
  if (info.warnings.length) parts.push(`Not rendered: ${info.warnings.join("; ")}`);
  if (info.logs.length) parts.push(`Output:\n${info.logs.join("\n")}`);
  return parts.length ? `\n${parts.join("\n")}` : "";
}

/** Read the source a `path` argument names, through whichever FileOps owns it. */
async function readShapeSource(context: ShapeScriptExecuteContext, filePath: string): Promise<string> {
  const files = context.files;
  if (!files) throw new Error("This host cannot open a ShapeScript by path — pass the source as `script` instead");
  const target = locateShape({ files }, filePath);
  if (!target) throw new Error("`path` must be a .shape file, without `.` / `..` segments");
  if (!(await target.files.exists(target.rel))) throw new Error(`No ShapeScript exists at ${filePath}`);
  return target.files.read(target.rel);
}

/** How many times a fresh path is re-minted before giving up. The random token
 *  makes one collision already unlikely; more than a couple in a row means the
 *  clock and the RNG are both stuck, which is not a case to keep looping on. */
const MINT_ATTEMPTS = 5;

/** Persist a new source under a fresh `artifacts/shapes/**` path. Returns the
 *  workspace-relative path, or undefined when the host has no file layer.
 *
 *  The existence check is what makes "fresh" a promise rather than a hope:
 *  `write` overwrites unconditionally, so a name that is already taken would
 *  replace someone else's model silently. */
async function saveShapeSource(context: ShapeScriptExecuteContext, script: string, title: string): Promise<string | undefined> {
  const artifacts = context.files?.artifacts;
  if (!artifacts) return undefined;
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const { relPath, filePath } = shapeArtifactPath(title);
    if (await artifacts.exists(relPath)) continue;
    await artifacts.write(relPath, script);
    return filePath;
  }
  throw new Error("Could not allocate a free path under artifacts/shapes — try again with a different title");
}

/** Resolve the tool call's two argument shapes to one source + its file. */
async function resolveSource(context: ShapeScriptExecuteContext, args: PresentShapeScriptArgs): Promise<PresentShapeScriptData> {
  // `script` and `path` are mutually exclusive — the tool description says
  // "either, not both". Reject both-set rather than letting one silently win.
  if (nonEmpty(args.path) && nonEmpty(args.script)) {
    throw new Error("Provide either `script` or `path`, not both");
  }
  if (nonEmpty(args.path)) {
    const script = await readShapeSource(context, args.path);
    return { script, filePath: args.path };
  }
  if (!nonEmpty(args.script)) {
    throw new Error("ShapeScript code is required but was not provided");
  }
  return { script: args.script };
}

export const presentShapeScript = async (context: ShapeScriptExecuteContext, args: PresentShapeScriptArgs): Promise<PresentShapeScriptExecutionResult> => {
  let code: ShapeScriptDiagnostic["code"] = "INVALID_ARGUMENT";
  try {
    if (!isRecord(args)) {
      throw new Error("presentShapeScript args must be an object with `script` or `path`");
    }
    if (!nonEmpty(args.title)) {
      throw new Error("A nonempty visualization title is required");
    }
    const source = await resolveSource(context ?? {}, args);
    code = "EVALUATION_ERROR";
    // Geometry construction is headless: validate the same evaluator/builders
    // the browser uses, then release the temporary scene before returning.
    const info = validateGeometry(source.script);
    // Only a NEW script is written; a `path` result already names its file.
    const filePath = source.filePath ?? (await saveShapeSource(context ?? {}, source.script, args.title));
    return {
      message: (filePath ? `Saved ShapeScript to ${filePath}` : `Created 3D visualization: ${args.title}`) + describeSceneInfo(info),
      title: args.title,
      data: filePath ? { script: source.script, filePath } : { script: source.script },
      instructions: PRESENT_ACK,
    };
  } catch (cause) {
    const error: ShapeScriptDiagnostic = {
      code: cause instanceof ParseError ? "PARSE_ERROR" : cause instanceof ShapeScriptLimitError ? "LIMIT_EXCEEDED" : code,
      message: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof ParseError && cause.line !== undefined ? { line: cause.line } : {}),
      ...(cause instanceof ParseError && cause.column !== undefined ? { column: cause.column } : {}),
    };
    return {
      message: `ShapeScript error: ${error.message}`,
      error,
      jsonData: { error },
      instructions: "The visualization was not created. Correct the ShapeScript using the returned diagnostic and call presentShapeScript again.",
    };
  }
};

export const pluginCore: ToolPluginCore<PresentShapeScriptData, unknown, PresentShapeScriptArgs> = {
  toolDefinition: TOOL_DEFINITION,
  execute: presentShapeScript,
  generatingMessage: "Creating 3D visualization...",
  waitingMessage: "Tell the user that the 3D visualization was created and will be presented shortly.",
  isEnabled: () => true,
};

export { TOOL_NAME, TOOL_DEFINITION };
export const executePresentShapeScript = presentShapeScript;
