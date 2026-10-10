import { Router, Request, Response } from "express";
import { Dirent, ReadStream, Stats, createReadStream, readFileSync, realpathSync } from "fs";
import { mkdir, realpath, writeFile } from "fs/promises";
import path from "path";
import { workspacePath } from "../../workspace/workspace.js";
import { statSafe, statSafeAsync, readDirSafeAsync, resolveWithinRoot, writeFileAtomic } from "../../utils/files/index.js";
import { stripDataUri } from "../../utils/files/attachment-store.js";
import { writeNewFileExclusive } from "../../utils/files/upload-io.js";
import { MAX_RENAME_ATTEMPTS, renamedCandidate, sanitizeUploadFilename, uploadRelPath } from "../../utils/files/upload-name.js";
import { joinPosixRelPath, toPosixRelPath } from "@mulmoclaude/core/files";
import { errorMessage } from "../../utils/errors.js";
import { badRequest, notFound, sendError, serverError } from "../../utils/httpError.js";
import { jsonSyntaxError, MAX_PREVIEW_BYTES } from "../../utils/files/content-write-validate.js";
import { TEXT_EXTENSIONS } from "../../utils/files/text-extensions.js";
import { respondWithWrittenFile, validateWriteRequestOr400, type WriteContentResponse } from "./filesWriteResponse.js";
import { getOptionalStringQuery } from "../../utils/request.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { GitignoreFilter } from "../../utils/gitignore.js";
import { getCachedReferenceDirs, resolveReferenceDir } from "../../workspace/reference-dirs.js";
import { classifyAsWikiPage, writeWikiPage } from "../../workspace/wiki-pages/io.js";
import { log } from "../../system/logger/index.js";
import { previewSnippet } from "../../utils/logPreview.js";
import { publishFileChange } from "../../events/file-change.js";
import { spawn } from "node:child_process";
import { isErrorWithCode } from "../../utils/types.js";

// Cross-platform "open this file with the host's default handler" that
// never lets the path travel through a shell parser. Windows earlier
// used `cmd /c start "" <path>` — `cmd` DOES tokenise the arguments,
// so a workspace filename with `&` / `|` / `^` / a leading `-` / etc.
// could be reinterpreted as command syntax (Codex + CodeQL flagged
// this on #1985). `explorer.exe <path>` is fed to CreateProcess as an
// array argv (no shell parsing) and treats the argument as a
// filesystem path.
//
// Returns a promise that settles based on `spawn` vs `error` events —
// NOT process exit. We can't tell whether the associated app actually
// opened a window (explorer.exe returns exit code 1 even on success),
// but we CAN distinguish "spawn succeeded" from "command not found /
// permission denied" (e.g. `xdg-open` missing on a headless Linux
// host). Client-side error handling depends on this signal.
/** The argv for opening a path in the host file manager, per platform. Pure,
 *  so the per-OS choice can be tested without spawning anything — running the
 *  real command in a test opens Finder on macOS and Explorer on Windows. */
export function openArgv(absPath: string, platform: typeof process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [absPath] };
  if (platform === "win32") return { command: "explorer.exe", args: [absPath] };
  return { command: "xdg-open", args: [absPath] };
}

/** The argv for revealing a path (folder opened, file selected). macOS `open -R`
 *  and Windows `explorer /select,` select the file; Linux `xdg-open <dir>` only
 *  opens the folder — there is no portable "select this item" across Linux file
 *  managers, and landing next to the file is enough for drag-and-drop (#1985).
 *  Same argv-array (no shell) discipline as `openArgv`, so a filename with shell
 *  metacharacters can never be reinterpreted as command syntax. */
export function revealArgv(absPath: string, platform: typeof process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: ["-R", absPath] };
  if (platform === "win32") return { command: "explorer.exe", args: [`/select,${absPath}`] };
  return { command: "xdg-open", args: [path.dirname(absPath)] };
}

/** Injectable so a test can assert the argv without launching the real file
 *  manager. Defaults to Node's `spawn`. */
export type Spawner = typeof spawn;

function spawnDetachedOsCommand(command: string, args: readonly string[], label: string, spawner: Spawner): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawner(command, args, { detached: true, stdio: "ignore" });
    let settled = false;
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      log.warn("files", `${label}: spawn error`, { platform: process.platform, error: err.message });
      resolve(false);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(true);
    });
  });
}

export function openInHostOs(absPath: string, spawner: Spawner = spawn): Promise<boolean> {
  const { command, args } = openArgv(absPath, process.platform);
  return spawnDetachedOsCommand(command, args, "open", spawner);
}

export function revealInHostOs(absPath: string, spawner: Spawner = spawn): Promise<boolean> {
  const { command, args } = revealArgv(absPath, process.platform);
  return spawnDetachedOsCommand(command, args, "reveal", spawner);
}

const router = Router();

const MAX_RAW_BYTES = 50 * 1024 * 1024; // 50 MB — cap for non-media streaming (images/pdf/binary load whole into the browser)
// Audio/video are streamed via HTTP Range requests (see GET /raw),
// so the browser never buffers the whole file. Podcasts commonly
// run 100–300 MB and recorded video can run multi-GB; cap at 4 GB
// just to keep an obviously-pathological file from being served.
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;
const HIDDEN_DIRS = new Set([".git"]);

// Files whose basename exactly matches one of these is refused by
// every file-API endpoint. Used to keep workspace secrets
// (credentials, API keys, SSH / TLS private keys) off the HTTP
// surface. Compared against `path.basename(...).toLowerCase()`.
const SENSITIVE_BASENAMES = new Set([
  "credentials.json",
  // Claude Code credentials file written by server/credentials.ts.
  ".session-token",
  // Bearer auth token file — readable without auth via /api/files/*
  // exemption, so it must be blocked here (defense in depth).
  ".npmrc",
  ".htpasswd",
  // Neither carries an extension, and `classify` answers "text" for every
  // extensionless name — so without an entry here both were readable
  // through `/files/content`. `_netrc` is the same file on Windows.
  ".netrc",
  "_netrc",
  ".git-credentials",
  "id_rsa",
  "id_ecdsa",
  "id_ed25519",
  "id_dsa",
]);

// File extensions whose contents are almost always secret. Compared
// against `path.extname(...).toLowerCase()`. Note: `.env` is matched
// separately below because `path.extname(".env")` returns "" —
// dotfiles with no second extension don't carry an extname.
//
// Keeping one of these out of `TEXT_EXTENSIONS` is only half a guard: it stops
// the preview and the write gate, and `/api/files/raw` would still stream the
// bytes to anything that asks. This list is the half that refuses them
// everywhere — tree, dir, content and raw alike — so the two are meant to
// agree, and `test_textExtensions.ts` pins that they do.
const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".crt",
  // `.env` as a SUFFIX. The two basename rules below cover `.env` and
  // `.env.local`, and covered nothing else: `prod.env` and `secrets.env` were
  // neither sensitive nor text, which meant /files/content refused them and
  // /files/raw streamed them anyway. Found while writing the test for the
  // keystore entries, and it is the same hole.
  ".env",
  // PKCS#12 / Java keystores — a private key with a password on it.
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  // Terraform: `.tfstate` records every provider credential in plaintext by
  // design, and `.tfvars` is where the concrete variable values live.
  ".tfstate",
  ".tfvars",
]);

