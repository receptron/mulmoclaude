// POST /api/attachments — store a paste/drop/file-picker attachment
// under data/attachments/YYYY/MM/<id>.<ext> and return the path the
// LLM should reference.
//
// PPTX uploads also save a converted `.pdf` companion alongside the
// original (same `<id>` prefix) and return the PDF path as `path` so
// callers can hand the LLM a document Claude can natively read.
// Other types (image / PDF / DOCX / XLSX / text/* / JSON / XML / YAML)
// return the original's path; conversion (e.g. DOCX → text via
// mammoth) still happens at message-build time inside
// `attachmentConverter.ts`, but reads the file off disk now.

import { Router, Request, Response } from "express";
import { extname } from "path";
import { saveAttachment, saveCompanion, stripDataUri, type SavedAttachment } from "../../utils/files/attachment-store.js";
import { convertPptxToPdf } from "../../agent/attachmentConverter.js";
import { CLAUDE_UNSUPPORTED_IMAGE_MIMES, sharpConvertToJpeg, type ConvertToJpeg } from "../../utils/files/image-jpeg-convert.js";
import { errorMessage } from "../../utils/errors.js";
import { badRequest, serverError } from "../../utils/httpError.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { log } from "../../system/logger/index.js";

const router = Router();

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// Injected converter for the HEIC / TIFF / BMP / AVIF → JPEG branch.
// Production wiring uses `sharpConvertToJpeg`; tests replace it via
// `setImageJpegConverterForTests` so they don't need the native
// binary. Kept as a module-level `let` so the swap is process-wide
// and doesn't require plumbing a param through the express handler.
let imageJpegConverter: ConvertToJpeg = sharpConvertToJpeg;

/** Test-only: swap in a stub converter and return the previous one so
 *  the caller can restore it. Production code never calls this. */
export function setImageJpegConverterForTests(converter: ConvertToJpeg): ConvertToJpeg {
  const previous = imageJpegConverter;
  imageJpegConverter = converter;
  return previous;
}

interface UploadAttachmentBody {
  /** `data:<mime>;base64,...` from FileReader.readAsDataURL. */
  dataUrl: string;
  /** Original filename (optional). Logged, and its extension is kept
   *  when the MIME type is unknown. */
  filename?: string;
}

interface UploadAttachmentResponse {
  /** Workspace-relative path the LLM should be handed. PPTX → the
   *  generated `.pdf` companion; everything else → the original. */
  path: string;
  /** Workspace-relative path of the original file as uploaded. Same
   *  as `path` for non-conversion cases. Surfaced so the client can
   *  show the original filename in the chat preview while still
   *  driving the LLM off the canonical `path`. */
  originalPath: string;
  /** MIME type of the file referenced by `path`. */
  mimeType: string;
}

interface UploadAttachmentError {
  error: string;
}

type UploadResponse = Response<UploadAttachmentResponse | UploadAttachmentError>;

// PPTX → PDF companion branch. LibreOffice unavailable → return the
// original PPTX path and let the agent loop produce its existing
// fallback text block. Surfaces a warn so it doesn't disappear
// silently in environments where conversion is expected.
async function respondWithPptxCompanion(res: UploadResponse, original: SavedAttachment, base64: string): Promise<void> {
  const pdfBuf = await convertPptxToPdf(base64);
  if (!pdfBuf) {
    log.warn("attachments", "upload: pptx conversion unavailable, returning original", {
      path: original.relativePath,
    });
    res.json({ path: original.relativePath, originalPath: original.relativePath, mimeType: original.mimeType });
    return;
  }
  const pdfPath = await saveCompanion(original.relativePath, pdfBuf, ".pdf");
  log.info("attachments", "upload: ok", {
    path: pdfPath,
    originalPath: original.relativePath,
    conversion: "pptx-to-pdf",
  });
  res.json({ path: pdfPath, originalPath: original.relativePath, mimeType: "application/pdf" });
}

// HEIC / HEIF / TIFF / BMP / AVIF — Claude API rejects these as
// `image.source.media_type`, so convert to JPEG at upload and hand
// the LLM the companion. The original still lives on disk (archival)
// and the EXIF sidecar hook has already run against it in
// `saveAttachment` — GPS / orientation are preserved independently of
// the JPEG. On sharp / libheif failure we log a warn and return the
// original path so the upload isn't lost; the caller then hits the
// same 400 it would have before this branch existed.
async function respondWithJpegCompanion(res: UploadResponse, original: SavedAttachment, base64: string, sourceMime: string): Promise<void> {
  let jpegBuf: Buffer;
  try {
    jpegBuf = await imageJpegConverter(Buffer.from(base64, "base64"), sourceMime);
  } catch (convertErr) {
    log.warn("attachments", "upload: image-to-jpeg conversion failed, returning original", {
      path: original.relativePath,
      sourceMime,
      error: errorMessage(convertErr),
    });
    res.json({ path: original.relativePath, originalPath: original.relativePath, mimeType: original.mimeType });
    return;
  }
  const jpegPath = await saveCompanion(original.relativePath, jpegBuf, ".jpg");
  log.info("attachments", "upload: ok", {
    path: jpegPath,
    originalPath: original.relativePath,
    conversion: `${sourceMime}-to-jpeg`,
  });
  res.json({ path: jpegPath, originalPath: original.relativePath, mimeType: "image/jpeg" });
}

async function handleUploadAttachment(req: Request<object, unknown, UploadAttachmentBody>, res: UploadResponse): Promise<void> {
  const { dataUrl, filename } = req.body;
  if (!dataUrl) {
    badRequest(res, "dataUrl is required");
    return;
  }
  const parsed = stripDataUri(dataUrl);
  if (!parsed) {
    badRequest(res, "dataUrl must be a data: URI");
    return;
  }
  log.info("attachments", "upload: start", {
    mimeType: parsed.mimeType,
    filename,
    bytes: Math.floor((parsed.base64.length * 3) / 4),
  });
  try {
    const original = await saveAttachment(parsed.base64, parsed.mimeType, filename);
    if (parsed.mimeType === PPTX_MIME) {
      await respondWithPptxCompanion(res, original, parsed.base64);
      return;
    }
    if (CLAUDE_UNSUPPORTED_IMAGE_MIMES.has(parsed.mimeType)) {
      await respondWithJpegCompanion(res, original, parsed.base64, parsed.mimeType);
      return;
    }
    log.info("attachments", "upload: ok", {
      path: original.relativePath,
      ext: extname(original.relativePath),
    });
    res.json({ path: original.relativePath, originalPath: original.relativePath, mimeType: original.mimeType });
  } catch (err) {
    log.error("attachments", "upload: threw", { error: errorMessage(err) });
    serverError(res, errorMessage(err));
  }
}

router.post(API_ROUTES.attachments.upload, async (req: Request<object, unknown, UploadAttachmentBody>, res: UploadResponse) =>
  handleUploadAttachment(req, res),
);

export default router;
