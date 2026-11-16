/**
 * Standalone MCP stdio server — spawned by the Claude CLI via --mcp-config.
 * Bridges Claude's tool calls to our server endpoints and pushes ToolResults
 * back to the active frontend SSE stream via the session registry.
 */

import type { ToolDefinition } from "gui-chat-protocol";
import { mcpTools, isMcpToolEnabled } from "./mcp-tools/index.js";
import { resolveActiveTools } from "./resolveActiveTools.js";
import { findDispatchableMcpTool } from "./dispatchableMcpTool.js";
import { pluginResultText, type PluginResultEnvelope } from "./pluginResultText.js";
import { TOOL_ENDPOINTS, PLUGIN_DEFS, MCP_PLUGIN_NAMES } from "./plugin-names.js";
import { loadRuntimePlugins } from "../plugins/runtime-loader.js";
import { loadDevPlugins, parseDevPluginsEnv } from "../plugins/dev-loader.js";
import { loadPresetPlugins } from "../plugins/preset-loader.js";
import { registerRuntimePlugins, getRuntimePlugins } from "../plugins/runtime-registry.js";
import { errorMessage } from "../utils/errors.js";
import { settleWithin } from "../utils/promise.js";
import { isNonEmptyString, isRecord } from "../utils/types.js";
import { API_ROUTES } from "../../src/config/apiRoutes.js";
import { env } from "../system/env.js";
import { extractFetchError, fetchWithTimeout } from "../utils/fetch.js";
import { ONE_MINUTE_MS, ONE_SECOND_MS } from "../utils/time.js";
import { safeResponseText } from "../utils/http.js";
import { readTextSafeSync } from "../utils/files/safe.js";
import { WORKSPACE_PATHS } from "../workspace/paths.js";
import { makeUuid } from "../utils/id.js";
import { deliverBeacon, BROKER_READY_DELIVERY } from "./brokerBeacon.js";

type JsonRpcId = string | number | null;

interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

interface JsonRpcMessage {
  jsonrpc: string;
  id?: JsonRpcId;
  method: string;
  params?: ToolCallParams;
}

const isJsonRpcMessage = (value: unknown): value is JsonRpcMessage => isRecord(value) && "method" in value;

const SESSION_ID = env.mcpSessionId;
const PORT = env.port;
const PLUGIN_NAMES = env.mcpPluginNames;
const MCP_HOST = env.mcpHost;
const BASE_URL = `http://${MCP_HOST}:${PORT}`;

// Bearer token for /api/* calls back to the parent server (#272).
// The parent writes it to <workspace>/.session-token at startup; we
// read once at module load — the token is immutable for the server's
// lifetime. Same resolution order as bridges/cli/token.ts.
function readSessionToken(): string {
  const fromEnv = process.env.MULMOCLAUDE_AUTH_TOKEN;
  if (isNonEmptyString(fromEnv)) return fromEnv;
  return readTextSafeSync(WORKSPACE_PATHS.sessionToken)?.trim() ?? "";
}
const SESSION_TOKEN = readSessionToken();
const AUTH_HEADER: Record<string, string> = SESSION_TOKEN ? { Authorization: `Bearer ${SESSION_TOKEN}` } : {};

interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  endpoint?: string;
}

// Shape returned by a plugin endpoint dispatch. `data` is the
// protocol's render-eligibility signal — present means "render a
// card", absent means narrate-only (see `gui-chat-protocol`'s
// `ToolResult` docs). `message` / `instructions` are read by the
// bridge for the LLM-facing return value; other fields (title,
// jsonData, action, etc.) flow through to the frontend untouched.
// `toolName` / `uuid` are listed so the post-spread override in
// `handleToolCall` is type-checked rather than relying on
// object-shape coincidence — the bridge always re-asserts them
// from its own state.
interface BridgeResultEnvelope extends PluginResultEnvelope {
  toolName?: unknown;
  uuid?: unknown;
}

