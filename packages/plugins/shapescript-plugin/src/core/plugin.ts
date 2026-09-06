import type { ToolContext, ToolPluginCore } from "gui-chat-protocol";
import type { PresentShapeScriptArgs, PresentShapeScriptData, PresentShapeScriptRenderedResult } from "./types";
import { TOOL_NAME, TOOL_DEFINITION } from "./definition";

// Returns `PresentShapeScriptRenderedResult`, whose `data` is required: that
// field is what makes the host push the result into the session and render the
// View. See the type's doc comment.
export const presentShapeScript = async (_context: ToolContext, args: PresentShapeScriptArgs): Promise<PresentShapeScriptRenderedResult> => {
  const { script, title } = args;

  // `typeof`, not truthiness: `script` arrives straight off `req.body`, so a
  // number or object would reach `.trim()` and throw a TypeError that surfaces
  // as a generic 500 instead of this message.
  if (typeof script !== "string" || script.trim() === "") {
    throw new Error("ShapeScript code is required but was not provided");
  }

  return {
    message: `Created 3D visualization: ${title}`,
    title,
    // Required — the host renders the View only for results that carry `data`.
    data: { script },
    instructions:
      "Acknowledge that the 3D visualization has been created and is displayed to the user. They can interact with it by rotating, zooming, and panning the camera.",
  };
};

export const pluginCore: ToolPluginCore<PresentShapeScriptData, unknown, PresentShapeScriptArgs> = {
  toolDefinition: TOOL_DEFINITION,
  execute: presentShapeScript,
  generatingMessage: "Creating 3D visualization...",
  waitingMessage: "Tell the user that the 3D visualization was created and will be presented shortly.",
  isEnabled: () => true,
};

export { TOOL_NAME, TOOL_DEFINITION };
export const executePresentShapeScript = presentShapeScript;
