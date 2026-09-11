// MulmoClaude's thin built-in adapter for the shared mulmoscript plugin
// (plans/done/feat-mulmoscript-plugin.md phase 2). View / Preview /
// TOOL_DEFINITION come from @mulmoclaude/mulmoscript-plugin; the View
// reaches host backends via useRuntime().dispatch → the built-in
// "mulmoScript" dispatch handler (server/plugins/mulmoscript-server.ts)
// and hears generation progress on the plugin pubsub channel. This adapter
// keeps MulmoClaude's existing tool-call create path (POST
// /api/mulmoScript/save) and injects the two host-transport capabilities
// the generic runtime can't carry: the active chat session id (sidebar
// generation indicator) and the bearer-authenticated media download.
import { computed, defineComponent, h, markRaw, provide, type Component } from "vue";
import type { PluginRegistration, ToolPlugin } from "../../tools/types";
import { View, Preview, MULMOSCRIPT_HOST_ADAPTER_KEY, type MulmoScriptData, type MulmoScriptHostAdapter } from "@mulmoclaude/mulmoscript-plugin/vue";
// Lib mode doesn't auto-inject the package's compiled styles; the consumer
// must import them — same as @mulmoclaude/{markdown,form,chart,html}-plugin.
import "@mulmoclaude/mulmoscript-plugin/style.css";
import toolDefinition, { TOOL_NAME, type MulmoScriptEndpoints } from "./definition";
import { pluginEndpoints } from "../api";
import { makeRouteExecute } from "../execute";
import { wrapWithScope } from "../scope";
import { apiFetchRaw } from "../../utils/api";
import { useActiveSession } from "../../composables/useActiveSession";

// Re-exported from the shared package so anything importing the result-data
// shape from "./index" keeps working while the type stays single-sourced.
export type { MulmoScriptData };

// Bearer-authenticated media download over the host's existing
// download routes. A plain <video src> / <a href download> can't attach
// the Authorization header, and the routes stay behind the standard
// /api/* bearer guard by explicit review decision — so the package View
// fetches bytes through this injected capability instead.
async function fetchMediaBlob(query: { moviePath?: string; pdfPath?: string; root?: string | undefined }): Promise<Blob> {
  const endpoints = pluginEndpoints<MulmoScriptEndpoints>("mulmoScript");
  // An artifact ref is relative to ITS stories root, and the same spelling exists in every
  // other one — so the root travels with it or the route serves the default root's file of
  // that name (#3014). Omitted when absent so a default-root request is unchanged.
  const rootQuery = query.root === undefined ? {} : { root: query.root };
  const target = query.pdfPath
    ? { url: endpoints.downloadPdf.url, query: { pdfPath: query.pdfPath, ...rootQuery } }
    : { url: endpoints.downloadMovie.url, query: { moviePath: query.moviePath ?? "", ...rootQuery } };
  const res = await apiFetchRaw(target.url, { method: "GET", query: target.query });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.blob();
}

/** Provide the package's host-adapter injection around the View —
 *  mounted INSIDE wrapWithScope's PluginScopedRoot, forwarding every
 *  prop / attr / slot through verbatim (same shape as wrapWithScope). */
function withHostAdapter(inner: Component): Component {
  return markRaw(
    defineComponent({
      name: "MulmoScriptHostAdapter",
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        const activeSessionRef = useActiveSession();
        const adapter: MulmoScriptHostAdapter = {
          chatSessionId: computed(() => activeSessionRef?.value?.id),
          fetchMediaBlob,
        };
        provide(MULMOSCRIPT_HOST_ADAPTER_KEY, adapter);
        return () => h(inner, attrs, slots);
      },
    }),
  );
}

const presentMulmoScriptPlugin: ToolPlugin<MulmoScriptData> = {
  toolDefinition,

  // Pass-through: the agent (MCP) and GUI dispatcher both end up at the
  // same backend route, which dispatches between create-new (`script`)
  // and reopen-existing (`filePath`) modes and handles the optional
  // `autoGenerateMovie` background trigger server-side. Keeping this
  // function trivial means the two callers can never drift apart.
  execute: makeRouteExecute<MulmoScriptEndpoints, MulmoScriptData>("mulmoScript", "save", TOOL_NAME),

  isEnabled: () => true,
  generatingMessage: "Generating MulmoScript storyboard…",
  viewComponent: wrapWithScope("mulmoScript", withHostAdapter(View)),
  previewComponent: wrapWithScope("mulmoScript", Preview),
};

export const REGISTRATION: PluginRegistration = {
  toolName: TOOL_NAME,
  entry: presentMulmoScriptPlugin,
};
