import type { ToolResult } from "gui-chat-protocol";

export interface PresentShapeScriptData {
  script: string;
}

export interface PresentShapeScriptArgs {
  title: string;
  script: string;
}

export type PresentShapeScriptResult = ToolResult<PresentShapeScriptData>;

/** The success shape of `presentShapeScript`.
 *
 *  `data` is REQUIRED here, not optional as on `ToolResult`, because it is the
 *  host's render-eligibility signal: MulmoClaude's MCP bridge only pushes a
 *  tool result into the session — the event the canvas renders the View from —
 *  when the handler set `data`. A result without it is a narrate-only call, so
 *  the LLM would report success while the user saw no 3D view at all. Typing it
 *  as required means dropping it cannot compile.
 */
export type PresentShapeScriptRenderedResult = PresentShapeScriptResult & {
  data: PresentShapeScriptData;
};
