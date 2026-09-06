// Manual extras the codegen can't auto-discover. These are the
// registrations and server bindings that don't fit the standard
// shape (one plugin dir → one META with apiNamespace+mcpDispatch).
//
// Two reasons something lives here:
//
//   1. **Cross-namespace endpoint** — editImages and generateImage
//      share the host-owned `/api/image/*` routes (so their META
//      is toolName-only). The codegen omits them from
//      `_generated/server-bindings.ts`; we wire the bindings here
//      against the host record directly.
//   2. **External npm-distributed plugin** — mindmap, quiz, googleMap
//      live in node_modules; they don't have a `src/plugins/<name>/`
//      directory the codegen can scan, so the registration AND the
//      binding both come from this file.
//
// New built-in plugins shouldn't land here — keep the standard shape
// (one dir, one META with apiNamespace+mcpDispatch). The extras list
// is meant to be small and stable.

import type { PluginRegistration } from "../tools/types";
import type { ServerPluginBinding } from "./server-bindings-types";
import { TOOL_NAMES } from "../config/toolNames";
import { API_ROUTES } from "../config/apiRoutes";

import { TOOL_DEFINITION as createMindMapDef } from "@gui-chat-plugin/mindmap";
import { TOOL_DEFINITION as putQuestionsDef } from "@mulmochat-plugin/quiz";
import { TOOL_DEFINITION as mapControlDef } from "@gui-chat-plugin/google-map";

import generateImageDef from "./generateImage/definition";
import editImagesDef from "./editImages/definition";

import MindMapPlugin from "@gui-chat-plugin/mindmap/vue";
import QuizPlugin from "@mulmochat-plugin/quiz/vue";
import GoogleMapPlugin from "@gui-chat-plugin/google-map/vue";

/** Externally-distributed plugin registrations. The codegen barrel
 *  in `_generated/registrations.ts` only knows about plugins with a
 *  local directory under `src/plugins/`; these npm packages need
 *  hand-wired entries. */
export const EXTERNAL_PLUGIN_REGISTRATIONS: readonly PluginRegistration[] = [
  { toolName: TOOL_NAMES.createMindMap, entry: MindMapPlugin.plugin },
  { toolName: TOOL_NAMES.putQuestions, entry: QuizPlugin.plugin },
  { toolName: TOOL_NAMES.mapControl, entry: GoogleMapPlugin.plugin },
];

/** MCP bindings that don't follow the standard
 *  `mcpEndpoint(meta)` resolution: image plugins reach into the
 *  host-owned `/api/image/*` routes; external npm plugins use
 *  legacy `/api/plugins/{mindmap,quiz,googleMap}` paths
 *  from `HOST_API_ROUTES.plugins`. */
export const EXTRA_SERVER_BINDINGS: readonly ServerPluginBinding[] = [
  { def: generateImageDef, endpoint: API_ROUTES.image.generate },
  { def: editImagesDef, endpoint: API_ROUTES.image.edit },
  { def: createMindMapDef, endpoint: API_ROUTES.plugins.mindmap },
  { def: putQuestionsDef, endpoint: API_ROUTES.plugins.quiz },
  { def: mapControlDef, endpoint: API_ROUTES.plugins.googleMap },
];
