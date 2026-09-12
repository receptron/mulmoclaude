// Workspace-scoped user settings, loaded fresh on every agent
// invocation so the UI can change things without a server restart.
//
// Layout under <workspace>/config/ (post-#284):
//   settings.json   ← AppSettings (this file)
//   mcp.json        ← user-defined MCP servers
//
// All helpers tolerate missing / malformed files by falling back to
// defaults. Writers perform an atomic replace (tmp + rename) so a
// reader never observes a half-written file.

import { mkdirSync } from "fs";
import path from "path";
import { log } from "./logger/index.js";
import { WORKSPACE_PATHS } from "../workspace/paths.js";
import { writeFileAtomicSync } from "../utils/files/atomic.js";
import { readTextSafeSync } from "../utils/files/safe.js";
import { isRecord, isStringArray, isStringRecord } from "../utils/types.js";

// Reasoning-effort levels accepted by `claude --effort`. Kept as a
// closed union so the validator + UI stay in lockstep; new levels
// added by the CLI must be mirrored here intentionally.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

// Model families accepted by `claude --model` (#2923). Deliberately
// aliases only, never a pinned id like `claude-opus-4-8`: an alias
// follows the user's saved choice onto the next generation, while a
// pinned id silently keeps them on a model that is eventually retired.
export const CHAT_MODELS = ["opus", "sonnet", "haiku"] as const;
export type ChatModel = (typeof CHAT_MODELS)[number];

// Chat-index summarizer setting (#1944). "off" disables the whole
// AI-title / summary / keywords background indexer; "haiku" / "sonnet"
// select the Claude model the summarizer spawns. Default (undefined)
// is treated as "off" — indexing is opt-in from Settings → Chat index
// so a fresh workspace doesn't burn CLI budget on scheduler/system
// automation sessions the user may never look at (see #1929 / #1944
// for the cost analysis). The origin filter (system + scheduler
// sessions always skipped) is enforced separately and does NOT
// depend on this setting.
export const CHAT_INDEX_MODES = ["off", "haiku", "sonnet"] as const;
export type ChatIndexMode = (typeof CHAT_INDEX_MODES)[number];

// Journal daily-pass setting (follow-up to #1944). Same three states as
// chat-index: "off" disables both the turn-end hook and the hourly
// scheduled pass; "haiku" / "sonnet" pick the Claude model the archivist
// CLI spawns for its summary calls. Default (undefined) is "off" so a
// fresh workspace doesn't burn CLI budget until the user opts in from
// Settings → Journal.
export const JOURNAL_MODES = ["off", "haiku", "sonnet"] as const;
export type JournalMode = (typeof JOURNAL_MODES)[number];

export interface AppSettings {
  // Extra tool names appended to BASE_ALLOWED_TOOLS in
  // server/agent/config.ts#buildCliArgs. Typical entries are
  // Claude Code built-in MCP prefixes like
  //   "mcp__claude_ai_Gmail"
  //   "mcp__claude_ai_Google_Calendar"
  extraAllowedTools: string[];

  // Google Maps JS API key. Pasted via Settings → Map tab and used
  // by `@gui-chat-plugin/google-map`'s View — passed through as a
  // prop from `App.vue`. Stored verbatim (local-desktop threat
  // model, same as Spotify token persistence).
  googleMapsApiKey?: string;

  // Photo-EXIF auto-capture (#1222 PR-A). When `autoCapture` is true
  // (the default), every saved attachment with an image MIME runs
  // through `readPhotoExif` and a sidecar JSON lands at
  // `data/locations/<YYYY>/<MM>/<id>.json`. Users opt out via
  // Settings → Privacy when they don't want GPS metadata captured
  // automatically (the future `manageMap` `extractExif` tool can
  // still read EXIF on demand).
  photoExif?: {
    autoCapture: boolean;
  };

  // Reasoning effort passed through as `claude --effort <level>` on
  // every agent invocation (#1323). Unset → flag is omitted →
  // Claude's own default.
  effortLevel?: EffortLevel;