// Decide whether `relPath` names a file whose contents should NEVER
// be served by the file API. Applied in three places:
//
// 1. `resolveSafe` returns null for sensitive paths so every
//    endpoint (content, raw, anything future) rejects them with a
//    generic 400.
// 2. `buildTreeAsync` / `listDirShallow` filter them out of
//    `/files/tree` and `/files/dir`, so the file explorer never
//    lists them in the first place.
// 3. The `.env` blocklist below is what keeps `/files/content`
//    from leaking credentials on a matching-name lookup.
//
// Exported so `test/routes/test_filesRoute.ts` can pin the matching
// rules down table-driven — regressions here silently reopen a
// credential-exfil surface.
export function isSensitivePath(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  if (SENSITIVE_BASENAMES.has(base)) return true;
  // `.env` and every `.env.<something>` variant
  // (`.env.local`, `.env.production`, ...). The startsWith check
  // is scoped to `.env` to avoid false-positives on names like
  // `.environment-notes` — we only match `.env` exact or
  // `.env.<suffix>`.
  if (base === ".env") return true;
  if (base.startsWith(".env.")) return true;
  const ext = path.extname(base);
  if (SENSITIVE_EXTENSIONS.has(ext)) return true;
  return false;
}

// `.bmp` / `.avif` / `.ico` are browser-renderable and this app already
// stores the first two (attachment-store.ts names them on upload), so the
// Files view calling them "binary" was a gap rather than a policy. HEIC /
// HEIF / TIFF stay out on purpose — no browser renders them, and they now
// reach the user through the fallback's Download button.
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif", ".ico"]);

export const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".ogg", ".oga", ".flac", ".aac"]);

export const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);

/** Things a later double-click would execute. Refused on upload — a drop into
 *  the workspace is for data, not for programs — and refused by the write gate
 *  for the same reason: `/api/files/*` is exempt from bearer auth
 *  (`server/index.ts`), so create and PUT are reachable by anything that can
 *  talk to the loopback port, and "typed through one unauthenticated route" is
 *  not a weaker capability than "dropped through another". PREVIEW is
 *  deliberately unaffected — a `.sh` still renders as text, it just cannot be
 *  written here. */
export const BLOCKED_UPLOAD_EXTENSIONS = new Set([".exe", ".dll", ".so", ".dylib", ".bat", ".cmd", ".com", ".scr", ".msi", ".app", ".sh", ".ps1"]);

/** The write gate for `POST /api/files/create` and `PUT /api/files/content`.
 *  Narrower than "is it text" on purpose: `TEXT_EXTENSIONS` answers whether the
 *  Files view can SHOW a file, which is a question about rendering, and the two
 *  were the same predicate until an executable suffix was previewable and
 *  writable at once. */
export function isWritableTextFile(absPath: string): boolean {
  if (classify(absPath) !== "text") return false;
  return !BLOCKED_UPLOAD_EXTENSIONS.has(path.extname(absPath).toLowerCase());
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".ogv": "video/ogg",
};

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  modifiedMs?: number;
  children?: TreeNode[];
}

interface ErrorResponse {
  error: string;
}

interface FileContentText {
  kind: "text";
  path: string;
  content: string;
  size: number;
  modifiedMs: number;
}

interface WriteContentRequest {
  path?: unknown;
  content?: unknown;
}

interface FileContentMeta {
  kind: "image" | "pdf" | "audio" | "video" | "binary" | "too-large";
  path: string;
  size: number;
  modifiedMs: number;
  message?: string;
}

type FileContentResponse = FileContentText | FileContentMeta;

export type ContentKind = "text" | "image" | "pdf" | "audio" | "video" | "binary";

// Exported for unit tests. Classification is purely extension-based
// and case-insensitive (via `path.extname(...).toLowerCase()`).
export function classify(filename: string): ContentKind {
  const ext = path.extname(filename).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (ext === ".pdf") return "pdf";
  // Files with no extension (e.g. README, LICENSE) — treat as text
  if (!ext) return "text";
  return "binary";
}

// Cached realpath of the workspace. Computed once at module load so
// every request avoids the syscall. resolveWithinRoot needs an
// already-realpath'd root.
const workspaceReal = realpathSync(workspacePath);

// Windows-only: cached **async-realpath** form of the workspace. On
// Windows, `realpathSync` (sync) and `realpath` (async) can return
// the same path in two different forms — 8.3 short-name (`RUNNER~1`)
// vs. long-name (`runneradmin`) — depending on which syscall path
// was used to open the dir entry. Comparing across forms via
// `path.relative` then produces a false "outside workspace" verdict
// (`..\..\runneradmin\...`). This cache mirrors `workspaceReal` but
// is guaranteed to share the form the async `realpath` returns, so
// `resolveNewFilePath`'s containment check has matching ends. On
// non-Windows hosts both syscalls return the same string, so the
// cache equals `workspaceReal` and the extra lookup is harmless.
let workspaceRealAsyncCache: string | null = null;
async function getWorkspaceRealAsync(): Promise<string> {
  if (workspaceRealAsyncCache !== null) return workspaceRealAsyncCache;
  try {
    workspaceRealAsyncCache = await realpath(workspaceReal);
  } catch {
    workspaceRealAsyncCache = workspaceReal;
  }
  return workspaceRealAsyncCache;
}

// Wraps the shared resolveWithinRoot helper with the additional
// hidden-dir traversal check (e.g. `.git/config`). `buildTreeAsync`
// / `listDirShallow` hide these from the listing, but the URL
// endpoints are reachable directly so they need their own check.
function resolveSafe(relPath: string): string | null {
  const resolved = resolveWithinRoot(workspaceReal, relPath);
  if (!resolved) return null;
  const relativeFromWorkspace = path.relative(workspaceReal, resolved);
  if (relativeFromWorkspace) {
    for (const seg of relativeFromWorkspace.split(path.sep)) {
      if (HIDDEN_DIRS.has(seg)) return null;
    }
  }
  // Reject workspace-sensitive filenames outright. `isSensitivePath`
  // matches on the basename so it catches `.env`, `id_rsa`, and
  // friends regardless of which directory they sit in.
  if (isSensitivePath(resolved)) return null;
  return resolved;
}

// ── Reference directory path resolution ──────────────────────────

const REF_PREFIX = "@ref/";
/** The prefix without its separator — a directory named exactly this is still
 *  reference territory even though it fails the `@ref/` prefix test. */
const REF_ROOT_SEGMENT = REF_PREFIX.slice(0, -1);

function isRefPath(relPath: string): boolean {
  return relPath.startsWith(REF_PREFIX);
}

/**
 * Resolve a `@ref/<label>/remainder` path against a registered
 * reference directory. Returns the absolute host path or null if
 * the label is unknown, the path escapes the ref root, or the
 * resolved file is sensitive / hidden.
 */
