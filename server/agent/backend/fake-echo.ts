// Test-only LLM backend. Loaded by `getActiveBackend()` only when
// `MULMOCLAUDE_FAKE_AGENT=1` (CI workflow boot wiring), and re-usable
// from unit tests via `setFakeResponse()` / `resetFakeResponse()`.
//
// Default behavior:
//   - emits a synthesized `claudeSessionId` so the orchestrator's
//     resume bookkeeping sees the same shape as a real run
//   - short-circuits `/<slug>` slash-command turns by reading the
//     seeded SKILL.md and echoing the canary marker line
//   - emits the concatenated per-session message history as the
//     assistant text reply, so context-recall tests (session L-12)
//     see prior turn content
//
// Tool dispatch: when the user prompt matches a known shape (see
// detectToolCalls), fake-echo emits the corresponding tool_call
// AND posts the args to the same internal plugin endpoint the MCP
// bridge would use under real Claude (see PLUGIN_ENDPOINTS). The
// handler runs unmodified, the artifact lands on disk, and the
// canvas mounts the plugin View — fake at the LLM seam only, real
// from the tool dispatch downward. Tests that need an LLM that
// actually reasons (presentForm field design, agent-driven slug
// choice in skill creation, etc.) still stay gated on
// `E2E_LIVE_NO_LLM=1`.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getCurrentToken } from "../../api/auth/token.js";
import { errorMessage } from "../../utils/errors.js";
import { makeUuid } from "../../utils/id.js";
import { isRecord } from "../../utils/types.js";
import { pluginResultText, type PluginResultEnvelope } from "../pluginResultText.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { EVENT_TYPES } from "../../../src/types/events.js";
import { WORKSPACE_DIRS } from "../../workspace/paths.js";
import type { AgentEvent } from "../stream.js";
import type { AgentInput, LLMBackend } from "./types.js";

export interface FakeToolCall {
  toolName: string;
  args: unknown;
  /** Result string emitted in the matching `tool_call_result`.
   *  Defaults to `{ ok: true }` JSON. */
  result?: string;
}

export interface FakeResponse {
  /** Tool calls emitted before the text block. Default generator
   *  never emits any — tests that want tool events drive them
   *  through `setFakeResponse()`. */
  toolCalls?: readonly FakeToolCall[] | undefined;
  /** Assistant text. Omit to skip the text event entirely. */
  text?: string | undefined;
  /** When set, emit a single `error` AgentEvent with this message
   *  and stop — mirrors what the claude-code backend does when the
   *  CLI exits non-zero (`readAgentEvents`). Tool calls / text that
   *  would otherwise follow are suppressed. */
  error?: string | undefined;
  /** Emit the `tool_call` for each `toolCalls` entry but NOT the
   *  paired `tool_call_result` — simulates a truncated / partial
   *  stream where the model died mid tool round-trip. */
  omitToolResult?: boolean | undefined;
}

export type FakeResponseFn = (input: AgentInput) => FakeResponse | Promise<FakeResponse>;

// Per-session conversation memory so context-recall tests see prior
// turn content in the reply. Cleared by `resetFakeResponse()`.
const sessionTurns = new Map<string, string[]>();

async function defaultResponse(input: AgentInput): Promise<FakeResponse> {
  // Slash-command turn shape: the SPA's "Run" button on a skill row
  // (e2e-live L-22) starts a new chat with `/<slug>` as the only
  // user message. Real Claude resolves this through its skill
  // pipeline and uses the SKILL.md body as system prompt; here we
  // short-circuit to read the seeded body and apply the
  // "respond with this exact line" heuristic the e2e-live canaries
  // rely on. Falls through to default echo on no match.
  // Prompt-driven error trigger for e2e-live. The in-process
  // `setFakeResponse()` knob is unreachable from a browser-driven
  // spec (separate process), so the error-banner UI canary opts in
  // by sending a message containing this exact marker. Prod never
  // reaches fake-echo (real Claude backend) so this is inert there.
  if (input.message.includes("__FAKE_ERROR__")) {
    // Message text is rendered through marked() in the chat card,
    // so keep it free of markdown-significant characters (no `__`,
    // `*`, backticks) — the e2e-live canary asserts on a literal
    // substring of this string.
    return { error: "fake-echo forced error for the e2e-live error-banner canary" };
  }

  // Match a leading `/<skill>` command, with or without trailing
  // arguments (e.g. the collection Chat button seeds
  // `/<slug> <message>`). Only the skill name drives the seeded
  // reply — any args are for the real LLM and are ignored here.
  const skillName = input.message.trim().match(/^\/([a-z0-9][a-z0-9-]*)(?:\s|$)/i)?.[1];
  if (skillName !== undefined) {
    const skillReply = await replyFromSeededSkill(input.workspacePath, skillName);
    if (skillReply !== null) return { text: skillReply };
  }

  const history = sessionTurns.get(input.sessionId) ?? [];
  history.push(input.message);
  sessionTurns.set(input.sessionId, history);

  const toolCalls = detectToolCalls(input.message);
  return {
    toolCalls,
    text: history.join("\n\n"),
  };
}

