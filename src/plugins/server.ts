// Vue-free server-facing barrel for every built-in plugin's MCP
// binding (ToolDefinition + REST endpoint). Sibling barrels:
//
//   - `src/plugins/index.ts`  — REGISTRATIONS with Vue View / Preview
//                                (frontend uses this; server can't —
//                                Vue dependency)
//   - `src/plugins/metas.ts`   — per-plugin META (toolName, apiRoutes,
//                                workspaceDirs, staticChannels). Both
//                                server and frontend safe.
//   - `src/plugins/server.ts`  — THIS FILE: server-only binding table
//                                (definition + MCP dispatch endpoint).
//                                Imports each plugin's `definition.ts`
//                                directly (no Vue, server-safe).
//
// **Auto-generated**. Standard plugins (one dir, one META declaring
// `apiNamespace` + `mcpDispatch`) flow through
// `_generated/server-bindings.ts`; cross-namespace bindings (image
// plugins reaching the host's `/api/image/*` routes) and external
// npm plugins (mindmap / quiz / googleMap) live in `_extras.ts`.
// Adding a standard plugin requires no edit here.

import { ServerPluginBinding } from "./server-bindings-types";
import { GENERATED_SERVER_BINDINGS } from "./_generated/server-bindings";
import { EXTRA_SERVER_BINDINGS } from "./_extras";

export type { ServerPluginBinding };

/** All built-in plugin MCP bindings. The two scheduler defs share
 *  one dispatch URL (the server splits calendar vs task actions via
 *  the action enum), so the codegen emits both rows pointing at the
 *  calendar META — see `_generated/server-bindings.ts`. */
export const BUILT_IN_SERVER_BINDINGS: readonly ServerPluginBinding[] = [...GENERATED_SERVER_BINDINGS, ...EXTRA_SERVER_BINDINGS];