  // Model family passed through as `claude --model <alias>` on every
  // agent invocation (#2923). Unset → flag is omitted → the CLI
  // resolves the model from `~/.claude/settings.json`, which is also
  // where other Claude Code clients (VS Code / Cursor) persist their
  // `/model` pick — so leaving this unset means a switch made in
  // another editor silently changes the model MulmoClaude runs on.
  chatModel?: ChatModel;

  // Local voice input (whisper.cpp). Ships off. `enabled` is the
  // user's explicit opt-in from Settings → Voice; flipping it true is
  // what triggers the model download. `model` is the selected GGML
  // model name (validated against the registry at the route layer, kept
  // as a free string here to avoid a low-level → whisper dependency).
  // See plans/done/feat-voice-input.md.
  voiceInput?: {
    enabled: boolean;
    model?: string;
  };

  // Chat-index summarizer mode (#1944). Ships "off" by default: the
  // background AI-title / summary / keywords indexer stays disabled
  // until the user opts in from Settings → Chat index. Flipping to
  // "haiku" or "sonnet" selects the model the summarizer spawns per
  // session. Non-user origins (`system`, `scheduler`) are always
  // skipped regardless of this value — see `indexer.ts`.
  chatIndex?: ChatIndexMode;

  // Journal daily-pass mode (follow-up to #1944). Ships "off" by
  // default: the archivist that summarizes chat sessions into
  // journal/*.md stays disabled until the user opts in from Settings →
  // Journal. Flipping to "haiku" / "sonnet" enables the run and picks
  // the Claude model the archivist CLI spawns. The turn-end hook
  // (`maybeRunJournal` in the agent finally block) and the hourly
  // `system:journal` scheduled task both honour this — off short-
  // circuits before the interval gate is even consulted.
  journal?: JournalMode;

  // Web Push on task finish (#2086). Ships off. When true, each finished
  // agent turn calls the mulmoserver `sendPush` Cloud Function so the user's
  // registered devices are notified. Only sends while the RemoteHost channel
  // is connected (that's what supplies the Firebase auth) — otherwise a no-op.
  pushEnabled?: boolean;

  // macOS Reminders sink (#789), on by default on darwin. The CLI flag
  // `--disable-macos-reminders` / `DISABLE_MACOS_REMINDER_NOTIFICATIONS=1`
  // still wins, but an icon launch (#2613) passes neither, so for those
  // users this setting is the only way to turn the sink off (#2617).
  macosRemindersEnabled?: boolean;
}

const DEFAULT_SETTINGS: AppSettings = { extraAllowedTools: [] };

// `AppSettings` is an interface, so its keys don't exist at runtime — but two
// consumers need them: the bug-report FAQ's `configKey:` pointers are verified
// against this list in CI, and the diagnostics report decides what it may print
// from it. The two `satisfies` below make the compiler reject a drifted list:
// a new field in `AppSettings` that isn't added here fails to build.
export const APP_SETTINGS_KEYS = [
  "extraAllowedTools",
  "googleMapsApiKey",
  "photoExif",
  "effortLevel",
  "chatModel",
  "voiceInput",
  "chatIndex",
  "journal",
  "pushEnabled",
  "macosRemindersEnabled",
] as const satisfies readonly (keyof AppSettings)[];

export type AppSettingsKey = (typeof APP_SETTINGS_KEYS)[number];

// Keys the diagnostics report may print VERBATIM. Deliberately an allow list:
// a setting added later is redacted until someone judges it safe, so the
// default on drift is "withhold" rather than "leak". `googleMapsApiKey` is the
// one secret stored in plaintext today and is absent by construction.
export const SAFE_SETTINGS_KEYS = [
  "extraAllowedTools",
  "photoExif",
  "effortLevel",
  "chatModel",
  "voiceInput",
  "chatIndex",
  "journal",
  "pushEnabled",
  "macosRemindersEnabled",
] as const satisfies readonly AppSettingsKey[];

export type SafeSettingsKey = (typeof SAFE_SETTINGS_KEYS)[number];