// ── Tool-call pattern detectors ───────────────────────────────────
//
// Each detector matches one e2e-live prompt shape. The fake-echo
// loop below dispatches each detected call to the matching server-
// side plugin endpoint (see PLUGIN_ENDPOINTS) so the real handler
// runs, the artifact lands on disk, and the canvas mounts the View.
// Production never reaches this code path — gated by
// MULMOCLAUDE_FAKE_AGENT=1 at server boot.

function detectPresentMulmoScript(message: string): FakeToolCall | null {
  if (!/presentMulmoScript/i.test(message)) return null;
  const filePathMatch = message.match(/filePath:\s*["']([^"']+)["']/);
  if (!filePathMatch) return null;
  return { toolName: "presentMulmoScript", args: { filePath: filePathMatch[1] } };
}

function detectPresentHtml(message: string): FakeToolCall | null {
  if (!/presentHtml/i.test(message)) return null;
  const idx = message.indexOf("<");
  if (idx < 0) return null;
  // The handler expects a self-contained document; wrap if the
  // prompt only supplies fragments (the spec's prompt does).
  const fragment = message.slice(idx).trim();
  const html = /^<!DOCTYPE/i.test(fragment) ? fragment : `<!DOCTYPE html><html><body>${fragment}</body></html>`;
  return { toolName: "presentHtml", args: { html } };
}

function detectPresentForm(message: string): FakeToolCall | null {
  if (!/presentForm/i.test(message)) return null;
  const titleMatch = message.match(/titled\s+['"]([^'"]+)['"]/i);
  const idMatch = message.match(/id\s*=\s*['"]([^'"]+)['"]/i);
  const labelMatch = message.match(/label\s*=\s*['"]([^'"]+)['"]/i);
  return {
    toolName: "presentForm",
    args: {
      title: titleMatch?.[1] ?? "Quick check",
      fields: [
        {
          id: idMatch?.[1] ?? "field1",
          type: "text",
          label: labelMatch?.[1] ?? "Field",
          required: /required/i.test(message),
          description: "auto-generated by fake-echo",
        },
      ],
    },
  };
}

function detectPresentChart(message: string): FakeToolCall | null {
  if (!/presentChart/i.test(message)) return null;
  const titleMatch = message.match(/titled\s+['"]([^'"]+)['"]/i);
  const pairs = Array.from(message.matchAll(/\b([A-Za-z]{3,})\s+(\d{1,6})\b/g)).map(([, label, value]) => ({ label, value: Number(value) }));
  const labels = pairs.length > 0 ? pairs.map((pair) => pair.label) : ["A", "B", "C"];
  const values = pairs.length > 0 ? pairs.map((pair) => pair.value) : [1, 2, 3];
  const title = titleMatch?.[1] ?? "Untitled";
  return {
    toolName: "presentChart",
    args: {
      document: {
        title,
        charts: [
          {
            title,
            type: "bar",
            option: {
              xAxis: { type: "category", data: labels },
              yAxis: { type: "value" },
              series: [{ type: "bar", data: values }],
            },
          },
        ],
      },
    },
  };
}

function detectToolCalls(message: string): FakeToolCall[] | undefined {
  const calls: FakeToolCall[] = [];
  for (const detector of [detectPresentMulmoScript, detectPresentHtml, detectPresentForm, detectPresentChart]) {
    const call = detector(message);
    if (call) calls.push(call);
  }
  return calls.length > 0 ? calls : undefined;
}

// ── Plugin dispatch ───────────────────────────────────────────────
//
// Maps each fake-detected tool to the same internal API the MCP
// bridge would post to in a real run, so the actual server-side
// handler runs end-to-end: artifact saved, canvas slug returned.
// Anything not in this table falls back to a synthesized success
// envelope (caller can override via FakeToolCall.result).
const PLUGIN_ENDPOINTS: Readonly<Record<string, string>> = {
  presentForm: "/api/form",
  presentHtml: "/api/html",
  presentChart: "/api/chart",
  presentMulmoScript: "/api/mulmoScript/save",
};

