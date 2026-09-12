import { basename, dirname, join } from "path";
import { homedir, tmpdir } from "os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Role } from "../../src/config/roles.js";
import { mcpTools, isMcpToolEnabled } from "./mcp-tools/index.js";
import { getActiveToolDescriptors } from "./activeTools.js";
import type { ChatModel, EffortLevel, McpServerSpec, PreparedMcpServerSpec } from "../system/config.js";
import { startStdioHttpShim, type ShimHandle } from "./stdioHttpShim.js";
import { claudeConfigDir, claudeConfigJson } from "../utils/claudeConfigPath.js";
import { getCurrentToken } from "../api/auth/token.js";
import { ONE_MINUTE_MS } from "../utils/time.js";
import type { Attachment } from "@mulmobridge/protocol";
import { isImageMime, isNativeAttachmentMime } from "@mulmobridge/client";
import { convertAttachment } from "./attachmentConverter.js";
import { log } from "../system/logger/index.js";
import { isRecord } from "../utils/types.js";
import { preflightUserServers, logPreflightResult } from "./mcpPreflight.js";
import { CONTAINER_WORKSPACE_PATH } from "./containerPaths.js";

// Lives in a leaf module so an mcp-tool can read it without importing this
// file, which imports `mcp-tools/index.js` and would close a cycle.
export { CONTAINER_WORKSPACE_PATH } from "./containerPaths.js";

// Junction-free NODE_PATH fallback root for the in-container MCP child.
// On Windows the yarn-workspace `node_modules/@mulmoclaude/*` links are
// absolute junctions that dangle inside the Linux container (#1946), so
// each workspace package is also bind-mounted here as
// `@mulmoclaude/<name>` and this dir is appended to NODE_PATH — CJS
// resolution falls through to it when the primary link fails to resolve.
// Only mounted for win32 source builds; a no-op path elsewhere.
//
// NODE_PATH is CJS-only per Node's spec, so the paired
// `mcp-esm-loader.mjs` (registered via `--import`) covers the ESM side
// by reading each pkg's package.json under this root and returning the
// resolved entry URL (#1982).
const CONTAINER_WORKSPACE_MODULES_PATH = "/app/pkg_modules";
// `--import` this bootstrap; the bootstrap in turn calls
// `node:module.register()` on the loader. Pointing `--import`
// straight at the loader would just evaluate its top level and
// leave the exported `resolve()` inert.
const CONTAINER_ESM_BOOTSTRAP_URL = "file:///app/server/agent/mcp-esm-bootstrap.mjs";

// `--import`ed ahead of everything else so it runs before the broker's own
// entry is loaded — that is what makes "the process exists" observable
// separately from "the process finished booting" (#2842). Passed on BOTH spawn
// paths and in both modes, because the question it answers ("did this thing
// launch at all?") is the same everywhere.
const START_BEACON_FILENAME = "mcp-start-beacon.mjs";
const CONTAINER_START_BEACON_URL = `file:///app/server/agent/${START_BEACON_FILENAME}`;

// `Skill` is the tool Claude Code uses to execute a discovered
// `.claude/skills/<name>/SKILL.md`. Because `--allowedTools` is passed
// as a strict allowlist, omitting it permission-denies every
// `Skill({skill:"…"})` call — the harness errors with
// `Execute skill: <name>` and the model falls back to Glob+Read.
// Bare `Skill` (no parens) permits all skills. See
// plans/done/fix-skill-tool-allowlist.md.
const BASE_ALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Skill"];

// Pre-allow every tool published by Anthropic's claude.ai account-
// level connectors so the agent can call them without firing a
// per-tool "Claude requested permission to use ..." prompt mid-turn
// inside MulmoClaude. The user still controls connector enable /
// disable via `claude` interactive `/mcp`; this list is purely a
// permission-prompt suppressor.
//
// Format: per-server shorthand `mcp__<server>`. The CLI expands it
// to every tool that server publishes. We avoid `~/.claude.json`
// reads (Docker-fragile, invasive) and avoid the
// `mcp__claude_ai_*` cross-server glob (not a documented
// --allowedTools shape — undefined behaviour even if CLI accepts the
// syntax).
//
// Maintenance: when the user enables a new Anthropic connector that
// MulmoClaude should pre-allow, append a `mcp__claude_ai_<DisplayName>`
// entry here. The server-id mapping is `display name with [\s.] → _`
// (e.g. `claude.ai Google Drive` → `mcp__claude_ai_Google_Drive`).
// Confirm the live spelling against `~/.claude.json`'s
// `claudeAiMcpEverConnected` list — that's the canonical display
// name Anthropic ships in the account-level connector picker, and
// hand-entered guesses (`Atlassian Jira` vs `Atlassian`) misfire
// silently.
//
// A spelling that doesn't match a real server is a no-op (the entry
// is just an unused `--allowedTools` argument), so the cost of
// over-listing is zero — better to include a connector that may not
// exist yet than to make users edit Settings → Allowed Tools every
// time Anthropic ships a new one (#1715).
const CLAUDE_AI_CONNECTOR_SERVERS = [
  // Google + Slack — Anthropic's original first-party set.
  "mcp__claude_ai_Gmail",
  "mcp__claude_ai_Google_Calendar",
  "mcp__claude_ai_Google_Drive",
  "mcp__claude_ai_Slack",
  // Anthropic's expanding catalog (alphabetical). When the actual
  // claude.ai display name uses spaces or dots, replace them with
  // underscores — see the rule at the top of this block.
  "mcp__claude_ai_Asana",
  "mcp__claude_ai_Atlassian",
  "mcp__claude_ai_Box",
  "mcp__claude_ai_Calendly",
  "mcp__claude_ai_Canva",
  "mcp__claude_ai_ClickUp",
  "mcp__claude_ai_Cloudflare",
  "mcp__claude_ai_Figma",
  "mcp__claude_ai_GitHub",
  "mcp__claude_ai_HubSpot",
  "mcp__claude_ai_Intercom",
  "mcp__claude_ai_Linear",
  "mcp__claude_ai_Notion",
  "mcp__claude_ai_PagerDuty",
  "mcp__claude_ai_Plaid",
  "mcp__claude_ai_Salesforce",
  "mcp__claude_ai_Sentry",
  "mcp__claude_ai_Stripe",
  "mcp__claude_ai_Zapier",
];

