// Single source of truth for environment-variable reads.
//
// Before this module existed, `process.env.X` calls were sprinkled
// across 8 files with each call site doing its own type coercion
// (`Number(process.env.PORT) || 3001`, `process.env.X === "1"`, …).
// Renaming an env var, changing a default, or auditing what we read
// from the environment all required grepping the codebase.
//
// All env-var reads should now go through `env.*`. The exception is
// `server/logger/config.ts` which has its own self-contained env
// reader (`resolveConfig(env)`) — that subsystem stays independent
// because it's loaded at extremely early bootstrap and accepts an
// arbitrary `env`-shaped object for testability.
//
// `docs/developer.md` lists every env var and what it does; this
// module is the runtime side of that table.

import { CLI_FLAGS } from "../utils/cli-flags.mjs";

// ── Type coercion helpers ───────────────────────────────────────────

// `asInt` moved to `../utils/envCoerce.ts` (#2650): `yarn dev`'s Vite proxy has
// to coerce `PORT` by exactly this rule, from outside the server tsconfig, and a
// second implementation would let the two disagree about which server to talk to.
import { asInt, DEFAULT_PORT, PORT_RANGE } from "../utils/envCoerce.js";

function asFlag(value: string | undefined): boolean {
  // Established convention in this project: env flags are "1"
  // (truthy) vs anything else (falsy). Avoids the trap of
  // `process.env.FOO === "false"` evaluating truthy as a string.
  return value === "1";
}

// Env vars also switched on by a CLI flag on this process's argv.
// The npx launcher injects the env var into the spawned server, so
// its path doesn't rely on this; this covers a direct
// `tsx server/index.ts` / `yarn dev --<flag>` run. Computed once at
// module load — same lifetime as the env snapshot below. (#1089.)
const argvEnabledEnv = new Set<string>(CLI_FLAGS.filter(({ flag }) => process.argv.includes(flag)).map(({ env: envName }) => envName));

function flagOf(envName: string): boolean {
  return asFlag(process.env[envName]) || argvEnabledEnv.has(envName);
}