// Mirrors what server/agent/mcp-server.ts#handleToolCall does for
// the real MCP bridge:
//   1. POST to the plugin endpoint to get the envelope back
//   2. If envelope.data is set, PUSH the envelope to
//      /api/internal/tool-result — this is what surfaces the result
//      to the canvas as a ToolResultComplete (toolName + uuid
//      stamped by the bridge so the plugin can't impersonate).
//   3. Return the text representation (message + instructions) so
//      the matching `tool_call_result` event carries something
//      meaningful for the tool-call history pane.
async function dispatchToPlugin(call: FakeToolCall, port: number, chatSessionId: string): Promise<string> {
  if (call.result !== undefined) return call.result;
  const endpoint = PLUGIN_ENDPOINTS[call.toolName];
  if (!endpoint) return '{"ok":true}';
  const token = getCurrentToken();
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    const response = await fetch(`http://localhost:${port}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(call.args),
    });
    if (!response.ok) {
      const errBody = await response.text();
      return JSON.stringify({ error: `plugin ${call.toolName} returned ${response.status}: ${errBody.slice(0, 200)}` });
    }
    const parsed: unknown = await response.json();
    const envelope: PluginResultEnvelope = isRecord(parsed) ? parsed : {};
    if (envelope.data !== undefined) {
      // Query key is `session`, not `chatSessionId` — matches the
      // `getSessionQuery(req)` reader and what the MCP bridge's
      // postJson(...) helper passes (`?session=${SESSION_ID}`).
      const toolResultUrl = `http://localhost:${port}${API_ROUTES.agent.internal.toolResult}?session=${encodeURIComponent(chatSessionId)}`;
      const pushRes = await fetch(toolResultUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ ...envelope, toolName: call.toolName, uuid: makeUuid() }),
      });
      if (!pushRes.ok) {
        // Fail loudly per codex review — a swallowed publish would
        // leave the canvas blank while the chat reads "Done", which
        // masks a real wiring break. Surface the failure as the
        // tool result so the test fails loud instead of timing out
        // on an absent View.
        const errBody = await pushRes.text();
        return JSON.stringify({
          error: `tool-result push failed for ${call.toolName}: ${pushRes.status} ${errBody.slice(0, 200)}`,
        });
      }
    }
    return pluginResultText(envelope);
  } catch (err) {
    // Don't tear down the chat turn on plugin-dispatch failure —
    // surface the error in the tool_result so the test sees it.
    return JSON.stringify({ error: errorMessage(err) });
  }
}

// Look up a project-scope skill seeded by `placeProjectSkill` and
// extract the canary line the seeded body asks the model to echo
// back ("respond with this exact line and nothing else: X").
// Returns null when the file is missing or the marker shape is
// absent — caller falls through to default echo.
async function replyFromSeededSkill(workspacePath: string, slug: string): Promise<string | null> {
  const skillFile = path.join(workspacePath, WORKSPACE_DIRS.claudeSkills, slug, "SKILL.md");
  let body: string;
  try {
    body = await readFile(skillFile, "utf8");
  } catch {
    return null;
  }
  // Line-by-line scan to avoid backtracking surprises.
  for (const line of body.split(/\r?\n/)) {
    const exactLine = line.match(/respond with this exact line(?: and nothing else)?:\s*(.+)/i)?.[1];
    if (exactLine !== undefined) return exactLine.trim();
  }
  return null;
}

// ── Backend wiring ────────────────────────────────────────────────

let responseFn: FakeResponseFn = defaultResponse;

/** Replace the default echo + slash-command generator. Useful for
 *  unit tests that want full control over what the fake backend
 *  emits. Pair with `resetFakeResponse()` in teardown so the next
 *  test sees a clean state. */
export function setFakeResponse(generator: FakeResponseFn): void {
  responseFn = generator;
}

/** Restore the default generator AND clear per-session history. */
export function resetFakeResponse(): void {
  responseFn = defaultResponse;
  sessionTurns.clear();
}

// Abort is checked between every yield. Real claude-code kills the
// subprocess on abort; the echo stub has no subprocess, so the
// faithful equivalent is "stop emitting immediately".
function aborted(input: AgentInput): boolean {
  return input.abortSignal?.aborted === true;
}

async function* runFakeEchoAgent(input: AgentInput): AsyncGenerator<AgentEvent> {
  if (aborted(input)) return;
  yield { type: EVENT_TYPES.claudeSessionId, id: randomUUID() };

  const response = await responseFn(input);

  // Error short-circuit: surface the error and stop, exactly like
  // the claude-code backend on a non-zero CLI exit.
  if (response.error !== undefined) {
    if (aborted(input)) return;
    yield { type: EVENT_TYPES.error, message: response.error };
    return;
  }

  for (const call of response.toolCalls ?? []) {
    if (aborted(input)) return;
    const toolUseId = `fake-${randomUUID()}`;
    yield {
      type: EVENT_TYPES.toolCall,
      toolUseId,
      toolName: call.toolName,
      args: call.args,
    };
    // Partial-stream simulation: skip the result half.
    if (response.omitToolResult) continue;
    // Run the actual plugin handler AND push the envelope to
    // /api/internal/tool-result so the canvas mounts the View — same
    // two-step the MCP bridge does for real Claude.
    const content = await dispatchToPlugin(call, input.port, input.sessionId);
    if (aborted(input)) return;
    yield {
      type: EVENT_TYPES.toolCallResult,
      toolUseId,
      content,
    };
  }

  if (response.text !== undefined && !aborted(input)) {
    yield { type: EVENT_TYPES.text, message: response.text };
  }
}

export const fakeEchoBackend: LLMBackend = {
  id: "fake-echo",
  // Resume-by-token / MCP aren't meaningfully replayable from a
  // stub. Flag them unsupported so callers that depend on the real
  // Claude semantics opt out instead of getting silently wrong
  // behavior.
  capabilities: { sessionResume: false, mcp: false },
  runAgent: runFakeEchoAgent,
};
