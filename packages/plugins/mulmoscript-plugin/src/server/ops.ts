// Transport-free cores for every mulmoScript operation, moved from
// MulmoClaude's `server/api/routes/mulmo-script-ops.ts` in phase 3 so the
// SAME implementation backs every host surface:
//
//   - MulmoClaude's legacy REST routes (kept for wire compat),
//   - the generic plugin dispatch (see `./dispatch`) that the package View
//     calls in both MulmoClaude and MulmoTerminal.
//
// Every op returns an `OpResult` — failures are data (`code` preserves the
// HTTP mapping for REST adapters) and never exceptions. Generation ops
// publish start/finish through the instance's edge-triggered tracker, which
// fans out via the injected `backend.onGenerationEvent` (session channels,
// UI pubsub — host-specific) and backs the View's mount-time
// `pendingGenerations` snapshot.
//
// Host-specific transport is injected via `MulmoScriptServerBackend`; the
// mulmocast orchestration, realpath containment, and generation-state
// tracking all live here.

import { existsSync, mkdirSync, realpathSync, statSync, unlinkSync } from "fs";
import path from "path";
import type { FileOps } from "gui-chat-protocol";
import {
  getFileObject,
  initializeContextFromFiles,
  generateBeatImage,
  getBeatPngImagePath,
  generateBeatAudio,
  getBeatAudioPathOrUrl,
  getBeatAnimatedVideoPath,
  getBeatMoviePaths,
  MulmoBeatMethods,
  generateReferenceImage,
  getReferenceImagePath,
  images,
  audio,
  movie,
  movieFilePath,
  pdf,
  pdfFilePath,
  setGraphAILogger,
  addSessionProgressCallback,
  removeSessionProgressCallback,
} from "mulmocast";
// From mulmocast itself, which builds the context: @mulmocast/types inlines the deck slide types of its own build,
// so its copy drifts from mulmocast's whenever deck gains a layout (deck 2.1.0's `figure`).
import type { MulmoBeat, MulmoImagePromptMedia, MulmoStudioContext } from "mulmocast";
import { DEFAULT_ROOT, normalizeRoot } from "../core/contract";
import type { MulmoScriptGenerationEvent } from "../core/contract";
import { isAbsoluteStoryPath, normalizeStoryPath, STORY_TARGET_EXTENSIONS, storyRefWithin, storiesRelativePath } from "../core/paths";
import { errorMessage } from "@mulmoclaude/common";
import { isWithinRoot, resolveWithinRoot } from "@mulmoclaude/core/files";
import { fileToDataUri, stripDataUri } from "./support";
import { beatMovieCandidates } from "./beatMovieCandidates";
import { beatRendersWithoutFfmpeg } from "./beatRendersWithoutFfmpeg";
import { missingRootCapabilities } from "./types";
import { enableGraphAIErrorCapture, setMulmoErrorCaptureLogger, withMulmoErrorCapture } from "./mulmoErrorCapture";
import type {
  GenerateOpArgsWith,
  MovieGenerationResult,
  MovieProgressEvent,
  MulmoScriptServerBackend,
  MulmoScriptServerLog,
  OpFailure,
  OpResult,
  PdfGenerationResult,
} from "./types";

type GenerationKind = MulmoScriptGenerationEvent["kind"];

// We pin pdfMode="slide" + pdfSize="a4" — that's the configured default
// for the storyboard editor; mulmocast's other modes (talk / handout /
// letter) stay reachable via the CLI for power users. (#1614)
export const PDF_MODE = "slide" as const;
export const PDF_SIZE = "a4" as const;

function opBadRequest(error: string): OpFailure {
  return { ok: false, code: "bad_request", error };
}

function opNotFound(error: string): OpFailure {
  return { ok: false, code: "not_found", error };
}

function opServerError(error: string): OpFailure {
  return { ok: false, code: "server_error", error };
}

const NOOP_LOG: MulmoScriptServerLog = { info: () => {}, warn: () => {}, error: () => {} };

// Helper: build mulmo context for a story file. The explicit return
// annotation keeps declaration emit portable — the inferred type would
// reference mulmocast's internal usage-collector path.
export async function buildContext(absoluteFilePath: string, force = false): Promise<MulmoStudioContext | null | undefined> {
  // setGraphAILogger(false) silences GraphAI's chatty info/debug output
  // but also its error level — re-enable error capture so a failed
  // generation surfaces the real provider error, not just mulmocast's
  // generic "generate error" wrapper.
  setGraphAILogger(false);
  enableGraphAIErrorCapture();
  const files = getFileObject({
    file: absoluteFilePath,
    basedir: path.dirname(absoluteFilePath),
    grouped: true,
  });
  return initializeContextFromFiles(files, true, force);
}

// Awaited context type used by every op that calls buildContext.
export type StoryContext = NonNullable<Awaited<ReturnType<typeof buildContext>>>;

export interface RunStoryOpDeps {
  resolveStory?: (filePath: string, root?: string) => { ok: true; absolutePath: string } | OpFailure;
  buildContext?: (absoluteFilePath: string, force?: boolean) => Promise<StoryContext | undefined>;
}

export interface RunStoryOpOptions<T> {
  force?: boolean | undefined;
  /** Which registered stories root `filePath` is relative to (#3014).
   *  Absent = the host's default root, i.e. exactly the pre-roots path. */
  root?: string | undefined;
  /**
   * Op-specific tag included in the failure log so dashboards can
   * distinguish which op is failing (e.g. `"generate-beat-audio"`).
   * Falls back to a generic `"op failed"` entry when omitted.
   */
  operation?: string;
  /**
   * Soft-fail override for `buildContext` returning undefined. Some
   * ops (e.g. `beatAudio`) historically returned a 200 `{ audio: null }`
   * in that case so the frontend can silently retry. If provided, this
   * callback returns the fallback result instead of the default
   * server_error "Failed to initialize mulmo context".
   */
  onContextMissing?: () => OpResult<T>;
}

// Map each beat to its array index, keyed by beat.id (falling back to
// a synthetic `__index__<n>` for id-less beats). Shared by the movie
// and PDF pipelines to translate mulmocast's per-beat progress events
// (which carry the beat id) back into an index the UI can address.
export function buildBeatIdIndex(beats: MulmoBeat[]): Map<string, number> {
  const idToIndex = new Map<string, number>();
  beats.forEach((beat, index) => {
    const key = beat.id ?? `__index__${index}`;
    idToIndex.set(key, index);
  });
  return idToIndex;
}

// Run `body` with a mulmocast per-beat progress callback registered.
// `onBeat` receives each beat event's sessionType + resolved index; the
// caller decides which sessionTypes to forward. The callback is always
// unregistered, even when `body` throws.
//
// Known limitation: addSessionProgressCallback is global, so when two
// generations for *different* scripts run concurrently, both closures
// are invoked for every beat event and rely on idToIndex to filter out
// the other run's events. That filter is reliable only when each beat
// carries an explicit `id`. Beats without one fall back to
// "__index__${index}", and identical fallback ids across scripts collide
// → progress meant for script A surfaces on script B. Fixing this
// properly needs mulmocast to attach a per-run identifier to its
// progress events (or a global serialization gate); tracked separately.
async function withBeatProgress<T>(beats: MulmoBeat[], onBeat: (sessionType: string, beatIndex: number) => void, body: () => Promise<T>): Promise<T> {
  const idToIndex = buildBeatIdIndex(beats);
  const onProgress = (event: { kind: string; sessionType: string; id?: string; inSession: boolean }) => {
    if (event.kind !== "beat" || event.inSession || event.id === undefined) return;
    const beatIndex = idToIndex.get(event.id);
    if (beatIndex === undefined) return;
    onBeat(event.sessionType, beatIndex);
  };
  addSessionProgressCallback(onProgress);
  try {
    return await body();
  } finally {
    removeSessionProgressCallback(onProgress);
  }
}