/** Tool names the agent is allowed to call this session. Drives
 *  `PLUGIN_NAMES` env (the MCP child's filter) and the CLI's
 *  `--allowedTools` arg. Static GUI / MCP plugins are gated by
 *  `role.availablePlugins`; runtime plugins (#1043 C-2) are always
 *  active. See `activeTools.ts` for the unified list. */
export function getActivePlugins(role: Role): string[] {
  return getActiveToolDescriptors(role).map((descriptor) => descriptor.name);
}

export interface McpConfigParams {
  /** Stable chat session ID (not the per-run UUID). Used as SESSION_ID
   *  env var so the MCP server's /internal/* callbacks address the
   *  session store by chatSessionId. */
  chatSessionId: string;
  port: number;
  activePlugins: string[];
  useDocker?: boolean;
  // User-defined MCP servers, AFTER `prepareUserServers`. Keys become
  // the server id in the generated --mcp-config file. Users may only
  // write `http` / `stdio` (`isMcpServerSpec` rejects the rest), but a
  // prepared value may also be `sse` — the host-exec shim rewrites an
  // opted-in stdio entry to the gateway it started (#3018).
  userServers?: Record<string, PreparedMcpServerSpec>;
  /** The turn's already-resolved broker, so this config and the turn's
   *  `broker=` log line describe the same one. See `resolveBrokerSpawn`. */
  broker?: BrokerSpawn;
  /** Identity of the broker this config will spawn, echoed back by its
   *  startup beacon so a superseded attempt's reading can be discarded. */
  spawnId?: string;
  /** Where the broker writes its start marker, in the coordinates the broker
   *  sees. See `resolveBrokerStartMarkerPaths`. */
  startMarkerPath?: string;
}

// In Docker mode the sandbox container can't reach the host's
// `localhost` / `127.0.0.1` — those refer to the container's own
// loopback interface. Rewriting to `host.docker.internal` keeps
// user-configured local MCP servers reachable.
export function rewriteLocalhostForDocker(url: string, useDocker: boolean): string {
  if (!useDocker) return url;
  return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/, "$1host.docker.internal");
}

function prepareUserHttpServer(spec: Extract<McpServerSpec, { type: "http" }>, useDocker: boolean): McpServerSpec {
  return {
    ...spec,
    url: rewriteLocalhostForDocker(spec.url, useDocker),
  };
}

// Rewrite stdio args so paths that point inside the host workspace are
// translated to their container equivalents. Paths outside the
// workspace are left alone — the caller surfaces a warning in the UI
// before they get this far.
function prepareUserStdioServer(spec: Extract<McpServerSpec, { type: "stdio" }>, useDocker: boolean, hostWorkspacePath: string): McpServerSpec {
  if (!useDocker) return spec;
  const normalisedWs = hostWorkspacePath.endsWith("/") ? hostWorkspacePath : `${hostWorkspacePath}/`;
  const args = spec.args?.map((arg) => {
    if (arg === hostWorkspacePath) return CONTAINER_WORKSPACE_PATH;
    if (arg.startsWith(normalisedWs)) {
      const rel = arg.slice(normalisedWs.length);
      return `${CONTAINER_WORKSPACE_PATH}/${rel}`;
    }
    return arg;
  });
  // Keep `args` absent when the source spec declared none — the prepared spec
  // is serialized into the MCP config the agent reads.
  return { ...spec, ...(args !== undefined ? { args } : {}) };
}

export interface PreparedUserServers {
  servers: Record<string, PreparedMcpServerSpec>;
  /** Host-side stdio→HTTP gateways started for opted-in servers
   *  (#1421 Phase B). The caller MUST `close()` each one when the
   *  agent turn ends, or host processes / ports leak. */
  shims: ShimHandle[];
}

/** Starts the host-side gateway for an opted-in stdio server.
 *  Injectable so the success path can be covered without spawning a
 *  real host process — the mislabelled transport in #3018 shipped
 *  because only the drop paths were reachable from a test. */
export type StartShim = typeof startStdioHttpShim;

// Async because the opt-in stdio→HTTP path spawns a host gateway and
// waits for it to listen before the spec can be rewritten to sse.
export async function prepareUserServers(
  userServers: Record<string, McpServerSpec>,
  useDocker: boolean,
  hostWorkspacePath: string,
  startShim: StartShim = startStdioHttpShim,
): Promise<PreparedUserServers> {
  // Drop catalog-known entries that are missing required config (#1352).
  // The dedup cache inside `logPreflightResult` keeps per-agent-run
  // calls quiet so a Settings UI fix only logs once when it transitions
  // missing → ok.
  const preflight = preflightUserServers(userServers);
  logPreflightResult(preflight, "agent-run");
  const out: Record<string, PreparedMcpServerSpec> = {};
  const shims: ShimHandle[] = [];
  for (const [serverId, spec] of Object.entries(preflight.ready)) {
    if (spec.enabled === false) continue;
    if (spec.type === "http") {
      out[serverId] = prepareUserHttpServer(spec, useDocker);
      continue;
    }
    if (!useDocker) {
      out[serverId] = prepareUserStdioServer(spec, useDocker, hostWorkspacePath);
      continue;
    }
    // Docker mode + stdio. Default: drop (the sandbox image can't
    // host arbitrary stdio runtimes — docs/mcp-sandbox.md, #162 /
    // #1334). Exception: an explicit, UI-acknowledged opt-in
    // (#1421 Phase B) runs the server on the HOST behind a
    // stdio↔HTTP gateway and rewrites the spec to http so the
    // sandboxed agent can still reach it.
    if (spec.hostExecInDocker === true) {
      const shim = await startShim(serverId, spec, hostWorkspacePath);
      if (shim) {
        shims.push(shim);
        // MUST be "sse", not "http": the gateway speaks the legacy
        // HTTP+SSE transport (supergateway defaults to it for
        // `--stdio`), which serves GET on the stream path and POST on
        // a separate one. Declaring "http" makes the CLI POST
        // `initialize` to the stream path, get a 404, and register the
        // server with zero tools — silently, because the readiness
        // probe only ever GETs. See #3018.
        out[serverId] = { type: "sse", url: rewriteLocalhostForDocker(shim.url, useDocker) };
        continue;
      }
      // Shim failed to come up — fall through to the safe default
      // (drop + log) rather than wiring a half-broken server.
    }
    log.info("mcp", "skipping stdio server in Docker sandbox", {
      serverId,
      transport: "stdio",
      reason:
        spec.hostExecInDocker === true
          ? "host-exec shim unavailable — see mcp-shim warnings"
          : "sandbox image is too minimal to host arbitrary stdio MCP runtimes",
    });
  }
  return { servers: out, shims };
}

