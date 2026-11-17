// Pure helpers for the whisper-server sidecar. Kept separate from `sidecar.ts`
// so the argv/response/stderr logic can be unit-tested without spawning a
// process or opening a socket.

import { hasStringProp } from "@mulmoclaude/common";

/** whisper-server CLI args to preload `modelPath` and bind to `host:port`,
 *  followed by any user-supplied `extraArgs`. */
export function buildServerArgs(modelPath: string, host: string, port: number, extraArgs: readonly string[] = []): string[] {
  return ["--model", modelPath, "--host", host, "--port", String(port), ...extraArgs];
}

/** Append `chunk` to a bounded stderr tail, keeping only the last `maxChars`. */
export function appendStderrTail(previous: string, chunk: string, maxChars: number): string {
  return (previous + chunk).slice(-maxChars);
}

/** Extract the transcript from a whisper-server `/inference` JSON response.
 *  Returns "" for any shape that lacks a string `text` field. */
export function parseInferenceText(data: unknown): string {
  return hasStringProp(data, "text") ? data.text : "";
}