function resolveRefPath(prefixedPath: string): string | null {
  const afterPrefix = prefixedPath.slice(REF_PREFIX.length);
  const slashIdx = afterPrefix.indexOf("/");
  const label = slashIdx >= 0 ? afterPrefix.slice(0, slashIdx) : afterPrefix;
  const remainder = slashIdx >= 0 ? afterPrefix.slice(slashIdx + 1) : "";

  const entries = getCachedReferenceDirs();
  const entry = entries.find((refEntry) => refEntry.label === label);
  if (!entry) return null;

  // Not a bare realpath: the same resolution the sandbox mount uses, so a
  // reference directory that points at a blocked tree is refused here too.
  // This route serves its CONTENT, so without the check `@ref/notes/...` reads
  // out of `~/.ssh` whether or not Docker is in play (#3200).
  const target = resolveReferenceDir(entry.hostPath);
  if (target.kind !== "ok") return null;
  const rootReal = target.realPath;

  // For root of the reference dir (no remainder), return the dir itself
  if (!remainder) return rootReal;

  const resolved = resolveWithinRoot(rootReal, remainder);
  if (!resolved) return null;

  // Apply the same hidden-dir and sensitive-path filters
  const relFromRoot = path.relative(rootReal, resolved);
  if (relFromRoot) {
    for (const seg of relFromRoot.split(path.sep)) {
      if (HIDDEN_DIRS.has(seg)) return null;
    }
  }
  if (isSensitivePath(resolved)) return null;

  return resolved;
}

export interface ByteRange {
  start: number;
  end: number;
}

// Parse an HTTP Range header of the form `bytes=START-END` or
// `bytes=-SUFFIX`. Returns null for malformed or unsatisfiable ranges
// so the caller can respond 416. We deliberately reject multi-range
// requests (`bytes=0-99,200-299`) since browsers don't issue them for
// media playback and supporting them would complicate the response.
//
// Exported for unit tests — this is the most security-sensitive piece
// of the file-serving surface, so it's covered exhaustively in
// `test/routes/test_filesRoute.ts`.
export function parseRange(header: string, size: number): ByteRange | null {
  // RFC 7233 §2.1: "A Range request on a representation whose current
  // length is 0 cannot be satisfied". We also need this guard at the
  // top because the naive suffix-range math below produces `end = -1`
  // for zero-byte files, which then crashes `createReadStream`
  // with `ERR_OUT_OF_RANGE`.
  if (size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return null;
  if (startStr === "") {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startStr);
  const end = endStr === "" ? size - 1 : Number(endStr);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || end >= size) return null;
  return { start, end };
}

// Security headers applied to `/files/raw` responses. Exported so a
// regression test can pin the exact strings down — a silent
// regression here reopens a real XSS surface (see plans/done/
// fix-files-raw-csp-sandbox.md for the full threat model).
//
// `sandbox` (no allow-flags) creates an opaque origin for the
// response. Even if an SVG / HTML / PDF with embedded JavaScript
// gets loaded as a top-level document or inside an iframe, its
// scripts can't access the localhost:3001 origin's cookies,
// session storage, or hit the `/api/*` endpoints. Frames rendering
// the response become sandboxed too.
//
// `nosniff` stops Chrome / Firefox from re-guessing Content-Type
// on files the server declared but the browser might want to
// re-interpret as HTML.
export const RAW_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "sandbox",
  "X-Content-Type-Options": "nosniff",
};

// Two kinds of response skip `Content-Security-Policy: sandbox`,
// each because a browser cannot show the file under it at all:
// - PDF (#1299): WebKit refuses to render a `sandbox`-opaque PDF and
//   forces a download, breaking the Files preview iframe on Safari.
//   The PDF viewer (PDFium on Chromium, the WebKit PDF renderer,
//   pdf.js on Firefox) runs embedded AcroJS inside its own sandbox;
//   the response-level CSP was never the layer enforcing PDF script
//   isolation.
// - audio / video (#3437): opened as a top-level document, Chrome's
//   media page re-requests the file in CORS mode from the sandbox's
//   `null` origin, the request is blocked, and the player has
//   nothing to play.
// Neither can run script in the document that shows it: a media
// file is decoded, not parsed as markup. `nosniff` is kept so the
// response can't be re-interpreted as HTML.
export const RAW_SECURITY_HEADERS_NO_SANDBOX: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
};

const SANDBOX_EXEMPT_MIME_PREFIXES = ["audio/", "video/"] as const;

/** True for the MIMEs a browser can only show without the sandbox
 *  CSP: `application/pdf` and the `audio/*` / `video/*` the route's
 *  MIME table emits. Every other MIME (`image/*`, `text/*`,
 *  `application/octet-stream`, …) must stay sandboxed — an SVG
 *  served without it is stored XSS against the app origin. */
