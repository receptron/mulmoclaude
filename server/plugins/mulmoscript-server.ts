// MulmoClaude's binding of the shared mulmoScript server ops (phase 3 of
// plans/done/feat-mulmoscript-plugin.md). The mulmocast orchestration, realpath
// containment, dispatch routing, and generation tracking all live in
// @mulmoclaude/mulmoscript-plugin/server; this module supplies the
// host-specific backend — stories location, artifacts FileOps, hardened
// atomic writes, the ffmpeg probe, the logger, and the generation fan-out
// (session `pendingGenerations` channel + plugin pubsub) — and registers
// the built-in "mulmoScript" dispatch handler. Imported for side effect at
// boot (server/index.ts); the REST routes in api/routes/mulmo-script.ts
// consume the same instance.

import path from "path";
import {
  createMulmoScriptServerOps,
  createMulmoScriptDispatchHandler,
  GENERATION_EVENT,
  type MulmoScriptServerOps,
} from "@mulmoclaude/mulmoscript-plugin/server";
import type { ParsedStoryRoot } from "../api/routes/mulmoScriptWriteRoot.js";
import { STORY_SCRIPT_EXTENSIONS } from "@mulmoclaude/mulmoscript-plugin";
import { makeByPathFileOps } from "../utils/files/by-path.js";
import { WORKSPACE_PATHS } from "../workspace/paths.js";
import { writeFileAtomic } from "../utils/files/atomic.js";
import { depStatus } from "../system/optionalDeps.js";
import { log } from "../system/logger/index.js";
import { publishGeneration } from "../events/session-store/index.js";
import type { IPubSub } from "../events/pub-sub/index.js";
import { makeArtifactsFileOps, pluginChannelName } from "./runtime.js";
import { registerBuiltinDispatch } from "./builtin-dispatch.js";

/** Scope name — matches `wrapWithScope("mulmoScript", …)` in
 *  `src/plugins/presentMulmoScript/index.ts`, which is what the View's
 *  `useRuntime().dispatch` / `pubsub` use as the plugin namespace. */
const MULMOSCRIPT_SCOPE = "mulmoScript";

let pubsubInstance: IPubSub | null = null;