/** Map identity for the in-flight tracker. JSON array keeps the three
 *  fields unambiguous (a human-visible delimiter could collide). */
function generationMapKey(kind: GenerationKind, filePath: string, key: string, root?: string): string {
  // Normalised HERE rather than by the caller. A start keyed `" repoA "` and a
  // finish keyed `"repoA"` never match, and the tracker entry then leaks for
  // the life of the process — so the one place that builds the key is the one
  // place that must not be able to get the spelling wrong (Codex on #3015).
  const normalized = normalizeRoot(root);
  // `root` is the LAST element so a call site that omits it produces exactly
  // the pre-#3014 key — the default root's entries keep their identity across
  // an upgrade, and a running generation is not orphaned by one.
  return normalized === DEFAULT_ROOT ? JSON.stringify([kind, filePath, key]) : JSON.stringify([kind, filePath, key, normalized]);
}

/**
 * Build the per-host mulmoScript server ops instance. One instance per
 * process — it owns the in-flight movie/PDF dedup sets and the
 * generation-state tracker, and binds the injected host backend.
 */
export function createMulmoScriptServerOps(backend: MulmoScriptServerBackend) {
  const log = backend.log ?? NOOP_LOG;
  setMulmoErrorCaptureLogger(log);
  // Root registry: the default (pre-#3014, wire `root` absent) plus whatever
  // the host registered. Resolved once — the host owns the ids, this package
  // only ever looks them up.
  const rootDirs = new Map<string, string>([[DEFAULT_ROOT, path.resolve(backend.storiesDir)]]);
  for (const [id, dir] of Object.entries(backend.extraRoots ?? {})) {
    // An empty id is the default root's own key: accepting it would re-point
    // every pre-roots caller at someone else's directory. Dropping it quietly
    // would hide the host's misconfiguration until a read returned the wrong
    // file, and this runs at boot, where throwing is the cheap failure.
    // Trim on registration too: a lookup normalizes, so an untrimmed key would
    // be unreachable.
    const trimmed = id.trim();
    if (trimmed === DEFAULT_ROOT) {
      throw new Error("mulmoScript: extraRoots key must not be empty — the empty id is reserved for the default stories root");
    }
    // Two ids that trim to one key: `set` would silently keep the LAST
    // directory, so every read for `repoA` would answer from a directory the
    // card never named, with the host given no signal (CodeRabbit on #3015).
    // Same reasoning as the empty id above — a misconfiguration is cheapest to
    // fail on at boot, and silently resolving the wrong directory is the
    // failure this package refuses everywhere else.
    if (rootDirs.has(trimmed)) {
      throw new Error(`mulmoScript: extraRoots keys must be distinct after trimming — "${trimmed}" is registered twice`);
    }
    rootDirs.set(trimmed, path.resolve(dir));
  }
  warnAboutUnwiredRoots();

  /**
   * Tell a host which named-root capabilities it has not wired — and nothing
   * when it has wired them all.
   *
   * The condition used to be the root COUNT alone, so a host that had passed
   * `artifactsFor` was still told, at every boot, that its writes land in the
   * default root. That is not a stale wording: it is the opposite of what the
   * code then does, read by the hosts that got the wiring RIGHT (#3022, from
   * the consuming host).
   *
   * Silence when nothing is missing, because a warning that always fires is
   * one people learn to skip — and then the host that really did forget
   * `artifactsFor` cannot tell either. Each clause is emitted only when that
   * capability is actually absent, so the message says what is true for THIS
   * host rather than what was true when it was written.
   */
  function warnAboutUnwiredRoots(): void {
    if (rootDirs.size <= 1) return;
    const missing = missingRootCapabilities(backend);
    if (missing.length === 0) return;
    log.warn(`extra stories roots registered — reads and uploads work, but ${missing.join(", and ")} (#3019)`, {
      roots: [...rootDirs.keys()].filter((id) => id !== DEFAULT_ROOT),
    });
  }

  /** The registered directory for a wire `root`, or null when the host never
   *  registered it. Null is a REJECTION, not a fallback to the default: an
   *  unknown root must not quietly read the workspace's file of the same
   *  name. */
  function rootDir(root: string | undefined): string | null {
    return rootDirs.get(normalizeRoot(root)) ?? null;
  }

  // ── Story path infrastructure ─────────────────────────────────

  // The download / status ops expect "stories/<rel>" (historical
  // convention, independent of the on-disk location) — the wire format
  // every endpoint keys on. Relativize against the REALPATH root when it
  // resolves: with a symlinked stories dir, mulmocast returns output
  // paths under the link's target, and relativizing against the link
  // itself would produce a traversal-like "stories/../../…" ref that
  // resolveStory then rejects (CodeRabbit on #2137).
  function toStoryRef(absolutePath: string, root?: string): string | null {
    // An unregistered root gets null, not the default root's base. Relativizing
    // against the default would mint a wire ref that READS BACK as a different
    // file — the same silent-substitution failure `resolveStory` rejects, and
    // this function is on the ops object, so a host can reach it directly
    // without passing through that guard (#3015 review F2).
    const dir = rootDir(root);
    if (dir === null) return null;
    const base = ensureStoriesReal(root) ?? dir;
    // The relativizing rule is a pure function in `core/paths.ts` so it can be
    // driven with `path.win32` from a POSIX machine — the case it guards
    // (no relative route across drives) is unreachable here.
    return storyRefWithin(base, absolutePath, path);
  }

  /**
   * The wire ref for an artifact mulmocast generated FROM `wireFilePath`
   * (movie, per-beat clip, PDF).
   *
   * mulmocast derives every output path from the script's own directory
   * (`buildContext` passes `basedir: path.dirname(absoluteFilePath)`), so an
   * absolute script's outputs live outside the stories dir and have no
   * `stories/<rel>` spelling. They travel as absolute paths — the same form
   * their script arrived in, which `resolveStory` reads back unchanged.
   * A relative script keeps minting relative refs, byte for byte as before.
   */
  function outputRef(outputPath: string, wireFilePath: string, root?: string): string | null {
    return path.isAbsolute(wireFilePath) ? outputPath : toStoryRef(outputPath, root);
  }

  // Lazily realpath the stories dir on first use. We can't realpath at
  // instance creation because the directory may not exist yet (it's
  // created on demand by the save route). The cache is invalidated
  // never — once the dir exists, its realpath is stable.
  //
  // Keyed by the resolved DIRECTORY rather than the root id, so there is no
  // normalisation left to forget: `rootDir` already collapses every spelling of
  // a root to one absolute path, and two ids pointing at the same directory
  // share one entry instead of allocating a second. Keying on the raw id let
  // `" repoA "` and `"repoA"` both resolve and then cache separately, in a map
  // that is never evicted (Codex P2 on #3015).
  const storiesRealCache = new Map<string, string>();
  function ensureStoriesReal(root?: string): string | null {
    const dir = rootDir(root);
    if (dir === null) return null;
    const cached = storiesRealCache.get(dir);
    if (cached) return cached;
    try {
      // Only the DEFAULT root is created on demand. An extra root is a
      // directory the user already owns — often a git worktree — and creating
      // it here would grow `artifacts/stories/` inside their repository as a
      // side effect of a status poll. A host that registers a root is
      // responsible for it existing (#3015 review F3).
      if (normalizeRoot(root) === DEFAULT_ROOT) mkdirSync(dir, { recursive: true });
      const real = realpathSync(dir);
      storiesRealCache.set(dir, real);
      return real;
    } catch {
      return null;
    }
  }

  /**
   * Resolve an ABSOLUTE wire path — a script the caller named outside the
   * stories dir, or one of the artifacts mulmocast generated beside it.
   *
   * Deliberately NOT containment-checked, for the reason spelled out on
   * `isAbsoluteStoryPath`: opening a file the caller named is the purpose of
   * the form, and the agent can already read and write those files directly.
   * What IS checked mirrors `@mulmoclaude/core/files`' byPath ops:
   *   - the lexical shape (no NUL, no `.` / `..` / empty segment, and one of
   *     the extensions this package mints or accepts), so a vetted path cannot
   *     be re-pointed later;
   *   - a real REGULAR FILE, judged through `realpath` so a symlink is
   *     assessed by what it points at and a directory named `deck.json` cannot
   *     masquerade as a script.
   *
   * The media extensions widen the same way, which is what makes the download
   * routes able to serve an absolute script's movie / clip / PDF. That is a
   * deliberate consequence, not an oversight: those routes sit behind the same
   * bearer auth as every other `/api` route, and a caller holding that token
   * can already have presentDocument read any `.md` and presentHtml any
   * `.html`. The boundary is the token, not the directory.
   */
  function resolveAbsoluteStory(filePath: string): { ok: true; absolutePath: string } | OpFailure {
    // `backend.byPath` is the host's OPT-IN to the absolute form, and it gates
    // the whole of it — not just the core's read/write. Without it these ops
    // (generation, status, probes, download) would keep serving absolute paths
    // that the core itself refuses, so a host that never opted in would have
    // the capability anyway through the half of the package that does not
    // consult it (Sourcery on #3042). Refusing here restores the pre-existing
    // behaviour EXACTLY: absolute paths were `bad_request "Invalid filePath"`.
    if (!backend.byPath) {
      return opBadRequest("Invalid filePath");
    }
    if (!isAbsoluteStoryPath(filePath, STORY_TARGET_EXTENSIONS)) {
      return opBadRequest("Invalid filePath");
    }
    let target: string;
    try {
      target = realpathSync(path.resolve(filePath));
    } catch {
      return opNotFound(`File not found: ${filePath}`);
    }
    try {
      if (!statSync(target).isFile()) return opBadRequest("Invalid filePath");
    } catch {
      return opNotFound(`File not found: ${filePath}`);
    }
    // The extension is re-checked on the RESOLVED target, not just the
    // spelling that arrived: a symlink named `deck.json` may point at any
    // regular file, and the download routes stream `absolutePath` straight to
    // the client — so checking only the link's own name would let `deck.json`
    // → `/etc/passwd` through the very gate that exists to stop it
    // (CodeRabbit CWE-59 on #3042). Judging the link by what it points at is
    // the same rule the regular-file check above already applies.
    if (!isAbsoluteStoryPath(target, STORY_TARGET_EXTENSIONS)) {
      return opBadRequest("Invalid filePath");
    }
    return { ok: true, absolutePath: target };
  }

  /**
   * Resolve and validate a RELATIVE stories wire path to its absolute
   * realpath (absolute wire paths are handed to `resolveAbsoluteStory`).
   *
   * Uses the realpath-based resolveWithinRoot helper to defeat
   * symlink-based escapes. Callers pass wire paths like
   * "stories/foo.json" or "stories/__movies__/bar.mp4". We strip the
   * leading "stories/" segment and resolve the remainder against the
   * realpath of the stories directory itself — this works whether
   * stories/ is a regular directory or a legitimate symlink to another
   * location. ENOENT and traversal are distinguished (404 vs 400).
   */
  function resolveStory(filePath: string, root?: string): { ok: true; absolutePath: string } | OpFailure {
    // An ABSOLUTE path names a script (or one of its generated artifacts)
    // living outside the stories dir, and is taken as named — the same rule
    // `presentDocument` / `presentHtml` apply to their `path` argument
    // (`@mulmoclaude/core/files`). Answered BEFORE the root checks below
    // because an absolute path is relative to nothing: there is no root for it
    // to be resolved against, so neither an unregistered root nor a stories
    // dir that cannot be realpathed has any bearing on it.
    //
    // A value that is absolute only under ANOTHER platform's rules
    // (`C:\\proj\\x.json` on POSIX) is NOT absolute here, and falls through to
    // the relative rules, which reject it — resolving it would land it under
    // the stories dir, a file nobody named.
    if (path.isAbsolute(filePath)) {
      return resolveAbsoluteStory(filePath);
    }
    // An unregistered root is a bad request, not a fall back to the default:
    // resolving it against the workspace would hand the caller a DIFFERENT
    // file that happens to share the name.
    if (rootDir(root) === null) {
      return opBadRequest("Unknown stories root");
    }
    const storiesReal = ensureStoriesReal(root);
    if (!storiesReal) {
      return opServerError("stories directory not available");
    }
    // Accept the workspace-relative spelling "artifacts/stories/<rel>"
    // the tool description historically taught (the wire form was truly
    // workspace-relative before the stories dir moved under artifacts/
    // in #284) by reducing it to the canonical "stories/<rel>".
    const ARTIFACTS_STORIES = "artifacts/stories";
    const wirePath = filePath === ARTIFACTS_STORIES || filePath.startsWith(`${ARTIFACTS_STORIES}/`) ? filePath.slice("artifacts/".length) : filePath;
    // Strip the optional "stories/" prefix so the remainder is a path
    // relative to storiesReal. Accepts both "stories/foo.json" (the
    // canonical caller convention) and bare "foo.json".
    const STORIES_PREFIX = `stories${path.sep}`;
    const relFromStories =
      wirePath === "stories" ? "" : wirePath.startsWith(STORIES_PREFIX) || wirePath.startsWith("stories/") ? wirePath.slice("stories/".length) : wirePath;
    // A base path with no remainder ("stories", "artifacts/stories",
    // trailing-slash variants) would resolve to the stories directory
    // itself and hand downstream ops a directory where they expect a
    // file — reject it, mirroring normalizeStoryPath's non-empty rule.
    if (relFromStories === "") {
      return opBadRequest("Invalid filePath");
    }
    // resolveWithinRoot enforces both the realpath boundary AND
    // existence; ENOENT and traversal both produce null. Distinguish
    // them via a follow-up existsSync so 404 vs 400 stays accurate —
    // but only consult the filesystem for lexically in-root candidates:
    // a traversal path must never touch the fs (and gets a uniform
    // bad_request so responses don't leak existence outside the root).
    const resolved = resolveWithinRoot(storiesReal, relFromStories);
    if (!resolved) {
      const candidate = path.resolve(storiesReal, relFromStories);
      if (isWithinRoot(storiesReal, candidate) && !existsSync(candidate)) {
        return opNotFound(`File not found: ${filePath}`);
      }
      return opBadRequest("Invalid filePath");
    }
    return { ok: true, absolutePath: resolved };
  }

  /**
   * Whether this root is one the host registered.
   *
   * Every other root-aware op learns this from `resolveStory`, which needs a
   * file. `pendingGenerations` needs none — it only filters an in-memory map —
   * so an unregistered root produced `{ ok: true, pending: [] }`, and a host
   * typo or a stale card read back as "no work is running" (Codex P2 on
   * #3015). An unknown root is a question this package cannot answer, and the
   * answer it must not give is a confident empty one.
   */
  function guardStoryRootRegistered(root: string | undefined): OpFailure | null {
    return rootDir(root) === null ? opBadRequest(`unknown stories root "${normalizeRoot(root)}"`) : null;
  }

  /**
   * Realpath containment pre-guard for wire paths handed to the phase-1
   * core's save/reopen/update executes. The core's own path guard is
   * lexical (it runs against the generic FileOps, whose read/write follows
   * symlinks), so hosts re-assert the realpath boundary here before
   * invoking it — a symlink planted below the stories dir can't read or
   * write outside the tree (Codex P1 on MulmoClaude#2133).
   *
   * For an ABSOLUTE `filePath` there is no tree to stay inside — the form
   * exists precisely to name a file elsewhere — so what this asserts there is
   * `resolveAbsoluteStory`'s pair: the lexical shape, and a real regular file
   * behind the realpath. The core's `locate` reaches the same verdict through
   * `isAbsoluteStoryPath`, which is why the two are one function.
   *
   * Returns null when `filePath` isn't a non-empty string — shape
   * validation (including the script-vs-filePath mode check) belongs to
   * the core.
   */
  function guardStoryWirePath(filePath: unknown, root?: string): OpFailure | null {
    if (typeof filePath !== "string" || filePath === "") return null;
    const resolved = resolveStory(filePath, root);
    return resolved.ok ? null : resolved;
  }

  /**
   * Whether a GENERATION may run in this root.
   *
   * The pair identity is complete inside this package but stops at the host
   * boundary: a host's per-session store keys pending work by
   * `(kind, filePath, key)` — `generationKey` in `@mulmobridge/protocol`,
   * which bridges also consume. Two roots running the same generation in one
   * session would collapse to one entry, and either completion would clear the
   * other root's indicator (Codex P1 on #3015).
   *
   * Whose hazard it is decides who answers: a host declares
   * `rootScopedGenerationState` when its own pending state carries the root —
   * or when it keeps none, which is MulmoTerminal's case. It was refused for a
   * collision it cannot have (#3019).
   *
   * Absent still refuses, so a host that has not thought about this keeps the
   * shipped behaviour rather than being quietly opened up.
   */
  function guardStoryGenerationRoot(root: string | undefined): OpFailure | null {
    if (normalizeRoot(root) === DEFAULT_ROOT) return null;
    // Registration BEFORE the host's opt-in. The flag says "this host can tell
    // two roots apart", not "any id is addressable" — and the generation ops
    // publish their start event before `runStoryOp` reaches `resolveStory`, so
    // an unregistered root emitted a start/finish pair for work that never
    // existed (Codex + CodeRabbit on #3020).
    const registered = guardStoryRootRegistered(root);
    if (registered) return registered;
    if (backend.rootScopedGenerationState === true) return null;
    return opBadRequest("generating in a non-default stories root is not supported yet");
  }

  /**
   * The write half of the same fail-closed rule.
   *
   * It lives in the ops that write rather than at their dispatch sites,
   * because a per-site guard is a list someone has to remember to extend:
   * `save` / `updateBeat` / `updateScript` were guarded and the two upload
   * kinds were not, so an image could still land in a named root
   * (CodeRabbit on #3015). `save` / `update* ` cannot follow suit — they run
   * through the package executors, not through these ops — so
   * `test_server_roots.ts` walks the whole ops surface and fails on any op
   * that is neither in the read-only allowlist nor refusing.
   */
  /**
   * Whether a WRITE may target this root.
   *
   * Reads are root-aware; writes are not. `executeMulmoScriptSave` and the
   * update executors run against one `FileOps`, bound by the host to the
   * default root, so a write naming another root would rewrite the DEFAULT
   * root's identically-named file and then announce the other one as changed
   * (#3015 review G1). Closing it was fail-closed: "readable but not yet
   * writable" beats "wrote somewhere else and said so".
   *
   * It opens per root, not globally: the host answers `artifactsFor` for the
   * roots it can serve, and a root it cannot is still refused. A host that
   * wires nothing keeps the shipped refusal (#3019).
   *
   * The two refusals say different things because they are fixed in different
   * places. No `artifactsFor` at all is a capability this host has not turned
   * on. `artifactsFor` present but answering `null` for a REGISTERED root is a
   * wiring mistake inside that host — and it is the quiet one, because the
   * boot warning stays silent (the resolver WAS passed) while every write is
   * refused. One message for both read as "the plugin cannot do this yet",
   * which sends the host looking in the wrong place (#3024).
   */
  function guardStoryWriteRoot(root: string | undefined): OpFailure | null {
    if (normalizeRoot(root) === DEFAULT_ROOT) return null;
    const registered = guardStoryRootRegistered(root);
    if (registered) return registered;
    if (artifactsForRoot(root) !== null) return null;
    return backend.artifactsFor === undefined
      ? opBadRequest("writing to a non-default stories root is not supported yet")
      : opBadRequest(`this host's \`artifactsFor\` returned no FileOps for the registered stories root "${normalizeRoot(root)}"`);
  }

  /**
   * The FileOps a write to this root must go through.
   *
   * The default root keeps the single `artifacts` it always had, byte for
   * byte. A named root is served only when the host both REGISTERED it
   * (`extraRoots` — the containment boundary, so a host cannot widen the
   * addressable set through this back door) and can supply a FileOps for it.
   */
  function artifactsForRoot(root: string | undefined): FileOps | null {
    const normalized = normalizeRoot(root);
    if (normalized === DEFAULT_ROOT) return backend.artifacts;
    if (rootDir(normalized) === null) return null;
    const hostOps = backend.artifactsFor?.(normalized);
    return hostOps === undefined || hostOps === null ? null : storiesScoped(hostOps);
  }

  /**
   * Address a named root's FileOps the way the READ side addresses it.
   *
   * The two sides disagreed about one path segment, and the disagreement was
   * silent. A read strips `stories/` and resolves under the registered
   * directory (`<root>/<rel>`); a write handed the executors' wire path
   * straight to the host's FileOps, which is rooted at that same registered
   * directory, so the bytes landed in `<root>/stories/<rel>`. `save` then
   * REPORTED SUCCESS and returned a wire path that could not be read back —
   * a card pointing at nothing (#3020 review H1, from the consuming host).
   *
   * Stripping here makes "the directory you registered is the directory your
   * FileOps is rooted at" true, which is what a host writes without being
   * told. The default root is untouched: its FileOps is rooted one level up,
   * at `<workspace>/artifacts`, and is shared with other plugins.
   *
   * A path that is not a stories wire path throws rather than passing
   * through. Everything reaching here has been through `normalizeStoryPath`
   * or `storyFilePath`, so one that has not is a bug — and letting it through
   * would write it somewhere nobody can read, which is the failure this whole
   * wrapper exists to end.
   */
  function storiesScoped(inner: FileOps): FileOps {
    const within = (wirePath: string): string => {
      const relative = storiesRelativePath(wirePath);
      if (relative === null) throw new Error(`mulmoScript: "${wirePath}" is not a stories path — a named root's FileOps takes stories paths only`);
      return relative;
    };
    // Every member is `async` so the refusal arrives as a REJECTED PROMISE,
    // the way every other FileOps failure does. Throwing synchronously out of
    // a method the caller only ever awaits would skip its `try`.
    return {
      read: async (wirePath) => inner.read(within(wirePath)),
      readBytes: async (wirePath) => inner.readBytes(within(wirePath)),
      write: async (wirePath, data) => inner.write(within(wirePath), data),
      readDir: async (wirePath) => inner.readDir(within(wirePath)),
      stat: async (wirePath) => inner.stat(within(wirePath)),
      exists: async (wirePath) => inner.exists(within(wirePath)),
      unlink: async (wirePath) => inner.unlink(within(wirePath)),
    };
  }

  // mulmocast shells out to ffmpeg for movies and movie beats. When the
  // host's probe reports it absent, intercept with a clear failure
  // instead of letting the library throw an opaque spawn ENOENT
  // mid-pipeline. `undefined` means the probe hasn't completed — assume
  // available so a brief startup window never blocks a render.
  function ffmpegGuard(): OpFailure | null {
    if (backend.isFfmpegAvailable?.() === false) {
      return {
        ok: false,
        code: "unavailable",
        error: "ffmpeg is not installed — movies, and beats that make or use a movie, cannot be rendered. Install ffmpeg and restart the server.",
      };
    }
    return null;
  }

  // ── Generation tracker (edge-triggered) ───────────────────────

  // Refcounted: two concurrent generations with the same kind/filePath/key
  // (e.g. the same beat rendered from two tabs) must not have the first
  // completion erase the second run's snapshot entry, and only the first
  // start / LAST finish reach the host channels — an early completion
  // can't clear subscribers' spinners while a duplicate run is active.
  // A finish with no tracked start (the movie/PDF pipelines' per-beat
  // completion pulses) always publishes.
  const inFlightGenerations = new Map<string, { kind: GenerationKind; filePath: string; key: string; root: string; count: number }>();

  /** Emit `root` only when it names a non-default one: an event carrying
   *  `root: ""` and one carrying nothing must stay indistinguishable to every
   *  pre-#3014 consumer. */
  function rootField(root: string | undefined): { root?: string } {
    const normalized = normalizeRoot(root);
    return normalized === DEFAULT_ROOT ? {} : { root: normalized };
  }

  /** Tracker state and events key on the canonical `stories/<rel>` wire
   *  form: subscribers (the View's pubsub filter, `pendingGenerations`
   *  callers) match by exact string, so the accepted alias spellings
   *  (`artifacts/stories/<rel>`, bare `<rel>`) must collapse to the same
   *  key as the canonical one (Codex P2 on #2139). An ABSOLUTE path is
   *  already its own canonical form — `normalizeStoryPath` refuses it, and
   *  passing it through unchanged is exactly right, because it has no
   *  stories-relative spelling to collapse to. Untrusted spellings pass
   *  through too: they never resolve, so they can't collide. */
  function canonicalWirePath(filePath: string): string {
    return normalizeStoryPath(filePath) ?? filePath;
  }

  /**
   * `error` and `root` travel in an options object, NOT as two trailing
   * optional positionals.
   *
   * They were positional once, and appending `root` to the sixteen call sites
   * put it in `error`'s slot at the nine that pass no error: every start event
   * carried `error: "<root>"`, the root was dropped from the key, the tracker
   * entry was filed under the default root — and because the matching finish
   * DID pass both, its key differed and the entry was never deleted, leaking
   * one row per generation for the life of the process. Two adjacent optional
   * strings cannot be told apart by the type checker, so the shape is the only
   * thing that can prevent it (#3015 review).
   */
  function publishGeneration(
    chatSessionId: string | undefined,
    kind: GenerationKind,
    filePath: string,
    key: string,
    finished: boolean,
    opts: { error?: string | undefined; root?: string | undefined } = {},
  ): void {
    const { error, root } = opts;
    const wirePath = canonicalWirePath(filePath);
    // The NORMALIZED root, not the raw spelling. The tracker value and the
    // emitted event both normalize, so keying on the raw text made a start
    // written `" repoA "` and its finish written `"repoA"` two entries: the
    // finish deleted nothing and the start leaked (Codex P2 on #3015).
    const mapKey = generationMapKey(kind, wirePath, key, root);
    const existing = inFlightGenerations.get(mapKey);
    if (finished) {
      if (existing && existing.count > 1) {
        existing.count -= 1;
        return; // a duplicate run is still active — suppress the early finish
      }
      inFlightGenerations.delete(mapKey);
    } else {
      if (existing) {
        existing.count += 1;
        return; // already reported as started
      }
      inFlightGenerations.set(mapKey, { kind, filePath: wirePath, key, root: normalizeRoot(root), count: 1 });
    }
    const event: MulmoScriptGenerationEvent = {
      kind,
      filePath: wirePath,
      key,
      done: finished,
      ...(error ? { error } : {}),
      ...rootField(root),
    };
    backend.onGenerationEvent?.(chatSessionId, event);
  }

  /**
   * Tell every open View that this script was written.
   *
   * `origin` is the writer. A View passes its own id so it can ignore the echo of its own
   * save — reloading there would rebuild the element the caret is in, mid-keystroke. A write
   * from the agent carries no origin, so everyone reloads.
   */
  function publishScriptChanged(filePath: string, origin?: string, root?: string): void {
    backend.onScriptChanged?.({
      filePath: canonicalWirePath(filePath),
      ...(origin === undefined ? {} : { origin }),
      ...rootField(root),
    });
  }

  /**
   * Snapshot of generations currently in flight for one script — the View's
   * mount-time catch-up.
   *
   * Filtered on the PAIR. Filtering on `filePath` alone hands a View watching
   * `repoB/stories/deck.json` the run started for `repoA`'s identically-named
   * deck, and the caller cannot discard it because the returned event would
   * carry no root either (Codex P1 / CodeRabbit on #3015).
   */
  function pendingGenerations(filePath: string, root?: string): MulmoScriptGenerationEvent[] {
    const wirePath = canonicalWirePath(filePath);
    const wanted = normalizeRoot(root);
    return [...inFlightGenerations.values()]
      .filter((entry) => entry.filePath === wirePath && entry.root === wanted)
      .map(({ kind, key }) => ({ kind, filePath: wirePath, key, done: false, ...rootField(root) }));
  }

  // ── Op scaffolding ────────────────────────────────────────────

  /**
   * Shared scaffolding for mulmoScript ops. Resolves the wire filePath,
   * builds the mulmo context, and folds unexpected handler errors into a
   * server_error failure (with a warn breadcrumb). Accepts a `deps` param
   * so unit tests can inject fakes without the full mulmocast stack.
   */
  async function runStoryOp<T>(
    filePath: string,
    options: RunStoryOpOptions<T>,
    handler: (ctx: { absoluteFilePath: string; context: StoryContext }) => Promise<OpResult<T>>,
    deps: RunStoryOpDeps = {},
  ): Promise<OpResult<T>> {
    const resolver = deps.resolveStory ?? resolveStory;
    const build = deps.buildContext ?? buildContext;
    const resolved = resolver(filePath, options.root);
    if (!resolved.ok) return resolved;
    try {
      const context = await build(resolved.absolutePath, options.force ?? false);
      if (!context) {
        if (options.onContextMissing) return options.onContextMissing();
        return opServerError("Failed to initialize mulmo context");
      }
      // withMulmoErrorCapture appends the underlying provider error
      // (missing API key, quota, …) to any mulmocast failure, which
      // otherwise reaches the client as a generic "generate error".
      return await withMulmoErrorCapture(() => handler({ absoluteFilePath: resolved.absolutePath, context }));
    } catch (err) {
      // Log every op failure at warn so operators get a breadcrumb even
      // when the op doesn't wrap its own try/catch.
      log.warn("op failed", {
        ...(options.operation ? { operation: options.operation } : {}),
        filePath,
        error: errorMessage(err),
      });
      return opServerError(errorMessage(err));
    }
  }

  // ── Probe ops ─────────────────────────────────────────────────

  async function beatImageOp(filePath: string, beatIndex: number, root?: string): Promise<OpResult<{ image: string | null }>> {
    return runStoryOp<{ image: string | null }>(filePath, { operation: "beat-image", root }, async ({ context }) => {
      const { imagePath } = getBeatPngImagePath(context, beatIndex);
      if (!existsSync(imagePath)) return { ok: true, image: null };
      return { ok: true, image: await fileToDataUri(imagePath, "image/png") };
    });
  }

  // beatAudio is a probe — the frontend polls it expecting `{ audio: null }`
  // when nothing has been generated yet. Override the default
  // server_error-on-context-missing so the soft-fail contract is preserved.
  async function beatAudioOp(filePath: string, beatIndex: number, root?: string): Promise<OpResult<{ audio: string | null }>> {
    return runStoryOp<{ audio: string | null }>(
      filePath,
      { operation: "beat-audio", root, onContextMissing: () => ({ ok: true, audio: null }) },
      async ({ context }) => {
        const beat = context.studio.script.beats[beatIndex];
        // Probe contract: a beat index the script doesn't have soft-fails
        // like a beat with nothing generated yet, never a server error.
        if (!beat) return { ok: true, audio: null };
        const audioPath = getBeatAudioPathOrUrl(beat.text ?? "", context, beat, context.lang);
        if (!audioPath || !existsSync(audioPath)) return { ok: true, audio: null };
        return { ok: true, audio: await fileToDataUri(audioPath, "audio/mpeg") };
      },
    );
  }

  // Probe for a beat's generated video clip. The response is the
  // "stories/…" wire path so the client can stream it through the host's
  // authenticated media download.
  async function beatMovieOp(filePath: string, beatIndex: number, root?: string): Promise<OpResult<{ moviePath: string | null }>> {
    return runStoryOp<{ moviePath: string | null }>(filePath, { operation: "beat-movie", root }, async ({ context }) => {
      const beat = context.studio.script.beats[beatIndex];
      const paths = { ...getBeatMoviePaths(context, beatIndex), animatedVideoFile: getBeatAnimatedVideoPath(context, beatIndex) };
      const candidates = beatMovieCandidates(paths, beat !== undefined && MulmoBeatMethods.isPluginVideo(beat));
      const existing = candidates.find((candidate) => existsSync(candidate));
      return { ok: true, moviePath: existing ? outputRef(existing, filePath, root) : null };
    });
  }

  async function characterImageOp(filePath: string, key: string, root?: string): Promise<OpResult<{ image: string | null }>> {
    return runStoryOp<{ image: string | null }>(filePath, { operation: "character-image", root }, async ({ context }) => {
      const imagePath = getReferenceImagePath(context, key, "png");
      if (!existsSync(imagePath)) return { ok: true, image: null };
      return { ok: true, image: await fileToDataUri(imagePath, "image/png") };
    });
  }

  /** Shared "output exists and is newer than the source script" gate for
   *  movie / PDF status. A stale artifact (script edited after it was
   *  generated) reports null so the UI re-offers the Generate button. */
  function freshOutputRef(outputPath: string, absoluteFilePath: string, wireFilePath: string, root?: string): string | null {
    if (!existsSync(outputPath)) return null;
    const outputMtime = statSync(outputPath).mtimeMs;
    const sourceMtime = statSync(absoluteFilePath).mtimeMs;
    if (outputMtime < sourceMtime) return null;
    return outputRef(outputPath, wireFilePath, root);
  }

  async function movieStatusOp(filePath: string, root?: string): Promise<OpResult<{ moviePath: string | null }>> {
    return runStoryOp(
      filePath,
      { operation: "movie-status", root, onContextMissing: () => ({ ok: true, moviePath: null }) },
      async ({ absoluteFilePath, context }) => ({ ok: true, moviePath: freshOutputRef(movieFilePath(context), absoluteFilePath, filePath, root) }),
    );
  }

  async function pdfStatusOp(filePath: string, root?: string): Promise<OpResult<{ pdfPath: string | null }>> {
    return runStoryOp(
      filePath,
      { operation: "pdf-status", root, onContextMissing: () => ({ ok: true, pdfPath: null }) },
      async ({ absoluteFilePath, context }) => ({
        ok: true,
        pdfPath: freshOutputRef(pdfFilePath(context, PDF_MODE), absoluteFilePath, filePath, root),
      }),
    );
  }

  // ── Generation ops ────────────────────────────────────────────

  async function renderBeatOp(args: GenerateOpArgsWith<"filePath" | "beatIndex">): Promise<OpResult<{ image: string }>> {
    const { filePath, beatIndex, force, chatSessionId, root } = args;
    const rootGuard = guardStoryGenerationRoot(root);
    if (rootGuard) return rootGuard;

    const mapKey = String(beatIndex);
    publishGeneration(chatSessionId, "beatImage", filePath, mapKey, false, { root });
    let genError: string | undefined;
    try {
      const result = await runStoryOp<{ image: string }>(filePath, { force, operation: "render-beat", root }, async ({ context }) => {
        const beat = context.studio.script.beats[beatIndex];
        const withoutFfmpeg = beatRendersWithoutFfmpeg(beat, {
          isPluginVideo: beat !== undefined && MulmoBeatMethods.isPluginVideo(beat),
          styleMovieParams: context.presentationStyle.movieParams,
          suppressSpeech: Boolean(context.studio.script.audioParams?.suppressSpeech),
        });
        if (!withoutFfmpeg) {
          const ffmpeg = ffmpegGuard();
          if (ffmpeg) return ffmpeg;
        }
        await generateBeatImage({
          index: beatIndex,
          context,
          ...(force ? { args: { forceImage: true } } : {}),
        });
        const { imagePath } = getBeatPngImagePath(context, beatIndex);
        if (!existsSync(imagePath)) {
          return opServerError("Image was not generated");
        }
        return { ok: true, image: await fileToDataUri(imagePath, "image/png") };
      });
      if (!result.ok) genError = result.error;
      return result;
    } finally {
      publishGeneration(chatSessionId, "beatImage", filePath, mapKey, true, { error: genError, root });
    }
  }

  async function generateBeatAudioOp(args: GenerateOpArgsWith<"filePath" | "beatIndex">): Promise<OpResult<{ audio: string }>> {
    const { filePath, beatIndex, force, chatSessionId, root } = args;
    const rootGuard = guardStoryGenerationRoot(root);
    if (rootGuard) return rootGuard;
    const mapKey = String(beatIndex);
    publishGeneration(chatSessionId, "beatAudio", filePath, mapKey, false, { root });
    let genError: string | undefined;
    try {
      const result = await runStoryOp<{ audio: string }>(filePath, { force, operation: "generate-beat-audio", root }, async ({ context }) => {
        await generateBeatAudio(beatIndex, context, {
          settings: process.env as Record<string, string>,
        } as Parameters<typeof generateBeatAudio>[2]);

        const beat = context.studio.script.beats[beatIndex];
        // The generated file still wins when present, so a beat index the
        // script doesn't have only skips the path-derivation fallback and
        // lands on the "audio was not generated" branch below.
        const generatedFile = context.studio.beats[beatIndex]?.audioFile;
        const audioPath = generatedFile ?? (beat ? getBeatAudioPathOrUrl(beat.text ?? "", context, beat, context.lang) : undefined);

        if (!audioPath || !existsSync(audioPath)) {
          // Logic-flow failure (not an exception) — emit a targeted
          // log. Don't write raw `beat.text` into persistent logs —
          // it's free-form user content and can contain sensitive
          // data.
          log.error("audio was not generated", {
            beatIndex,
            audioPath,
            exists: audioPath ? existsSync(audioPath) : false,
            beatTextLength: typeof beat?.text === "string" ? beat.text.length : 0,
            audioFilePresent: Boolean(context.studio.beats[beatIndex]?.audioFile),
          });
          return opServerError("Audio was not generated");
        }
        return { ok: true, audio: await fileToDataUri(audioPath, "audio/mpeg") };
      });
      if (!result.ok) genError = result.error;
      return result;
    } finally {
      publishGeneration(chatSessionId, "beatAudio", filePath, mapKey, true, { error: genError, root });
    }
  }

  async function renderCharacterOp(args: GenerateOpArgsWith<"filePath" | "key">): Promise<OpResult<{ image: string }>> {
    const { filePath, key, force, chatSessionId, root } = args;
    const rootGuard = guardStoryGenerationRoot(root);
    if (rootGuard) return rootGuard;
    publishGeneration(chatSessionId, "characterImage", filePath, key, false, { root });
    let genError: string | undefined;
    try {
      const result = await runStoryOp<{ image: string }>(filePath, { force, operation: "render-character", root }, async ({ context }) => {
        // `imageEntries` (not `images`) to avoid shadowing mulmocast's
        // imported `images()` pipeline stage.
        const imageEntries = context.studio.script.imageParams?.images ?? {};
        const imageEntry = imageEntries[key];
        if (!imageEntry || imageEntry.type !== "imagePrompt") {
          return opBadRequest(`No imagePrompt entry for key: ${key}`);
        }

        const index = Object.keys(imageEntries).indexOf(key);
        const imagePath = getReferenceImagePath(context, key, "png");
        mkdirSync(path.dirname(imagePath), { recursive: true });

        await generateReferenceImage({
          context,
          key,
          index,
          image: imageEntry as MulmoImagePromptMedia,
          ...(force !== undefined ? { force } : {}),
        });
        if (!existsSync(imagePath)) {
          return opServerError("Character image was not generated");
        }
        return { ok: true, image: await fileToDataUri(imagePath, "image/png") };
      });
      if (!result.ok) genError = result.error;
      return result;
    } finally {
      publishGeneration(chatSessionId, "characterImage", filePath, key, true, { error: genError, root });
    }
  }

  // ── Upload ops ────────────────────────────────────────────────

  async function uploadBeatImageOp(filePath: string, beatIndex: number, imageData: string, root?: string): Promise<OpResult<{ image: string }>> {
    // No root guard: the write is already in the right root. `runStoryOp`
    // resolves through `resolveStory` — realpath containment, per root — and
    // hands the executor an ABSOLUTE path, from which `buildContext` derives
    // its `basedir`. The guard here was added defensively during #3015's
    // review and refused a write that was never wrong (#3019).
    return runStoryOp<{ image: string }>(filePath, { operation: "upload-beat-image", root }, async ({ context }) => {
      const { imagePath } = getBeatPngImagePath(context, beatIndex);
      // writeFileAtomic creates parent dirs and prevents a half-
      // written PNG from surviving a crash mid-write (#881 v2).
      const base64 = stripDataUri(imageData);
      await backend.writeFileAtomic(imagePath, Buffer.from(base64, "base64"));
      return { ok: true, image: await fileToDataUri(imagePath, "image/png") };
    });
  }

  async function uploadCharacterImageOp(filePath: string, key: string, imageData: string, root?: string): Promise<OpResult<{ image: string }>> {
    // No root guard: the write is already in the right root. `runStoryOp`
    // resolves through `resolveStory` — realpath containment, per root — and
    // hands the executor an ABSOLUTE path, from which `buildContext` derives
    // its `basedir`. The guard here was added defensively during #3015's
    // review and refused a write that was never wrong (#3019).
    return runStoryOp<{ image: string }>(filePath, { operation: "upload-character-image", root }, async ({ context }) => {
      const imagePath = getReferenceImagePath(context, key, "png");
      const base64 = stripDataUri(imageData);
      await backend.writeFileAtomic(imagePath, Buffer.from(base64, "base64"));
      return { ok: true, image: await fileToDataUri(imagePath, "image/png") };
    });
  }

  // ── Movie / PDF pipelines ─────────────────────────────────────

  // Per-instance dedup so a foreground call (SSE route or long-held
  // dispatch) and a fire-and-forget background call can't race on the same
  // script. Keyed by the realpath (absoluteFilePath) so two different wire
  // spellings of the same file still collide. Process-local — a
  // multi-process deployment would need an external lock; out of scope.
  const inFlightMovies = new Set<string>();

  // Same dedup model as inFlightMovies, scoped to PDF generation
  // (#1614). PDFs and movies don't share the lock — they write to
  // different output files and can safely run in parallel.
  const inFlightPdfs = new Set<string>();

  // Shared core for the SSE-streaming route, the long-held dispatch op, and
  // the fire-and-forget background path triggered by `autoGenerateMovie`.
  // Builds the mulmo context, runs audio→images→movie, and reports
  // per-beat progress through the supplied callback. Throws on
  // unexpected pipeline errors; returns a structured failure when the
  // pipeline runs to completion but the output file is missing.
  async function runMovieGeneration(absoluteFilePath: string, onProgressEvent: (event: MovieProgressEvent) => void): Promise<MovieGenerationResult> {
    return withMulmoErrorCapture(() => runMoviePipeline(absoluteFilePath, onProgressEvent));
  }

  async function runMoviePipeline(absoluteFilePath: string, onProgressEvent: (event: MovieProgressEvent) => void): Promise<MovieGenerationResult> {
    const context = await buildContext(absoluteFilePath);
    if (!context) return { ok: false, error: "Failed to initialize mulmo context" };

    return withBeatProgress(
      context.studio.script.beats as MulmoBeat[],
      (sessionType, beatIndex) => {
        if (sessionType !== "image" && sessionType !== "audio") return;
        onProgressEvent({ kind: sessionType, beatIndex });
      },
      async () => {
        // Order matters: audio() must run before images(). For html_tailwind
        // beats with `animation: true`, mulmocast only emits the per-beat
        // `_animated.mp4` when the beat's duration is already known (see
        // processHtmlTailwindAnimated in mulmocast). Durations are populated
        // by audio(), so running images() first leaves the .mp4 files
        // missing and movie() then fails in validateBeatSource.
        const audioContext = await audio(context);
        const imagesContext = await images(audioContext);
        await movie(imagesContext);

        const outputPath = movieFilePath(imagesContext);
        if (!existsSync(outputPath)) return { ok: false, error: "Movie was not generated" };
        return { ok: true, outputPath };
      },
    );
  }

  /** The root guard, the ffmpeg guard and the resolve, in the order the
   *  whole-script renders (movie, PDF) run them. */
  function resolveRenderTarget(filePath: string, root?: string): { ok: true; absolutePath: string } | OpFailure {
    return guardStoryGenerationRoot(root) ?? ffmpegGuard() ?? resolveStory(filePath, root);
  }

  /**
   * Long-held foreground movie generation (the package View's
   * `generateMovie` dispatch). Resolves when the whole pipeline finishes.
   * Per-beat completions are mirrored to the generation channels so the
   * initiating View (and any other mounted View) reloads assets off disk
   * as they land — the successor of the SSE per-beat events.
   */
  async function generateMovieOp(filePath: string, chatSessionId: string | undefined, root?: string): Promise<OpResult<{ moviePath: string }>> {
    const resolved = resolveRenderTarget(filePath, root);
    if (!resolved.ok) return resolved;
    const absoluteFilePath = resolved.absolutePath;

    if (inFlightMovies.has(absoluteFilePath)) {
      return opBadRequest("Movie generation is already in progress for this script");
    }

    inFlightMovies.add(absoluteFilePath);
    publishGeneration(chatSessionId, "movie", filePath, "", false, { root });
    let genError: string | undefined;
    try {
      const result = await runMovieGeneration(absoluteFilePath, (event) => {
        const eventKind = event.kind === "image" ? "beatImage" : "beatAudio";
        publishGeneration(chatSessionId, eventKind, filePath, String(event.beatIndex), true, { root });
      });
      if (!result.ok) {
        genError = result.error;
        return opServerError(result.error);
      }
      const movieRef = outputRef(result.outputPath, filePath, root);
      if (movieRef === null) return opServerError("generated movie is outside the registered stories root");
      return { ok: true, moviePath: movieRef };
    } catch (err) {
      genError = errorMessage(err);
      return opServerError(genError);
    } finally {
      inFlightMovies.delete(absoluteFilePath);
      publishGeneration(chatSessionId, "movie", filePath, "", true, { error: genError, root });
    }
  }

  function triggerAutoBackgroundMovie(absoluteFilePath: string, wireFilePath: string, chatSessionId: string | undefined, root?: string): void {
    // The same refusal as the foreground generation ops, reached the only way
    // a `void` entry point can reach it. This one takes a `root` but never
    // returned an `OpResult`, so the guard that covers every other generation
    // did not cover the one generation nobody is waiting on — which is the
    // worse half: a detached run corrupting the other root's pending state
    // has no caller to see the failure (Codex P1 on #3015).
    if (guardStoryGenerationRoot(root)) {
      log.warn("refused an auto background movie in a non-default stories root", { filePath: wireFilePath, root });
      return;
    }
    if (inFlightMovies.has(absoluteFilePath)) return;
    inFlightMovies.add(absoluteFilePath);
    void runBackgroundMovieGeneration(absoluteFilePath, wireFilePath, chatSessionId, root);
  }

  // Detached movie generation. Reports progress through the generation
  // channels the View watches — so a user opening the canvas
  // mid-generation sees spinners, and a user opening it after completion
  // sees the finished movie loaded from disk by the View's normal
  // mount-time path. Errors are persisted to a `<filename>.error.txt`
  // sidecar next to the script (no synchronous client to alert); any
  // stale sidecar from a previous run is cleared on each new attempt.
  // Triggered server-side from the unified save route when the caller
  // passes `autoGenerateMovie: true`.
  async function runBackgroundMovieGeneration(absoluteFilePath: string, wireFilePath: string, chatSessionId: string | undefined, root?: string): Promise<void> {
    const errorSidecarPath = `${absoluteFilePath}.error.txt`;
    // Clear stale error from a previous failed run before starting; if it
    // doesn't exist that's fine. Catch any unexpected fs errors silently —
    // the worst case is the user sees an out-of-date error file later.
    try {
      unlinkSync(errorSidecarPath);
    } catch {
      // intentional: ENOENT is the common case, others non-fatal
    }

    publishGeneration(chatSessionId, "movie", wireFilePath, "", false, { root });
    let genError: string | undefined;
    try {
      const result = await runMovieGeneration(absoluteFilePath, (event) => {
        // Mirror per-beat completions through the generation channels so
        // subscribed Views reload the asset off disk. We fire start+finish
        // in two ticks — `setImmediate` lets the session SSE writer flush
        // the start event before the finish removes the entry, otherwise
        // Vue's batched reactivity could see a net "no change" and skip
        // the reload.
        const eventKind = event.kind === "image" ? "beatImage" : "beatAudio";
        const key = String(event.beatIndex);
        publishGeneration(chatSessionId, eventKind, wireFilePath, key, false, { root });
        setImmediate(() => publishGeneration(chatSessionId, eventKind, wireFilePath, key, true, { root }));
      });

      if (!result.ok) {
        genError = result.error;
        await writeErrorSidecar(errorSidecarPath, result.error);
        log.warn("background movie generation failed", { filePath: wireFilePath, error: result.error });
        return;
      }
      log.info("background movie generation done", {
        filePath: wireFilePath,
        outputPath: result.outputPath,
      });
    } catch (err) {
      genError = errorMessage(err);
      await writeErrorSidecar(errorSidecarPath, genError);
      log.error("background movie generation crashed", { filePath: wireFilePath, error: genError });
    } finally {
      inFlightMovies.delete(absoluteFilePath);
      publishGeneration(chatSessionId, "movie", wireFilePath, "", true, { error: genError, root });
    }
  }

  // Atomic write so a crash mid-write can't leave a truncated sidecar.
  async function writeErrorSidecar(errorSidecarPath: string, message: string): Promise<void> {
    try {
      await backend.writeFileAtomic(errorSidecarPath, message);
    } catch (writeErr) {
      log.error("failed to write error sidecar", {
        errorSidecarPath,
        error: errorMessage(writeErr),
      });
    }
  }

  // ── PDF (#1614) ───────────────────────────────────────────────

  // Shared core for the SSE-streaming route and the long-held dispatch op.
  // Mirrors the movie pipeline's per-beat progress reporting so the UI can
  // light spinners during the image pass; the PDF action itself doesn't
  // emit progress events, so only image events are forwarded. Returns a
  // structured failure when the pipeline completes but the output file is
  // missing.
  async function runPdfGeneration(context: StoryContext, onImageBeatDone: (beatIndex: number) => void): Promise<PdfGenerationResult> {
    return withMulmoErrorCapture(() => runPdfPipeline(context, onImageBeatDone));
  }

  async function runPdfPipeline(context: StoryContext, onImageBeatDone: (beatIndex: number) => void): Promise<PdfGenerationResult> {
    return withBeatProgress(
      context.studio.script.beats as MulmoBeat[],
      (sessionType, beatIndex) => {
        if (sessionType !== "image") return;
        onImageBeatDone(beatIndex);
      },
      async () => {
        const imagesContext = await images(context);
        await pdf(imagesContext, PDF_MODE, PDF_SIZE);
        const outputPath = pdfFilePath(imagesContext, PDF_MODE);
        if (!existsSync(outputPath)) return { ok: false, error: "PDF was not generated" };
        return { ok: true, outputPath };
      },
    );
  }

  /** Long-held foreground PDF generation (the package View's `generatePdf`
   *  dispatch) — the PDF sibling of `generateMovieOp`. */
  async function generatePdfOp(filePath: string, chatSessionId: string | undefined, root?: string): Promise<OpResult<{ pdfPath: string }>> {
    const resolved = resolveRenderTarget(filePath, root);
    if (!resolved.ok) return resolved;
    const absoluteFilePath = resolved.absolutePath;

    if (inFlightPdfs.has(absoluteFilePath)) {
      return opBadRequest("PDF generation is already in progress for this script");
    }

    inFlightPdfs.add(absoluteFilePath);
    publishGeneration(chatSessionId, "pdf", filePath, "", false, { root });
    let genError: string | undefined;
    try {
      const context = await buildContext(absoluteFilePath);
      if (!context) {
        genError = "Failed to initialize mulmo context";
        return opServerError(genError);
      }
      const result = await runPdfGeneration(context, (beatIndex) => {
        publishGeneration(chatSessionId, "beatImage", filePath, String(beatIndex), true, { root });
      });
      if (!result.ok) {
        genError = result.error;
        return opServerError(result.error);
      }
      const pdfRef = outputRef(result.outputPath, filePath, root);
      if (pdfRef === null) return opServerError("generated PDF is outside the registered stories root");
      return { ok: true, pdfPath: pdfRef };
    } catch (err) {
      genError = errorMessage(err);
      return opServerError(genError);
    } finally {
      inFlightPdfs.delete(absoluteFilePath);
      publishGeneration(chatSessionId, "pdf", filePath, "", true, { error: genError, root });
    }
  }

  return {
    backend,
    toStoryRef,
    outputRef,
    resolveStory,
    guardStoryWirePath,
    guardStoryRootRegistered,
    guardStoryWriteRoot,
    artifactsForRoot,
    guardStoryGenerationRoot,
    ffmpegGuard,
    runStoryOp,
    publishGeneration,
    publishScriptChanged,
    pendingGenerations,
    beatImageOp,
    beatAudioOp,
    beatMovieOp,
    characterImageOp,
    movieStatusOp,
    pdfStatusOp,
    renderBeatOp,
    generateBeatAudioOp,
    renderCharacterOp,
    uploadBeatImageOp,
    uploadCharacterImageOp,
    inFlightMovies,
    inFlightPdfs,
    runMovieGeneration,
    runPdfGeneration,
    generateMovieOp,
    generatePdfOp,
    triggerAutoBackgroundMovie,
  };
}

export type MulmoScriptServerOps = ReturnType<typeof createMulmoScriptServerOps>;
