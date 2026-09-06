import type { PluginRegistration, ToolPlugin } from "../../tools/types";
import { View, Preview, SYSTEM_PROMPT, samples, type PresentShapeScriptData } from "@mulmoclaude/shapescript-plugin/vue";
// The package's component scoped styles are compiled into a standalone
// stylesheet; Vite lib mode does NOT auto-inject it, so the consumer must
// import it — same as @mulmoclaude/{chart,form,markdown}-plugin.
import "@mulmoclaude/shapescript-plugin/style.css";
import toolDefinition, { TOOL_NAME, type ShapeScriptEndpoints } from "./definition";
import { makeRouteExecute } from "../execute";
import { wrapWithScope } from "../scope";

const shapeScriptPlugin: ToolPlugin<PresentShapeScriptData> = {
  toolDefinition,

  execute: makeRouteExecute<ShapeScriptEndpoints, PresentShapeScriptData>("shapescript", "create", TOOL_NAME),

  isEnabled: () => true,
  generatingMessage: "Creating 3D visualization…",
  systemPrompt: SYSTEM_PROMPT,
  samples,
  viewComponent: wrapWithScope("shapescript", View),
  previewComponent: wrapWithScope("shapescript", Preview),
};
export { TOOL_NAME };

export const REGISTRATION: PluginRegistration = {
  toolName: TOOL_NAME,
  entry: shapeScriptPlugin,
};
