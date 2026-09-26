// Attachment types whose content is inlined for the model. Must equal the
// MIME keys of server/utils/files/attachment-mime.ts (a test pins it): any
// other type is stored as `.bin` and reaches the agent by path only.

export const READABLE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/bmp",
  "image/avif",
  "application/pdf",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/toml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/xml",
  "text/yaml",
  "text/x-yaml",
]);

export function isReadableAttachmentType(mime: string): boolean {
  return READABLE_MIMES.has(mime);
}
