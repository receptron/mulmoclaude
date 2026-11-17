import type { ToolPlugin } from "gui-chat-protocol/vue";
import type { PluginRegistration } from "../../tools/types";
import { plugin as brepPlugin, type PresentBrepData } from "@gui-chat-plugin/brep/vue";
// The View's scoped styles are a standalone stylesheet; Vite lib mode does not
// inject it, so the consumer imports it (same as presentShapeScript / presentForm).
import "@gui-chat-plugin/brep/style.css";
import type { BrepEndpoints } from "./definition";
import { META } from "./meta";
import { makeRouteExecute } from "../execute";

const TOOL_NAME = META.toolName;

// Imported from the browser entry, not ./definition (a type-only import above):
// the package's core entry reaches the OpenCascade kernel and `node:vm`, and
// must stay out of the client bundle.
//
// The View and Preview are the package's own, unwrapped: everything they show
// (the mesh, the report, the files behind the download buttons) travels in the
// tool result, so they use no runtime, no dispatch and no file route.
const presentBrepPlugin: ToolPlugin<PresentBrepData, unknown, object> = {
  ...brepPlugin,
  // The model is built on the server (POST /api/brep). The package's own
  // browser `execute` only refuses, saying where the tool runs.
  execute: makeRouteExecute<BrepEndpoints, PresentBrepData>("brep", "create", TOOL_NAME),
};
export { TOOL_NAME };

export const REGISTRATION: PluginRegistration = {
  toolName: TOOL_NAME,
  entry: presentBrepPlugin,
};