export function isSandboxExemptMime(mime: string): boolean {
  return mime === "application/pdf" || SANDBOX_EXEMPT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

export function rawSecurityHeadersForMime(mime: string): Readonly<Record<string, string>> {
  return isSandboxExemptMime(mime) ? RAW_SECURITY_HEADERS_NO_SANDBOX : RAW_SECURITY_HEADERS;
}

function applyRawSecurityHeaders(res: Response, mime: string): void {
  for (const [name, value] of Object.entries(rawSecurityHeadersForMime(mime))) {
    res.setHeader(name, value);
  }
}

// If the read stream errors mid-flight (file deleted, disk error,
// permissions changed), surface a clean failure to the client instead
// of leaving the connection hanging.
function pipeWithErrorHandling(stream: ReadStream, res: Response<ErrorResponse>): void {
  stream.on("error", (err) => {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    // The raw `err.message` carries filesystem paths / system error
    // detail — keep it in the server log but ship a stable opaque
    // string to the client. Same threat model as `asyncHandler`.
    log.error("files", "raw stream error", { error: errorMessage(err) });
    serverError(res, "Failed to read file");
  });
  stream.pipe(res);
}

// Apply the UI-visibility filters (hidden dirs, sensitive files,
// symlinks, .gitignore matches) to a single directory entry and stat
// it. Returns the resolved child paths + stat, or null when the entry
// should not surface. The recursive walk and the shallow lazy-expand
// path share this so the filter policy lives in exactly one place.
async function resolveVisibleChild(
  entry: Dirent,
  absPath: string,
  relPath: string,
  localFilter: GitignoreFilter | undefined,
): Promise<{ childRel: string; childAbs: string; childStat: Stats } | null> {
  if (HIDDEN_DIRS.has(entry.name)) return null;
  if (!entry.isDirectory() && isSensitivePath(entry.name)) return null;
  if (entry.isSymbolicLink()) return null;
  // POSIX-shaped: this becomes `TreeNode.path` (a `/`-separated contract on
  // every host) and the `.gitignore` test path below, and the `ignore` package
  // only matches POSIX input — on Windows `sub\node_modules/` silently misses a
  // `node_modules/` rule, surfacing entries the user marked ignored (#2542).
  const childRel = joinPosixRelPath(relPath, entry.name);
  // .gitignore check: for directories, append trailing / so
  // directory-only patterns (e.g. "node_modules/") match.
  if (localFilter) {
    const testPath = entry.isDirectory() ? `${childRel}/` : childRel;
    if (localFilter.ignores(testPath)) return null;
  }
  const childAbs = path.join(absPath, entry.name);
  const childStat = await statSafeAsync(childAbs);
  if (!childStat) return null;
  return { childRel, childAbs, childStat };
}

// Await a directory's child-node promises, drop the filtered-out nulls,
// sort (dirs before files, alphabetical within type), and wrap them in
// the parent's `dir` TreeNode. Shared by the recursive and shallow
// builders so the assembly + ordering is defined once.
async function assembleDirNode(childPromises: Promise<TreeNode | null>[], relPath: string, modifiedMs: number): Promise<TreeNode> {
  const resolved = await Promise.all(childPromises);
  const children = resolved.filter((childNode): childNode is TreeNode => childNode !== null);
  children.sort((leftChild, rightChild) => {
    if (leftChild.type !== rightChild.type) return leftChild.type === "dir" ? -1 : 1;
    return leftChild.name.localeCompare(rightChild.name);
  });
  return {
    name: relPath ? path.basename(relPath) : "",
    path: relPath,
    type: "dir",
    modifiedMs,
    children,
  };
}

// Async workspace tree walker — recurses through the workspace with
// the same security filters as the original sync implementation
// (hidden dirs, sensitive files, symlinks all rejected) and the same
// ordering (dirs before files, alphabetical within type). Uses
// `promises` throughout so the walk never blocks the event loop,
// and fans out each directory's children in parallel via
// `Promise.all`.
//
// Exported so unit tests can point it at a tmp dir fixture.
export async function buildTreeAsync(absPath: string, relPath: string, gitFilter?: GitignoreFilter): Promise<TreeNode> {
  const stat = await statSafeAsync(absPath);
  if (!stat) {
    // Caller is expected to have resolved `absPath` beforehand; if it
    // vanished between resolve and walk, surface an empty dir node.
    return {
      name: path.basename(absPath),
      path: relPath,
      type: "dir",
      children: [],
    };
  }
  if (!stat.isDirectory()) {
    return {
      name: path.basename(absPath),
      path: relPath,
      type: "file",
      size: stat.size,
      modifiedMs: stat.mtimeMs,
    };
  }
  const entries = await readDirSafeAsync(absPath);
  // Pick up any .gitignore in this directory so its rules apply to
  // children. The filter chains: parent rules + local .gitignore.
  // When gitFilter is undefined (workspace root), DON'T read the
  // root .gitignore (it's for git, not the UI). Pass a fresh empty
  // filter so children pick up THEIR .gitignore files.
  const localFilter = gitFilter ? gitFilter.childForDir(absPath) : new GitignoreFilter();
  // Build every surviving child concurrently, recursing into the ones
  // that pass the visibility filter.
  const childPromises: Promise<TreeNode | null>[] = entries.map(async (entry): Promise<TreeNode | null> => {
    const child = await resolveVisibleChild(entry, absPath, relPath, localFilter);
    if (!child) return null;
    return buildTreeAsync(child.childAbs, child.childRel, localFilter);
  });
  return assembleDirNode(childPromises, relPath, stat.mtimeMs);
}

// Map a single directory entry to a shallow TreeNode, applying the
// same hidden/sensitive/symlink/gitignore filters as the recursive
// walk. Returns null for entries that should not surface in the UI.
async function dirEntryToNode(entry: Dirent, absPath: string, relPath: string, localFilter: GitignoreFilter | undefined): Promise<TreeNode | null> {
  const child = await resolveVisibleChild(entry, absPath, relPath, localFilter);
  if (!child) return null;
  const { childRel, childStat } = child;
  if (childStat.isDirectory()) {
    return {
      name: entry.name,
      path: childRel,
      type: "dir",
      modifiedMs: childStat.mtimeMs,
      // No `children` field — caller fetches via another
      // /api/files/dir call on expand.
    };
  }
  return {
    name: entry.name,
    path: childRel,
    type: "file",
    size: childStat.size,
    modifiedMs: childStat.mtimeMs,
  };
}

// Shallow variant: return the given directory's immediate children
// only (no recursion). Used by the lazy-expand endpoint below — the
// client fetches one level at a time as the user expands nodes,
// so the initial Files view load cost is O(root entries) rather than
// O(all workspace files).
//
// Exported for unit tests.
export async function listDirShallow(absPath: string, relPath: string, gitFilter?: GitignoreFilter): Promise<TreeNode> {
  const stat = await statSafeAsync(absPath);
  if (!stat || !stat.isDirectory()) {
    return {
      name: relPath ? path.basename(relPath) : "",
      path: relPath,
      type: "dir",
      children: [],
    };
  }
  const entries = await readDirSafeAsync(absPath);
  // When gitFilter is undefined (workspace root), DON'T read the
  // root .gitignore (it's for git, not the UI). Pass a fresh empty
  // filter so children pick up THEIR .gitignore files.
  const localFilter = gitFilter ? gitFilter.childForDir(absPath) : new GitignoreFilter();
  const childPromises = entries.map((entry) => dirEntryToNode(entry, absPath, relPath, localFilter));
  return assembleDirNode(childPromises, relPath, stat.mtimeMs);
}

router.get(API_ROUTES.files.tree, async (_req: Request<object, unknown, unknown, object>, res: Response<TreeNode | ErrorResponse>) => {
  log.info("files", "GET tree: start");
  try {
    // Start with an empty filter — the workspace root's .gitignore
    // is for git (excluding github/ from commits), NOT for the
    // Files UI. Only .gitignore files inside subdirectories (e.g.
    // github/mulmoclaude/.gitignore) are applied.
    // Pass undefined = skip workspace root .gitignore (it's for
    // git, not the UI). Sub-dir .gitignore files still apply.
    const tree = await buildTreeAsync(workspaceReal, "");
    res.json(tree);
  } catch (err) {
    log.error("files", "GET tree: threw", { error: errorMessage(err) });
    serverError(res, "Failed to read workspace");
  }
});

// Build the gitignore filter chain for `absPath`. Start undefined at
// the root (the workspace root's .gitignore is for git, not the UI).
// Once we descend into a sub-dir, childForDir picks up local
// .gitignore files. Exported for unit tests.
export function buildGitignoreFilterChain(rootAbs: string, absPath: string): GitignoreFilter | undefined {
  let filter: GitignoreFilter | undefined;
  const segments = path.relative(rootAbs, absPath).split(path.sep).filter(Boolean);
  let walkAbs = rootAbs;
  for (const seg of segments) {
    walkAbs = path.join(walkAbs, seg);
    filter = filter ? filter.childForDir(walkAbs) : new GitignoreFilter().childForDir(walkAbs);
  }
  return filter;
}

// Lazy-expand endpoint. Returns one directory's immediate children
// (no recursion) so the client can render the tree incrementally.
// `path` is optional; empty / missing = workspace root.
router.get(API_ROUTES.files.dir, async (req: Request<object, unknown, unknown, PathQuery>, res: Response<TreeNode | ErrorResponse>) => {
  const relPath = getOptionalStringQuery(req, "path") ?? "";
  log.info("files", "GET dir: start", { pathPreview: previewSnippet(relPath) });

  // Reference directory branch — resolve against the registered ref dir
  if (isRefPath(relPath)) {
    const absPath = resolveRefPath(relPath);
    if (!absPath) {
      log.warn("files", "GET dir: ref dir not found", { pathPreview: previewSnippet(relPath) });
      notFound(res, "Not found");
      return;
    }
    const stat = await statSafeAsync(absPath);
    if (!stat || !stat.isDirectory()) {
      log.warn("files", "GET dir: ref path missing or not a dir", { pathPreview: previewSnippet(relPath) });
      notFound(res, "Not found");
      return;
    }
    // No gitignore filter — a ref dir lives outside the workspace repo.
    const node = await listDirShallow(absPath, relPath);
    res.json(node);
    return;
  }

  // Workspace path — existing logic
  const absPath = resolveSafe(relPath);
  if (!absPath) {
    log.warn("files", "GET dir: path outside workspace", { pathPreview: previewSnippet(relPath) });
    notFound(res, "Not found");
    return;
  }
  const stat = await statSafeAsync(absPath);
  if (!stat) {
    log.warn("files", "GET dir: not found", { pathPreview: previewSnippet(relPath) });
    notFound(res, "Not found");
    return;
  }
  if (!stat.isDirectory()) {
    log.warn("files", "GET dir: not a directory", { pathPreview: previewSnippet(relPath) });
    badRequest(res, "path is not a directory");
    return;
  }
  try {
    const filter = buildGitignoreFilterChain(workspaceReal, absPath);
    // `path.relative` is host-shaped; the walk below joins onto this seed and
    // hands the result out as `TreeNode.path`, so it crosses to POSIX here.
    const listing = await listDirShallow(absPath, toPosixRelPath(path.relative(workspaceReal, absPath)), filter);
    res.json(listing);
  } catch (err) {
    log.error("files", "GET dir: threw", { pathPreview: previewSnippet(relPath), error: errorMessage(err) });
    serverError(res, "Failed to read directory");
  }
});

interface PathQuery {
  path?: string;
}

// Shared validation preamble for /files/content and /files/raw. Both
// endpoints need to: read `path` from the query, validate it's
// inside the workspace (with symlink hardening), stat it, and
// confirm it's a regular file. On any failure this writes the
// appropriate 4xx response and returns null; the caller bails out.
//
// `T` lets each caller's Response type stay precise — both endpoints
// have different success-shape unions and we just need ErrorResponse
// to be one of the alternatives.
//
// Order matters: stat the syntactic candidate first so a missing
// file gets a 404, then run the realpath-hardened resolveSafe check
// for symlink escapes (which would return 400). Doing them in this
// order keeps 404 reachable for the common "file not found" case
// instead of conflating it with traversal attempts.
function resolveAndStatFile<T>(
  req: Request<object, unknown, unknown, PathQuery>,
  res: Response<T | ErrorResponse>,
): { relPath: string; absPath: string; stat: Stats } | null {
  return resolveAndStatFileByPath(getOptionalStringQuery(req, "path") ?? "", res);
}

function resolveAndStatFileByPath<T>(relPath: string, res: Response<T | ErrorResponse>): { relPath: string; absPath: string; stat: Stats } | null {
  if (!relPath) {
    badRequest(res, "path required");
    return null;
  }

  // Reference directory branch
  if (isRefPath(relPath)) {
    const absPath = resolveRefPath(relPath);
    if (!absPath) {
      notFound(res, "Not found");
      return null;
    }
    const stat = statSafe(absPath);
    if (!stat || !stat.isFile()) {
      notFound(res, "File not found");
      return null;
    }
    return { relPath, absPath, stat };
  }

  // Workspace path — existing logic
  // Syntactic candidate (no symlink resolution yet).
  const candidate = path.resolve(workspaceReal, path.normalize(relPath));
  const stat = statSafe(candidate);
  if (!stat) {
    // Distinguish "missing file under workspace" (404) from "path
    // syntactically outside workspace" (400). We check the
    // syntactic relative form, NOT realpath, because the file
    // doesn't exist so realpath would throw anyway.
    const relativeFromWorkspace = path.relative(workspaceReal, candidate);
    const escapesSyntactically = relativeFromWorkspace === ".." || relativeFromWorkspace.startsWith(`..${path.sep}`);
    if (escapesSyntactically) {
      badRequest(res, "Path outside workspace");
    } else {
      notFound(res, "File not found");
    }
    return null;
  }
  if (!stat.isFile()) {
    badRequest(res, "Not a file");
    return null;
  }
  // File exists — run the realpath-hardened check to defeat
  // symlink-escape attempts (e.g. workspace/secret → /etc/passwd).
  // resolveSafe also rejects paths that traverse a hidden dir.
  const absPath = resolveSafe(relPath);
  if (!absPath) {
    badRequest(res, "Path outside workspace");
    return null;
  }
  return { relPath, absPath, stat };
}

// Decide the metadata-only response for a resolved file based on its
// classified kind and byte size — media/pdf/image return metadata,
// oversized or binary files return a message, everything else returns
// null so the caller reads and returns the file as text. Pure;
// exported for unit tests.
export function decideContentResponse(kind: ContentKind, meta: { path: string; size: number; modifiedMs: number }): FileContentMeta | null {
  const { size } = meta;
  // Audio/video stream via Range requests, so they get the looser
  // MAX_MEDIA_BYTES cap. Everything else (images/PDFs/binary) is
  // loaded whole by the browser and stays at MAX_RAW_BYTES.
  const isStreamingMedia = kind === "audio" || kind === "video";
  const sizeCap = isStreamingMedia ? MAX_MEDIA_BYTES : MAX_RAW_BYTES;
  if (size > sizeCap) {
    return {
      kind: "too-large",
      ...meta,
      message: `File too large to preview (${size} bytes)`,
    };
  }
  if (kind === "image" || kind === "pdf" || kind === "audio" || kind === "video") {
    return { kind, ...meta };
  }
  if (kind === "binary") {
    return {
      kind: "binary",
      ...meta,
      message: "Binary file — preview not supported",
    };
  }
  if (size > MAX_PREVIEW_BYTES) {
    return {
      kind: "too-large",
      ...meta,
      message: `Text file too large to preview (${size} bytes)`,
    };
  }
  return null;
}

router.get(API_ROUTES.files.content, (req: Request<object, unknown, unknown, PathQuery>, res: Response<FileContentResponse | ErrorResponse>) => {
  const requestedPath = getOptionalStringQuery(req, "path") ?? "";
  log.info("files", "GET content: start", { pathPreview: previewSnippet(requestedPath) });
  const ctx = resolveAndStatFile(req, res);
  if (!ctx) {
    // resolveAndStatFile already wrote the 4xx; surface the gate
    // miss so the operator can correlate the user-visible error
    // with a concrete reason in the log without re-running.
    log.warn("files", "GET content: gated by resolve/stat", { pathPreview: previewSnippet(requestedPath) });
    return;
  }
  const { relPath, absPath, stat } = ctx;

  const meta = {
    path: relPath,
    size: stat.size,
    modifiedMs: stat.mtimeMs,
  };

  const kind = classify(absPath);
  const preview = decideContentResponse(kind, meta);
  if (preview) {
    res.json(preview);
    return;
  }
  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (err) {
    log.error("files", "GET content: read threw", { pathPreview: previewSnippet(relPath), error: errorMessage(err) });
    serverError(res, "Failed to read file");
    return;
  }
  log.info("files", "GET content: ok", { pathPreview: previewSnippet(relPath), bytes: stat.size });
  res.json({ kind: "text", ...meta, content });
});

type ResolvedTextFile = { ok: true; absPath: string } | { ok: false; status: 400 | 404; message: string };

// Two-step path resolution + text-only gate for PUT /api/files/content.
//
// Why two steps: `resolveSafe` calls `realpathSync`, which throws
// ENOENT for missing files. Conflating "path outside workspace"
// (caller bug, 400) with "file does not exist" (404) loses the
// signal. Stat the syntactic candidate first; only if it exists
// do we run the symlink-hardened resolveSafe.
//
// The classifier check rejects binary / image / audio / etc. so
// this endpoint can't be used as an arbitrary upload channel.
async function resolveExistingTextFile(relPathRaw: string): Promise<ResolvedTextFile> {
  const candidate = path.resolve(workspaceReal, path.normalize(relPathRaw));
  const existing = await statSafeAsync(candidate);
  if (!existing) {
    const relativeFromWorkspace = path.relative(workspaceReal, candidate);
    const escapesSyntactically = relativeFromWorkspace === ".." || relativeFromWorkspace.startsWith(`..${path.sep}`);
    return escapesSyntactically ? { ok: false, status: 400, message: "Path outside workspace" } : { ok: false, status: 404, message: "File not found" };
  }
  if (!existing.isFile()) return { ok: false, status: 400, message: "Not a file" };
  const absPath = resolveSafe(relPathRaw);
  if (!absPath) return { ok: false, status: 400, message: "Path outside workspace" };
  if (!isWritableTextFile(absPath)) return { ok: false, status: 400, message: "File type not editable" };
  return { ok: true, absPath };
}

// Wiki pages route through `writeWikiPage` so the (old, new) pair
// reaches the edit-history pipeline (#763). Everything else takes
// the generic atomic write. `uniqueTmp: true` appends a randomUUID
// to the tmp filename so two simultaneous PUTs to the same path
// can't clobber each other's staging file and race through rename
// (writeWikiPage applies it internally).
//
// `workspaceReal` is the already-realpath'd workspace root —
// resolveSafe returns a realpath'd absPath, so the classifier MUST
// compare against the same realpath'd root. A symlinked workspace
// (e.g. `~/mulmoclaude` → some real path elsewhere) would otherwise
// silently bypass the wiki chokepoint.
async function writeFileContent(absPath: string, content: string): Promise<void> {
  const wikiClass = classifyAsWikiPage(absPath, { workspaceRoot: workspaceReal });
  if (wikiClass.wiki) {
    await writeWikiPage(wikiClass.slug, content, { editor: "user" }, { workspaceRoot: workspaceReal });
  } else {
    await writeFileAtomic(absPath, content, { uniqueTmp: true });
  }
}

// JSON config files are editable from the Files Explorer (#833 Phase
// 1), but a hand-edit that breaks JSON syntax would corrupt a file the
// app (or the agent) parses on read. Reject a malformed save before it
// hits disk so the editor can surface the parser error inline. `.jsonl`
// is intentionally excluded — each line is its own document, not one
// JSON value, so `JSON.parse` of the whole file would always fail.
// Write the body of an existing text file. Only text-classified files
// (per `classify`) are editable — binary, image, audio, etc. are
// refused so the endpoint can't be used to ship arbitrary uploads.
// The file must already exist; creating new files is out of scope.
// Resolve a path for a file we expect to NOT exist yet (POST create).
// `resolveExistingTextFile` requires existence and bails with 404 for
// new files, which is exactly the create case.
//
// Hardening (Codex iter-2..6 on #1598):
//
//   - **Syntactic checks** (containment, HIDDEN_DIRS, sensitive
//     basenames, classifier) are equivalent to what `resolveSafe`
//     applies to existing paths.
//   - **realpath-walk** the deepest existing ancestor of the target.
//     PUT inherits this via `resolveSafe`'s `realpathSync` on the
//     existing file; for create the target is absent, so we walk up
//     to the first ancestor that exists, realpath that, and
//     reconstruct the final path under the resolved real ancestor.
//     A symlinked workspace subtree pointing outside `workspaceReal`
//     therefore can't route create writes outside the workspace.
async function resolveNewFilePath(
  relPathRaw: string,
): Promise<{ ok: true; absPath: string; workspaceRoot: string } | { ok: false; status: 400; message: string }> {
  const normalised = path.normalize(relPathRaw);
  if (path.isAbsolute(normalised)) return { ok: false, status: 400, message: "Path must be workspace-relative" };
  const candidate = path.resolve(workspaceReal, normalised);
  const relativeFromWorkspace = path.relative(workspaceReal, candidate);
  if (relativeFromWorkspace === ".." || relativeFromWorkspace.startsWith(`..${path.sep}`)) {
    return { ok: false, status: 400, message: "Path outside workspace" };
  }
  // Mirror `resolveSafe`: refuse `.git/` (or any HIDDEN_DIRS) segment.
  for (const seg of relativeFromWorkspace.split(path.sep)) {
    if (HIDDEN_DIRS.has(seg)) return { ok: false, status: 400, message: "Path not allowed" };
  }
  if (isSensitivePath(relativeFromWorkspace)) return { ok: false, status: 400, message: "Path not allowed" };
  // Walk up the candidate's ancestors until we find one that exists.
  // Realpath THAT ancestor — a symlinked in-workspace folder pointing
  // outside `workspaceReal` would otherwise let the create land outside.
  // Reconstruct the final path as the realpath'd ancestor + the
  // remaining missing segments, then re-verify containment.
  const trailing: string[] = [];
  let probe = candidate;
  let probeStat = await statSafeAsync(probe);
  while (!probeStat) {
    const parent = path.dirname(probe);
    if (parent === probe) return { ok: false, status: 400, message: `Path outside workspace (root reached at ${probe})` };
    trailing.unshift(path.basename(probe));
    probe = parent;
    probeStat = await statSafeAsync(probe);
  }
  let realProbe: string;
  try {
    realProbe = await realpath(probe);
  } catch {
    return { ok: false, status: 400, message: "Path not allowed" };
  }
  const finalAbs = trailing.length === 0 ? realProbe : path.join(realProbe, ...trailing);
  // Compare against the **async-realpath** form of the workspace, not
  // the sync form cached as `workspaceReal`. On Windows the two can
  // differ (8.3 short-name vs. long-name), and `path.relative` across
  // the two yields a spurious `..\..\..\<long-name>\...` that fails
  // the containment check. See `getWorkspaceRealAsync` for the why.
  const rootAsync = await getWorkspaceRealAsync();
  const relFromReal = path.relative(rootAsync, finalAbs);
  if (relFromReal === ".." || relFromReal.startsWith(`..${path.sep}`) || path.isAbsolute(relFromReal)) {
    return { ok: false, status: 400, message: "Path outside workspace" };
  }
  return { ok: true, absPath: finalAbs, workspaceRoot: rootAsync };
}

// Perform the exclusive create write for POST /files/create. Atomic
// create via `wx` (POSIX O_EXCL) — fails with EEXIST if the target
// already exists, closing the check-then-write TOCTOU that Codex
// flagged on earlier iterations. Wiki pages route through
// `writeWikiPage` with `exclusive: true` so the same exclusive
// primitive applies after the frontmatter stamp. On failure this
// writes the appropriate 4xx/5xx response and returns false; the
// caller bails.
async function performCreateWrite(
  resolved: { absPath: string; workspaceRoot: string },
  content: string,
  relPath: string,
  res: Response<WriteContentResponse | ErrorResponse>,
): Promise<boolean> {
  try {
    // `resolved.workspaceRoot` is the async-realpath form, matching
    // `resolved.absPath`'s form. Passing the sync-form `workspaceReal`
    // would make `classifyAsWikiPage` fail to match the prefix on
    // Windows (8.3 short-name vs. long-name) — we'd fall into the
    // plain-file branch and skip the wiki frontmatter stamp.
    const wikiClass = classifyAsWikiPage(resolved.absPath, { workspaceRoot: resolved.workspaceRoot });
    if (wikiClass.wiki) {
      await writeWikiPage(wikiClass.slug, content, { editor: "user" }, { workspaceRoot: resolved.workspaceRoot, exclusive: true });
    } else {
      await mkdir(path.dirname(resolved.absPath), { recursive: true });
      await writeFile(resolved.absPath, content, { flag: "wx" });
    }
  } catch (err) {
    const code = isErrorWithCode(err) ? err.code : undefined;
    if (code === "EEXIST") {
      log.warn("files", "POST create: conflict", { pathPreview: previewSnippet(relPath) });
      sendError(res, 409, "File already exists");
      return false;
    }
    // EISDIR: the target path already exists as a directory. That's
    // a client-visible conflict (you can't replace a dir with a
    // file via this endpoint), not a server error. Maps to the same
    // 409 lane so the inline UI shows the localised "exists" copy.
    if (code === "EISDIR") {
      log.warn("files", "POST create: target is a directory", { pathPreview: previewSnippet(relPath) });
      sendError(res, 409, "Target is a directory");
      return false;
    }
    log.error("files", "POST create: write threw", { pathPreview: previewSnippet(relPath), error: errorMessage(err) });
    serverError(res, "Failed to create file");
    return false;
  }
  return true;
}

// Create a new text file. Refuses to overwrite — that's PUT's job and
// requires a separate explicit-overwrite UX. Used by the File
// Explorer's "New file" context menu (#1598) where the client already
// passes a slug for a file it believes doesn't exist; we re-check
// here to close the TOCTOU window between two tabs.
router.post(API_ROUTES.files.create, async (req: Request<object, unknown, WriteContentRequest>, res: Response<WriteContentResponse | ErrorResponse>) => {
  const inputs = validateWriteRequestOr400(req.body, res, "POST create");
  if (!inputs) return;
  const { relPath, content, bytes: contentBytes } = inputs;

  const resolved = await resolveNewFilePath(relPath);
  if (!resolved.ok) {
    badRequest(res, resolved.message);
    return;
  }
  // Type policy lives with the caller: create/edit only accept editable text,
  // while `files.upload` deliberately writes arbitrary bytes.
  if (!isWritableTextFile(resolved.absPath)) {
    badRequest(res, "File type not editable");
    return;
  }
  const jsonError = jsonSyntaxError(relPath, content);
  if (jsonError !== null) {
    log.warn("files", "POST create: invalid JSON", { pathPreview: previewSnippet(relPath) });
    badRequest(res, jsonError);
    return;
  }
  const created = await performCreateWrite(resolved, content, relPath, res);
  if (!created) return;
  await respondWithWrittenFile(res, { absPath: resolved.absPath, relPath, fallbackBytes: contentBytes, logLabel: "POST create" });
});

/** Cap on one dropped file, in decoded bytes.
 *
 *  Deliberately well under the 50 MB `express.json` body cap (server/index.ts):
 *  the file travels as a base64 `data:` URI inside JSON, which inflates it by
 *  4/3 before the envelope is even counted. Advertising 50 MB would be a limit
 *  this handler never gets to enforce — express would reject a 40 MB file with
 *  a generic 413 first. 32 MB decoded is ~43 MB encoded, comfortably inside. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

interface UploadFileBody {
  dir?: unknown;
  filename?: unknown;
  dataUrl?: unknown;
}

/** Seams for `writeUploadWithRename`, so its collision / containment behaviour
 *  can be exercised without touching the real workspace. */
export interface UploadWriteDeps {
  resolve: (relPath: string) => Promise<{ ok: true; absPath: string; workspaceRoot: string } | { ok: false; status: 400; message: string }>;
  write: (absPath: string, bytes: Buffer) => Promise<void>;
}

const defaultUploadWriteDeps: UploadWriteDeps = {
  resolve: resolveNewFilePath,
  // Exclusive create lives in its own I/O module; EEXIST drives the rename retry.
  write: writeNewFileExclusive,
};

// Write the bytes under `dirRel`, never clobbering: on EEXIST the name gets a
// ` (n)` suffix and we retry. Each candidate re-runs the containment check, so
// a rename can't walk the write out of the workspace either.
export async function writeUploadWithRename(
  dirRel: string,
  safeName: string,
  bytes: Buffer,
  deps: UploadWriteDeps = defaultUploadWriteDeps,
): Promise<{ ok: true; relPath: string; absPath: string } | { ok: false; status: number; message: string }> {
  for (let attempt = 0; attempt <= MAX_RENAME_ATTEMPTS; attempt += 1) {
    const relPath = uploadRelPath(dirRel, attempt === 0 ? safeName : renamedCandidate(safeName, attempt));
    const resolved = await deps.resolve(relPath);
    if (!resolved.ok) return { ok: false, status: resolved.status, message: resolved.message };
    try {
      await deps.write(resolved.absPath, bytes);
      // Hand back the resolver's realpath'd target: rebuilding it from
      // `workspaceReal + relPath` would skip symlink resolution and could stat
      // the wrong file (or nothing).
      return { ok: true, relPath, absPath: resolved.absPath };
    } catch (err) {
      if (!isErrorWithCode(err) || err.code !== "EEXIST") return { ok: false, status: 500, message: errorMessage(err) };
    }
  }
  return { ok: false, status: 409, message: "Could not find an unused filename" };
}

export function validateUploadBody(body: UploadFileBody): { ok: true; dir: string; safeName: string; bytes: Buffer } | { ok: false; message: string } {
  const { dir, filename, dataUrl } = body;
  if (typeof dir !== "string" || typeof filename !== "string" || typeof dataUrl !== "string") {
    return { ok: false, message: "dir, filename and dataUrl are required" };
  }
  // Reference roots are read-only mounts. The tree hides the drop affordance
  // for them, but that's UI, not enforcement — a direct POST must be refused
  // too, or `@ref/<label>/…` would resolve like any other folder. The bare
  // `@ref` segment has to go as well: it isn't a ref path by the prefix test,
  // yet writing into it produces `@ref/<file>`, which every other file API
  // then reads back as a reference path.
  // Compare on a POSIX-shaped path. `path.normalize` is host-dependent: on
  // Windows it rewrites "@ref/docs" to "@ref\docs", and the prefix test looks
  // for the literal "@ref/" — so normalising the host way would let a ref-root
  // upload through on Windows while blocking it on POSIX.
  const normalisedDir = path.posix.normalize(dir.replace(/\\/g, "/"));
  if (isRefPath(normalisedDir) || normalisedDir === REF_ROOT_SEGMENT) {
    return { ok: false, message: "Reference roots are read-only" };
  }
  const safeName = sanitizeUploadFilename(filename);
  if (safeName === null) return { ok: false, message: "Invalid filename" };
  if (BLOCKED_UPLOAD_EXTENSIONS.has(path.extname(safeName).toLowerCase())) return { ok: false, message: "File type not allowed" };
  const parsed = stripDataUri(dataUrl);
  if (!parsed) return { ok: false, message: "dataUrl must be a data: URI" };
  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, message: `File exceeds the ${MAX_UPLOAD_BYTES} byte upload limit` };
  return { ok: true, dir, safeName, bytes };
}

