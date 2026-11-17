import { META } from "./meta";
import type { ResolvedRoute } from "../meta-types";
import { TOOL_DEFINITION } from "@gui-chat-plugin/brep";

// presentBrep's tool schema, the build (the OpenCascade kernel, in Node), its
// checks, View and Preview live in the shared @gui-chat-plugin/brep package
// (also used by MulmoTerminal and MulmoChat). This built-in is a thin host
// adapter, like presentShapeScript: it keeps MulmoClaude's routing META.
//
// Server-only: this imports the package's core entry, which reaches the kernel
// and `node:vm`. The browser side (index.ts) takes the definition from
// `@gui-chat-plugin/brep/vue`, which carries the View alone.
export const TOOL_NAME = META.toolName;

/** Resolved-URL view of the plugin's routes (create). Auto-derived from META. */
export type BrepEndpoints = { readonly [K in keyof typeof META.apiRoutes]: ResolvedRoute };

export { TOOL_DEFINITION };
export default TOOL_DEFINITION;
