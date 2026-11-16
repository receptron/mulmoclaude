// A narrate-only envelope without `message` / `instructions` is plain JSON meant
// for the LLM; with `data` the card carries it and the payload may be large.
export interface PluginResultEnvelope {
  data?: unknown;
  message?: unknown;
  instructions?: unknown;
  [key: string]: unknown;
}

export const EMPTY_PLUGIN_RESULT_TEXT = "Done";
const EMPTY_JSON_OBJECT = "{}";

export function pluginResultText(envelope: PluginResultEnvelope): string {
  const parts = [envelope.message, envelope.instructions].filter(Boolean);
  if (parts.length > 0) return parts.join("\n");
  if (envelope.data !== undefined) return EMPTY_PLUGIN_RESULT_TEXT;
  const json = JSON.stringify(envelope);
  return json === EMPTY_JSON_OBJECT ? EMPTY_PLUGIN_RESULT_TEXT : json;
}