router.post(API_ROUTES.files.upload, async (req: Request<object, unknown, UploadFileBody>, res: Response<WriteContentResponse | ErrorResponse>) => {
  const validation = validateUploadBody(req.body);
  if (!validation.ok) {
    log.warn("files", "POST upload: rejected", { reason: validation.message });
    badRequest(res, validation.message);
    return;
  }
  const { dir, safeName, bytes } = validation;
  log.info("files", "POST upload: start", { pathPreview: previewSnippet(uploadRelPath(dir, safeName)), bytes: bytes.byteLength });

  const written = await writeUploadWithRename(dir, safeName, bytes);
  if (!written.ok) {
    sendError(res, written.status, written.message);
    return;
  }
  // Kept off `respondWithWrittenFile`: the success line reports the
  // decoded payload size the client sent, not the post-write stat that
  // the create / overwrite routes log.
  const fresh = await statSafeAsync(written.absPath);
  log.info("files", "POST upload: ok", { pathPreview: previewSnippet(written.relPath), bytes: bytes.byteLength });
  void publishFileChange(written.relPath);
  res.json({ path: written.relPath, size: fresh?.size ?? bytes.byteLength, modifiedMs: fresh?.mtimeMs ?? Date.now() });
});

router.put(API_ROUTES.files.content, async (req: Request<object, unknown, WriteContentRequest>, res: Response<WriteContentResponse | ErrorResponse>) => {
  const inputs = validateWriteRequestOr400(req.body, res, "PUT content");
  if (!inputs) return;
  const { relPath, content, bytes: contentBytes } = inputs;

  const resolved = await resolveExistingTextFile(relPath);
  if (!resolved.ok) {
    if (resolved.status === 404) notFound(res, resolved.message);
    else badRequest(res, resolved.message);
    return;
  }
  const jsonError = jsonSyntaxError(relPath, content);
  if (jsonError !== null) {
    log.warn("files", "PUT content: invalid JSON", { pathPreview: previewSnippet(relPath) });
    badRequest(res, jsonError);
    return;
  }
  try {
    await writeFileContent(resolved.absPath, content);
  } catch (err) {
    log.error("files", "PUT content: write threw", { pathPreview: previewSnippet(relPath), error: errorMessage(err) });
    serverError(res, "Failed to write file");
    return;
  }
  await respondWithWrittenFile(res, { absPath: resolved.absPath, relPath, fallbackBytes: contentBytes, logLabel: "PUT content" });
});