// When running in Docker the MCP server subprocess won't inherit the host
// environment. Pass sentinel values for required env vars of enabled tools
// so isMcpToolEnabled() returns the same result inside the container.
// The actual API calls happen on the host server, so real values aren't needed.
function collectMcpToolSentinelEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const tool of mcpTools.filter(isMcpToolEnabled)) {
    for (const key of tool.requiredEnv ?? []) {
      if (process.env[key]) env[key] = "1";
    }
  }
  return env;
}

// `process.cwd()` is unreliable: when launched via the package bin
// (`npx mulmoclaude` / `node packages/mulmoclaude/bin/mulmoclaude.js`),
// cwd is the package directory. Under yarn workspaces that dir's
// `node_modules/` is empty (deps hoisted to repo root), so mounting it
// into the sandbox at `/app/node_modules` causes the MCP child to
// crash on startup with `Cannot find module 'express'` — silently,
// because the failure happens before the MCP `initialize` handshake.
// Resolving through a known npm dep lands on the populated
// `node_modules/` in both dev (yarn workspace, repo root) and prod
// (npx, package root with installed deps).
function resolveProjectRoot(): string {
  try {
    const req = createRequire(import.meta.url);
    const expressPkgJson = req.resolve("express/package.json");
    return dirname(dirname(dirname(expressPkgJson)));
  } catch {
    return process.cwd();
  }
}

// The mulmoclaude package source root — the directory that contains
// `server/`, `src/`, and (in dev only) `packages/`. Different from
// `resolveProjectRoot()` only in the npx layout:
//
//   dev (yarn dev):   packageRoot === projectRoot === <repo>
//   npx packaged:     packageRoot = <consumer>/node_modules/mulmoclaude/
//                     projectRoot = <consumer>/  (where node_modules lives)
//
// Anchored at `import.meta.url ↑3` because this file is
// `<packageRoot>/server/agent/config.ts`.
function resolvePackageRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

// The MCP broker source (`server/agent/mcp-server.ts`) is a SIBLING of
// THIS file inside the published mulmoclaude package. Anchor to
// `import.meta.url` so the path is correct in both shapes:
//
//   - dev (yarn dev) :  <repo>/server/agent/config.ts
//                       → broker at <repo>/server/agent/mcp-server.ts ✓
//   - npx packaged   :  <consumer>/node_modules/mulmoclaude/server/agent/config.ts
//                       → broker at <consumer>/node_modules/mulmoclaude/
//                         server/agent/mcp-server.ts ✓
//
// The pre-#1770 code derived the broker path from `resolveProjectRoot()`
// which anchors to wherever `node_modules/express/` lives. In dev that
// happens to coincide with the repo root, but in packaged installs npm
// hoists deps to <consumer>/node_modules/ while the mulmoclaude package
// itself sits a level deeper at <consumer>/node_modules/mulmoclaude/ —
// so `<projectRoot>/server/agent/mcp-server.ts` resolved to a path
// that does not exist, the broker silently failed to spawn, and every
// `mcp__mulmoclaude__*` tool (incl. `handlePermission`) vanished from
// the agent's registry (#1770).
const LOCAL_MCP_SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), "mcp-server.ts");

// Bundled broker (`yarn build:mcp-broker`), preferred over the tsx path when
// present. Anchored the same way as LOCAL_MCP_SERVER_PATH — `server/build/` is
// a sibling of `server/agent/`, so this resolves in dev and in the packaged
// install alike, and `server/` is bind-mounted whole into the container.
//
// Why it matters: `tsx` transcodes the broker's 292-file runtime graph on every
// spawn, which is 20-24 s over a Windows bind mount (#2233) against a ~5 s CLI
// connect wait — the `handlePermission not found` race (#2201). One bundled
// file answers `initialize` in well under a second.
const BUNDLED_MCP_SERVER_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), "build", "mcp-server.mjs");
const CONTAINER_BUNDLED_MCP_SERVER_PATH = "/app/server/build/mcp-server.mjs";
const CONTAINER_MCP_SERVER_PATH = "/app/server/agent/mcp-server.ts";

/** Where the start-beacon preload lives, as a URL `--import` accepts. Anchored
 *  the same way as the broker paths: a sibling of this module in dev and in the
 *  packaged install alike, and `server/` is bind-mounted whole into the
 *  container. A URL rather than a bare path because a Windows drive letter is
 *  not a valid ESM specifier. */
export function startBeaconUrl(useDocker: boolean): string {
  if (useDocker) return CONTAINER_START_BEACON_URL;
  return pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), START_BEACON_FILENAME)).href;
}

/** Which of the two spawn paths was taken. Names the CAUSE of the cold-boot
 *  cost, so a log line carrying it answers "is this install on the 20-50 s
 *  path?" without the reader having to know what a bundle is (#2842). */
export type BrokerKind = "bundle" | "tsx";

export interface BrokerSpawn {
  kind: BrokerKind;
  command: string;
  scriptPath: string;
}

/** Which broker to spawn, as a pure function of the two things that decide it.
 *  `hasBundle` is passed in rather than probed so both branches are testable
 *  without touching the filesystem — the bundle's presence depends on whether
 *  `yarn build` has run, which a test must not have to arrange. */
export function brokerSpawn(useDocker: boolean, hasBundle: boolean): BrokerSpawn {
  if (hasBundle) {
    return {
      kind: "bundle",
      command: useDocker ? "node" : process.execPath,
      scriptPath: useDocker ? CONTAINER_BUNDLED_MCP_SERVER_PATH : BUNDLED_MCP_SERVER_PATH,
    };
  }
  return {
    kind: "tsx",
    command: useDocker ? "tsx" : join(resolveProjectRoot(), "node_modules/.bin/tsx"),
    scriptPath: useDocker ? CONTAINER_MCP_SERVER_PATH : LOCAL_MCP_SERVER_PATH,
  };
}

// One warn per process, not per turn: the condition is a property of the
// install, so repeating it every agent run would bury the rest of the log.
const warnedBrokerKinds = new Set<BrokerKind>();

