// Parses the opt-in extra whisper-server argv (e.g. `--vad --vad-model <path>`)
// from an env var. Pure so the accept/reject rules are testable without a process.

import type { WhisperLogger } from "./internal.ts";

export const WHISPER_SERVER_EXTRA_ARGS_ENV = "WHISPER_SERVER_EXTRA_ARGS";

// Every whisper-server SERVER-level option (upstream `server.cpp`), plus the
// model and help: the sidecar owns where it listens, what it serves and which
// model it loads, and a later flag would silently override ours. Every other
// option is passed through untouched.
const RESERVED_FLAGS: ReadonlySet<string> = new Set([
  "-m",
  "--model",
  "-h",
  "--help",
  "--host",
  "--port",
  "--public",
  "--request-path",
  "--inference-path",
  "--convert",
  "--tmp-dir",
]);

export type ExtraArgsResult = { readonly ok: true; readonly args: string[] } | { readonly ok: false; readonly reason: string };

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function parseJsonArray(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isStringArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// A JSON array lets a path contain spaces; plain text is split on whitespace.
function tokenize(text: string): string[] | null {
  if (text.startsWith("[")) return parseJsonArray(text);
  return text.split(/\s+/);
}

// `--port=1` names the same option as `--port`.
const flagName = (arg: string): string => arg.split("=", 1)[0] ?? arg;

function findProblem(args: readonly string[]): string | null {
  // spawn() throws synchronously on a NUL byte, before any fallback could run.
  if (args.some((arg) => arg.includes("\0"))) return "an argument contains a NUL character";
  const reserved = args.find((arg) => RESERVED_FLAGS.has(flagName(arg)));
  return reserved === undefined ? null : `${flagName(reserved)} is set by MulmoClaude and cannot be overridden`;
}

export function parseExtraServerArgs(raw: string | undefined): ExtraArgsResult {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, args: [] };
  const args = tokenize(text);
  if (args === null) return { ok: false, reason: "expected a JSON array of strings" };
  const problem = findProblem(args);
  return problem === null ? { ok: true, args } : { ok: false, reason: problem };
}

/** Resolve the extra argv from the env value. A rejected value falls back to
 *  no extras so a typo cannot stop voice input. Only the count is logged: a
 *  value is a path, and nothing tells a flag from a value that starts with `-`. */
export function resolveExtraServerArgs(raw: string | undefined, logger: WhisperLogger): string[] {
  const result = parseExtraServerArgs(raw);
  if (!result.ok) {
    logger.warn(`${WHISPER_SERVER_EXTRA_ARGS_ENV} ignored`, { reason: result.reason });
    return [];
  }
  if (result.args.length > 0) logger.info(`${WHISPER_SERVER_EXTRA_ARGS_ENV} applied`, { count: result.args.length });
  return result.args;
}