router.get(API_ROUTES.files.raw, (req: Request<object, unknown, unknown, PathQuery>, res: Response<ErrorResponse>) => {
  const requestedPath = getOptionalStringQuery(req, "path") ?? "";
  log.info("files", "GET raw: start", { pathPreview: previewSnippet(requestedPath) });
  const ctx = resolveAndStatFile(req, res);
  if (!ctx) {
    log.warn("files", "GET raw: gated by resolve/stat", { pathPreview: previewSnippet(requestedPath) });
    return;
  }
  const { absPath, stat } = ctx;

  const rawKind = classify(absPath);
  const rawSizeCap = rawKind === "audio" || rawKind === "video" ? MAX_MEDIA_BYTES : MAX_RAW_BYTES;
  if (stat.size > rawSizeCap) {
    log.warn("files", "GET raw: too large", { pathPreview: previewSnippet(requestedPath), bytes: stat.size, cap: rawSizeCap });
    sendError(res, 413, `File too large to stream (${stat.size} bytes, limit ${rawSizeCap})`);
    return;
  }
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mime);
  // Sandbox the response so an `.svg` / `.html` with embedded
  // JavaScript can't escape into the localhost:3001 origin via
  // direct navigation or <iframe>. PDFs (#1299) and audio / video
  // (#3437) get a narrower header set (no sandbox CSP) because a
  // browser cannot show them under it. See plans/done/
  // fix-files-raw-csp-sandbox.md for the full threat model.
  applyRawSecurityHeaders(res, mime);

  // Range support is required for `<video>` playback (Safari refuses
  // to play media without 206 responses) and for seek-past-buffered
  // in `<audio>`. When no Range header is sent we fall through to
  // the existing full-file pipe.
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const range = parseRange(rangeHeader, stat.size);
    if (!range) {
      // The media MIME was set above so the 206 success path
      // doesn't have to repeat it, but on a 416 we want JSON so
      // `res.json` doesn't lie about the body's content-type. Set
      // the Content-Range per RFC 7233 §4.4 before sending.
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Range", `bytes */${stat.size}`);
      sendError(res, 416, "Range not satisfiable");
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader("Content-Length", String(range.end - range.start + 1));
    pipeWithErrorHandling(createReadStream(absPath, { start: range.start, end: range.end }), res);
    return;
  }

  res.setHeader("Content-Length", String(stat.size));
  pipeWithErrorHandling(createReadStream(absPath), res);
});