/** Probe for the bundle and decide the spawn.
 *
 *  The bundle is a build artifact and deliberately not committed, so a fresh
 *  checkout / `yarn dev` before any build still has to work — hence a fallback
 *  rather than a hard requirement. The probe runs on the HOST even for the
 *  container command: `server/` is bind-mounted wholesale, so what exists here
 *  exists at `/app/server` there.
 *
 *  Call this ONCE per turn and pass the result to everything that needs it.
 *  Probing separately for the config and for the log lets the two straddle a
 *  concurrent `yarn build:mcp-broker` and disagree — and a `broker=` field that
 *  can contradict the command actually spawned is worse than no field at all,
 *  given this whole diagnostic exists to be trusted.
 *
 *  The warn lives here because the fallback used to be silent: an install
 *  missing the bundle sat on the 20-50 s tsx cold boot with nothing anywhere
 *  saying so, which is how #2842 was diagnosed as "the connect-wait gate is too
 *  small" when the real answer was "this build never ran
 *  `yarn build:mcp-broker`". */
export function resolveBrokerSpawn(useDocker: boolean): BrokerSpawn {
  const spawn = brokerSpawn(useDocker, existsSync(BUNDLED_MCP_SERVER_PATH));
  if (spawn.kind === "tsx" && !warnedBrokerKinds.has(spawn.kind)) {
    warnedBrokerKinds.add(spawn.kind);
    log.warn("mcp", "broker bundle missing — falling back to tsx, which transcodes the whole import graph on every spawn", {
      expectedBundle: BUNDLED_MCP_SERVER_PATH,
      cost: "seconds to tens of seconds per turn over a Windows/macOS bind mount; may exceed the CLI connect wait and surface as `handlePermission not found`",
      fix: "run `yarn build:mcp-broker` (dev), or update the mulmoclaude package (npm installs ship the bundle since 1.9.0)",
    });
  }
  return spawn;
}

/** Test seam — the warn is once per process, so a test asserting it has to be
 *  able to reset that. */
export function _resetBrokerKindWarnings(): void {
  warnedBrokerKinds.clear();
}

/** The `mcpServers.mulmoclaude` entry Claude Code spawns over stdio.
 *  Exported so `test/agent/test_mcp_docker_smoke.ts` drives the container
 *  with the SHIPPED command/args/env instead of a hand-copied duplicate —
 *  the drift that let #1974 and #1995 ship without the smoke test ever
 *  seeing them (#2052). */
/** Connect-wait ceiling handed to the CLI inside the sandbox container.
 *
 *  This is a CEILING, not a delay: a fast environment still proceeds the moment
 *  the broker answers, so raising it costs nothing there. It exists for the slow
 *  bind-mount case (Windows / macOS Docker Desktop), where tsx transcodes the
 *  broker's import graph over a 9p-class mount and cold boot overruns the CLI's
 *  ~5s default, surfacing as an intermittent
 *  `MCP tool mcp__mulmoclaude__handlePermission not found` (#2201, #2234).
 *
 *  Deliberately generous rather than tuned: the only cost of overshooting is a
 *  slower report when the broker is genuinely dead, while undershooting brings
 *  the flake back. #2233 will measure real cold-boot time and this can tighten
 *  to that figure plus margin. */
const MCP_CONNECT_TIMEOUT_MS = ONE_MINUTE_MS;

