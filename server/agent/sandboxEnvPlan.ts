// Which extra environment variables reach the Docker sandbox (#3617). Pure: the
// caller reads the env file and the host environment and injects them.
//
// Values never enter the docker argv. `SANDBOX_ENV` names become `-e NAME`, which
// docker resolves from its own environment — the server's, inherited unchanged.
// File entries are not copied into that environment either, because it also
// configures the docker CLI itself (`DOCKER_HOST`, `HOME`, …). Instead the lines
// that pass are re-serialised into `stagedEnvFileText`, which the caller writes
// to a private file for `--env-file`: docker then reads exactly what was checked,
// not the user's file again after it might have changed.

export type SandboxEnvSource = "SANDBOX_ENV" | "SANDBOX_ENV_FILE";

export type SandboxEnvSkipReason = "invalid-name" | "reserved" | "unset-on-host";

export interface SandboxEnvSkip {
  source: SandboxEnvSource;
  /** The variable name, or `#<position>` / `line <n>` for an invalid one: an
   *  invalid entry is often a mistyped assignment, and its text can hold a secret. */
  entry: string;
  reason: SandboxEnvSkipReason;
}

export interface EnvFileEntry {
  name: string;
  /** A bare `NAME` line: docker takes the value from its own environment. */
  bare: boolean;
  /** The line as docker would read it, leading whitespace dropped. */
  line: string;
  lineNumber: number;
}

export type EnvFileInput = { path: string; text: string } | { path: string; error: string };

export interface SandboxEnvInput {
  names: readonly string[];
  envFile: EnvFileInput | null;
  hostEnv: Readonly<Record<string, string | undefined>>;
  reservedNames: ReadonlySet<string>;
}

export interface SandboxEnvPlan {
  /** `-e NAME` pairs for `SANDBOX_ENV`, to follow any `--env-file` so they win. */
  nameArgs: string[];
  /** The accepted env-file lines, or null when no file line passes. */
  stagedEnvFileText: string | null;
  /** Names each source passes, for logging. Never values. */
  fileNames: string[];
  namedNames: string[];
  skipped: SandboxEnvSkip[];
}

// Variables `sandbox-entrypoint.sh` reads even on runs whose argv does not set
// them — `HOST_UID` alone switches the entrypoint into its root-only branch.
export const ENTRYPOINT_ENV_NAMES: readonly string[] = ["HOST_UID", "HOST_GID", "SANDBOX_SSH_ALLOWED_HOSTS", "SSH_AUTH_SOCK"];

// Docker's own rule for an env-file name: not empty, no whitespace. `=` cannot
// occur in a parsed name, and in a `SANDBOX_ENV` entry it would turn `-e NAME`
// into an assignment whose value sits in the argv.
export const isEnvName = (name: string): boolean => name !== "" && !/[\s=]/.test(name);

// Mirrors docker's `--env-file` reader: lines split on LF with a trailing CR
// dropped, leading whitespace dropped, blank and `#` lines skipped, the name
// ending at the first `=`, and a bare `NAME` taking the host's value.
function envFileEntry(rawLine: string, lineNumber: number): EnvFileEntry | null {
  const line = rawLine.trimStart();
  if (line === "" || line.startsWith("#")) return null;
  const separator = line.indexOf("=");
  const name = separator === -1 ? line : line.slice(0, separator);
  return { name, bare: separator === -1, line, lineNumber };
}

export function parseEnvFileText(text: string): EnvFileEntry[] {
  return text.split(/\r?\n/).flatMap((rawLine, index) => envFileEntry(rawLine, index + 1) ?? []);
}

/** Every variable name a `-e` / `--env` flag sets before `image` in a docker argv. */
export function dockerEnvNames(dockerArgs: readonly string[], image: string): Set<string> {
  const options = optionsBeforeImage(dockerArgs, image);
  const values = options.filter((_, index) => index > 0 && (options[index - 1] === "-e" || options[index - 1] === "--env"));
  return new Set(values.map((value) => value.split("=", 1).join("")));
}

function optionsBeforeImage(dockerArgs: readonly string[], image: string): readonly string[] {
  const imageIndex = dockerArgs.indexOf(image);
  return imageIndex === -1 ? dockerArgs : dockerArgs.slice(0, imageIndex);
}

// `-v SOURCE:TARGET[:ro]`. A source never holds `:` (`dockerMountArgs` moves such
// a path to `--mount`), except a Windows drive letter, which is kept.
function volumeSource(value: string): string {
  const drive = /^[A-Za-z]:/.test(value) ? value.slice(0, 2) : "";
  const rest = value.slice(drive.length);
  const end = rest.indexOf(":");
  return drive + (end === -1 ? rest : rest.slice(0, end));
}

