import { Router, Request, Response } from "express";
import { generateGeminiImageContent, generateGeminiImageFromPrompt } from "../../utils/gemini.js";
import { errorMessage } from "../../utils/errors.js";
import { badRequest, serverError } from "../../utils/httpError.js";
import { saveImage, overwriteImage, loadImageBase64, stripDataUri, isImagePath } from "../../utils/files/image-store.js";
import { isAttachmentPath, loadAttachmentBase64 } from "../../utils/files/attachment-store.js";
import { inferMimeFromExtension } from "../../utils/files/attachment-mime.js";
import { promptMeta } from "../../utils/promptMeta.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { log } from "../../system/logger/index.js";

// Image-generation routes were silent on success and on failure. When
// the canvas showed "missing image" with no server-side trace, there
// was nothing to grep. Log lines now carry a prompt fingerprint
// (`{ length, sha256 }`) via `promptMeta()` instead of the raw text —
// see `server/utils/promptMeta.ts` for why.

const router = Router();

// ── Shared response helpers ──────────────────────────────────────

interface ImageSuccessResponse {
  message: string;
  instructions?: string;
  title?: string;
  data?: { imageData: string; prompt: string };
}

interface ImageErrorResponse {
  success: false;
  message: string;
}

type ImageResponse = ImageSuccessResponse | ImageErrorResponse;

// Shared save-and-respond for /generate-image and /edit-image. The
// only difference between the two routes is how they obtain the raw
// imageData from Gemini — once that's done, the "save to disk and
// build the JSON response" step is identical.
async function respondWithImage(
  res: Response<ImageResponse>,
  imageData: string | undefined,
  fallbackMessage: string | undefined,
  prompt: string,
  kind: "generation" | "edit",
): Promise<void> {
  if (!imageData) {
    // Gemini returned text-only / no image — typically a refusal,
    // safety filter, or a quota miss. Codex flagged this branch
    // (review of #780) for treating refusals as success; switching
    // it to a 502 is the obvious fix, but `apiPost.extractError`
    // only extracts `body.error` and image responses use
    // `{ success: false, message }`, so the agent would lose the
    // Gemini-side message and see only "Bad Gateway". Leaving
    // behavior unchanged here until the shared error-shape
    // (`extractError` accepting `message`, or all image responses
    // adopting `error`) lands in a separate PR — see #783 review
    // history.
    res.json({ message: fallbackMessage ?? "no image data in response" });
    return;
  }
  const imagePath = await saveImage(imageData);
  const label = kind === "generation" ? "Generated" : "Edited";
  res.json({
    message: `Saved image to ${imagePath}`,
    instructions: `Acknowledge that the image was ${kind === "generation" ? "generated" : "edited"} and has been presented to the user.`,
    title: `${label} Image`,
    data: { imageData: imagePath, prompt },
  });
}

// ── Canvas image storage routes ──────────────────────────────────

interface CanvasImageBody {
  imageData: string;
}

interface CanvasImageResponse {
  path: string;
}

interface CanvasImageError {
  error: string;
}

async function saveCanvasImage(
  res: Response<CanvasImageResponse | CanvasImageError>,
  base64: string,
  writeFn: (b64: string) => Promise<string>,
): Promise<void> {
  try {
    const imagePath = await writeFn(base64);
    res.json({ path: imagePath });
  } catch (err) {
    serverError(res, errorMessage(err));
  }
}

// ── Routes ───────────────────────────────────────────────────────

interface GenerateImageBody {
  prompt: string;
  model?: string;
}

router.post(API_ROUTES.image.generate, async (req: Request<object, unknown, GenerateImageBody>, res: Response<ImageResponse>) => {
  const { prompt, model } = req.body;
  if (!prompt) {
    log.warn("image", "generate: missing prompt");
    res.status(400).json({ success: false, message: "prompt is required" });
    return;
  }
  log.info("image", "generate: start", { prompt: promptMeta(prompt), model: model ?? "(default)" });
  try {
    const { imageData, message } = await generateGeminiImageFromPrompt(prompt, model);
    if (!imageData) {
      log.warn("image", "generate: gemini returned no image data", {
        prompt: promptMeta(prompt),
        fallbackMessage: message,
      });
    } else {
      log.info("image", "generate: ok", { prompt: promptMeta(prompt), bytes: imageData.length });
    }
    await respondWithImage(res, imageData, message, prompt, "generation");
  } catch (err) {
    log.error("image", "generate: gemini call threw", {
      prompt: promptMeta(prompt),
      error: errorMessage(err),
    });
    res.status(500).json({ success: false, message: errorMessage(err) });
  }
});

interface EditImagesBody {
  prompt: string;
  imagePaths: string[];
}

// Hard upper bound on how many source images a single edit call may
// reference. Gemini's image-edit endpoint accepts multi-image inputs
// but quality degrades quickly past a small number, and a runaway
// LLM passing dozens of paths would burn tokens / disk reads on
// every retry. Tune up if real workloads need more.
const MAX_EDIT_IMAGES = 8;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