export interface McpStdioServerSpec {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Connect to this server at session start rather than lazily, so a resumed
   *  turn doesn't race the broker's cold boot (#2234). Requires CLI ≥ 2.1.121;
   *  older versions ignore the field. Inert on its own — the CLI still gives up
   *  after its default connect wait, so this only helps together with the
   *  raised `MCP_CONNECT_TIMEOUT_MS` in `buildDockerSpawnArgs`. */
  alwaysLoad: boolean;
}

/** What broker lines call themselves in the shared log file (`LOG_SOURCE`). */
export const BROKER_LOG_SOURCE = "mcp-broker";

export function buildMulmoclaudeServer(params: {
  chatSessionId: string;
  port: number;
  activePlugins: string[];
  useDocker: boolean;
  /** Pre-resolved by the caller when the same turn also logs which broker it
   *  spawned, so the config and the log cannot describe different brokers.
   *  Omitted (tests, `print-mcp-container-spec`) means resolve here. */
  broker?: BrokerSpawn;
  /** Identity of this particular broker, for the startup beacon. Omitted by
   *  callers that only inspect the spec and never spawn it. */
  spawnId?: string;
  /** Where the broker writes its start marker, in the coordinates IT sees
   *  (container path under Docker). Omitted by callers that only inspect the
   *  spec; the preload then skips the file half of the signal. */
  startMarkerPath?: string;
}): McpStdioServerSpec {
  const { chatSessionId, port, activePlugins, useDocker, spawnId = "", startMarkerPath = "" } = params;
  const { command, scriptPath: mcpServerPath } = params.broker ?? resolveBrokerSpawn(useDocker);

  const dockerEnv: Record<string, string> = useDocker
    ? {
        MCP_HOST: "host.docker.internal",
        NODE_PATH: `/app/node_modules:${CONTAINER_WORKSPACE_MODULES_PATH}`,
        ...collectMcpToolSentinelEnv(),
      }
    : {};

  // Bearer token for MCP subprocess to call /api/* back to this server
  // (#272). The MCP bridge also has a file-read fallback from
  // <workspace>/.session-token, but env is faster and works in Docker
  // where the token file may not be bind-mounted.
  const token = getCurrentToken();
  const authEnv: Record<string, string> = token ? { MULMOCLAUDE_AUTH_TOKEN: token } : {};

  return {
    // Claude Code 2.1.x requires the explicit `type: "stdio"` field
    // for MCP servers it should spawn locally; without it the entry
    // is silently skipped (no error, no log) and tools never reach
    // the agent's tool registry. Older versions defaulted the type
    // when absent, which is why this worked through Apr 2026 and
    // started silently failing some time after the CLI update.
    type: "stdio",
    alwaysLoad: true,
    command,
    // Docker path: register the ESM resolver hook that plugs the
    // Windows-junction gap in the ESM loader (#1946/#1982). Passed
    // as a Node CLI flag; tsx forwards `--import` through. No-op on
    // Linux/macOS Docker (the hook's catch never fires). Native
    // mode never sees this flag.
    // Order matters: the start beacon first, so the earliest possible moment is
    // the one it reports. `--import` is a node flag; `tsx` forwards it.
    args: useDocker
      ? ["--import", startBeaconUrl(true), "--import", CONTAINER_ESM_BOOTSTRAP_URL, mcpServerPath]
      : ["--import", startBeaconUrl(false), mcpServerPath],
    env: {
      SESSION_ID: chatSessionId,
      // Identifies THIS broker, where SESSION_ID identifies the conversation.
      // The startup beacon echoes it so the host can drop a reading from a
      // superseded attempt instead of crediting it to the retry that replaced
      // it (#2842, Codex review on #2898).
      MCP_SPAWN_ID: spawnId,
      // Written synchronously by the `--import` preload, before anything else
      // loads. Empty when the caller is only inspecting the spec.
      MCP_START_MARKER: startMarkerPath,
      PORT: String(port),
      PLUGIN_NAMES: activePlugins.join(","),
      // The broker's stdout carries JSON-RPC. The shared `log` helper
      // otherwise sends info/debug there, so a plugin loader's "loaded"
      // line lands between protocol messages — or, once a response is
      // large enough to be split across writes, inside one.
      LOG_CONSOLE_STREAM: "stderr",
      // The broker writes to the SAME log file as the parent server and
      // respawns once per turn, so its untagged lines read as server restarts
      // — "plugins/preset loaded" 34x/day was reported as a reload loop
      // (#2904). Tagging the source is what separates the two.
      LOG_SOURCE: BROKER_LOG_SOURCE,
      ...authEnv,
      ...dockerEnv,
    },
  };
}

// Never let a user-defined server shadow the built-in internal bridge —
// even if they pick "mulmoclaude" as the id. Drop the entry silently:
// the UI already validates ids against the slug pattern, so this is
// defence-in-depth.
function excludeReservedKeys(servers: Record<string, PreparedMcpServerSpec>): Record<string, PreparedMcpServerSpec> {
  const out: Record<string, PreparedMcpServerSpec> = {};
  for (const [serverId, spec] of Object.entries(servers)) {
    if (serverId === "mulmoclaude") continue;
    out[serverId] = spec;
  }
  return out;
}

export function buildMcpConfig(params: McpConfigParams): { mcpServers: Record<string, unknown> } {
  const { chatSessionId, port, activePlugins, useDocker = false, userServers = {} } = params;
  return {
    mcpServers: {
      mulmoclaude: buildMulmoclaudeServer({
        chatSessionId,
        port,
        activePlugins,
        useDocker,
        ...(params.broker ? { broker: params.broker } : {}),
        ...(params.spawnId ? { spawnId: params.spawnId } : {}),
        ...(params.startMarkerPath ? { startMarkerPath: params.startMarkerPath } : {}),
      }),
      ...excludeReservedKeys(userServers),
    },
  };
}

// User-facing `mcp__<server>` wildcard form for --allowedTools. Enabled
// HTTP servers always participate; stdio servers only participate when
// we're running natively (since the sandbox image is minimal in Docker).
export function userServerAllowedToolNames(userServers: Record<string, PreparedMcpServerSpec>, useDocker: boolean): string[] {
  const names: string[] = [];
  for (const [serverId, spec] of Object.entries(userServers)) {
    if (spec.enabled === false) continue;
    // This reads the PREPARED map, so a `hostExecInDocker` server has
    // already become `sse` and MUST stay allow-listed — it runs on the
    // host behind a gateway, not in the sandbox. Only entries still
    // typed `stdio` here were never shimmed, and those can't run in the
    // sandbox image (see #162 / #3018).
    if (spec.type === "stdio" && useDocker) continue;
    names.push(`mcp__${serverId}`);
  }
  return names;
}

export interface CliArgsParams {
  /** Path handed to `--system-prompt-file` (the container-side path
   *  under Docker — see `resolveSystemPromptPaths`). The prompt travels
   *  as a file, never as an inline `--system-prompt` argument: on
   *  Windows the argv collapses to a single CreateProcess command line
   *  capped at ~32k chars, so a rich role + plugins + memory pushes the
   *  prompt past the cap and the spawn fails with ENAMETOOLONG before
   *  the CLI even starts (#2078). */
  systemPromptPath: string;
  activePlugins: string[];
  claudeSessionId?: string | undefined;
  mcpConfigPath?: string | undefined;
  // Web UI-managed extension of the allowed-tools list. Merged with
  // BASE_ALLOWED_TOOLS and the mcp__mulmoclaude__ plugin names.
  extraAllowedTools?: string[] | undefined;
  // Reasoning effort (#1323). When undefined, the flag is omitted
  // and Claude picks its own default.
  effortLevel?: EffortLevel | undefined;
  // Model family (#2923). When undefined, the flag is omitted and the
  // CLI resolves the model from `~/.claude/settings.json` — the same
  // file other Claude Code clients write their `/model` pick to.
  chatModel?: ChatModel | undefined;
}

export function buildCliArgs(params: CliArgsParams): string[] {
  const { systemPromptPath, activePlugins, claudeSessionId, mcpConfigPath, extraAllowedTools = [], effortLevel, chatModel } = params;

  const mcpToolNames = activePlugins.map((pluginName) => `mcp__mulmoclaude__${pluginName}`);
  // DEBUG: also pass the wildcard form `mcp__mulmoclaude` so Claude
  // CLI auto-discovers all tools the mulmoclaude MCP server publishes
  // (matches the convention used for user-defined MCP servers).
  // Claude's tool registry seems to require wildcard for runtime
  // discovery; specific names alone register permissions but not
  // the tool's existence.
  const allowedTools = [...BASE_ALLOWED_TOOLS, ...extraAllowedTools, "mcp__mulmoclaude", ...CLAUDE_AI_CONNECTOR_SERVERS, ...mcpToolNames];

  // stream-json input mode: the user message is streamed through
  // stdin (see `writeUserMessage` in server/agent.ts) rather than
  // passed as a `-p <text>` argument. This path is required so that
  // Claude resolves slash-command invocations (e.g. `/shiritori` from
  // the manageSkills Run button) against `~/.claude/skills/`. In the
  // old `-p <text>` mode the CLI treats the message as literal text
  // and "/shiritori" never reaches the skill resolver.
  const args = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--system-prompt-file",
    systemPromptPath,
    "--allowedTools",
    allowedTools.join(","),
    "-p",
  ];

