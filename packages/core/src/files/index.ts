// Entry point for `@mulmoclaude/core/files` (server-only). The single source of
// truth for the safety-critical file primitives shared by the host, core, and
// plugins: atomic file I/O — tmp-write + rename, with the Windows retry loop —
// lives in exactly one place (#2399), and so does the realpath-based
// path-containment check (#2461). Internal-only helpers (isTransientRenameError,
// renameWithWindowsRetry) stay off this barrel and are imported from ./atomic by tests.
export { writeFileAtomic, writeFileAtomicSync, type WriteAtomicOptions } from "./atomic.js";
export { writeJsonAtomic } from "./json.js";
export { isEnoent, resolveWithinRoot } from "./safe.js";
// Check-then-use that survives a path swapped mid-call (#3573): reads prove the opened handle, writes verify their staging file.
export {
  openVerifiedWithinScope,
  writeFileVerifiedInScope,
  createFileVerifiedInScope,
  scopeRealpath,
  resolveExistingWithinRoot,
  realpathIfPresent,
  type VerifiedScope,
  type VerifiedFileHooks,
} from "./verified.js";
export { toPosixRelPath, joinPosixRelPath } from "./relPath.js";
export { canonicalRoot } from "./root.js";
// presentDocument / presentHtml's `path` argument: resolving a caller-supplied
// file path, and serving a page that is not an artifact. Both hosts share these
// so one tool call cannot mean two different things.
export { resolveByPath, existsAsFile, createByPathFileOps, MARKDOWN_EXTENSIONS, HTML_EXTENSIONS, type ByPathFileOps, type ByPathOptions } from "./byPath.js";
export { resolveHtmlFileRequestPath } from "./htmlFileRequest.js";