const rawOps = createMulmoScriptServerOps({
  storiesDir: path.resolve(WORKSPACE_PATHS.stories),
  artifacts: makeArtifactsFileOps(),
  // Lets `filePath` name a .json script outside `artifacts/stories/` — see
  // the `byPath` doc on MulmoScriptServerBackend.
  byPath: makeByPathFileOps(STORY_SCRIPT_EXTENSIONS),
  writeFileAtomic: async (absolutePath, data) => {
    await writeFileAtomic(absolutePath, typeof data === "string" ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  },
  isFfmpegAvailable: () => depStatus("ffmpeg")?.available,
  // Edge-triggered by the package's tracker: fan each transition out to
  // the per-session pendingGenerations channel (sidebar indicator;
  // no-ops without a session) AND the plugin pubsub channel the
  // extracted View subscribes to for spinners + reload-on-finish.
  onGenerationEvent: (chatSessionId, event) => {
    publishGeneration(chatSessionId, event.kind, event.filePath, event.key, event.done, event.error);
    pubsubInstance?.publish(pluginChannelName(MULMOSCRIPT_SCOPE, GENERATION_EVENT), event);
  },
  log: {
    info: (message, data) => log.info("mulmo-script", message, data),
    warn: (message, data) => log.warn("mulmo-script", message, data),
    error: (message, data) => log.error("mulmo-script", message, data),
  },
});

registerBuiltinDispatch(MULMOSCRIPT_SCOPE, createMulmoScriptDispatchHandler(rawOps));

/**
 * The ops, seen through a contract that only accepts a root someone PARSED.
 *
 * The raw object is deliberately not exported (#3086). Its root parameters are
 * `string | undefined`, so any request value type-checks as a root — and this session found four
 * separate places that passed an unparsed one, each of which reads or writes the DEFAULT root's
 * identically-named script while the caller believes it named another (#3076, #3077). The
 * previous defence was a textual sweep, and a review spent five rounds on spellings it missed.
 *
 * This is the same object at runtime; only the TYPE is narrowed, so there is no wrapper to keep
 * in step and no behaviour to re-verify. What it buys is that a caller cannot reach the
 * unbranded signatures at all: `mulmoScriptOps.beatImageOp(p, i, req.query.root)` no longer
 * compiles, because `req.query.root` is not a `ParsedStoryRoot` and `parseSuppliedRoot` is the
 * only thing that mints one.
 *
 * Members that take no root are untouched and pass straight through.
 */
type RootTakingOp =
  | "resolveStory"
  | "beatImageOp"
  | "beatAudioOp"
  | "beatMovieOp"
  | "characterImageOp"
  | "movieStatusOp"
  | "pdfStatusOp"
  | "renderBeatOp"
  | "generateBeatAudioOp"
  | "renderCharacterOp"
  | "uploadBeatImageOp"
  | "uploadCharacterImageOp"
  | "outputRef"
  | "guardStoryWriteRoot"
  | "guardStoryGenerationRoot"
  | "guardStoryWirePath"
  | "artifactsForRoot";

type RootedMulmoScriptOps = Omit<MulmoScriptServerOps, RootTakingOp> & {
  resolveStory: (filePath: string, root?: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["resolveStory"]>;
  beatImageOp: (filePath: string, beatIndex: number, root?: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["beatImageOp"]>;
  beatAudioOp: (filePath: string, beatIndex: number, root?: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["beatAudioOp"]>;
  beatMovieOp: (filePath: string, beatIndex: number, root?: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["beatMovieOp"]>;
  characterImageOp: (filePath: string, key: string, root?: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["characterImageOp"]>;
  movieStatusOp: (filePath: string, root?: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["movieStatusOp"]>;
  pdfStatusOp: (filePath: string, root?: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["pdfStatusOp"]>;
  renderBeatOp: (args: RootedGenerateArgs<Parameters<MulmoScriptServerOps["renderBeatOp"]>[0]>) => ReturnType<MulmoScriptServerOps["renderBeatOp"]>;
  generateBeatAudioOp: (
    args: RootedGenerateArgs<Parameters<MulmoScriptServerOps["generateBeatAudioOp"]>[0]>,
  ) => ReturnType<MulmoScriptServerOps["generateBeatAudioOp"]>;
  renderCharacterOp: (
    args: RootedGenerateArgs<Parameters<MulmoScriptServerOps["renderCharacterOp"]>[0]>,
  ) => ReturnType<MulmoScriptServerOps["renderCharacterOp"]>;
  uploadBeatImageOp: (filePath: string, beatIndex: number, imageData: string, root?: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["uploadBeatImageOp"]>;
  uploadCharacterImageOp: (
    filePath: string,
    key: string,
    imageData: string,
    root?: ParsedStoryRoot,
  ) => ReturnType<MulmoScriptServerOps["uploadCharacterImageOp"]>;
  outputRef: (outputPath: string, wireFilePath: string, root?: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["outputRef"]>;
  guardStoryWriteRoot: (root: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["guardStoryWriteRoot"]>;
  guardStoryGenerationRoot: (root: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["guardStoryGenerationRoot"]>;
  guardStoryWirePath: (filePath: unknown, root?: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["guardStoryWirePath"]>;
  artifactsForRoot: (root: ParsedStoryRoot) => ReturnType<MulmoScriptServerOps["artifactsForRoot"]>;
};

/** The object-argument ops take their root in a field rather than a position. */
type RootedGenerateArgs<T> = Omit<T, "root"> & { root?: ParsedStoryRoot };

export const mulmoScriptOps: RootedMulmoScriptOps = rawOps;

/** Wired at boot (initEventPublishers) — publishes before this are
 *  session-only. */
export function initMulmoScriptGenerationPublisher(instance: IPubSub): void {
  pubsubInstance = instance;
}
