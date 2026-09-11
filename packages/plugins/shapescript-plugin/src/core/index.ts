export type {
  PresentShapeScriptData,
  PresentShapeScriptArgs,
  PresentShapeScriptResult,
  PresentShapeScriptRenderedResult,
  PresentShapeScriptErrorResult,
  PresentShapeScriptExecutionResult,
  ShapeScriptDiagnostic,
} from "./types";
export { TOOL_NAME, TOOL_DEFINITION } from "./definition";
export { pluginCore, presentShapeScript, executePresentShapeScript } from "./plugin";
export type { ShapeScriptExecuteContext } from "./plugin";
export { executeShapeScriptDispatch, locateShape } from "./dispatch";
export type { ShapeScriptDispatchContext, ShapeFileOps } from "./dispatch";
export { isShapeScriptDispatchArgs, readLoadShapeResult, readSaveShapeResult } from "./contract";
export type { LoadShapeArgs, SaveShapeArgs, ShapeScriptDispatchArgs, ShapeScriptDispatchResult } from "./contract";
export { isPresentableShapePath, isShapeArtifactPath, shapeArtifactPath, usdzArtifactPath, toArtifactsRelative, SHAPE_EXTENSIONS } from "./paths";
// USDZ export: the pure serialiser (shared with the View's download button) and
// the `exportShapeScriptUsdz` tool, which needs only the generic `files`
// capability — so it lives on `.` rather than a server-only entry.
export { sceneToUsdz, shapeScriptToUsdz, USDZ_MIME_TYPE, USDZ_EXTENSION } from "../export/usdz";
export {
  executeExportShapeScriptUsdz,
  EXPORT_USDZ_TOOL_NAME,
  EXPORT_USDZ_DESCRIPTION,
  EXPORT_USDZ_PROMPT,
  EXPORT_USDZ_SCHEMA,
  EXPORT_USDZ_TOOL_TIMEOUT_MS,
} from "../export/tool";
export type { ExportUsdzResult } from "../export/tool";
export { samples } from "./samples";

// Re-export ShapeScript utilities
export { parseShapeScript } from "../shapescript/parser";
export { astToThreeJS, sceneInfoOf } from "../shapescript/toThreeJS";
export type { ShapeScriptSceneInfo } from "../shapescript/toThreeJS";
export type { SceneNode } from "../shapescript/types";
