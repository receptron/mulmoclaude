# feat: accept attachments of unknown file types as files (#3299)

Origin: #3297 (`.mpp`). Core does not learn `.mpp`; it only stops refusing files it cannot read.

## Behaviour

| type | before | after |
|---|---|---|
| readable (image, PDF, DOCX, XLSX, PPTX, text/*, JSON/XML/YAML/TOML) | inlined as content | unchanged |
| anything else | rejected in the chat input | stored as `data/attachments/…/<id>.<ext>.bin`, announced to the agent by path, content not sent; the chip says "file only" |

## Changes

1. `server/utils/files/attachment-mime.ts` (new, pure): the MIME ↔ extension tables moved verbatim from `attachment-store.ts`, plus `storedExtensionFor(mimeType, filename)` — known MIME → its extension; unknown MIME → `<filename's ext>.bin` when that extension is short/alphanumeric, else `.bin`.
2. `saveAttachment(base64, mimeType, filename?)` uses it. The upload route and `persistInlineBytesAsPaths` pass the filename.
3. `prepareRequestExtras`: the MIME of a stored file comes from its extension only (a declared `mimeType` on the entry is ignored; image paths are always `image/png`). An existing file whose MIME cannot be inferred emits its marker but no content block.
4. Client: `isReadableAttachmentType` in `src/utils/attachment/readableTypes.ts`, whose set equals the server's MIME table (parity test); `validateFile` no longer rejects by type; the picker's `accept` filter is dropped; `ChatAttachmentPreview` shows a "file only" note for unreadable types. i18n: `unsupportedFileType` removed, `fileOnlyAttachment` added in all 8 locales.

## Why an unknown type always ends in `.bin`

Routes dispatch on a workspace file's final extension (`/htmlfile` serves `.html`/`.htm`; the raw-file route picks a MIME by extension). Ending in `.bin` keeps every such extension out, including ones no table lists, instead of denylisting them.

## Tests

- unit: `storedExtensionFor` both directions (known MIME, unknown MIME + safe/unsafe/known/missing ext).
- unit: `prepareRequestExtras` emits a marker without bytes for an unknown-extension file; drops a missing one.
- unit: `isReadableAttachmentType`.
- e2e: the three "unsupported type → error" specs become "unknown type → chip with file-only note".
