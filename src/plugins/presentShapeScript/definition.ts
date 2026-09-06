import { META } from "./meta";
import type { ResolvedRoute } from "../meta-types";
import { TOOL_DEFINITION } from "@mulmoclaude/shapescript-plugin";

// presentShapeScript's tool schema, ShapeScript parser, Three.js renderer,
// View and Preview live in the shared @mulmoclaude/shapescript-plugin package
// (also consumable by MulmoTerminal). This built-in is a thin host adapter: it
// keeps MulmoClaude's routing META and scoped-runtime wrapping while sourcing
// the schema and UI from the package. Same shape as the chart adapter.
export const TOOL_NAME = META.toolName;

/** Resolved-URL view of the plugin's routes (create). Auto-derived from META. */
export type ShapeScriptEndpoints = { readonly [K in keyof typeof META.apiRoutes]: ResolvedRoute };

export { TOOL_DEFINITION };
export default TOOL_DEFINITION;