  if (claudeSessionId) {
    args.push("--resume", claudeSessionId);
  }

  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
    // We DELIBERATELY do NOT pass `--strict-mcp-config`. The flag is
    // additive by default ("Load MCP servers from JSON files"); the
    // strict variant restricts the session to only our file and
    // hides any claude.ai connectors (Gmail / Calendar / Drive /
    // Slack) the user has wired up via `claude` interactive `/mcp`.
    //
    // We previously DID pass `--strict` as a workaround for a
    // #1043 C-2 finding that the merge silently dropped the local
    // mulmoclaude broker. Re-verified on CLI 2.1.163 (#1617): both
    // layers now coexist in the session's `init.mcp_servers` array
    // and the local broker's full 12-tool surface remains callable.
    // Removing the workaround unlocks the user's already-authorised
    // claude.ai connectors inside MulmoClaude for free, no per-
    // connector mcp.json hand-rolling required.
    //
    // Permission hook for `behavior:"ask"` checks. Gated on
    // `mcpConfigPath` because the handler tool (`handlePermission`)
    // lives inside our MCP server — without `--mcp-config` the CLI
    // can't resolve `mcp__mulmoclaude__handlePermission` and refuses
    // to start (Codex review on PR #1560). In a no-MCP session the
    // CLI's default ask handling stays in place; AskUserQuestion's
    // leak (#1499) only manifests once tools are wired up, so the
    // hook is correctly tied to the MCP-config presence.
    args.push("--permission-prompt-tool", "mcp__mulmoclaude__handlePermission");
  }

  if (effortLevel) {
    args.push("--effort", effortLevel);
  }

  if (chatModel) {
    args.push("--model", chatModel);
  }

  return args;
}

/** JSON line to write to the Claude CLI's stdin when running in
 *  stream-json input mode. One line per user turn.
 *
 *  Supported attachment types:
 *  - `image/*` → vision content blocks (`type: "image"`)
 *  - `application/pdf` → document content blocks (`type: "document"`)
 *  - `text/*`, JSON, XML, YAML, CSV → decoded UTF-8 → text block
 *  - DOCX → mammoth text extraction → text block
 *  - XLSX → xlsx CSV extraction → text block
 *  - PPTX → libreoffice PDF conversion → document block (Docker only)
 *  - Other MIME types → skipped with a console hint.
 *
 *  Without attachments, content is a plain string (smaller,
 *  backward-compatible). */