// ── Reference directory roots ───────────────────────────────────
//
// Returns configured reference directories as top-level TreeNode[]
// for the file explorer. Each node's path uses the @ref/<label>
// prefix so subsequent /dir and /content requests route correctly.

// POST /api/files/open — spawn the host OS's default handler for a
// file. Backing the "Open in OS" button on the Files view's binary /
// unsupported preview so a `.xlsx` / `.pptx` reachable via the file
// tree can be viewed in Excel / Keynote when in-browser preview isn't
// available (#1985). Cross-platform: macOS `open`, Linux `xdg-open`,
// Windows `explorer.exe`. Workspace-scoped path validation same as
// every other files route.
interface OpenFileRequest {
  path?: unknown;
}

// Shared by the /open and /reveal routes: validate the workspace-scoped
// path, run the platform action, and map the spawn result to the JSON
// contract. Accepts `path` from body OR query so a swallowed body
// doesn't stop the button (belt + suspenders).
async function handleOsFileAction(
  req: Request<object, unknown, OpenFileRequest, PathQuery>,
  res: Response<{ ok: boolean } | ErrorResponse>,
  action: (absPath: string) => Promise<boolean>,
  failureMessage: string,
): Promise<void> {
  const bodyPath = typeof req.body?.path === "string" ? req.body.path : "";
  const queryPath = getOptionalStringQuery(req, "path") ?? "";
  const requestedPath = bodyPath || queryPath;
  if (!requestedPath) {
    badRequest(res, "path required");
    return;
  }
  const ctx = resolveAndStatFileByPath(requestedPath, res);
  if (!ctx) return;
  const spawned = await action(ctx.absPath);
  if (!spawned) {
    serverError(res, failureMessage);
    return;
  }
  res.json({ ok: true });
}

