export type { PresentShapeScriptData, PresentShapeScriptArgs, PresentShapeScriptResult, PresentShapeScriptRenderedResult } from "./types";
export { TOOL_NAME, TOOL_DEFINITION } from "./definition";
export { pluginCore, presentShapeScript, executePresentShapeScript } from "./plugin";
export { samples } from "./samples";

// Re-export ShapeScript utilities
export { parseShapeScript } from "../shapescript/parser";
export { astToThreeJS } from "../shapescript/toThreeJS";
export type { SceneNode } from "../shapescript/types";