export async function buildUserMessageLine(message: string, attachments?: Attachment[]): Promise<string> {
  const all = attachments ?? [];
  if (all.length === 0) {
    return `${JSON.stringify({
      type: "user",
      message: { role: "user", content: message },
    })}\n`;
  }

  const blocks: Record<string, unknown>[] = [];
  const skippedReasons: string[] = [];

  for (const att of all) {
    // Defensive: prepareRequestExtras normalises path-only entries to
    // bytes before we get here, so `data` + `mimeType` should always
    // be set. Skip with a reason if a malformed entry slipped through.
    if (!att.data || !att.mimeType) {
      skippedReasons.push(att.path ? `attachment "${att.path}" missing bytes/mimeType after normalisation` : "attachment missing bytes/mimeType");
      continue;
    }
    // Native types: image and PDF go directly as content blocks
    if (isNativeAttachmentMime(att.mimeType)) {
      blocks.push(buildNativeBlock(att));
      continue;
    }
    // Convertible types: text, docx, xlsx, pptx
    const result = await convertAttachment(att);
    if (result.kind === "converted") {
      blocks.push(...result.blocks);
    } else {
      skippedReasons.push(result.reason);
    }
  }

  if (skippedReasons.length > 0) {
    log.warn("agent", "skipping unsupported attachment(s)", {
      count: skippedReasons.length,
      reasons: skippedReasons,
    });
  }

  blocks.push({ type: "text", text: message });
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: blocks },
  })}\n`;
}

function buildNativeBlock(att: Attachment): Record<string, unknown> {
  const mimeType = att.mimeType ?? "application/octet-stream";
  const data = att.data ?? "";
  const blockType = isImageMime(mimeType) ? "image" : "document";
  return {
    type: blockType,
    source: {
      type: "base64",
      media_type: mimeType,
      data,
    },
  };
}

export interface SessionFilePaths {
  // Where the file is actually written on the host filesystem.
  hostPath: string;
  // The path handed to the claude CLI (e.g. via --mcp-config or
  // --system-prompt-file): the container path under docker, read
  // through the workspace bind mount, identical to hostPath natively.
  argPath: string;
}

// `sessionId` reaches a filesystem path here. `basename` strips any
// directory components (the recognised path-traversal barrier — a
// crafted `../../x` collapses to `x`); the char-strip then removes
// any residual non-id chars (CodeQL js/path-injection).
function safeSessionSegment(sessionId: string): string {
  return basename(sessionId).replace(/[^A-Za-z0-9_-]/g, "_");
}

export function resolveMcpConfigPaths(opts: { workspacePath: string; sessionId: string; useDocker: boolean }): SessionFilePaths {
  const sid = safeSessionSegment(opts.sessionId);
  if (opts.useDocker) {
    const hostPath = join(opts.workspacePath, ".mulmoclaude", `mcp-${sid}.json`);
    const argPath = `${CONTAINER_WORKSPACE_PATH}/.mulmoclaude/mcp-${sid}.json`;
    return { hostPath, argPath };
  }
  const hostPath = join(tmpdir(), `mulmoclaude-mcp-${sid}.json`);
  return { hostPath, argPath: hostPath };
}

/** Where the broker's start marker goes — the synchronous half of the startup
 *  signal (#2842). Same host/container split as the MCP config, for the same
 *  reason: under Docker the file has to sit inside the workspace bind mount so
 *  both sides see it, and the OS tmpdir is fine natively.
 *
 *  Keyed by SPAWN, not by session: a replay spawns a second broker while the
 *  first attempt's marker may still be on disk, and a marker that could vouch
 *  for a broker other than the one being waited on is worse than none.
 *
 *  Deliberately the SAME directory as the MCP config, which is what creates it
 *  (`writeMcpConfig` mkdirs it under Docker). The preload writes the marker
 *  synchronously and cannot afford an mkdir, so moving either path without the
 *  other would leave it writing into a directory that does not exist. */
export function resolveBrokerStartMarkerPaths(opts: { workspacePath: string; sessionId: string; useDocker: boolean; spawnId: string }): SessionFilePaths {
  const name = `broker-start-${safeSessionSegment(opts.sessionId)}-${safeSessionSegment(opts.spawnId)}`;
  if (opts.useDocker) {
    return {
      hostPath: join(opts.workspacePath, ".mulmoclaude", name),
      argPath: `${CONTAINER_WORKSPACE_PATH}/.mulmoclaude/${name}`,
    };
  }
  const hostPath = join(tmpdir(), `mulmoclaude-${name}`);
  return { hostPath, argPath: hostPath };
}

// Where the per-session system-prompt file lives — same host/container
// split as resolveMcpConfigPaths. Under Docker the file must sit inside
// the workspace bind mount so the container-side CLI can read it via
// --system-prompt-file; natively the OS tmpdir is fine. One file per
// chat session — successive turns overwrite it.
export function resolveSystemPromptPaths(opts: { workspacePath: string; sessionId: string; useDocker: boolean }): SessionFilePaths {
  const sid = safeSessionSegment(opts.sessionId);
  if (opts.useDocker) {
    const hostPath = join(opts.workspacePath, ".mulmoclaude", `system-prompt-${sid}.md`);
    const argPath = `${CONTAINER_WORKSPACE_PATH}/.mulmoclaude/system-prompt-${sid}.md`;
    return { hostPath, argPath };
  }
  const hostPath = join(tmpdir(), `mulmoclaude-system-prompt-${sid}.md`);
  return { hostPath, argPath: hostPath };
}

// Mirror NodeJS.Platform — re-declared so the file doesn't need a
// `NodeJS` global reference, which the no-undef rule doesn't see in
// type-only positions.
export type Platform = "aix" | "android" | "darwin" | "freebsd" | "haiku" | "linux" | "openbsd" | "sunos" | "win32" | "cygwin" | "netbsd";

export interface DockerSpawnArgsParams {
  workspacePath: string;
  cliArgs: string[];
  uid: number;
  gid: number;
  platform: Platform;
  /** Our app's chat session id. Forwarded into the container as
   *  `MULMOCLAUDE_CHAT_SESSION_ID` so the wiki-history PostToolUse
   *  hook can publish a `page-edit` toolResult to the right chat
   *  session — Claude CLI's own `session_id` (in the hook payload)
   *  is the *CLI* session, not our chat session, so the session
   *  store would never find a match (#963). */
  chatSessionId: string;
  projectRoot?: string;
  /** Source root of the mulmoclaude package itself (the dir that holds
   *  `server/` + `src/` and, in dev, `packages/`). In dev this equals
   *  `projectRoot`; in npx packaged installs it's
   *  `<consumer>/node_modules/mulmoclaude/`. Defaults to
   *  `resolvePackageRoot()`. Overridable for tests. */
  packageRoot?: string;
  homeDir?: string;
  /** Extra `-v` / `-e` tokens for opt-in host credentials (#259).
   *  Built by `resolveSandboxAuth` in `sandboxMounts.ts`. Default []. */
  sandboxAuthArgs?: readonly string[];
  /** Whether SSH agent forwarding is active. When true, the container
   *  uses the entrypoint (root → setup → setpriv drop) instead of
   *  `--user`, and adds the minimum capabilities the entrypoint needs.
   *  When false (default), `--user uid:gid --cap-drop ALL` with zero
   *  capabilities — identical to the pre-#259 security posture. */
  sshAgentForward?: boolean;
}

// Every workspace-package dir under `packages/`, matching the root manifest's
// `packages/*` + `packages/<group>/*` globs structurally: a child that carries a
// package.json IS a package; one that doesn't is a grouping dir (`plugins/`,
// `bridges/`, `services/`) we descend one level into. Derived from the tree, not
// from the root package.json, so a packaged install without a `workspaces` field
// still behaves.
//
// This used to hardcode `packages/core` + `packages/plugins/*`, which missed
// `packages/protocol` (`@mulmobridge/protocol`) and `packages/client`. yarn
// junctions EVERY workspace package on Windows, so the ones this list omitted
// dangled inside the Linux container with no `/app/pkg_modules` fallback — and
// the MCP child, which reaches `@mulmobridge/protocol` through
// `src/types/events.ts`, died at load with MODULE_NOT_FOUND. Every tool,
// `handlePermission` included, then vanished from the agent's registry (#2052).
//
// Source/dev layout only (npx installs have no `packages/`), so an absent dir
// yields an empty list.
function workspacePackageDirs(packageRoot: string): string[] {
  const packagesDir = join(packageRoot, "packages");
  if (!existsSync(packagesDir)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    if (existsSync(join(dir, "package.json"))) {
      dirs.push(dir);
      continue;
    }
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const childDir = join(dir, child.name);
      if (existsSync(join(childDir, "package.json"))) dirs.push(childDir);
    }
  }
  return dirs;
}

// The scoped name a workspace package declares, or null when it is unscoped
// (the `mulmoclaude` launcher) or unreadable — a malformed package.json never
// breaks a spawn. Any scope counts: `@mulmoclaude/*`, `@mulmobridge/*`,
// `@receptron/*`. Restricting this to `@mulmoclaude/` is what left
// `@mulmobridge/protocol` unmounted (#2052).
function scopedPackageName(pkgDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
    const name = isRecord(parsed) ? parsed.name : undefined;
    return typeof name === "string" && name.startsWith("@") ? name : null;
  } catch {
    return null;
  }
}

// Windows-only bind mounts giving the in-container MCP child a junction-free
// copy of each `@mulmoclaude/*` package under CONTAINER_WORKSPACE_MODULES_PATH
// (#1946 — the yarn-workspace junctions dangle inside the Linux container).
// Empty on every other platform and on npx installs (no `packages/`).
export function workspaceModuleMounts(packageRoot: string, platform: Platform, toDockerPath: (hostPath: string) => string): string[] {
  if (platform !== "win32") return [];
  const mounts: string[] = [];
  for (const dir of workspacePackageDirs(packageRoot)) {
    const name = scopedPackageName(dir);
    if (name) mounts.push("-v", `${toDockerPath(dir)}:${CONTAINER_WORKSPACE_MODULES_PATH}/${name}:ro`);
  }
  return mounts;
}

// npx installs can leave some deps in the NESTED `<packageRoot>/node_modules`
// instead of hoisting them to `<projectRoot>/node_modules` — npm does this on a
// dependency version conflict, and on overwrite-updates that leave the npx cache
// only half-deduped (observed: `@mulmoclaude/chart-plugin` / `html-plugin` /
// `@gui-chat-plugin/camera`). Only `<projectRoot>/node_modules` is mounted to
// `/app/node_modules`, so those nested deps are invisible in the container and
// the MCP child dies at load with MODULE_NOT_FOUND — the same all-tools-vanish
// failure as #2052, a different cause (#2056). Mount the nested tree at
// `/app/pkg_modules`, already on the child's `NODE_PATH` + ESM-hook search path,
// so both CJS and ESM resolution find it. This mounts the WHOLE nested tree at
// `/app/pkg_modules`, while `workspaceModuleMounts` mounts individual packages
// UNDER it (`/app/pkg_modules/@scope/name`) — the two would collide (a child
// bind mount into a read-only parent fails `docker run`). They must be mutually
// exclusive, so skip this whenever a `packages/` tree is present: that's the
// source layout `workspaceModuleMounts` owns (dev, or an install-from-source /
// `npm link` that copied the full repo, not just the published `files`). A true
// npx install has a distinct `packageRoot` and NO `packages/`, which is the only
// shape this mount serves.
function nestedNodeModulesMount(projectRoot: string, packageRoot: string, toDocker: (hostPath: string) => string): string[] {
  if (packageRoot === projectRoot) return [];
  if (existsSync(join(packageRoot, "packages"))) return [];
  const nested = join(packageRoot, "node_modules");
  if (!existsSync(nested)) return [];
  return ["-v", `${toDocker(nested)}:${CONTAINER_WORKSPACE_MODULES_PATH}:ro`];
}

// Pure helper that returns the full `docker run ... claude <args>`
// argv array. Extracted from runAgent so the long flag list can be
// inspected and tested without spawning a real subprocess.
// Windows host paths use `\`; Docker's `-v` wants `/`. Pure.
const toDockerPath = (hostPath: string): string => hostPath.replace(/\\/g, "/");

// Cap/user posture. With SSH-agent forwarding the entrypoint needs 5 caps +
// HOST_UID/GID to fix /etc/passwd + chown/chmod the socket, then drops them on
// exec (`setpriv --inh-caps=-all`). Without SSH, run the whole container as the
// host user — zero caps from the start (pre-#259 posture). Pure.
export function dockerUserCapArgs(sshAgentForward: boolean, uid: number, gid: number): string[] {
  if (!sshAgentForward) return ["--user", `${uid}:${gid}`];
  return [
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "FOWNER",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "-e",
    `HOST_UID=${uid}`,
    "-e",
    `HOST_GID=${gid}`,
  ];
}

interface DockerBindMountOpts {
  projectRoot: string;
  packageRoot: string;
  workspacePath: string;
  homeDir: string;
  packagesMount: string[];
  platform: Platform;
}

// The `-v` bind mounts, in order. node_modules stays on projectRoot (hoisted
// deps live next to the consumer's package.json, not mulmoclaude's package dir,
// #1770); server/src come from packageRoot (repo root in dev, the installed
// package in npx). Pure given its inputs. Extracted to keep buildDockerSpawnArgs
// under the max-lines threshold.
export function dockerBindMountArgs(opts: DockerBindMountOpts): string[] {
  return [
    "-v",
    `${toDockerPath(opts.projectRoot)}/node_modules:/app/node_modules:ro`,
    "-v",
    `${toDockerPath(opts.packageRoot)}/server:/app/server:ro`,
    "-v",
    `${toDockerPath(opts.packageRoot)}/src:/app/src:ro`,
    ...opts.packagesMount,
    ...workspaceModuleMounts(opts.packageRoot, opts.platform, toDockerPath),
    ...nestedNodeModulesMount(opts.projectRoot, opts.packageRoot, toDockerPath),
    "-v",
    `${toDockerPath(opts.workspacePath)}:${CONTAINER_WORKSPACE_PATH}`,
    "-v",
    `${toDockerPath(claudeConfigDir(opts.homeDir))}:/home/node/.claude`,
    "-v",
    `${toDockerPath(claudeConfigJson(opts.homeDir))}:/home/node/.claude.json`,
  ];
}

export function buildDockerSpawnArgs(params: DockerSpawnArgsParams): string[] {
  const {
    workspacePath,
    cliArgs,
    uid,
    gid,
    platform,
    projectRoot = resolveProjectRoot(),
    packageRoot = resolvePackageRoot(),
    homeDir = homedir(),
    sandboxAuthArgs = [],
    sshAgentForward = false,
  } = params;
  const extraHosts: string[] = platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : [];
  // `packages/` ships in the dev monorepo but NOT in the published
  // mulmoclaude package (the `files` whitelist in
  // `packages/mulmoclaude/package.json` excludes it — internal
  // `@mulmoclaude/*` workspaces are installed as `node_modules/
  // @mulmoclaude/*` after publish). Skip the bind mount when the dir
  // is absent so `docker run` doesn't error on a missing source path
  // in packaged installs (#1770 Docker-side gap @ystknsh flagged).
  const packagesDir = join(packageRoot, "packages");
  const packagesMount: string[] = existsSync(packagesDir) ? ["-v", `${toDockerPath(packagesDir)}:/app/packages:ro`] : [];

  return [
    "run",
    "--rm",
    // -i keeps the container's stdin open so the stream-json user
    // message (see buildUserMessageLine) can flow through. Without
    // this Docker detaches stdin and the CLI reads EOF on startup.
    "-i",
    "--cap-drop",
    "ALL",
    ...dockerUserCapArgs(sshAgentForward, uid, gid),
    "-e",
    "HOME=/home/node",
    // Wiki-history hook (#763 PR 2) runs inside this container after
    // every Write/Edit and POSTs back to the parent server. Plain
    // loopback fails — `127.0.0.1` is the container itself. Same
    // resolution as MCP_HOST above; on Linux the corresponding
    // `--add-host host.docker.internal:host-gateway` is appended via
    // `extraHosts`.
    "-e",
    "MULMOCLAUDE_HOST=host.docker.internal",
    // Chat session id for the wiki-history hook (#963). The hook
    // POSTs `{slug, sessionId}` to the parent server; the server
    // looks up the chat session by this id to publish a `page-edit`
    // toolResult into its timeline.
    "-e",
    `MULMOCLAUDE_CHAT_SESSION_ID=${params.chatSessionId}`,
    // How long the CLI *inside the container* waits for the MCP broker to
    // connect. Set here because only the vars listed in this argv reach the
    // container — a host-side `MCP_CONNECT_TIMEOUT_MS` never arrived, so the
    // knob was unreachable in the one environment that needs it (#2234).
    "-e",
    `MCP_CONNECT_TIMEOUT_MS=${MCP_CONNECT_TIMEOUT_MS}`,
    ...dockerBindMountArgs({ projectRoot, packageRoot, workspacePath, homeDir, packagesMount, platform }),
    ...sandboxAuthArgs,
    ...extraHosts,
    "mulmoclaude-sandbox",
    "claude",
    ...cliArgs,
  ];
}
