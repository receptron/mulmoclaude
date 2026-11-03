// Which extra environment variables reach the Docker sandbox (#3617). Pure: the
// caller reads the env file and the host environment and injects them.
//
// Values never enter the docker argv. `SANDBOX_ENV` names become `-e NAME`, which
// docker resolves from its own environment — the server's, inherited unchanged.
// The env file goes to docker as `--env-file <path>` instead of being copied into
// the spawn environment, because that environment also configures the docker CLI
// itself: a file line `DOCKER_HOST=…` or `HOME=…` would redirect the daemon or
// the CLI config rather than reach the container.

const ENV_NAME_RE = /^[A-Za-z_]\w*$/;

export type SandboxEnvSkipReason = "invalid-name" | "reserved" | "unset-on-host";

export interface SandboxEnvSkip {
  name: string;
  reason: SandboxEnvSkipReason;
}

export type EnvFileProblem = "invalid-line";

export interface EnvFileEntry {
  name: string;
  /** A bare `NAME` line: docker takes the value from its own environment. */
  bare: boolean;
}

export interface ParsedEnvFile {
  /** Valid lines in file order. */
  entries: EnvFileEntry[];
  /** 1-based line numbers docker would reject or read differently from us. */
  invalidLines: number[];
}

export type EnvFileInput = { path: string; text: string } | { path: string; error: string };

export interface SandboxEnvInput {
  names: readonly string[];
  envFile: EnvFileInput | null;
  hostEnv: Readonly<Record<string, string | undefined>>;
  reservedNames: ReadonlySet<string>;
}

export interface SandboxEnvPlan {
  args: string[];
  /** Names that reach the container, for logging. Never values. */
  passedNames: string[];
  skipped: SandboxEnvSkip[];
  envFileProblem: { path: string; reason: EnvFileProblem | "unreadable"; lines: number[] } | null;
}

export const isEnvName = (name: string): boolean => ENV_NAME_RE.test(name);

// Mirrors docker's `--env-file` reader: leading whitespace is dropped, blank and
// `#` lines are skipped, a CRLF line ending is read as LF, the name ends at the
// first `=`, and a bare `NAME` takes the host's value. Stricter on names than
// docker, which would accept `a.b`.
function envFileLineEntry(line: string): EnvFileEntry | null {
  const trimmed = line.trimStart();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const separator = trimmed.indexOf("=");
  return separator === -1 ? { name: trimmed, bare: true } : { name: trimmed.slice(0, separator), bare: false };
}

export function parseEnvFileText(text: string): ParsedEnvFile {
  const lines = text.split(/\r?\n/).map((line, index) => ({ lineNumber: index + 1, entry: envFileLineEntry(line) }));
  const named = lines.flatMap(({ lineNumber, entry }) => (entry === null ? [] : [{ lineNumber, entry }]));
  return {
    entries: named.filter(({ entry }) => isEnvName(entry.name)).map(({ entry }) => entry),
    invalidLines: named.filter(({ entry }) => !isEnvName(entry.name)).map(({ lineNumber }) => lineNumber),
  };
}

function nameOfAssignment(assignment: string): string {
  const separator = assignment.indexOf("=");
  return separator === -1 ? assignment : assignment.slice(0, separator);
}

/** Every variable name a `-e` / `--env` flag sets before `image` in a docker argv. */
export function dockerEnvNames(dockerArgs: readonly string[], image: string): Set<string> {
  const imageIndex = dockerArgs.indexOf(image);
  const options = imageIndex === -1 ? dockerArgs : dockerArgs.slice(0, imageIndex);
  const values = options.filter((_, index) => index > 0 && (options[index - 1] === "-e" || options[index - 1] === "--env"));
  return new Set(values.map(nameOfAssignment));
}

/** `extra` spliced in just before `image`, i.e. after every option already set. */
export function insertDockerOptions(dockerArgs: readonly string[], image: string, extra: readonly string[]): string[] {
  const imageIndex = dockerArgs.indexOf(image);
  if (imageIndex === -1) throw new Error(`docker argv has no image "${image}"`);
  return [...dockerArgs.slice(0, imageIndex), ...extra, ...dockerArgs.slice(imageIndex)];
}

function classifyName(name: string, input: SandboxEnvInput): SandboxEnvSkipReason | null {
  if (!isEnvName(name)) return "invalid-name";
  if (input.reservedNames.has(name)) return "reserved";
  if (input.hostEnv[name] === undefined) return "unset-on-host";
  return null;
}

function planNamedEnv(input: SandboxEnvInput): Pick<SandboxEnvPlan, "passedNames" | "skipped"> {
  const unique = [...new Set(input.names)];
  const verdicts = unique.map((name) => ({ name, reason: classifyName(name, input) }));
  return {
    passedNames: verdicts.filter((verdict) => verdict.reason === null).map((verdict) => verdict.name),
    skipped: verdicts.flatMap((verdict) => (verdict.reason === null ? [] : [{ name: verdict.name, reason: verdict.reason }])),
  };
}

// A file with a name docker would reject is not passed at all: docker fails the
// whole `run` on it, which would take every agent turn down with it.
function envFileProblemOf(envFile: EnvFileInput): SandboxEnvPlan["envFileProblem"] {
  if ("error" in envFile) return { path: envFile.path, reason: "unreadable", lines: [] };
  const { invalidLines } = parseEnvFileText(envFile.text);
  return invalidLines.length > 0 ? { path: envFile.path, reason: "invalid-line", lines: invalidLines } : null;
}

// A reserved name in the file is still read by docker, but docker applies every
// `-e` after the file, so the fixed value wins; it is reported, not passed. Of
// repeated lines docker keeps the last, so the last one decides.
function classifyFileEntry(entry: EnvFileEntry, input: SandboxEnvInput): SandboxEnvSkipReason | null {
  if (input.reservedNames.has(entry.name)) return "reserved";
  if (entry.bare && input.hostEnv[entry.name] === undefined) return "unset-on-host";
  return null;
}

function planFileEnv(text: string, input: SandboxEnvInput): Pick<SandboxEnvPlan, "passedNames" | "skipped"> {
  const lastByName = new Map(parseEnvFileText(text).entries.map((entry) => [entry.name, entry]));
  const verdicts = [...lastByName.values()].map((entry) => ({ name: entry.name, reason: classifyFileEntry(entry, input) }));
  return {
    passedNames: verdicts.filter((verdict) => verdict.reason === null).map((verdict) => verdict.name),
    skipped: verdicts.flatMap((verdict) => (verdict.reason === null ? [] : [{ name: verdict.name, reason: verdict.reason }])),
  };
}

export function planSandboxEnv(input: SandboxEnvInput): SandboxEnvPlan {
  const named = planNamedEnv(input);
  const envFileProblem = input.envFile === null ? null : envFileProblemOf(input.envFile);
  const usableFile = input.envFile !== null && envFileProblem === null && "text" in input.envFile ? input.envFile : null;
  const fromFile = usableFile === null ? { passedNames: [], skipped: [] } : planFileEnv(usableFile.text, input);
  return {
    args: [...(usableFile === null ? [] : ["--env-file", usableFile.path]), ...named.passedNames.flatMap((name) => ["-e", name])],
    passedNames: [...new Set([...fromFile.passedNames, ...named.passedNames])],
    skipped: [...fromFile.skipped, ...named.skipped],
    envFileProblem,
  };
}
