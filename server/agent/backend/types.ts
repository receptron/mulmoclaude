// LLM backend abstraction. Today the only implementation is
// ClaudeCodeBackend (server/agent/backend/claude-code.ts), which spawns
// the `claude` CLI as a subprocess. The interface exists so future
// backends (OpenAI, Ollama native, Gemini, etc.) can plug in here
// without the orchestrator in server/agent/index.ts knowing which one
// is active.
//
// See plans/done/refactor-llm-backend-abstraction.md for the broader plan.

import type { Attachment } from "@mulmobridge/protocol";
import type { Role } from "../../../src/config/roles.js";
import type { ChatModel, EffortLevel } from "../../system/config.js";
import type { AgentEvent } from "../stream.js";

/** Inputs the orchestrator passes to a backend for one user turn.
 *  The orchestrator owns role expansion, system prompt building, and
 *  MCP config writing. The backend owns the LLM call itself plus
 *  translation of provider-specific stream events into AgentEvent. */
export interface AgentInput {
  systemPrompt: string;
  message: string;
  role: Role;
  workspacePath: string;
  sessionId: string;
  port: number;
  /** Opaque, backend-specific resume token. For Claude this is the
   *  CLI's session id passed to --resume; other backends may
   *  interpret it differently or ignore it entirely
   *  (capabilities.sessionResume === false). */
  sessionToken?: string | undefined;
  attachments?: Attachment[] | undefined;
  /** Active MCP plugin names (the subset of role.availablePlugins
   *  that is actually registered as an MCP plugin). The orchestrator
   *  has already filtered these — backends should not re-derive. */
  activePlugins: string[];
  /** When set, the path the backend should hand to its MCP loader.
   *  Pre-resolved for host-vs-container by the orchestrator. */
  mcpConfigPath?: string | undefined;
  /** HOST-side path of the broker's start marker (#2842). The broker writes it
   *  through its own (container) path; a backend that spawns the broker reads
   *  this one to tell "the process launched" from "it never did". */
  startMarkerPath?: string | undefined;
  /** Identity of the broker this turn spawns. The marker must contain it, so a
   *  file merely pre-created at that path does not read as a broker. */
  spawnId?: string | undefined;
  /** Extra allowed-tool names from settings + user MCP servers. */
  extraAllowedTools: string[];
  /** Reasoning effort from settings (#1323). Undefined → flag omitted. */
  effortLevel?: EffortLevel | undefined;
  /** Model family from settings (#2923). Undefined → flag omitted, so the
   *  CLI resolves the model from `~/.claude/settings.json`. */
  chatModel?: ChatModel | undefined;
  /** When fired, the backend must terminate any in-flight
   *  subprocess / connection. */
  abortSignal?: AbortSignal | undefined;
  userTimezone?: string | undefined;
  /** Whether the orchestrator detected a usable Docker sandbox.
   *  Backends that don't sandbox can ignore. */
  useDocker: boolean;
}

export interface BackendCapabilities {
  /** Can the backend resume a prior conversation by an opaque token?
   *  Claude: yes (--resume <id>). OpenAI / Ollama: no — the
   *  orchestrator must replay transcript instead. */
  sessionResume: boolean;
  /** Does the backend speak MCP natively? Claude: yes. Others:
   *  emulate or skip. Today only Claude consumes activePlugins /
   *  mcpConfigPath. */
  mcp: boolean;
}

export interface LLMBackend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  /** Run one user turn. Yields portable AgentEvents. */
  runAgent: (input: AgentInput) => AsyncIterable<AgentEvent>;
}
