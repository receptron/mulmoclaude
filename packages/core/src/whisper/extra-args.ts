// Parses the opt-in extra whisper-server argv (e.g. `--vad --vad-model <path>`)
// from an env var. Pure so the accept/reject rules are testable without a process.

export const WHISPER_SERVER_EXTRA_ARGS_ENV = "WHISPER_SERVER_EXTRA_ARGS";

// We pass these ourselves; whisper-server lets a later flag win, so an override
// would point the sidecar at a port/model we are not polling.
const RESERVED_FLAGS: ReadonlySet<string> = new Set(["-m", "--model", "--host", "--port"]);

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

export function parseExtraServerArgs(raw: string | undefined): ExtraArgsResult {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, args: [] };
  const args = tokenize(text);
  if (args === null) return { ok: false, reason: "expected a JSON array of strings" };
  const reserved = args.find((arg) => RESERVED_FLAGS.has(arg));
  if (reserved !== undefined) return { ok: false, reason: `${reserved} is set by MulmoClaude and cannot be overridden` };
  return { ok: true, args };
}
