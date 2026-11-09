import { GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse, type Part } from "@google/genai";
import { geminiApiKey } from "../system/env.js";
import { log } from "../system/logger/index.js";
import { errorMessage } from "./errors.js";

export { isGeminiAvailable } from "../system/env.js";

export function getGeminiClient(): GoogleGenAI {
  const apiKey = geminiApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  // @google/genai 3 defaults to v1; the preview image model and imageConfig were served on v1beta.
  return new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
}

// --- Image generation -----------------------------------------------

const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image-preview";

const DEFAULT_IMAGE_CONFIG: GenerateContentParameters["config"] = {
  responseModalities: ["TEXT", "IMAGE"],
  imageConfig: { aspectRatio: "16:9" },
};

export interface GeminiImageResult {
  // Raw base64 payload (no `data:` prefix). Undefined if Gemini
  // declined to return an image, e.g. because the prompt was filtered.
  imageData?: string;
  // Optional text part returned alongside the image (or in lieu of
  // it). Used as a fallback message when imageData is empty.
  message?: string;
}

// Pull the first candidate's `content.parts` array out of a Gemini
// response, defaulting to `[]` when any layer of the optional chain is
// absent. Pure — exported for unit tests.
export function firstCandidateParts(response: GenerateContentResponse): readonly Part[] {
  return response.candidates?.[0]?.content?.parts ?? [];
}

// Pull the first candidate's `finishReason` (used in debug logs).
// Pure — exported for unit tests.
export function firstFinishReason(response: GenerateContentResponse): string | undefined {
  return response.candidates?.[0]?.finishReason;
}

// Reduce a Gemini response's `parts` array down to the {imageData,
// message} pair the rest of the app cares about. Last text wins; last
// inline-image wins. Parts without text or `inlineData.data` are
// skipped. Pure — exported for unit tests.
export function extractImageResult(parts: readonly Part[]): GeminiImageResult {
  const result: GeminiImageResult = {};
  for (const part of parts) {
    if (part.text) result.message = part.text;
    if (part.inlineData?.data) result.imageData = part.inlineData.data;
  }
  return result;
}

// Low-level wrapper around `ai.models.generateContent` that pulls
// the first inline image and text part out of the response. Use this
// when you need to pass custom `contents` (e.g. text + reference
// image for /edit-image). Pass `undefined` for `config` to omit it
// entirely from the request.
//
// Per-call logging is deliberately at debug level so the route /
// plugin call sites can decide what surfaces to info/warn at their
// own granularity. SDK throws are caught here only to surface a
// debug line, then re-thrown — callers are still responsible for the
// HTTP / canvas response.
export async function generateGeminiImageContent(
  contents: GenerateContentParameters["contents"],
  config?: GenerateContentParameters["config"],
  model: string = DEFAULT_IMAGE_MODEL,
): Promise<GeminiImageResult> {
  const client = getGeminiClient();
  log.debug("gemini", "generateContent: request", {
    model,
    hasConfig: Boolean(config),
    aspectRatio: config?.imageConfig?.aspectRatio,
  });
  let response;
  try {
    response = await client.models.generateContent({
      model,
      contents,
      ...(config && { config }),
    });
  } catch (err) {
    log.debug("gemini", "generateContent: SDK threw", { model, error: errorMessage(err) });
    throw err;
  }
  const parts = firstCandidateParts(response);
  const result = extractImageResult(parts);
  log.debug("gemini", "generateContent: response", {
    model,
    parts: parts.length,
    hasImage: Boolean(result.imageData),
    hasText: Boolean(result.message),
    finishReason: firstFinishReason(response),
  });
  return result;
}

// Convenience wrapper for the common "text prompt → image" path.
// Uses the standard 16:9 image config.
export async function generateGeminiImageFromPrompt(prompt: string, model?: string): Promise<GeminiImageResult> {
  return generateGeminiImageContent([{ text: prompt }], DEFAULT_IMAGE_CONFIG, model);
}