interface SourceImage {
  data: string;
  mimeType: string;
}

async function loadSourceImage(imagePath: string): Promise<SourceImage> {
  if (isImagePath(imagePath)) {
    const data = await loadImageBase64(imagePath);
    // `isImagePath` only requires `.png`, but historically `saveImage`
    // also wrote `.jpg` / `.webp`. Defer to extension inference and
    // fall back to `image/png` so a workspace seeded by an older build
    // still reports a sensible MIME (#1050 review).
    const mimeType = inferMimeFromExtension(imagePath) ?? "image/png";
    return { data, mimeType };
  }
  if (isAttachmentPath(imagePath)) {
    const mimeType = inferMimeFromExtension(imagePath);
    if (!mimeType || !mimeType.startsWith("image/")) {
      throw new Error(`attachment is not a recognised image: ${imagePath}`);
    }
    const data = await loadAttachmentBase64(imagePath);
    return { data, mimeType };
  }
  throw new Error(`imagePath must live under artifacts/images/ or data/attachments/: ${imagePath}`);
}

router.post(API_ROUTES.image.edit, async (req: Request<object, unknown, EditImagesBody>, res: Response<ImageResponse>) => {
  const { prompt, imagePaths } = req.body;
  if (typeof prompt !== "string" || prompt.length === 0) {
    log.warn("image", "edit: missing prompt");
    res.status(400).json({ success: false, message: "prompt is required" });
    return;
  }
  if (!isStringArray(imagePaths) || imagePaths.length === 0) {
    log.warn("image", "edit: missing imagePaths");
    res.status(400).json({
      success: false,
      message: "imagePaths must be a non-empty array of workspace-relative paths",
    });
    return;
  }
  if (imagePaths.length > MAX_EDIT_IMAGES) {
    log.warn("image", "edit: too many imagePaths", { count: imagePaths.length });
    res.status(400).json({
      success: false,
      message: `imagePaths exceeds the maximum of ${MAX_EDIT_IMAGES} entries`,
    });
    return;
  }

  log.info("image", "edit: start", { prompt: promptMeta(prompt), imageCount: imagePaths.length });
  try {
    const sources: SourceImage[] = [];
    for (const imagePath of imagePaths) {
      sources.push(await loadSourceImage(imagePath));
    }
    // /edit-image deliberately omits `config` (no aspectRatio) so
    // Gemini preserves the input image's dimensions. Multiple
    // inlineData parts before the text instruct Gemini to combine
    // / edit the inputs as a single composition.
    const parts = [...sources.map((src) => ({ inlineData: { mimeType: src.mimeType, data: src.data } })), { text: prompt }];
    const { imageData, message } = await generateGeminiImageContent([{ parts }]);
    if (!imageData) {
      log.warn("image", "edit: gemini returned no image data", {
        prompt: promptMeta(prompt),
        imageCount: imagePaths.length,
        fallbackMessage: message,
      });
    } else {
      log.info("image", "edit: ok", { prompt: promptMeta(prompt), imageCount: imagePaths.length, bytes: imageData.length });
    }
    await respondWithImage(res, imageData, message, prompt, "edit");
  } catch (err) {
    log.error("image", "edit: gemini call threw", {
      prompt: promptMeta(prompt),
      imageCount: imagePaths.length,
      error: errorMessage(err),
    });
    res.status(500).json({ success: false, message: errorMessage(err) });
  }
});

// Canvas image persistence — POST creates a new file, PUT overwrites.

router.post(API_ROUTES.image.upload, async (req: Request<object, unknown, CanvasImageBody>, res: Response<CanvasImageResponse | CanvasImageError>) => {
  const { imageData } = req.body;
  if (!imageData) {
    badRequest(res, "imageData is required");
    return;
  }
  const base64 = stripDataUri(imageData);
  await saveCanvasImage(res, base64, async (b64) => saveImage(b64));
});

interface UpdateImageBody extends CanvasImageBody {
  relativePath: string;
}

// Canvas saves come in with the workspace-relative path the file
// already lives at (returned at canvas creation), so the client never
// has to know how `saveImage` shards by YYYY/MM. The server validates
// the prefix + extension via `isImagePath`; `safeResolve` inside
// `overwriteImage` blocks any traversal.
router.put(API_ROUTES.image.update, async (req: Request<object, unknown, UpdateImageBody>, res: Response<CanvasImageResponse | CanvasImageError>) => {
  const { relativePath, imageData } = req.body;
  if (!relativePath || !isImagePath(relativePath)) {
    badRequest(res, "invalid image relativePath");
    return;
  }
  if (!imageData) {
    badRequest(res, "imageData is required");
    return;
  }
  const base64 = stripDataUri(imageData);
  await saveCanvasImage(res, base64, async (b64) => {
    await overwriteImage(relativePath, b64);
    return relativePath;
  });
});

export default router;
