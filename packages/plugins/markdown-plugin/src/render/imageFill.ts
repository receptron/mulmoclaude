// Shared image-placeholder fill (task #6 Phase 4). The LLM is told (see
// definition.ts) to emit embedded images as one of:
//   - plain:  ![prompt](__too_be_replaced_image_path__)
//   - Marp:   ![bg right:45%](__too_be_replaced_image_path__ "prompt")
// i.e. the GENERATION PROMPT is the alt text, UNLESS the alt is taken by a
// Marp directive — then the prompt lives in the quoted markdown title. This
// owns the regex + substitution so every host stays in lockstep, while image
// GENERATION + STORAGE is injected (each host wires Gemini + URL/data-URI).

import { mapWithConcurrency } from "@mulmoclaude/common";

// Groups: 1 = alt text (prompt OR Marp directive), 2 = optional quoted title
// (the prompt when the alt is a directive). The title allows escaped chars
// (`\"`, `\\`) so a prompt containing quotes still matches. Both groups are
// bounded ({1,1000}) with disjoint alternatives so the regex stays linear on
// uncontrolled markdown (CodeQL polynomial-ReDoS).
export const IMAGE_PLACEHOLDER = /!\[([^\]]{1,1000})\]\(\/?__too_be_replaced_image_path__(?:\s+"((?:[^"\\]|\\.){1,1000})")?\)/g;

// Marp image-directive keywords (the alt slot for a directive image). Used to
// decide whether a title-less placeholder's alt is a prompt (generate) or a
// layout directive (skip — a directive image needs its prompt in the title).
const MARP_DIRECTIVE_KEYWORDS = new Set([
  "bg",
  "fit",
  "cover",
  "auto",
  "left",
  "right",
  "vertical",
  "center",
  "top",
  "bottom",
  "blur",
  "brightness",
  "contrast",
  "grayscale",
  "invert",
  "opacity",
  "saturate",
  "sepia",
  "drop-shadow",
  "hue-rotate",
]);

function isMarpDirectiveToken(token: string): boolean {
  const lower = token.toLowerCase();
  if (MARP_DIRECTIVE_KEYWORDS.has(lower)) return true;
  const colon = lower.indexOf(":");
  if (colon > 0 && (lower.slice(0, colon) === "w" || lower.slice(0, colon) === "h" || MARP_DIRECTIVE_KEYWORDS.has(lower.slice(0, colon)))) return true;
  return /^#?[0-9a-f]+$|^\d+(\.\d+)?(%|px)?$/.test(lower); // bare size / colour value
}

/** True when every whitespace-separated token of `alt` is a Marp image
 *  directive — i.e. the alt is layout, not a prompt. A real prompt always has
 *  at least one natural-language token, so this won't swallow prompts. */
function altIsOnlyDirectives(alt: string): boolean {
  const tokens = alt.trim().split(/\s+/);
  return tokens.length > 0 && tokens.every(isMarpDirectiveToken);
}

// Undo markdown title escaping (`\"` → `"`, `\\` → `\`, …) before using the
// title as a generation prompt.
function unescapeTitle(title: string): string {
  return title.replace(/\\(.)/g, "$1");
}

/** Build the markdown that replaces one placeholder. `altText` is kept as the
 *  rendered alt (the prompt for plain images, or the Marp directive for
 *  directive images). `ref` is the host-resolved image reference (URL / data
 *  URI) or null when generation was unavailable/failed — in which case an
 *  italic marker shows `fallbackLabel` (defaults to `altText`; callers pass
 *  the generation prompt so a Marp directive isn't shown as the label). */
export function buildImagePlaceholderReplacement(altText: string, ref: string | null, fallbackLabel: string = altText): string {
  if (ref) return `![${altText}](${ref})`;
  return `*🖼️ Image: ${fallbackLabel}*`;
}

export interface ImagePlaceholderResult {
  full: string;
  /** The rendered alt text (prompt for plain images, directive for Marp). */
  alt: string;
  /** The text used to GENERATE the image (the title when present, else alt). */
  prompt: string;
  ref: string | null;
}

export interface FillImagePlaceholdersDeps {
  /** Resolve a displayable image reference for `prompt` (the host
   *  generates + stores it, returning a URL or data URI), or null to
   *  fall back to a text marker. `index`/`total` are for progress logs. */
  resolveImage: (prompt: string, index: number, total: number) => Promise<string | null>;
  /** Max image generations in flight at once. Bounded so a document with
   *  many placeholders doesn't fan out into a burst of provider calls
   *  (rate limits / resource spikes). Default 4. */
  concurrency?: number;
}

/** Replace every `__too_be_replaced_image_path__` placeholder. Returns
 *  the filled markdown plus the per-placeholder results so the host can
 *  emit its own batch observability. Generation runs with bounded
 *  concurrency (`deps.concurrency`, default 4). */
export async function fillImagePlaceholders(
  markdown: string,
  deps: FillImagePlaceholdersDeps,
): Promise<{ markdown: string; results: ImagePlaceholderResult[] }> {
  const matches = [...markdown.matchAll(IMAGE_PLACEHOLDER)];
  if (matches.length === 0) return { markdown, results: [] };

  const total = matches.length;
  const results = await mapWithConcurrency(matches, deps.concurrency ?? 4, async (match, index) => {
    // Group 1 is mandatory in IMAGE_PLACEHOLDER, so it always
    // participates and the `""` default is unreachable; group 2 is
    // optional and genuinely absent for a plain image.
    const [, alt = "", rawTitle] = match;
    const title = rawTitle !== undefined ? unescapeTitle(rawTitle) : undefined;
    // Plain image: the alt IS the prompt. Directive image: the prompt is the
    // title. A directive alt WITHOUT a title carries no prompt → skip
    // generation (the contract requires the title for directive images), rather
    // than generating a garbage image from "bg right:45%".
    const prompt = title ?? (altIsOnlyDirectives(alt) ? undefined : alt);
    const ref = prompt !== undefined ? await deps.resolveImage(prompt, index, total) : null;
    return { full: match[0], alt, prompt: prompt ?? alt, ref };
  });

  // One ordered pass over the same matches: `String.replace` with the
  // global regex invokes the replacer per match in document order, and
  // `results` is in matchAll order — so each placeholder (including
  // duplicate identical ones) gets its own result. Avoids the
  // quadratic re-scan + first-occurrence collision of a per-item
  // `filled.replace(full, …)` loop (Sourcery).
  const pending = results[Symbol.iterator]();
  const filled = markdown.replace(IMAGE_PLACEHOLDER, (placeholder) => {
    const { value: result } = pending.next();
    // Unreachable — `results` holds one entry per match. Leaving the
    // placeholder untouched is the safest degradation if it ever isn't.
    if (!result) return placeholder;
    // Keep the alt (prompt for plain, directive for Marp) in the output; the
    // null-fallback marker shows the generation prompt, not the directive.
    return buildImagePlaceholderReplacement(result.alt, result.ref, result.prompt);
  });
  return { markdown: filled, results };
}
