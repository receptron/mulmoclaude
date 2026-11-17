// Single source of truth for "what tools is the agent allowed to use
// in this session?" (#1043 C-2 follow-up).
//
// Three consumer sites used to maintain their own copy of this logic
// and each had to be patched separately when runtime plugins (#1043
// C-2) joined the picture:
//
//   - server/agent/config.ts  (`getActivePlugins(role)` → ENV
//                              PLUGIN_NAMES + `--allowedTools`)
//   - server/agent/prompt.ts  (`buildPluginPromptSections(role)` →
//                              `### <name>` blocks in system prompt)
//   - server/agent/mcp-server.ts (`tools` array → MCP tools/list)
//
// They went out of sync more than once during runtime-plugin rollout:
// e.g. config.ts gated by role.availablePlugins while prompt.ts did
// the same with a different filter; runtime plugins ended up in
// PLUGIN_NAMES but missing from the system prompt, etc.
//
// `getActiveToolDescriptors(role)` produces a single list of
// `ActiveToolDescriptor` rows and the three call sites read whichever
// fields they need (name only / name + prompt / name + endpoint).
// EVERY tool source (static-gui, static-mcp, runtime) is gated by
// `role.availablePlugins` — runtime plugins used to be auto-included
// regardless, which surfaced as a real bug (preset plugins like
// `manageRecipes` leaked into every role even though `cookingCoach`
// was their intended home). The MCP-prefixed full
// name is precomputed once so callers don't have to re-derive it.

import type { Role } from "../../src/config/roles.js";
import { mcpTools, isMcpToolEnabled } from "./mcp-tools/index.js";
import { PLUGIN_DEFS, PLUGIN_PACKAGE_BY_TOOL, TOOL_ENDPOINTS } from "./plugin-names.js";
import { agentRunsOnHost } from "../system/docker.js";
import { toolPromptFor } from "./promptFiles.js";
import { getRuntimePlugins } from "../plugins/runtime-registry.js";

/** The MCP server id the parent registers via `--mcp-config` (see
 *  `buildMulmoclaudeServer` in `config.ts`). The Claude Agent SDK
 *  exposes every tool the server publishes under
 *  `mcp__<serverId>__<toolName>` — we precompute the full id so the
 *  prompt section can give the LLM the exact name to call (a short
 *  name alone leads the LLM to hallucinate the server prefix from
 *  the tool's package name; observed during manual test of the
 *  weather preset). */
export const MCP_SERVER_ID = "mulmoclaude";

export type ToolSource = "static-gui" | "static-mcp" | "runtime";

export interface ActiveToolDescriptor {
  /** Bare tool name (TOOL_DEFINITION.name). Matches what the MCP
   *  server's `tools/list` reports and what the LLM uses on
   *  `tools/call`. */
  name: string;
  /** Fully-qualified Claude Agent SDK form, e.g.
   *  `mcp__mulmoclaude__fetchWeather`. Used by the system prompt
   *  hint and by the `--allowedTools` builder. */
  fullName: string;
  /** One-line description from the tool definition. Always present. */
  description: string;
  /** Optional richer prompt the plugin author wrote for the system
   *  prompt. Falls back to `description` when missing. */
  prompt?: string | undefined;
  /** HTTP endpoint the MCP child posts to when the tool is called.
   *  Static GUI plugins look this up via `TOOL_ENDPOINTS`; runtime
   *  plugins always go through the generic dispatch route; pure
   *  MCP tools handle the call internally and have no endpoint. */
  endpoint?: string | undefined;
  /** Where the descriptor came from. Useful for telemetry / debug
   *  logging; not consumed by the production tool-call path. */
  source: ToolSource;
}

/** What every tool published by the built-in broker is called. User-configured
 *  MCP servers get their own `mcp__<their-id>__` prefix, so this is how callers
 *  tell "our broker answered" from "some MCP server answered". */