// `satisfies` above catches a typo'd or removed key, but not a MISSING one —
// a field added to `AppSettings` and forgotten here would still compile, and
// would then be invisible to both the FAQ check and the redactor. This turns
// that omission into a build error: the `extends never` bound only holds while
// nothing is left over.
type AssertNoUncovered<T extends never> = T;
export type UncoveredAppSettingsKey = AssertNoUncovered<Exclude<keyof AppSettings, AppSettingsKey>>;

export const SETTINGS_FILE_NAME = "settings.json";
export const MCP_FILE_NAME = "mcp.json";

export function configsDir(): string {
  return WORKSPACE_PATHS.configs;
}

export function settingsPath(): string {
  return path.join(configsDir(), SETTINGS_FILE_NAME);
}

export function mcpConfigPath(): string {
  return path.join(configsDir(), MCP_FILE_NAME);
}

export function ensureConfigsDir(): void {
  mkdirSync(configsDir(), { recursive: true });
}

function isPhotoExifSettings(value: unknown): value is { autoCapture: boolean } {
  return isRecord(value) && typeof value.autoCapture === "boolean";
}

function isEffortLevel(value: unknown): value is EffortLevel {
  return EFFORT_LEVELS.some((level) => level === value);
}

function isChatModel(value: unknown): value is ChatModel {
  return CHAT_MODELS.some((model) => model === value);
}

function isChatIndexMode(value: unknown): value is ChatIndexMode {
  return CHAT_INDEX_MODES.some((mode) => mode === value);
}

function isJournalMode(value: unknown): value is JournalMode {
  return JOURNAL_MODES.some((mode) => mode === value);
}

function isVoiceInputSettings(value: unknown): value is { enabled: boolean; model?: string } {
  if (!isRecord(value)) return false;
  if (typeof value.enabled !== "boolean") return false;
  if (value.model !== undefined && typeof value.model !== "string") return false;
  return true;
}

