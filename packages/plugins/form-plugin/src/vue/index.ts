import "../style.css";

import type { ToolPlugin } from "gui-chat-protocol/vue";
import type { FormData, FormArgs } from "../core/types";
import { pluginCore } from "../core/plugin";
import { samples } from "../core/samples";
import View from "./View.vue";
import Preview from "./Preview.vue";

export const TOOL_NAME = "presentForm";

export const SYSTEM_PROMPT = `Use the ${TOOL_NAME} tool to collect structured input from the user with a form, instead of asking for everything as free text. Supports text, textarea, number, radio, dropdown, checkbox, date, and time fields, each with optional validation, plus read-only excerpt fields that show a passage with highlighted phrases (never submitted) — put an excerpt right before the fields that ask about it. When the user submits, their answers arrive as your next message — wait for it before continuing.`;

export const plugin: ToolPlugin<FormData, FormData, FormArgs> = {
  ...pluginCore,
  viewComponent: View,
  previewComponent: Preview,
  samples,
  systemPrompt: SYSTEM_PROMPT,
};

export type { FormData, FormArgs, FormField, ExcerptField, InputField } from "../core/types";

export { TOOL_DEFINITION, executeForm, pluginCore } from "../core/plugin";

export { samples } from "../core/samples";

export { View, Preview };

export default { plugin };