export const BUILTIN_MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_ID}__`;
const fullNameFor = (toolName: string): string => `${BUILTIN_MCP_TOOL_PREFIX}${toolName}`;

// `alwaysActive` tools (generic host infra like spawnBackgroundChat) bypass the
// per-role gate — offered to every role, like a built-in — unless the role opts
// out of one by name. All other MCP tools stay gated by `availablePlugins`.
export function isMcpToolOfferedTo(role: Role, toolName: string, alwaysActive: boolean | undefined): boolean {
  if (role.availablePlugins.includes(toolName)) return true;
  return alwaysActive === true && !(role.excludedAlwaysActiveTools ?? []).includes(toolName);
}

// Static GUI plugins that work only with a key in the server's environment,
// as an MCP tool's `requiredEnv`: without it the tool is not offered (neither
// in the prompt nor in --allowedTools), so a role falls back to another one
// (the Tutor quizzes with putQuestions) instead of calling a tool that can
// only reply "set the key and restart".
const STATIC_PLUGIN_REQUIRED_ENV: Readonly<Record<string, readonly string[]>> = {
  manageKenteiScript: ["TYPESAFE_API_KEY"],
};

// Static GUI plugins that run what the agent writes as CODE in this server's
// process. They are offered only to an agent that already runs on this machine
// unsandboxed: to one inside the Docker sandbox, such a tool is a way out of it,
// onto the host and past the mounts the sandbox is there to enforce.
//
// presentBrep: its replicad script is JavaScript, run by @gui-chat-plugin/brep
// through node:vm with no isolation. The route refuses for the same reason
// (server/api/routes/plugins.ts), since not offering a tool is not a boundary.
const STATIC_PLUGIN_RUNS_HOST_CODE: ReadonlySet<string> = new Set(["presentBrep"]);

/** `onHost` is a parameter so the rule can be tested without a Docker daemon. */
export function isStaticPluginEnabled(name: string, onHost: boolean = agentRunsOnHost()): boolean {
  if (STATIC_PLUGIN_RUNS_HOST_CODE.has(name) && !onHost) return false;
  return (STATIC_PLUGIN_REQUIRED_ENV[name] ?? []).every((key) => Boolean(process.env[key]?.trim()));
}

export function getActiveToolDescriptors(role: Role): ActiveToolDescriptor[] {
  const allowed = new Set<string>(role.availablePlugins);
  const seen = new Set<string>();
  const out: ActiveToolDescriptor[] = [];

  for (const def of PLUGIN_DEFS) {
    if (!allowed.has(def.name) || seen.has(def.name) || !isStaticPluginEnabled(def.name)) continue;
    out.push({
      name: def.name,
      fullName: fullNameFor(def.name),
      description: def.description,
      prompt: toolPromptFor(def, PLUGIN_PACKAGE_BY_TOOL.get(def.name)),
      endpoint: TOOL_ENDPOINTS[def.name],
      source: "static-gui",
    });
    seen.add(def.name);
  }

  for (const tool of mcpTools) {
    const toolName = tool.definition.name;
    if (!isMcpToolOfferedTo(role, toolName, tool.alwaysActive) || seen.has(toolName) || !isMcpToolEnabled(tool)) continue;
    out.push({
      name: toolName,
      fullName: fullNameFor(toolName),
      description: tool.definition.description,
      prompt: toolPromptFor(tool, tool.packageName),
      // pure MCP tools dispatch internally — no external endpoint
      source: "static-mcp",
    });
    seen.add(toolName);
  }

  for (const plugin of getRuntimePlugins()) {
    const def = plugin.definition;
    if (seen.has(def.name)) continue; // runtime-registry collision
    // Runtime plugins (preset + user-installed alike) are now gated
    // by `role.availablePlugins`, mirroring the static-GUI / static-MCP
    // loops above. Previously they were auto-included regardless of
    // role — that broke the role's stated promise of "exactly these
    // tools" and surfaced as a real bug when a non-cooking role
    // started seeing `manageRecipes`. Roles that want a runtime
    // plugin must list its `toolName` in `availablePlugins`. The
    // Settings → Roles UI lets users add tool names per role; preset
    // plugin names land in the `general` role's `availablePlugins`
    // out of the box.
    if (!allowed.has(def.name)) continue;
    out.push({
      name: def.name,
      fullName: fullNameFor(def.name),
      description: def.description,
      prompt: toolPromptFor(def, plugin.name),
      endpoint: `/api/plugins/runtime/${encodeURIComponent(plugin.name)}/dispatch`,
      source: "runtime",
    });
    seen.add(def.name);
  }

  return out;
}