// Combine `description` (one-liner) and `prompt` (detailed usage
// instructions) into the MCP tool description so Claude CLI sees
// both. The MCP protocol only has `description` — there's no
// `prompt` field — so the prompt content must ride along in the
// description string. The gui-chat-protocol ToolDefinition carries
// `prompt` separately because the Vue client uses it for different
// purposes, but the CLI needs it in-band.
function fromPackage(def: ToolDefinition, endpoint: string): ToolDef {
  const parts = [def.description];
  if (typeof def.prompt === "string" && def.prompt.length > 0) {
    parts.push(def.prompt);
  }
  return {
    name: def.name,
    description: parts.join("\n\n"),
    inputSchema: def.parameters ?? {},
    endpoint,
  };
}

// Pure MCP tools (no GUI) — auto-registered from server/mcp-tools/
const mcpToolDefs: Record<string, ToolDef> = Object.fromEntries(
  mcpTools.filter(isMcpToolEnabled).map((toolDef) => [
    toolDef.definition.name,
    {
      name: toolDef.definition.name,
      description: toolDef.definition.description,
      inputSchema: toolDef.definition.inputSchema,
    },
  ]),
);

// Static plugins land in ALL_TOOLS synchronously; runtime plugins
// (#1043 C-2) are added once the async load completes. The MCP child
// process is short-lived but cannot use top-level await — Docker
// builds tsx with cjs output, where TLA fails at parse time.
// Instead, the stdin handler awaits `runtimeReady` before serving
// `tools/list` / `tools/call`, so requests arriving early just wait.
// Both views are derived from the same plugin barrel, so every def has an
// endpoint; a def without one is dropped rather than published half-wired.
function pluginToolEntries(): [name: string, tool: ToolDef][] {
  const entries: [string, ToolDef][] = [];
  for (const def of PLUGIN_DEFS) {
    const endpoint = TOOL_ENDPOINTS[def.name];
    if (endpoint !== undefined) entries.push([def.name, fromPackage(def, endpoint)]);
  }
  return entries;
}

const ALL_TOOLS: Record<string, ToolDef> = {
  ...mcpToolDefs,
  ...Object.fromEntries(pluginToolEntries()),
};

// Host-internal MCP tools the CLI invokes directly via flags
// (currently: `--permission-prompt-tool mcp__mulmoclaude__handlePermission`,
// see buildCliArgs + #1499). NOT gated by `role.availablePlugins`
// — they're infrastructure, not LLM-facing surfaces. Filtered against
// ALL_TOOLS before use so a typo here can't crash the server.
const ALWAYS_ON_INTERNAL_TOOL_NAMES = ["handlePermission"] as const;

function expandActiveNames(base: readonly string[]): string[] {
  return [...base, ...ALWAYS_ON_INTERNAL_TOOL_NAMES];
}

let activeNames: string[] = expandActiveNames(PLUGIN_NAMES);
let tools: ToolDef[] = resolveActiveTools(activeNames, ALL_TOOLS);

// Comma-joined tool names, used to detect whether runtime-plugin load
// actually changed the advertised surface (so we only nudge the client
// to re-fetch when there is something new to see).
const toolSignature = (list: ToolDef[]): string => list.map((toolDef) => toolDef.name).join(",");

// The tool surface served by the immediate `tools/list` response, before
// runtime plugins load.
const staticToolSignature = toolSignature(tools);

// The MCP lifecycle forbids the server from sending notifications before
// the client's `notifications/initialized`. If runtime plugins finish
// loading first, the `tools/list_changed` notification is held here until
// the handshake completes.
let initializedReceived = false;
let listChangedPending = false;