function asCsv(value: string | undefined): readonly string[] {
  return Object.freeze(
    (value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

// ── Snapshot ────────────────────────────────────────────────────────

/**
 * Frozen snapshot of every env var the app reads, with type coercion
 * and defaults baked in. Read at module load time so tests can
 * import a stable view without re-reading process.env on every
 * access.
 */
export const env = Object.freeze({
  // HTTP server
  port: asInt(process.env.PORT, DEFAULT_PORT, PORT_RANGE),
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: process.env.NODE_ENV === "production",
  // Start even when another instance is already serving this workspace
  // (#3079). Off by default: the two would overwrite each other's
  // `.session-token`, and the damage that follows is silent. See
  // `server/utils/instance-guard.mjs`.
  allowMultipleInstances: flagOf("MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES"),

  // Claude Code CLI config-location overrides (issue #87 §2). Both undefined →
  // `server/utils/claudeConfigPath.ts` falls back to `homedir()/.claude` +
  // `homedir()/.claude.json`. Set when your Claude install writes elsewhere
  // (Windows corp redirect, sandboxed test fixture, future Anthropic location
  // change). `CLAUDE_CONFIG_DIR` alone is enough: `.claude.json` lives inside
  // that directory, so the helper resolves both from it (#2654).
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
  claudeConfigJson: process.env.CLAUDE_CONFIG_JSON,

  // Sandbox / Docker
  disableSandbox: flagOf("DISABLE_SANDBOX"),
  // Debug aid: also persist `tool_call` events to the session
  // jsonl (the `tool_result` side already lands on disk). Off by
  // default because args can be large and may carry payload bytes
  // the user didn't expect to land in this exact form. See
  // plans/done/feat-persist-tool-calls.md / issue #1096.
  persistToolCalls: flagOf("PERSIST_TOOL_CALLS"),
  // Host-credential opt-ins for the Docker sandbox (#259). Both off
  // by default. See docs/sandbox-credentials.md for the contract.
  sandboxSshAgentForward: asFlag(process.env.SANDBOX_SSH_AGENT_FORWARD),
  sandboxSshAllowedHosts: process.env.SANDBOX_SSH_ALLOWED_HOSTS || "github.com",
  sandboxMountConfigs: asCsv(process.env.SANDBOX_MOUNT_CONFIGS),

  // API credentials (undefined when not configured)
  geminiApiKey: process.env.GEMINI_API_KEY,
  xBearerToken: process.env.X_BEARER_TOKEN,

  // Bearer auth token (#272, #316): if set, the server uses this
  // verbatim instead of generating a fresh random token at startup.
  // Matches the env var already honoured by `bridges/_lib/token.ts`
  // and the Vite dev plugin, so pinning on both sides survives a
  // server restart. Undefined / empty → random-per-startup path.
  authTokenOverride: process.env.MULMOCLAUDE_AUTH_TOKEN,

  // Sessions index API
  sessionsListWindowDays: asInt(process.env.SESSIONS_LIST_WINDOW_DAYS, 90, {
    min: 0,
  }),

  // Debug-only force-run flags. Off by default; `=1` triggers an
  // immediate run on startup instead of waiting for the scheduled
  // interval.
  journalForceRunOnStartup: flagOf("JOURNAL_FORCE_RUN_ON_STARTUP"),
  chatIndexForceRunOnStartup: flagOf("CHAT_INDEX_FORCE_RUN_ON_STARTUP"),

  // Evaluation-only ablation switches. Comma-separated component names
  // that are DISABLED for baseline comparisons (systems-paper E2):
  //   "validation" — manageCollection putItems skips pre-write record
  //     validation, and the getItems / presentCollection best-effort
  //     record scans stop reporting issues to the model.
  //   "reconciler" — collection watchers (fs.watch + wall-clock tick)
  //     are not started: no completion bells, no trigger reminders, no
  //     spawn recurrence.
  // Never set in normal operation; the server logs a warning at boot
  // when any ablation is active. See also MULMOCLAUDE_FAKE_NOW
  // (packages/core collection-watchers/clock.ts) for the companion
  // deterministic-time switch.
  ablation: asCsv(process.env.MULMOCLAUDE_ABLATION),

  // macOS Reminder notification sink (#789). Darwin-only; iCloud
  // Reminders sync mirrors the entry to the user's iPhone, which
  // delivers the system notification. **On by default** on macOS —
  // first run will prompt the user for Reminders.app access, which
  // is the right place to consent. Set
  // `DISABLE_MACOS_REMINDER_NOTIFICATIONS=1` to opt out (e.g. for
  // a shared dev box where the iPhone owner shouldn't get pinged).
  // Mirrors the `DISABLE_SANDBOX` convention.
  disableMacosReminderNotifications: flagOf("DISABLE_MACOS_REMINDER_NOTIFICATIONS"),

  // MulmoBridge Relay (#520). Optional — when both are set the server
  // connects to the Relay via WebSocket and forwards bridge messages.
  relayUrl: process.env.RELAY_URL,
  relayToken: process.env.RELAY_TOKEN,

  // CSRF guard — opt-in trusted Origin allowlist for cross-origin
  // state-changing requests. `requireSameOrigin` allows localhost +
  // anything in this list and 403s every other Origin. Use case:
  // the user accesses the Vite dev server from another LAN device
  // (iPad on `http://192.168.x.x:5173`) where the browser sends the
  // LAN-IP Origin and the localhost-only check would otherwise fail.
  // Values are matched verbatim against the request `Origin` header
  // (scheme + host + port, no trailing slash). Comma-separated for
  // multiple entries. The literal string `null` is rejected even if
  // listed — browsers send it for sandboxed iframes / file:// /
  // data: pages, none of which are trustworthy origins. See
  // `NULL_ORIGIN_LITERAL` in server/api/csrfGuard.ts.
  trustedOrigins: asCsv(process.env.MULMOCLAUDE_TRUSTED_ORIGINS),

  // MCP subprocess: set by the parent server when spawning
  // mcp-server.ts. The MCP process reads them via this same module —
  // OS-level env vars are shared across both processes.
  mcpSessionId: process.env.SESSION_ID ?? "",
  /** Identity of THIS broker process, set by the parent per spawn. Lets the
   *  host discard a startup beacon from an attempt it has already replaced
   *  (#2842). Empty when the broker was launched outside a real turn. */
  mcpSpawnId: process.env.MCP_SPAWN_ID ?? "",
  mcpHost: process.env.MCP_HOST ?? "localhost",
  mcpPluginNames: asCsv(process.env.PLUGIN_NAMES),
});

// ── Derived helpers ─────────────────────────────────────────────────

/** True iff a Gemini API key is configured. Drives the "image
 *  generation available" hint in the UI. */
export function isGeminiAvailable(): boolean {
  return env.geminiApiKey !== undefined && env.geminiApiKey !== "";
}

/** The components MULMOCLAUDE_ABLATION may disable (evaluation-only —
 *  see the `ablation` entry above). The union type is the single source
 *  of truth for component names: call sites write `isAblated("...")`
 *  and a typo is a compile error rather than a silently-inactive switch. */
export type AblationComponent = "validation" | "reconciler";

/** True iff the named component is disabled via MULMOCLAUDE_ABLATION. */
export function isAblated(component: AblationComponent): boolean {
  return env.ablation.includes(component);
}
