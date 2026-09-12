// `./render` entry — server-only rasterisation of a ShapeScript model to a PNG.
//
// Separate from `.` because of what it needs: `node:fs`, `node:module`, and a
// headless Chromium. The main entry is imported by the Vue build, so anything
// here reaching it would put a browser driver in a browser bundle.
//
// A host wires this to whatever it calls tools: MulmoClaude registers a
// `renderShapeScript` MCP tool, MulmoTerminal serves the same tool through its
// own MCP surface. Neither owns the renderer, which is the point — the two used
// to be one copy each.
export { renderShapeScriptSheet, RenderUnavailableError, CHROMIUM_HINT, RENDER_TIMEOUT_MS, LAUNCH_TIMEOUT_MS, RENDER_BUDGET_MS } from "./renderer";
export type { RenderShapeScriptOptions } from "./renderer";
export { buildRenderPage, gridFor } from "./page";
export type { ViewAngle, RenderPageOptions } from "./page";
export {
  executeRenderShapeScript,
  viewAngles,
  RENDER_SHAPE_SCRIPT_TOOL_NAME,
  RENDER_SHAPE_SCRIPT_DESCRIPTION,
  RENDER_SHAPE_SCRIPT_PROMPT,
  RENDER_SHAPE_SCRIPT_SCHEMA,
  RENDER_TOOL_TIMEOUT_MS,
  renderOptionsFrom,
  savedMessage,
} from "./tool";
export type { RenderToolDeps, RenderToolResult } from "./tool";
export { renderShapeThumbnail } from "./thumbnail";