// Ask the client to re-fetch `tools/list` because runtime plugins just
// became available. `respond` is hoisted (declared below).
function notifyToolsListChanged(): void {
  if (!initializedReceived) {
    listChangedPending = true;
    return;
  }
  respond({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}

const publishedToolNames = (): ReadonlySet<string> => new Set(tools.map((toolDef) => toolDef.name));

// Whether a tool name resolves without waiting for runtime-plugin load:
// the `manageSkills` special case, or a tool already published in `tools`
// (static plugins and active pure MCP tools, incl. the always-on
// `handlePermission`). Any other name may be a runtime plugin still loading.
function isToolKnown(name: string): boolean {
  if (name === "manageSkills") return true;
  return tools.some((toolDef) => toolDef.name === name);
}

// Static collision floor — both the GUI plugin set (`MCP_PLUGIN_NAMES`)
// AND the pure MCP tool set (`mcpToolDefs` keys: notify / readXPost /
// searchX / …). A runtime plugin named `notify` must NOT shadow the
// built-in notify tool; including both groups makes the collision
// policy in `runtime-registry.ts` enforce that.
const STATIC_TOOL_NAMES: ReadonlySet<string> = new Set([...MCP_PLUGIN_NAMES, ...Object.keys(mcpToolDefs)]);

// The parent describes every name in PLUGIN_NAMES to the LLM
// (`buildPluginPromptSections`), so a name that resolves to no tool here is a
// tool the agent has been told to call and cannot — the state behind #2731,
// previously visible only by hand-driving the broker over stdio.
function reportPublishedSurface(): void {
  const published = new Set(tools.map((toolDef) => toolDef.name));
  const missing = activeNames.filter((name) => !published.has(name));
  process.stderr.write(`[mcp-server] publishing ${tools.length} tools: ${toolSignature(tools)}\n`);
  if (missing.length > 0) {
    process.stderr.write(`[mcp-server] advertised but NOT published (check plugin load above): ${missing.join(",")}\n`);
  }
}

// Internal try/catch so a filesystem failure (EACCES on plugins.json,
// busted tgz, runaway plugin import) can never strand the MCP
// handshake. Runtime plugins are best-effort: any failure logs and
// falls back to the static-only tool list initialised above. `tools/list`
// answers immediately from the static set; only a `tools/call` for an
// as-yet-unknown name awaits `runtimeReady`. When it resolves, the client
// is nudged to re-fetch via `notifications/tools/list_changed`.
const runtimeReady: Promise<void> = (async () => {
  try {
    // Same merge order as the parent server (server/index.ts):
    // presets first so they win the runtime-vs-runtime collision.
    // Dev plugins (`--dev-plugin`) come last and rely on the parent
    // server having already validated paths + collision-free; the
    // child re-loads them here so the MCP tool table sees them too.
    // Failures are logged in the parent's pre-flight, so anything that
    // gets through `loadDevPlugins` here should be clean — but we still
    // collect errors silently and skip rather than abort the MCP child.
    const presets = await loadPresetPlugins();
    const userInstalled = await loadRuntimePlugins();
    const devLoad = await loadDevPlugins(parseDevPluginsEnv(process.env.MULMOCLAUDE_DEV_PLUGINS, process.cwd()));
    registerRuntimePlugins(STATIC_TOOL_NAMES, [...presets, ...userInstalled, ...devLoad.plugins]);
    for (const plugin of getRuntimePlugins()) {
      // Build from the canonical route constant so a future rename
      // ripples here automatically — `runtime-plugin.ts` registers
      // the same `:pkg` pattern (#1077 review).
      const endpoint = API_ROUTES.plugins.runtimeDispatch.replace(":pkg", encodeURIComponent(plugin.name));
      ALL_TOOLS[plugin.definition.name] = fromPackage(plugin.definition, endpoint);
    }
    // Runtime plugins are gated by `role.availablePlugins` (mirrored
    // here through the PLUGIN_NAMES env set by the parent's
    // `getActivePlugins(role)`). Previously every runtime plugin was
    // auto-active in every role, which leaked preset plugins like
    // `manageRecipes` into roles that shouldn't expose them. The
    // intersection is now: ALL_TOOLS includes both static + runtime
    // entries, but only the names PLUGIN_NAMES authorises become live
    // tools.
    activeNames = expandActiveNames(PLUGIN_NAMES);
    tools = resolveActiveTools(activeNames, ALL_TOOLS);
  } catch (err) {
    process.stderr.write(`[mcp-server] runtime plugin load failed; static tools only: ${String(err)}\n`);
  }
  reportPublishedSurface();
  // Runtime plugins (if any) are now folded into `tools`. The initial
  // `tools/list` already served the static set (incl. handlePermission);
  // nudge the client to re-fetch only if the surface actually grew.
  if (toolSignature(tools) !== staticToolSignature) {
    notifyToolsListChanged();
  }
})();

// How long the first `tools/list` may wait for runtime plugins. Deliberately
// well under the CLI's ~5 s native connect wait (#2201) — this is a
// correctness fix for a load that normally takes milliseconds, not a budget
// for a slow one. A load that overruns it falls back to today's behaviour:
// answer with the static set, then `notifications/tools/list_changed`.
const TOOLS_LIST_RUNTIME_WAIT_MS = 2 * ONE_SECOND_MS;

// MCP tools (e.g. readXPost, searchX) call external APIs through their
// own handlers. The bridge timeout must exceed those inner timeouts
// plus a small buffer for JSON parsing / HTTP round-trip, otherwise the
// bridge aborts before the handler can return a formatted error.
// Currently the slowest inner timeout is the X API (20 s); 30 s gives
// 10 s of headroom and still lands well inside the MCP client's own
// 30-60 s tool-call window.
const MCP_TOOL_BRIDGE_TIMEOUT_MS = 30 * ONE_SECOND_MS;

// Plugin tools (e.g. presentDocument, openCanvas) may invoke generative
// AI — image generation routinely takes 10–30 s per call, video can run
// for several minutes, and a single tool invocation can fan out to
// multiple parallel generations. The bridge MUST stay out of the way:
// set a ceiling far above any realistic completion time so the limiting
// factor is the agent SDK's own tool-call window, never this fetch.
// Pick 20 minutes — long enough for batch image gen + future video gen,
// short enough that a truly wedged Express handler still surfaces.
const PLUGIN_BRIDGE_TIMEOUT_MS = 20 * ONE_MINUTE_MS;

function respond(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

// All bridge calls go to the same backend on the same session, so
// every fetch was duplicating the same headers, method, and
// stringify boilerplate. `postJson` captures BASE_URL + SESSION_ID
// once and lets handleToolCall focus on what it's calling, not how.
//
// `path` is the absolute server path (e.g. /api/internal/tool-result)
// — the session query string is appended automatically.
//
// Both network errors and HTTP failures (4xx/5xx) are converted into
// a descriptive Error by default, so the outer catch in handleToolCall
// reports them as the failed tool call instead of a silent success.
// Pass `allowHttpError: true` for callers that want to inspect the
// response themselves (e.g. /api/mcp-tools/* which has its own
// status-aware result handling).
//
// =====================================================================
// TIMEOUT POLICY — read this before adding a new bridge call
// =====================================================================
// The default `timeoutMs` from `fetchWithTimeout` is 10 s, sized for
// healthy localhost round-trips. THAT IS TOO SHORT for any handler
// that fans out to generative AI (image / video / model calls) or
// hits a slow external API. Whenever the downstream handler can
// legitimately take longer than ~5 s, the caller MUST pass an
// explicit `timeoutMs` that comfortably exceeds the worst realistic
// completion time:
//
//   - Generative AI plugins (presentDocument, openCanvas, …)
//     → use `PLUGIN_BRIDGE_TIMEOUT_MS` (20 min). Image batches and
//       future video generation MUST NOT be limited by the bridge.
//   - External-API MCP tools (readXPost, searchX, …)
//     → use `MCP_TOOL_BRIDGE_TIMEOUT_MS` (30 s) or a custom value
//       larger than the inner API's own timeout.
//   - Pure server-state RPCs (toolResult push, role switch, …)
//     → default 10 s is fine; these are local JSON round-trips.
//
// On EVERY failure (timeout, abort, connection reset, HTTP 5xx) this
// function MUST emit an error log to stderr. Silent timeouts are the
// exact failure mode that hid the original bug — the server kept
// generating images, the bridge gave up at 10 s, and the user saw
// "tool failed" with no trace in the logs. If you change the catch
// block below, keep the log emission.
// =====================================================================
interface PostJsonOpts {
  allowHttpError?: boolean | undefined;
  // Override the default bridge-call timeout. Needed when the
  // downstream handler itself does slow work (e.g. /api/mcp-tools/*
  // that hits an external API): the bridge must wait long enough for
  // the handler's own timeout to fire, otherwise the outer abort
  // preempts a formatted error.
  timeoutMs?: number | undefined;
}

async function postJson(path: string, body: unknown, opts: PostJsonOpts = {}): Promise<Response> {
  // SESSION_ID comes from the parent process env so it's effectively
  // trusted, but encode it anyway — defense in depth against future
  // callers passing unexpected characters (`&`, `#`, newlines, etc.).
  // The path arg is used as-is because all current call sites pass
  // hardcoded literals.
  let res: Response;
  const startedAt = Date.now();
  try {
    res = await fetchWithTimeout(`${BASE_URL}${path}?session=${encodeURIComponent(SESSION_ID)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    // `fetchWithTimeout` throws a DOMException("TimeoutError") when
    // the timer fires; surface that case explicitly so the operator
    // can tell "timeout vs. connection error" at a glance.
    const elapsedMs = Date.now() - startedAt;
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    const kind = isTimeout ? "TIMEOUT" : "NETWORK";
    console.error(`[mcp-bridge] ${kind} ${path} after ${elapsedMs}ms (timeoutMs=${opts.timeoutMs ?? "default"}): ${errorMessage(err)}`);
    throw new Error(`Network error calling ${path}: ${errorMessage(err)}`);
  }
  if (!opts.allowHttpError && !res.ok) {
    const errBody = await safeResponseText(res, 500);
    const detail = errBody ? `: ${errBody}` : "";
    // Mirror the network/timeout error path above — log to stderr so
    // an HTTP 4xx/5xx from the server never hides from the bridge
    // operator. Without this, the thrown Error propagates silently
    // to the MCP caller and the log stream shows nothing.
    const elapsedMs = Date.now() - startedAt;
    console.error(`[mcp-bridge] HTTP ${res.status} ${path} after ${elapsedMs}ms${detail}`);
    throw new Error(`HTTP ${res.status} calling ${path}${detail}`);
  }
  return res;
}

// Bridge for the manageSkills tool. Routes by `action`:
//   - "list" (default): GET /api/skills, push the list as a ToolResult
//   - "save"          : POST /api/skills with { name, description, body }
//   - "delete"        : DELETE /api/skills/:name
// In every case, after a successful mutation we re-fetch the list and
// push it so the canvas reflects the new state immediately.
async function handleManageSkills(args: Record<string, unknown>): Promise<string> {
  const action = typeof args.action === "string" ? args.action : "list";
  if (action === "save") return handleManageSkillsSave(args);
  if (action === "update") return handleManageSkillsUpdate(args);
  if (action === "delete") return handleManageSkillsDelete(args);
  return handleManageSkillsList();
}

async function fetchSkillsList(): Promise<{ name: string }[]> {
  const url = `${BASE_URL}/api/skills?session=${encodeURIComponent(SESSION_ID)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers: AUTH_HEADER });
  } catch (err) {
    throw new Error(`Network error calling /api/skills: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    const body = await safeResponseText(res);
    throw new Error(`HTTP ${res.status} calling /api/skills: ${body}`);
  }
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.skills)) {
    throw new Error(`Unexpected /api/skills response: expected { skills: [...] }`);
  }
  return body.skills.filter((skill): skill is { name: string } => isRecord(skill) && typeof skill.name === "string");
}

async function pushSkillsListResult(message: string): Promise<void> {
  const skills = await fetchSkillsList();
  await postJson(API_ROUTES.agent.internal.toolResult, {
    toolName: "manageSkills",
    uuid: makeUuid(),
    title: "Skills",
    message,
    data: { skills },
  });
}

async function handleManageSkillsList(): Promise<string> {
  const skills = await fetchSkillsList();
  const suffix = skills.length === 1 ? "" : "s";
  await postJson(API_ROUTES.agent.internal.toolResult, {
    toolName: "manageSkills",
    uuid: makeUuid(),
    title: "Skills",
    message: `Found ${skills.length} skill${suffix}.`,
    data: { skills },
  });
  return `Listed ${skills.length} skill${suffix}`;
}

// `args` is whatever the model emitted, so `name` can be any JSON type. These
// three used `String(args.name ?? "")` with the stated intent of never
// interpolating an accidental object into `/${name}` — but `String({})` is
// exactly the "[object Object]" that would then be POSTed to the API and read
// back to the user as a skill name. Rejecting a non-string outright is what the
// comment always meant, and matches how `action` is read in the dispatcher.
function skillNameArg(args: Record<string, unknown>): string {
  if (!isNonEmptyString(args.name)) {
    throw new Error("manageSkills: `name` must be a non-empty string");
  }
  return args.name;
}

async function handleManageSkillsSave(args: Record<string, unknown>): Promise<string> {
  const name = skillNameArg(args);
  const res = await postJson(
    API_ROUTES.skills.create.url,
    {
      name,
      description: args.description,
      body: args.body,
    },
    { allowHttpError: true },
  );
  if (!res.ok) {
    return `Error: ${await extractFetchError(res)}`;
  }
  await pushSkillsListResult(`Saved skill "${name}".`);
  return `Saved skill ${name}. Run with /${name}.`;
}

async function handleManageSkillsUpdate(args: Record<string, unknown>): Promise<string> {
  const name = skillNameArg(args);
  const url = `${BASE_URL}/api/skills/${encodeURIComponent(name)}?session=${encodeURIComponent(SESSION_ID)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "PUT",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({
        description: args.description,
        body: args.body,
      }),
    });
  } catch (err) {
    throw new Error(`Network error calling PUT /api/skills/${name}: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    return `Error: ${await extractFetchError(res)}`;
  }
  await pushSkillsListResult(`Updated skill "${name}".`);
  return `Updated skill ${name}. The changes take effect in new sessions.`;
}

async function handleManageSkillsDelete(args: Record<string, unknown>): Promise<string> {
  const name = skillNameArg(args);
  const url = `/api/skills/${encodeURIComponent(name)}?session=${encodeURIComponent(SESSION_ID)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(`${BASE_URL}${url}`, {
      method: "DELETE",
      headers: AUTH_HEADER,
    });
  } catch (err) {
    throw new Error(`Network error calling DELETE ${url}: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    return `Error: ${await extractFetchError(res)}`;
  }
  await pushSkillsListResult(`Deleted skill "${name}".`);
  return `Deleted skill ${name}.`;
}

// Render a pure-MCP-tool response body to the string the CLI returns. The
// body is untyped JSON, so `error`/`result` are read through guards: a
// non-string `error` falls back to the status code (avoids stringifying an
// object), and a non-string `result` is JSON-encoded — with a "null" fallback
// because `JSON.stringify(undefined)` is itself `undefined`, which the return
// type forbids.
async function formatMcpToolResponse(res: Response): Promise<string> {
  const json: unknown = await res.json();
  if (!res.ok) {
    const errValue = isRecord(json) && typeof json.error === "string" ? json.error : undefined;
    return `Error: ${errValue ?? res.status}`;
  }
  const resultValue = isRecord(json) ? json.result : undefined;
  return typeof resultValue === "string" ? resultValue : (JSON.stringify(resultValue) ?? "null");
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "manageSkills") return handleManageSkills(args);

  // Pure MCP tools — call via /api/mcp-tools/:tool, return text directly
  // (no frontend push). Opt out of postJson's HTTP error throw because
  // we want to surface the JSON error body to the caller as a string.
  // The tool handler may hit a slow external API (e.g. X), so pass a
  // longer bridge timeout than the default 10 s used for localhost
  // roundtrips — see MCP_TOOL_BRIDGE_TIMEOUT_MS.
  const mcpTool = findDispatchableMcpTool(name, mcpTools, publishedToolNames());
  if (mcpTool) {
    const res = await postJson(`/api/mcp-tools/${name}`, args, {
      allowHttpError: true,
      // A tool whose own budget exceeds the shared 30 s says so on its
      // definition; otherwise the external-API default applies.
      timeoutMs: mcpTool.bridgeTimeoutMs ?? MCP_TOOL_BRIDGE_TIMEOUT_MS,
    });
    return formatMcpToolResponse(res);
  }

  const tool = tools.find((toolDef) => toolDef.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!tool.endpoint) throw new Error(`Tool has no endpoint: ${name}`);

  // Plugin handlers can fan out to generative AI (image batches via
  // presentDocument, future video). The bridge MUST wait long enough
  // for the slowest realistic completion — see PLUGIN_BRIDGE_TIMEOUT_MS
  // and the timeout-policy comment on `postJson`.
  const res = await postJson(tool.endpoint, args, { timeoutMs: PLUGIN_BRIDGE_TIMEOUT_MS });
  const rawResult: unknown = (await res.json()) ?? {};
  const result: BridgeResultEnvelope = isRecord(rawResult) ? rawResult : {};

  // Push visual ToolResult to the frontend via the session — but
  // only when the handler set `data`, which is the protocol's
  // render-eligibility signal. Narrate-only actions (e.g.
  // accounting `getReport`, `getBooks`, plugin validation-error
  // branches) deliberately omit `data` and behave like a plain
  // MCP tool call: the LLM gets the result via
  // the return value below, and nothing lands in the session's
  // `toolResults` or its on-disk JSONL log. (`jsonData` is
  // orthogonal — the LLM-readable copy — and does NOT gate
  // rendering on its own.)
  if (result.data !== undefined) {
    // Spread `result` first so the bridge's own `toolName` and `uuid`
    // are authoritative — a plugin handler that (intentionally or
    // accidentally) returned those keys can't impersonate a different
    // tool or collide on uuid.
    await postJson(API_ROUTES.agent.internal.toolResult, {
      ...result,
      toolName: name,
      uuid: makeUuid(),
    });
  }

  return pluginResultText(result);
}

// Milliseconds from this process starting to the module being set up — the
// cold boot itself. `performance.now()` is relative to process start, so tsx
// transcoding the import graph (or node reading the 6 MB bundle) is already
// inside the number, and no host/container clock agreement is needed (#2842).
const BOOT_MS = Math.round(performance.now());

// Which spawn path this is, as seen from inside: the bundle is emitted as
// `server/build/mcp-server.mjs`, the fallback runs `mcp-server.ts` under tsx.
const BROKER_KIND = import.meta.url.endsWith(".mjs") ? "bundle" : "tsx";

// `initialize` can arrive again on a reconnect; the first answer is the one
// that raced the CLI's connect wait, so later ones say nothing new. Set when
// delivery STARTS, not when it succeeds — a second handshake must not open a
// second retry chain reporting a boot time that is no longer the first one.
const brokerReadyBeacon = { started: false };

// Fire-and-forget, and only AFTER the handshake reply is already on the wire.
// The host has no other view of this child — Claude CLI spawned it and owns its
// stderr — so without this beacon a slow broker and a dead one are the same
// observation from out there (#2842). Deliberately never awaited and never
// rethrown: a beacon that delayed `initialize` would worsen the very race it
// exists to measure.
//
// Retried rather than sent once, because the host now SKIPS the automatic
// replay when no beacon arrived. A beacon dropped in flight would make a
// healthy broker look like one that never started.
function reportBrokerReady(): void {
  if (brokerReadyBeacon.started) return;
  brokerReadyBeacon.started = true;
  const body = { bootMs: BOOT_MS, initializeMs: Math.round(performance.now()), kind: BROKER_KIND, spawnId: env.mcpSpawnId };
  void deliverBeacon(
    {
      send: (timeoutMs) => postJson(API_ROUTES.mcp.brokerReady, body, { timeoutMs }),
      // Unref'd: a pending retry must never be the reason this process stays up.
      wait: (delayMs) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs).unref();
        }),
      report: (attempts, err) => process.stderr.write(`[mcp-server] startup beacon undelivered after ${attempts} attempts: ${errorMessage(err)}\n`),
    },
    BROKER_READY_DELIVERY,
  );
}

function handleInitialize(requestId: JsonRpcId | undefined): void {
  respond({
    jsonrpc: "2.0",
    id: requestId,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "mulmoclaude", version: "1.0.0" },
    },
  });
  reportBrokerReady();
}

// Answer once runtime plugins are in — but never later than the cap. A client
// that snapshots the tool surface at session start (a deferred / tool-search
// index does) keeps whatever this first response said, so answering
// static-only leaves preset tools like `google` described in the system prompt
// yet uncallable for the rest of the session, with
// `notifications/tools/list_changed` doing nothing for it (#2731). The cap
// keeps the #1698 / #2201 property that a slow plugin load cannot starve
// `handlePermission` at session start: past it we answer with what we have and
// the notification remains the backstop.
function handleToolsList(requestId: JsonRpcId | undefined): void {
  void settleWithin(runtimeReady, TOOLS_LIST_RUNTIME_WAIT_MS).then(() => {
    respond({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        tools: tools.map((toolDef) => ({
          name: toolDef.name,
          description: toolDef.description,
          inputSchema: toolDef.inputSchema,
        })),
      },
    });
  });
}

function handleToolsCall(requestId: JsonRpcId | undefined, params?: ToolCallParams): void {
  if (!params?.name) {
    respond({
      jsonrpc: "2.0",
      id: requestId,
      error: { code: -32602, message: "Invalid params: tools/call requires params.name" },
    });
    return;
  }
  const toolArgs = params.arguments ?? {};
  const callName = params.name;
  // Static tools (incl. `handlePermission`) resolve synchronously, so they
  // need not wait for `runtimeReady`; only an as-yet-unknown name (possibly a
  // runtime plugin still loading) does. Keeps the permission-prompt tool
  // responsive at session start (#1698).
  const callReady = isToolKnown(callName) ? Promise.resolve() : runtimeReady;
  callReady
    .then(() => handleToolCall(callName, toolArgs))
    .then((text) => {
      respond({ jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text }] } });
    })
    .catch((err: unknown) => {
      respond({
        jsonrpc: "2.0",
        id: requestId,
        result: { content: [{ type: "text", text: String(err) }], isError: true },
      });
    });
}

// The client is ready for server notifications. Flush a `tools/list_changed`
// that runtime-plugin load produced before the handshake completed (the MCP
// lifecycle forbids sending it earlier).
function handleInitialized(): void {
  initializedReceived = true;
  if (listChangedPending) {
    listChangedPending = false;
    respond({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }
}

function dispatchRpc(msg: JsonRpcMessage): void {
  const { id: requestId, method, params } = msg;
  if (method === "initialize") handleInitialize(requestId);
  else if (method === "tools/list") handleToolsList(requestId);
  else if (method === "tools/call") handleToolsCall(requestId, params);
  else if (method === "ping") respond({ jsonrpc: "2.0", id: requestId, result: {} });
  else if (method === "notifications/initialized") handleInitialized();
  // other notifications: no response needed
}

let buffer = "";

process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (isJsonRpcMessage(msg)) dispatchRpc(msg);
  }
});

// Drain pending responses before exiting. A `tools/call` for an
// as-yet-unknown name queues its reply on `runtimeReady.then(...)`, so a
// synchronous `process.exit(0)` here can race it: if stdin closes before the
// runtime plugin loader resolves, that `.then` callback never gets to write
// its response. Awaiting `runtimeReady` first lets the pending reply flush,
// and setting `exitCode` (instead of calling `exit`) lets the event loop
// drain the rest of the I/O before the process leaves naturally.
process.stdin.on("end", () => {
  // Terminal `.catch` rather than a bare `void` — the promise has to be
  // settled here. The exit code deliberately stays 0 on both paths: a runtime
  // that failed to load is already reported on stderr and degrades to static
  // tools rather than aborting this child, and that tolerance is exactly what
  // keeps a host whose plugin junctions don't resolve (Windows + Docker,
  // #1946 / #2052) usable instead of surfacing a crashed MCP server.
  runtimeReady
    .finally(() => {
      process.exitCode = 0;
    })
    .catch(() => {});
});