function mountSource(value: string): string | null {
  const field = value.split(",").find((part) => part.startsWith("source=") || part.startsWith("src="));
  return field === undefined ? null : field.slice(field.indexOf("=") + 1);
}

/** The host side of every `-v` / `--mount` before `image`: what the container can read. */
export function dockerMountSources(dockerArgs: readonly string[], image: string): string[] {
  const options = optionsBeforeImage(dockerArgs, image);
  return options.flatMap((value, index): string[] => {
    const flag = options[index - 1];
    if (flag === "-v" || flag === "--volume") return [volumeSource(value)];
    const source = flag === "--mount" ? mountSource(value) : null;
    return source === null ? [] : [source];
  });
}

/** `extra` spliced in just before `image`, i.e. after every option already set. */
export function insertDockerOptions(dockerArgs: readonly string[], image: string, extra: readonly string[]): string[] {
  const imageIndex = dockerArgs.indexOf(image);
  if (imageIndex === -1) throw new Error(`docker argv has no image "${image}"`);
  return [...dockerArgs.slice(0, imageIndex), ...extra, ...dockerArgs.slice(imageIndex)];
}

interface Verdict<T> {
  item: T;
  skip: SandboxEnvSkip | null;
}

function splitVerdicts<T>(verdicts: Verdict<T>[]): { accepted: T[]; skipped: SandboxEnvSkip[] } {
  return {
    accepted: verdicts.flatMap((verdict) => (verdict.skip === null ? [verdict.item] : [])),
    skipped: verdicts.flatMap((verdict) => (verdict.skip === null ? [] : [verdict.skip])),
  };
}

function namedVerdict(name: string, position: number, input: SandboxEnvInput): Verdict<string> {
  const skip = (entry: string, reason: SandboxEnvSkipReason): Verdict<string> => ({ item: name, skip: { source: "SANDBOX_ENV", entry, reason } });
  if (!isEnvName(name)) return skip(`#${position}`, "invalid-name");
  if (input.reservedNames.has(name)) return skip(name, "reserved");
  if (input.hostEnv[name] === undefined) return skip(name, "unset-on-host");
  return { item: name, skip: null };
}

function fileVerdict(entry: EnvFileEntry, input: SandboxEnvInput): Verdict<EnvFileEntry> {
  const skip = (label: string, reason: SandboxEnvSkipReason): Verdict<EnvFileEntry> => ({
    item: entry,
    skip: { source: "SANDBOX_ENV_FILE", entry: label, reason },
  });
  if (!isEnvName(entry.name)) return skip(`line ${entry.lineNumber}`, "invalid-name");
  if (input.reservedNames.has(entry.name)) return skip(entry.name, "reserved");
  if (entry.bare && input.hostEnv[entry.name] === undefined) return skip(entry.name, "unset-on-host");
  return { item: entry, skip: null };
}

// Of repeated lines docker keeps the last, so only the last one is judged.
function lastPerName(entries: EnvFileEntry[]): EnvFileEntry[] {
  const valid = entries.filter((entry) => isEnvName(entry.name));
  const last = new Map(valid.map((entry) => [entry.name, entry]));
  return entries.filter((entry) => !isEnvName(entry.name) || last.get(entry.name) === entry);
}

function planFileEnv(text: string, input: SandboxEnvInput): { accepted: EnvFileEntry[]; skipped: SandboxEnvSkip[] } {
  return splitVerdicts(lastPerName(parseEnvFileText(text)).map((entry) => fileVerdict(entry, input)));
}

export function planSandboxEnv(input: SandboxEnvInput): SandboxEnvPlan {
  const named = splitVerdicts([...new Set(input.names)].map((name, index) => namedVerdict(name, index + 1, input)));
  const fromFile = input.envFile !== null && "text" in input.envFile ? planFileEnv(input.envFile.text, input) : { accepted: [], skipped: [] };
  return {
    nameArgs: named.accepted.flatMap((name) => ["-e", name]),
    stagedEnvFileText: fromFile.accepted.length === 0 ? null : `${fromFile.accepted.map((entry) => entry.line).join("\n")}\n`,
    fileNames: fromFile.accepted.map((entry) => entry.name),
    namedNames: named.accepted,
    skipped: [...fromFile.skipped, ...named.skipped],
  };
}
