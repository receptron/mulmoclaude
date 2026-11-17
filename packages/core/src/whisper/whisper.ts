// Public server-side façade: wires the model downloader, the warm sidecar, and
// ffmpeg conversion into one host-agnostic service. The host injects the models
// directory + a logger and gates capability itself (platform / binary presence);
// this package assumes the binaries exist when called.

import { mkdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { NOOP_LOGGER, type WhisperLogger } from "./internal.ts";
import { convertToWav16k } from "./ffmpeg.ts";
import { createModelDownloader } from "./models.ts";
import { createSidecar } from "./sidecar.ts";
import { resolveExtraServerArgs, WHISPER_SERVER_EXTRA_ARGS_ENV } from "./extra-args.ts";
import { isModelReady, type ModelStatus, type WhisperModelName } from "./models.ts";

export interface WhisperOptions {
  /** Directory that holds the GGML model files (e.g. `{workspace}/models`). */
  modelsDir: string;
  logger?: WhisperLogger;
  /** Defaults to "whisper-server" / "ffmpeg" on PATH. */
  serverBinary?: string;
  ffmpegBinary?: string;
}

export interface TranscribeRequest {
  base64: string;
  mimeType: string;
  language: string;
  model: WhisperModelName;
}

export interface Whisper {
  isModelReady: (model: WhisperModelName) => boolean;
  getModelStatus: (model: WhisperModelName) => ModelStatus;
  /** Fire-and-forget friendly; never throws (errors land in the status). */
  ensureModelDownloaded: (model: WhisperModelName) => Promise<void>;
  warmup: (model: WhisperModelName) => Promise<void>;
  transcribe: (req: TranscribeRequest) => Promise<{ text: string }>;
  shutdown: () => void;
}

// whisper.cpp returns these sentinels for non-speech windows; treat them as
// empty so the UI shows "didn't catch that" rather than a literal marker.
const BLANK_MARKERS = new Set(["[blank_audio]", "[silence]", "(silence)", "[ inaudible ]"]);

function normalizeTranscript(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return BLANK_MARKERS.has(trimmed.toLowerCase()) ? "" : trimmed;
}

export function createWhisper(opts: WhisperOptions): Whisper {
  const { modelsDir } = opts;
  const logger = opts.logger ?? NOOP_LOGGER;
  const ffmpegBinary = opts.ffmpegBinary ?? "ffmpeg";
  const downloader = createModelDownloader(modelsDir, logger);
  const sidecar = createSidecar(
    modelsDir,
    opts.serverBinary ?? "whisper-server",
    logger,
    resolveExtraServerArgs(process.env[WHISPER_SERVER_EXTRA_ARGS_ENV], logger),
  );

  // Scratch dir for transient audio — a hidden subdir of the models dir so it
  // shares the (non-git) models tree. Files are deleted after each transcription.
  const scratchDir = path.join(modelsDir, ".scratch");

  async function transcribe(req: TranscribeRequest): Promise<{ text: string }> {
    mkdirSync(scratchDir, { recursive: true });
    const clipId = randomUUID();
    const inputPath = path.join(scratchDir, `utterance-${clipId}.webm`);
    const wavPath = path.join(scratchDir, `utterance-${clipId}.wav`);
    try {
      await writeFile(inputPath, Buffer.from(req.base64, "base64"));
      await convertToWav16k(inputPath, wavPath, ffmpegBinary);
      const text = await sidecar.transcribeWav(wavPath, req.language, req.model);
      return { text: normalizeTranscript(text) };
    } finally {
      await rm(inputPath, { force: true });
      await rm(wavPath, { force: true });
    }
  }

  return {
    isModelReady: (model) => isModelReady(modelsDir, model),
    getModelStatus: (model) => downloader.getStatus(model),
    ensureModelDownloaded: (model) => downloader.ensure(model),
    warmup: (model) => sidecar.warmup(model),
    transcribe,
    shutdown: () => sidecar.shutdown(),
  };
}
