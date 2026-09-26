// Pure MIME <-> extension rules for stored chat attachments. No fs, so the
// naming decision can be tested without a workspace.

import path from "path";

const FALLBACK_EXTENSION = ".bin";
const SAFE_EXTENSION = /^\.[a-z0-9]{1,16}$/;

// MIME ↔ extension mapping. Kept narrow on purpose — anything not
// in this table falls back to `.bin` so we don't have to guess.
// `inferMimeFromExtension()` is the inverse, used when reading a
// stored file back to build a Claude content block.
const MIME_EXT: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  // HEIC / HEIF — iOS default capture format. Without these
  // entries, an iPhone upload was getting saved as `<id>.bin` and
  // looked broken in the Files panel even though the bytes were
  // intact (#1222 PR-A follow-up). The EXIF reader treats both
  // MIMEs as supported, so the upload pipeline must too.
  "image/heic": ".heic",
  "image/heif": ".heif",
  // TIFF — exifr can read it, and the photo plugin enumerates it
  // as a supported source format. Same rationale as HEIC.
  "image/tiff": ".tif",
  // BMP + AVIF — routed through upload-time JPEG conversion for
  // Claude's Messages API (see image-jpeg-convert.ts). Without these
  // MIME_EXT entries the original would land as `<id>.bin`, breaking
  // the `originalPath` fidelity the route response promises.
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/xml": ".xml",
  "application/x-yaml": ".yaml",
  "application/toml": ".toml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/xml": ".xml",
  "text/yaml": ".yaml",
  "text/x-yaml": ".yaml",
};

// Inverse of MIME_EXT — enough to round-trip everything we save.
// Not a complete extension → MIME table; only entries we produce
// when storing files (so reading back is unambiguous).
const EXT_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".toml": "application/toml",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".md": "text/markdown",
};

function extensionForMime(mimeType: string): string {
  return MIME_EXT[mimeType] ?? FALLBACK_EXTENSION;
}

export function inferMimeFromExtension(filename: string): string | undefined {
  const ext = path.extname(filename).toLowerCase();
  return EXT_MIME[ext];
}

/** Extension to store an attachment under. An unknown MIME keeps the
 *  original extension as a hint (`<id>.mpp.bin`) but always ends in
 *  `.bin`, so nothing that dispatches on the final extension (HTML
 *  preview, raw-file MIME table) ever treats the bytes as something the
 *  MIME never claimed. */
export function storedExtensionFor(mimeType: string, filename: string | undefined): string {
  const fromMime = extensionForMime(mimeType);
  if (fromMime !== FALLBACK_EXTENSION || !filename) return fromMime;
  const original = path.extname(filename).toLowerCase();
  return SAFE_EXTENSION.test(original) ? `${original}${FALLBACK_EXTENSION}` : FALLBACK_EXTENSION;
}

export function knownAttachmentMimes(): string[] {
  return Object.keys(MIME_EXT);
}