router.post(API_ROUTES.files.open, (req: Request<object, unknown, OpenFileRequest, PathQuery>, res: Response<{ ok: boolean } | ErrorResponse>) =>
  handleOsFileAction(req, res, openInHostOs, "Failed to launch OS file handler"),
);

// POST /api/files/reveal — open the file's containing folder in the
// host file manager (file selected on macOS / Windows) so a generated
// file can be dragged into another app (#1985 follow-up).
router.post(API_ROUTES.files.reveal, (req: Request<object, unknown, OpenFileRequest, PathQuery>, res: Response<{ ok: boolean } | ErrorResponse>) =>
  handleOsFileAction(req, res, revealInHostOs, "Failed to reveal file in OS file manager"),
);

router.get(API_ROUTES.files.refRoots, async (_req: Request, res: Response<TreeNode[]>) => {
  log.info("files", "GET ref-roots: start");
  const entries = getCachedReferenceDirs();
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    const stat = await statSafeAsync(entry.hostPath);
    if (!stat || !stat.isDirectory()) continue;
    // Same rule as `resolveRefPath`, so the explorer never lists a root whose
    // every child it would then refuse to open.
    if (resolveReferenceDir(entry.hostPath).kind !== "ok") continue;
    nodes.push({
      name: entry.label,
      path: `${REF_PREFIX}${entry.label}`,
      type: "dir",
      modifiedMs: stat.mtimeMs,
    });
  }
  log.info("files", "GET ref-roots: ok", { configured: entries.length, mounted: nodes.length });
  res.json(nodes);
});

export default router;
