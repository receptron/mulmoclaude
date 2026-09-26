// File store for chat attachments (paste / drop / file picker).
// Mirrors the shape of image-store.ts but keeps the original MIME's
// extension instead of forcing `.png`, since attachments cover PDF,
// DOCX, XLSX, PPTX, text/* and JSON/XML/YAML/TOML in addition to
// images. PPTX uploads also save a converted `.pdf` companion under
// the same YYYY/MM partition (and ID prefix) so the agent loop can
// hand Claude the PDF path directly.
//
// Layout:
//   data/attachments/YYYY/MM/<id>.<ext>            (original, always)
//   data/attachments/YYYY/MM/<id>.pdf              (companion, PPTX only — same <id>)

import { readFile, stat } from "fs/promises";
import path from "path";
import { WORKSPACE_DIRS, WORKSPACE_PATHS } from "../../workspace/paths.js";
import { shortId } from "../id.js";
import { writeFileAtomic } from "./atomic.js";
import { yearMonthUtc } from "@mulmoclaude/core/artifacts";
import { makePathValidator } from "./path-validator.js";
import { makeStoreResolvers } from "./store-resolvers.js";
import { storedExtensionFor } from "./attachment-mime.js";

const resolvers = makeStoreResolvers(() => WORKSPACE_PATHS.attachments, WORKSPACE_DIRS.attachments);

export interface SavedAttachment {
  /** Workspace-relative path of the file written to disk. */
  relativePath: string;
  /** MIME type stored on disk (matches the input — conversions are
   *  reported separately via `companions`). */
  mimeType: string;
}

/** Post-save hook fired after every successful `saveAttachment`.
 *  Receives the absolute on-disk path, the workspace-relative path
 *  (the same one returned to the caller), and the MIME type the
 *  bytes were saved with. Hooks must NEVER throw — the upload is
 *  already on disk by the time the hook runs, so a failure should
 *  log and return, not propagate. Multiple hooks fan out via
 *  `Promise.allSettled` so one slow / failing hook can't block or
 *  break the others. (#1222 PR-A.) */
export type SaveAttachmentHook = (absPath: string, relativePath: string, mimeType: string) => Promise<void>;

const saveAttachmentHooks: SaveAttachmentHook[] = [];

/** Register a hook that runs after every saved attachment. Returns
 *  an unregister function so test setups can install + tear down a
 *  hook without leaking state into the next test. Production
 *  registrations live in `server/index.ts` boot. */
export function registerSaveAttachmentHook(hook: SaveAttachmentHook): () => void {
  saveAttachmentHooks.push(hook);
  return () => {
    const idx = saveAttachmentHooks.indexOf(hook);
    if (idx !== -1) saveAttachmentHooks.splice(idx, 1);
  };
}

async function runSaveAttachmentHooks(absPath: string, relativePath: string, mimeType: string): Promise<void> {
  if (saveAttachmentHooks.length === 0) return;
  // Snapshot the array so a hook that calls `registerSaveAttachmentHook`
  // (or its unregister fn) during this loop doesn't mutate the
  // iteration order. `allSettled` so one failing hook doesn't stop
  // the others — failures are the hook's responsibility to log.
  const snapshot = [...saveAttachmentHooks];
  await Promise.allSettled(snapshot.map((hook) => hook(absPath, relativePath, mimeType)));
}

/** Save a single attachment under data/attachments/YYYY/MM/. The
 *  caller picks the ID; companions (e.g. PPTX → PDF) reuse it via
 *  `saveCompanion()` so they share the same numeric prefix. */
export async function saveAttachment(base64Data: string, mimeType: string, originalFilename?: string): Promise<SavedAttachment> {
  const partition = yearMonthUtc();
  const ext = storedExtensionFor(mimeType, originalFilename);
  const filename = `${shortId()}${ext}`;
  const absPath = path.join(WORKSPACE_PATHS.attachments, partition, filename);
  await writeFileAtomic(absPath, Buffer.from(base64Data, "base64"));
  const relativePath = path.posix.join(WORKSPACE_DIRS.attachments, partition, filename);
  // Hooks (e.g. photo-EXIF capture) are awaited so callers can rely
  // on the sidecar existing by the time `saveAttachment` resolves —
  // simplifies test assertions and removes a class of race conditions
  // for downstream tools that read sidecars right after upload.
  await runSaveAttachmentHooks(absPath, relativePath, mimeType);
  return { relativePath, mimeType };
}

/** Save a companion file (e.g. PPTX → PDF) alongside an existing
 *  attachment, reusing its `<id>` so both filenames share a prefix
 *  and the same partition directory. Used by the upload route to
 *  store conversion artefacts next to their originals. Accepts a
 *  raw Buffer — the converter already has bytes in hand and base64
 *  re-encoding would be wasted work. */
export async function saveCompanion(originalRelativePath: string, buf: Buffer, ext: string): Promise<string> {
  const dir = path.posix.dirname(originalRelativePath);
  const base = path.posix.basename(originalRelativePath, path.posix.extname(originalRelativePath));
  const relativePath = path.posix.join(dir, `${base}${ext}`);
  const absPath = await resolvers.forWrite(relativePath);
  await writeFileAtomic(absPath, buf);
  return relativePath;
}

export async function loadAttachmentBase64(relativePath: string): Promise<string> {
  const absPath = await resolvers.forRead(relativePath);
  const buf = await readFile(absPath);
  return buf.toString("base64");
}

export async function loadAttachmentBytes(relativePath: string): Promise<Buffer> {
  const absPath = await resolvers.forRead(relativePath);
  return readFile(absPath);
}

/** True when `relativePath` names a regular file inside the attachment store. */
export async function attachmentExists(relativePath: string): Promise<boolean> {
  try {
    const absPath = await resolvers.forRead(relativePath);
    return (await stat(absPath)).isFile();
  } catch {
    return false;
  }
}

export const isAttachmentPath = makePathValidator({ prefix: WORKSPACE_DIRS.attachments });

export function stripDataUri(dataUri: string): { mimeType: string; base64: string } | undefined {
  // Parse without a regex (the nested-quantifier form trips
  // security/detect-unsafe-regex). RFC 2397 shape:
  //   data:<mediatype>(;<param>)*(;base64)?,<payload>
  // The first comma delimits header from payload. MediaRecorder +
  // FileReader emit params like `;codecs=opus`, so we must tolerate
  // them; the bare MIME type (params dropped) is what callers want for
  // extension lookup.
  if (!dataUri.startsWith("data:")) return undefined;
  const commaIndex = dataUri.indexOf(",");
  if (commaIndex === -1) return undefined;
  const header = dataUri.slice("data:".length, commaIndex);
  const payload = dataUri.slice(commaIndex + 1);
  const params = header.split(";");
  const [mimeType] = params;
  if (!mimeType) return undefined;
  if (!params.includes("base64")) {
    // URL-encoded inline form — convert to base64 for storage.
    // `decodeURIComponent` throws on malformed escapes (e.g. a lone `%`);
    // treat that as invalid input rather than letting it bubble up.
    try {
      return { mimeType, base64: Buffer.from(decodeURIComponent(payload), "utf-8").toString("base64") };
    } catch {
      return undefined;
    }
  }
  return { mimeType, base64: payload };
}