// Optional fields: each is either absent or must match its type.
const isOptionalBoolean = (value: unknown): boolean => value === undefined || typeof value === "boolean";
const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === "string";
const optional =
  (isValid: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === undefined || isValid(value);

type OptionalAppSettingsKey = Exclude<keyof AppSettings, "extraAllowedTools">;

// A table rather than a chain of ifs, for two reasons. The chain hit the
// cognitive-complexity ceiling once it reached nine settings, so every further
// field forced a reshuffle. And `Record<OptionalAppSettingsKey, …>` turns the
// real hazard — a field added to `AppSettings` and never validated, which
// would then be accepted from disk in any shape — into a build error.
const OPTIONAL_SETTING_VALIDATORS: Record<OptionalAppSettingsKey, (value: unknown) => boolean> = {
  googleMapsApiKey: isOptionalString,
  photoExif: optional(isPhotoExifSettings),
  effortLevel: optional(isEffortLevel),
  chatModel: optional(isChatModel),
  voiceInput: optional(isVoiceInputSettings),
  chatIndex: optional(isChatIndexMode),
  journal: optional(isJournalMode),
  pushEnabled: isOptionalBoolean,
  macosRemindersEnabled: isOptionalBoolean,
};

function hasValidOptionalAppSettings(value: Record<string, unknown>): boolean {
  return Object.entries(OPTIONAL_SETTING_VALIDATORS).every(([key, isValid]) => isValid(value[key]));
}

export function isAppSettings(value: unknown): value is AppSettings {
  if (!isRecord(value)) return false;
  if (!isStringArray(value.extraAllowedTools)) return false;
  return hasValidOptionalAppSettings(value);
}

// isAppSettingsPatch adds a null sentinel to `chatIndex` / `journal` (see below).

/** A PUT-payload validator: every field optional, but if present
 *  it must match the AppSettings shape. Distinct from
 *  `isAppSettings` (which insists on the full storage shape) so a
 *  tab that owns one field can patch it without echoing back fields
 *  it doesn't manage. The PUT handler merges the patch onto the
 *  current on-disk settings before saving.
 *
 *  Why two validators: the storage-shape invariant
 *  (`extraAllowedTools` is always an array) is preserved by
 *  `loadSettings` (DEFAULT_SETTINGS) + `saveSettings` (payload
 *  ensures the array). Loosening the storage validator would
 *  weaken that guarantee for code reading from `loadSettings`. */
/** Wire shape for a settings PUT patch. Mirrors `Partial<AppSettings>`
 *  but lets nullable fields carry `null` as a "clear me" sentinel —
 *  callers normalise via `normaliseAppSettingsPatch` before merging
 *  into the storage shape (#1323). */
export type AppSettingsPatch = Partial<Omit<AppSettings, "effortLevel" | "chatModel" | "chatIndex" | "journal">> & {
  effortLevel?: EffortLevel | null;
  chatModel?: ChatModel | null;
  chatIndex?: ChatIndexMode | null;
  journal?: JournalMode | null;
};

/** Convert a wire patch to the storage-shape patch by dropping any
 *  `null` sentinels (which mean "clear" for the corresponding field). */
export function normaliseAppSettingsPatch(patch: AppSettingsPatch): Partial<AppSettings> {
  const { effortLevel, chatModel, chatIndex, journal, ...rest } = patch;
  const out: Partial<AppSettings> = { ...rest };
  if (effortLevel !== null && effortLevel !== undefined) {
    out.effortLevel = effortLevel;
  }
  if (chatModel !== null && chatModel !== undefined) {
    out.chatModel = chatModel;
  }
  if (chatIndex !== null && chatIndex !== undefined) {
    out.chatIndex = chatIndex;
  }
  if (journal !== null && journal !== undefined) {
    out.journal = journal;
  }
  return out;
}

// Split each field's optional-with-null-sentinel validation into its own
// mini-helper so `isAppSettingsPatch` stays under the cognitive-complexity
// ceiling as new nullable fields land.
const isOptionalNullableEffortLevel = (value: unknown): boolean => value === undefined || value === null || isEffortLevel(value);
const isOptionalNullableChatModel = (value: unknown): boolean => value === undefined || value === null || isChatModel(value);
const isOptionalNullableChatIndexMode = (value: unknown): boolean => value === undefined || value === null || isChatIndexMode(value);
const isOptionalNullableJournalMode = (value: unknown): boolean => value === undefined || value === null || isJournalMode(value);

export function isAppSettingsPatch(value: unknown): value is AppSettingsPatch {
  if (!isRecord(value)) return false;
  if (value.extraAllowedTools !== undefined && !isStringArray(value.extraAllowedTools)) return false;
  if (!isOptionalString(value.googleMapsApiKey)) return false;
  if (value.photoExif !== undefined && !isPhotoExifSettings(value.photoExif)) return false;
  if (!isOptionalNullableEffortLevel(value.effortLevel)) return false;
  if (!isOptionalNullableChatModel(value.chatModel)) return false;
  if (value.voiceInput !== undefined && !isVoiceInputSettings(value.voiceInput)) return false;
  if (!isOptionalNullableChatIndexMode(value.chatIndex)) return false;
  if (!isOptionalNullableJournalMode(value.journal)) return false;
  if (!isOptionalBoolean(value.pushEnabled)) return false;
  if (!isOptionalBoolean(value.macosRemindersEnabled)) return false;
  return true;
}

function parseSettingsRaw(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn("config", "settings.json is not valid JSON — using defaults", { file, error: String(err) });
    return null;
  }
}

/** Defensive copy — callers shouldn't be able to mutate the file on
 *  disk by mutating the returned object. New optional fields added
 *  to `AppSettings` need a line here too (loadSettings is the choke
 *  point that propagates them). */
function cloneAppSettings(settings: AppSettings): AppSettings {
  const copy: AppSettings = { extraAllowedTools: [...settings.extraAllowedTools] };
  if (settings.googleMapsApiKey !== undefined) {
    copy.googleMapsApiKey = settings.googleMapsApiKey;
  }
  if (settings.photoExif !== undefined) {
    copy.photoExif = { autoCapture: settings.photoExif.autoCapture };
  }
  if (settings.effortLevel !== undefined) {
    copy.effortLevel = settings.effortLevel;
  }
  if (settings.chatModel !== undefined) {
    copy.chatModel = settings.chatModel;
  }
  if (settings.voiceInput !== undefined) {
    copy.voiceInput = { enabled: settings.voiceInput.enabled };
    if (settings.voiceInput.model !== undefined) {
      copy.voiceInput.model = settings.voiceInput.model;
    }
  }
  if (settings.chatIndex !== undefined) {
    copy.chatIndex = settings.chatIndex;
  }
  if (settings.journal !== undefined) {
    copy.journal = settings.journal;
  }
  if (settings.pushEnabled !== undefined) {
    copy.pushEnabled = settings.pushEnabled;
  }
  if (settings.macosRemindersEnabled !== undefined) {
    copy.macosRemindersEnabled = settings.macosRemindersEnabled;
  }
  return copy;
}

/** Chat-index mode with the documented "undefined → off" default, so
 *  every reader (indexer, backfill scheduler, force-startup switch,
 *  Settings tab) resolves the same way. Callers switch on the
 *  returned literal string to decide skip vs pick a model. */
export function chatIndexMode(settings: AppSettings): ChatIndexMode {
  return settings.chatIndex ?? "off";
}

/** Journal mode with the documented "undefined → off" default, so
 *  every reader (turn-end hook, hourly scheduler, force-startup
 *  switch, Settings tab) resolves the same way. Callers switch on
 *  the returned literal string to decide skip vs pick a model. */
export function journalMode(settings: AppSettings): JournalMode {
  return settings.journal ?? "off";
}

/** Read the photo-exif auto-capture flag with the documented
 *  default of `true`. Centralises the "missing block ⇒ on" rule so
 *  the post-save hook + future Settings UI stay aligned. */
export function isPhotoExifAutoCaptureEnabled(settings: AppSettings): boolean {
  return settings.photoExif?.autoCapture ?? true;
}

/** Web-push-on-task-finish flag with the documented default of `false`.
 *  Centralises the "missing ⇒ off" rule so the turn-end trigger and the
 *  Settings UI stay aligned. */
export function isPushEnabled(settings: AppSettings): boolean {
  return settings.pushEnabled ?? false;
}

/** macOS Reminders sink flag with the documented default of `true`.
 *  It shipped enabled (#789), so a settings file written before this
 *  field existed must keep firing reminders. */
export function isMacosRemindersEnabled(settings: AppSettings): boolean {
  return settings.macosRemindersEnabled ?? true;
}

export function loadSettings(): AppSettings {
  const file = settingsPath();
  const raw = readTextSafeSync(file);
  if (raw === null) return { ...DEFAULT_SETTINGS };
  const parsed = parseSettingsRaw(raw, file);
  if (parsed === null) return { ...DEFAULT_SETTINGS };
  // Accept the partial-patch shape, not just the full storage shape.
  // A user who hand-edits `settings.json` to only set the fields they
  // care about (`{ "photoExif": { "autoCapture": false } }` per the
  // PR-A docs) shouldn't have their opt-out silently ignored just
  // because `extraAllowedTools` is omitted. Missing fields fall back
  // to DEFAULT_SETTINGS; only structurally-invalid payloads (wrong
  // type on a present field) trigger the schema-warning fallback.
  // (Codex review on PR #1247.)
  if (!isAppSettingsPatch(parsed)) {
    log.warn("config", "settings.json does not match AppSettings schema — using defaults", { file });
    return { ...DEFAULT_SETTINGS };
  }
  return cloneAppSettings({ ...DEFAULT_SETTINGS, ...normaliseAppSettingsPatch(parsed) });
}

export function saveSettings(settings: AppSettings): void {
  if (!isAppSettings(settings)) {
    throw new Error("saveSettings: invalid AppSettings shape");
  }
  ensureConfigsDir();
  const payload: AppSettings = { extraAllowedTools: [...settings.extraAllowedTools] };
  if (settings.googleMapsApiKey !== undefined) {
    payload.googleMapsApiKey = settings.googleMapsApiKey;
  }
  if (settings.photoExif !== undefined) {
    payload.photoExif = { autoCapture: settings.photoExif.autoCapture };
  }
  if (settings.effortLevel !== undefined) {
    payload.effortLevel = settings.effortLevel;
  }
  if (settings.chatModel !== undefined) {
    payload.chatModel = settings.chatModel;
  }
  if (settings.voiceInput !== undefined) {
    payload.voiceInput = { enabled: settings.voiceInput.enabled };
    if (settings.voiceInput.model !== undefined) {
      payload.voiceInput.model = settings.voiceInput.model;
    }
  }
  if (settings.chatIndex !== undefined) {
    payload.chatIndex = settings.chatIndex;
  }
  if (settings.journal !== undefined) {
    payload.journal = settings.journal;
  }
  if (settings.pushEnabled !== undefined) {
    payload.pushEnabled = settings.pushEnabled;
  }
  if (settings.macosRemindersEnabled !== undefined) {
    payload.macosRemindersEnabled = settings.macosRemindersEnabled;
  }
  const serialised = JSON.stringify(payload, null, 2);
  writeFileAtomicSync(settingsPath(), `${serialised}\n`, { mode: 0o600 });
}

// ── MCP user-defined servers ────────────────────────────────────
//
// Stored under <workspace>/config/mcp.json in the Claude CLI's
// standard `--mcp-config` shape so the file is portable:
//   { "mcpServers": { "<id>": <McpServerSpec> } }
//
// A server is either HTTP (remote, always Docker-safe) or stdio
// (local command). See plans/done/feat-web-settings-ui.md for Phase 2a /
// 2b scope notes.

export interface McpHttpSpec {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** Legacy MCP HTTP+SSE transport. NOT accepted in user config
 *  (`isMcpServerSpec` rejects it) — it exists only because the
 *  host-exec shim's gateway speaks SSE, and the spec handed to the
 *  CLI must name the transport the gateway actually serves (#3018). */
export interface McpSseSpec {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpStdioSpec {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  /** Opt-in (#1421 Phase B): when true AND the agent runs in Docker
   *  sandbox mode, this stdio server is NOT dropped — instead it is
   *  spawned on the HOST behind a stdio↔HTTP gateway and the
   *  sandboxed agent reaches it over `host.docker.internal`. This
   *  DELIBERATELY escapes the sandbox for this one server; the
   *  Settings UI requires an explicit risk acknowledgment to set
   *  it. Unset / false → default behavior (dropped + warned). */
  hostExecInDocker?: boolean;
}

export type McpServerSpec = McpHttpSpec | McpStdioSpec;

/** What `prepareUserServers` hands downstream. Wider than the
 *  user-writable `McpServerSpec` because the host-exec shim turns an
 *  opted-in stdio entry into an `sse` spec pointing at its gateway. */
export type PreparedMcpServerSpec = McpServerSpec | McpSseSpec;

// UI-friendly flat array form. Storage uses the record form; conversion
// helpers below keep the two in sync.
export interface McpServerEntry {
  id: string;
  spec: McpServerSpec;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerSpec>;
}

const DEFAULT_MCP: McpConfigFile = { mcpServers: {} };

// Accepts only allow-listed commands for stdio servers — user input
// that asks Claude to spawn arbitrary binaries (eg. a shell one-liner)
// is rejected upstream. Anything that needs more tools should go in
// the sandbox image (see #162), not here.
const STDIO_COMMAND_ALLOWLIST = new Set(["npx", "node", "tsx"]);

// Accept only http: / https: URLs. Rejects malformed strings, other
// protocols (ftp:, file:, javascript:, ...), and empty values so bad
// endpoints can't be persisted even if a client bypasses the UI.
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isMcpHttpSpec(value: unknown): value is McpHttpSpec {
  if (!isRecord(value)) return false;

  if (value.type !== "http") return false;
  if (typeof value.url !== "string" || !isHttpUrl(value.url)) return false;
  if (value.headers !== undefined && !isStringRecord(value.headers)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  return true;
}

export function isMcpStdioSpec(value: unknown): value is McpStdioSpec {
  if (!isRecord(value)) return false;

  if (value.type !== "stdio") return false;
  if (typeof value.command !== "string" || value.command.length === 0) return false;
  if (!STDIO_COMMAND_ALLOWLIST.has(value.command)) return false;
  if (value.args !== undefined && !isStringArray(value.args)) return false;
  if (value.env !== undefined && !isStringRecord(value.env)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (value.hostExecInDocker !== undefined && typeof value.hostExecInDocker !== "boolean") return false;
  return true;
}

export function isMcpServerSpec(value: unknown): value is McpServerSpec {
  return isMcpHttpSpec(value) || isMcpStdioSpec(value);
}

// Workspace id must be slug-shaped so it survives being used as the
// mcpServers map key and in the `mcp__<id>__<tool>` tool naming.
//
// Consecutive `__` is forbidden inside the id because `__` is the
// delimiter in the tool-name encoding — a server id like `foo__bar`
// produces `mcp__foo__bar__tool`, which is ambiguous between server
// `foo` (tool `bar__tool`) and server `foo__bar` (tool `tool`).
// Forbidding `__` in the id keeps the convention unambiguous
// everywhere (Codex review on #1356).
const MCP_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export function isMcpServerId(value: unknown): value is string {
  return typeof value === "string" && MCP_ID_RE.test(value) && !value.includes("__");
}

export function isMcpConfigFile(value: unknown): value is McpConfigFile {
  if (!isRecord(value)) return false;

  const servers = value.mcpServers;
  if (!isRecord(servers)) return false;
  for (const [serverId, spec] of Object.entries(servers)) {
    if (!isMcpServerId(serverId)) return false;
    if (!isMcpServerSpec(spec)) return false;
  }
  return true;
}

export function loadMcpConfig(): McpConfigFile {
  const file = mcpConfigPath();
  const raw = readTextSafeSync(file);
  if (raw === null) return { mcpServers: { ...DEFAULT_MCP.mcpServers } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn("config", "mcp.json is not valid JSON — using defaults", {
      file,
      error: String(err),
    });
    return { mcpServers: {} };
  }
  if (!isMcpConfigFile(parsed)) {
    log.warn("config", "mcp.json does not match McpConfigFile schema — using defaults", { file });
    return { mcpServers: {} };
  }
  return parsed;
}

export function saveMcpConfig(cfg: McpConfigFile): void {
  if (!isMcpConfigFile(cfg)) {
    throw new Error("saveMcpConfig: invalid McpConfigFile shape");
  }
  ensureConfigsDir();
  const serialised = JSON.stringify(cfg, null, 2);
  writeFileAtomicSync(mcpConfigPath(), `${serialised}\n`, { mode: 0o600 });
}

// Flatten storage form to UI-friendly array.
export function toMcpEntries(cfg: McpConfigFile): McpServerEntry[] {
  return Object.entries(cfg.mcpServers).map(([serverId, spec]) => ({ id: serverId, spec }));
}

// Re-inflate UI-friendly array to storage form. Duplicate ids are
// rejected so the record shape stays lossless.
export function fromMcpEntries(entries: McpServerEntry[]): McpConfigFile {
  const out: Record<string, McpServerSpec> = {};
  for (const { id, spec } of entries) {
    if (!isMcpServerId(id)) {
      throw new Error(`invalid MCP server id: ${JSON.stringify(id)}`);
    }
    if (id in out) {
      throw new Error(`duplicate MCP server id: ${id}`);
    }
    if (!isMcpServerSpec(spec)) {
      throw new Error(`invalid MCP server spec for id ${id}`);
    }
    out[id] = spec;
  }
  return { mcpServers: out };
}
