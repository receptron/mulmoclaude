// Claude Code backend: spawns the `claude` CLI as a subprocess (or
// inside the mulmoclaude-sandbox Docker image) and translates its
// stream-json output into portable AgentEvents.
//
// This file is the single seam between the orchestrator in
// server/agent/index.ts (which is backend-agnostic) and the Claude
// CLI specifics. Pure helpers it depends on (CLI arg construction,
// Docker arg construction, stream parsing) stay in their existing
// home so the existing test suite under test/agent/ keeps working
// unchanged.

import { spawn, type ChildProcessByStdio } from "child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { Readable, Writable } from "stream";
import { buildCliArgs, buildDockerSpawnArgs, buildUserMessageLine, resolveSystemPromptPaths, type CliArgsParams } from "../config.js";
import { writeFileAtomic } from "../../utils/files/atomic.js";
import { resolveSandboxAuth } from "../sandboxMounts.js";
import { getCachedReferenceDirs, referenceDirMountArgs } from "../../workspace/reference-dirs.js";
import { createStreamParser, type AgentEvent, type RawStreamEvent } from "../stream.js";
import { createMcpFailureMonitor } from "../mcpFailureMonitor.js";
import { getBrokerReady, getBrokerStarted } from "../brokerReadiness.js";
import { BUILTIN_MCP_TOOL_PREFIX } from "../activeTools.js";
import { isMcpBrokerNotReadyError } from "../mcpBrokerFailover.js";
import { log } from "../../system/logger/index.js";
import { errorMessage } from "../../utils/errors.js";
import { EVENT_TYPES } from "../../../src/types/events.js";
import { env } from "../../system/env.js";
import { claudeBinPath } from "../../utils/claudeBin.js";
import type { AgentInput, LLMBackend } from "./types.js";

type ClaudeProc = ChildProcessByStdio<Writable, Readable, Readable>;

function spawnClaude(useDocker: boolean, workspacePath: string, cliArgs: string[], chatSessionId: string): ClaudeProc {
  if (!useDocker) {
    // MULMOCLAUDE_CHAT_SESSION_ID is the chat-session id our wiki-history
    // PostToolUse hook needs to publish a `page-edit` toolResult back to
    // the right session (#963). Claude CLI's own hook payload carries
    // its internal session_id, which doesn't match our session store.
    return spawn(claudeBinPath(), cliArgs, {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MULMOCLAUDE_CHAT_SESSION_ID: chatSessionId },
    });
  }
  const sandboxAuth = resolveSandboxAuth({
    sshAgentForward: env.sandboxSshAgentForward,
    sshAllowedHosts: env.sandboxSshAllowedHosts,
    configMountNames: env.sandboxMountConfigs,
    sshAuthSock: process.env.SSH_AUTH_SOCK,
  });
  const refDirArgs = referenceDirMountArgs(getCachedReferenceDirs());
  const dockerArgs = buildDockerSpawnArgs({
    workspacePath,
    cliArgs,
    chatSessionId,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    platform: process.platform,
    sandboxAuthArgs: [...sandboxAuth.args, ...refDirArgs],
    sshAgentForward: env.sandboxSshAgentForward,
  });
  return spawn("docker", dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });
}

// Counts the tools a turn ran FROM THE BUILT-IN BROKER. Scoped to
// `mcp__mulmoclaude__` rather than `mcp__`, because the beacon only speaks for
// that broker: a working `mcp__github__…` call says nothing about whether OUR
// broker loaded, and counting it would hide the very startup failure this
// feeds (Codex review on #2906).
//
// A Set rather than a boolean so the state stays `const` and the count can go
// into the log line. Which names count is the half of #2886 that went wrong,
// so this is exported and pinned by tests.
export function createBuiltinMcpToolWatcher() {
  const called = new Set<string>();
  return {
    track(event: AgentEvent): void {
      if (event.type !== EVENT_TYPES.toolCall) return;
      if (event.toolName.startsWith(BUILTIN_MCP_TOOL_PREFIX)) called.add(event.toolName);
    },
    count: (): number => called.size,
  };
}

/** Did this turn look like the broker never delivered its tools?
 *
 *  All four conditions are required, and each rules out a way of being wrong.
 *  They are listed in the order the predicate reads them:
 *
 *  - `mcpConfigured` — a turn that was never given MCP cannot be missing it.
 *  - `!aborted` — a turn the user stopped never got the chance to use its
 *    tools. Hitting the stop button straight away produces "configured, no
 *    beacon, no calls" every time, so without this the diagnostic fires on an
 *    ordinary cancellation (Codex review on #2906).
 *  - `!brokerEverReady` — the startup beacon (#2898) is direct evidence, where
 *    the old check inferred a crash from the SHAPE of the tool names: it fired
 *    whenever ToolSearch ran without a following `mcp__*` call. ToolSearch also
 *    resolves CLI built-ins (`WebFetch`, `PushNotification`), so a perfectly
 *    healthy turn satisfied it — which is how #2886 came to be filed against a
 *    working MCP server.
 *  - `builtinMcpToolsCalled === 0` — the beacon is a POST from the broker back
 *    to the host, so a relay or firewall can swallow it (#2842's socat setup is
 *    exactly that). Built-in tools that ran prove the broker delivered whether
 *    or not its beacon arrived; without this the fix would re-create the false
 *    positive in the very environment that reported it. Only the BUILT-IN
 *    broker's tools count — a user-configured MCP server answering says nothing
 *    about ours.
 */
export function shouldWarnMcpUnavailable(turn: { mcpConfigured: boolean; aborted: boolean; brokerEverReady: boolean; builtinMcpToolsCalled: number }): boolean {
  return turn.mcpConfigured && !turn.aborted && !turn.brokerEverReady && turn.builtinMcpToolsCalled === 0;
}

// Exit codes the claude CLI reports when it is terminated by one of the
// signals our abort handler sends: 128 + signal number (SIGTERM=15 → 143,
// SIGKILL=9 → 137). Node also reports a null code with `signal` set when a
// signal kills the process directly without the CLI's own handler running.
const ABORT_EXIT_CODES = new Set([143, 137]);
const ABORT_SIGNALS = new Set<string>(["SIGTERM", "SIGKILL"]);

// A non-zero exit caused by our own abort (stop button → proc.kill()) is
// expected, not a failure — surfacing it as an error event makes a deliberate
// stop look like a crash. Suppress it ONLY when we actually aborted AND the
// exit is signal-shaped, so a genuine crash that happens to coincide with a
// stop click still surfaces its real error.
export function isAbortCausedExit(exitCode: number | null, signal: string | null, abortSignal?: AbortSignal): boolean {
  if (!abortSignal?.aborted) return false;
  if (signal !== null && ABORT_SIGNALS.has(signal)) return true;
  return exitCode !== null && ABORT_EXIT_CODES.has(exitCode);
}

// Build the error event for a finished claude process, or null when nothing
// should surface (clean exit, or a deliberate abort). exitCode is null when a
// signal — not a code — ended the process, so name the signal in that case
// rather than emitting "claude exited with code null".
export function buildExitErrorEvent(
  exitCode: number | null,
  signal: string | null,
  abortSignal: AbortSignal | undefined,
  stderrOutput: string,
): { type: typeof EVENT_TYPES.error; message: string } | null {
  if (exitCode === 0 || isAbortCausedExit(exitCode, signal, abortSignal)) return null;
  const exitSummary = exitCode !== null ? `claude exited with code ${exitCode}` : `claude terminated by signal ${signal ?? "unknown"}`;
  return { type: EVENT_TYPES.error, message: stderrOutput || exitSummary };
}

// The broker startup race (#2057) can leave the CLI exiting 0 — the model gives
// up after the first tool call fails, so `buildExitErrorEvent` sees a clean exit
// and returns null. Scan stderr for the permission-prompt-tool phrase and
// surface it as an error the fail-over loop can retry on. A non-zero exit
// carrying the same phrase already flows through `buildExitErrorEvent`, so this
// only covers the clean-exit case.
export function brokerNotReadyErrorEvent(stderrOutput: string): { type: typeof EVENT_TYPES.error; message: string } | null {
  return isMcpBrokerNotReadyError(stderrOutput) ? { type: EVENT_TYPES.error, message: stderrOutput } : null;
}

// Not every claude CLI stderr line is an error. The sandbox workspace-trust
// notice (#2055) is the common benign case: the container's workspace path
// (`/home/node/mulmoclaude`) isn't among the host `~/.claude.json`'s trusted
// projects, so claude ignores the workspace `permissions.allow` entries. That's
// harmless here — tool permissions come from `--allowedTools` + the mulmoclaude
// MCP permission handler, not the workspace `.claude/settings.json` — but
// logging it at ERROR on every spawn made it look like a failure and buried
// real errors. Recognise it so the stderr router can log it at debug instead.
export function isBenignClaudeStderr(line: string): boolean {
  return line.includes("has not been trusted");
}

// Route a claude CLI stderr line to the right log level: benign notices at
// debug, genuine errors at error (so they stop burying each other).
function logAgentStderr(line: string): void {
  if (isBenignClaudeStderr(line)) log.debug("agent-stderr", line);
  else log.error("agent-stderr", line);
}

// What the turn's tool availability is judged against once the CLI exits. The
// readiness lookup needs the session key, and "was MCP configured at all" is
// the orchestrator's decision, not something to re-derive here.
interface TurnMcpContext {
  chatSessionId: string;
  mcpConfigured: boolean;
  /** Host-side path of the broker's start marker, when this turn has a broker
   *  (#2842). Read once, after the CLI exits. */
  startMarkerPath?: string | undefined;
  /** What that marker must contain to count. */
  spawnId?: string | undefined;
}

// Did the broker PROCESS ever exist? Answered by two independent signals,
// because they fail for unrelated reasons: a marker file the broker writes
// synchronously before loading anything, and an HTTP beacon it fires at the
// same moment. See `mcp-start-beacon.mjs` for why both.
//
// Read after the CLI exits, so this costs nothing on a healthy turn.
function brokerEverStarted(turn: TurnMcpContext): boolean {
  // Both halves are scoped to THIS spawn. A replay starts a second broker for
  // the same session within seconds, and either half answered per-session would
  // credit it to the attempt that already failed.
  if (turn.spawnId === undefined) return false;
  if (getBrokerStarted(turn.chatSessionId, turn.spawnId)) return true;
  return turn.startMarkerPath !== undefined && markerHolds(turn.startMarkerPath, turn.spawnId);
}

/** Longest a marker may be and still be read. It holds one uuid; anything
 *  larger is not one. Enforced by the READ — a fixed buffer — rather than by
 *  slicing afterwards, or a planted multi-gigabyte file would be pulled into
 *  memory in full before the cap applied (Codex review on #2932), which is the
 *  trap `docs/large-file-reading.md` exists for. */
export const MARKER_MAX_BYTES = 128;

/** Does the marker say THIS broker wrote it?
 *
 *  `lstat` rather than `existsSync`, and a regular file rather than any entry,
 *  because a symlink planted at that path would otherwise report a broker that
 *  never ran as having started. The content check rules out the cheaper version
 *  of the same trick — a file merely pre-created at the path (Codex review on
 *  #2932).
 *
 *  It does NOT make the signal unforgeable, and cannot: under Docker the marker
 *  path, the spawn id, and the bearer token all live in the per-session MCP
 *  config inside the workspace mount, so anything that can plant the file can
 *  also read what to put in it — or POST the beacon directly. This is a
 *  diagnostic that nothing acts on (the fail-fast this signal was built for was
 *  measured and dropped), so the bar is "not wrong by accident", not "cannot be
 *  lied to by the sandbox about its own turn". */
export function markerHolds(markerPath: string, spawnId: string): boolean {
  // Three flags, each closing a way this path can be turned against the host —
  // it is inside the workspace mount, so the sandbox chooses what is there:
  //
  //  - `O_NOFOLLOW` on the OPEN rather than an `lstat` first, because the
  //    two-step version can be raced.
  //  - `O_NONBLOCK`, because opening a FIFO waits for a writer FOREVER, and
  //    this open is synchronous — a planted pipe would freeze the event loop,
  //    not merely mislead a log line (Codex review on #2932; reproduced:
  //    `openSync` never returned and a pending timer never fired).
  //  - `fstat` on the descriptor we are about to read, so anything that is not
  //    a regular file is refused after the open rather than read from.
  //
  // The first two are POSIX-only; on Windows the constants are absent and fall
  // out of the mask, where neither symlinks-without-privilege nor FIFOs at a
  // path like this arise, and the `fstat` check still applies.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let handle: number;
  try {
    handle = openSync(markerPath, flags);
  } catch {
    return false;
  }
  try {
    // Size as well as type. Reading only the first `MARKER_MAX_BYTES` bounds
    // the read, but it does not REJECT a larger file: an id followed by
    // whitespace inside the cap, then arbitrary content past it, survives the
    // `trim()` below. Our own marker is one uuid, so anything larger is not one
    // (CodeRabbit review on #2932).
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size > MARKER_MAX_BYTES) return false;
    const buffer = Buffer.alloc(MARKER_MAX_BYTES);
    const bytes = readSync(handle, buffer, 0, MARKER_MAX_BYTES, 0);
    return buffer.subarray(0, bytes).toString("utf-8").trim() === spawnId;
  } catch {
    return false;
  } finally {
    closeSync(handle);
  }
}

// `aborted` is the abort SIGNAL, not `isAbortCausedExit`: the question here is
// whether the turn was cut short, not whether this particular exit code was
// ours. A cancel that lets the CLI exit 0 cleanly is still a turn that never got
// to use its tools, and `isAbortCausedExit` reads that one as a normal finish.
function logIfMcpUnavailable(turn: TurnMcpContext, builtinMcpToolsCalled: number, aborted: boolean): void {
  // Spawn-scoped like `brokerEverStarted`, and for the same reason: this runs
  // after the CLI exited, by which time a replay may have started a second
  // broker for the same session. A session-keyed read would let that one
  // suppress the diagnosis for the attempt that actually failed.
  const brokerEverReady = turn.spawnId !== undefined && getBrokerReady(turn.chatSessionId, turn.spawnId) !== null;
  if (!shouldWarnMcpUnavailable({ mcpConfigured: turn.mcpConfigured, aborted, brokerEverReady, builtinMcpToolsCalled })) return;
  // `brokerEverStarted` splits this warn's one symptom into the two failures it
  // was hiding, and they are fixed in different places: a broker that launched
  // and never answered is the boot (the mount, the `tsx` path), while one that
  // never launched is the spawn (the command, the paths, a missing module).
  const started = brokerEverStarted(turn);
  log.warn("agent", "MCP tools were unavailable this turn — the broker never reported ready and none of its tools ran", {
    chatSessionId: turn.chatSessionId,
    brokerEverStarted: started,
    brokerEverReady,
    builtinMcpToolsCalled,
    hint: started
      ? "The broker process started and never answered `initialize` — it is still loading (see `broker=`; `tsx` is the slow path) or it died while loading. Its own error is not in this log: Claude CLI owns its stderr."
      : "The broker process never started — check the spawn command and the paths it resolves to.",
  });
}

async function* readAgentEvents(proc: ClaudeProc, turn: TurnMcpContext, abortSignal?: AbortSignal): AsyncGenerator<AgentEvent> {
  let stderrOutput = "";
  let stderrBuffer = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrOutput += text;
    stderrBuffer += text;
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) logAgentStderr(line);
    }
  });

  // Stateful parser tracks whether text was already streamed via
  // assistant content blocks so the final `result` event's duplicate
  // text is suppressed. See createStreamParser() in stream.ts.
  const parser = createStreamParser();

  const builtinMcpToolWatcher = createBuiltinMcpToolWatcher();
  // Runtime failure monitor (#1353). Lives next to builtinMcpToolWatcher
  // because they share the same event stream — the watcher feeds the
  // "MCP never invoked" check, the monitor spots the
  // "MCP invoked but consistently failing" pattern.
  const mcpFailureMonitor = createMcpFailureMonitor();

  // Attach the close listener BEFORE draining stdout. The `close` event
  // can fire on the same tick stdout ends; registering it only after the
  // read loop risks missing it and hanging on the await below.
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => proc.on("close", (code, sig) => resolve({ code, signal: sig })));

  let buffer = "";
  for await (const chunk of proc.stdout) {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let event: RawStreamEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      for (const agentEvent of parser.parse(event)) {
        builtinMcpToolWatcher.track(agentEvent);
        mcpFailureMonitor.track(agentEvent);
        yield agentEvent;
      }
    }
  }

  const { code: exitCode, signal } = await closed;

  if (stderrBuffer.trim()) logAgentStderr(stderrBuffer);
  log.info("agent", "claude exited", { exitCode, signal });
  logIfMcpUnavailable(turn, builtinMcpToolWatcher.count(), abortSignal?.aborted === true);

  const errorEvent = buildExitErrorEvent(exitCode, signal, abortSignal, stderrOutput) ?? brokerNotReadyErrorEvent(stderrOutput);
  if (errorEvent) yield errorEvent;
}

// The non-pass-through mappings are `sessionToken` -> `claudeSessionId`
// (the CLI's `--resume` id) and the system prompt, which travels as a
// file path (`systemPromptPath`) rather than inline text — see the
// CliArgsParams field comment for the Windows ENAMETOOLONG rationale.
export function cliArgsForInput(input: AgentInput, systemPromptPath: string): CliArgsParams {
  return {
    systemPromptPath,
    activePlugins: input.activePlugins,
    claudeSessionId: input.sessionToken,
    mcpConfigPath: input.mcpConfigPath,
    extraAllowedTools: input.extraAllowedTools,
    effortLevel: input.effortLevel,
    chatModel: input.chatModel,
  };
}

// Write the per-session system-prompt file the CLI reads via
// `--system-prompt-file`, returning the path to put on the command line
// (container path under Docker). Atomic so a concurrent spawn on the
// same session never reads a half-written prompt; one file per session,
// overwritten each turn (mirroring the MCP config lifecycle). Mode 0600
// because the prompt carries the role / memory / plugin instructions —
// no reason for it to be world-readable in the OS tmpdir or workspace.
export async function writeSystemPromptFile(input: AgentInput): Promise<string> {
  const paths = resolveSystemPromptPaths({
    workspacePath: input.workspacePath,
    sessionId: input.sessionId,
    useDocker: input.useDocker,
  });
  await writeFileAtomic(paths.hostPath, input.systemPrompt, { mode: 0o600 });
  return paths.argPath;
}

async function* runClaudeAgent(input: AgentInput): AsyncGenerator<AgentEvent> {
  const systemPromptPath = await writeSystemPromptFile(input);
  const cliArgs = buildCliArgs(cliArgsForInput(input, systemPromptPath));

  // spawnClaude can throw synchronously when `claudeBinPath()` fails
  // to locate `claude.exe` on Windows — surface that through the same
  // AgentEvent error channel as the post-spawn "error" event so the
  // server stays alive (#1364) and the user sees the actionable
  // "install with npm install -g …" hint.
  let proc: ReturnType<typeof spawnClaude>;
  try {
    proc = spawnClaude(input.useDocker, input.workspacePath, cliArgs, input.sessionId);
  } catch (err) {
    const target = input.useDocker ? "docker" : "claude";
    const message = err instanceof Error ? err.message : String(err);
    log.error("agent", `failed to resolve ${target} binary`, { error: message });
    yield {
      type: EVENT_TYPES.error,
      message: `Failed to spawn ${target}: ${message}`,
    };
    return;
  }

  // Wait for the kernel to confirm the spawn before piping anything
  // into stdin. Without this guard, a missing `claude` (or `docker`)
  // binary emits a delayed `error` event with no listener attached —
  // Node treats it as uncaught and tears down the entire server
  // process. Surfacing it as a regular AgentEvent keeps the server
  // alive across CI runs and prod-misconfig recovery (#1364).
  try {
    await new Promise<void>((resolve, reject) => {
      proc.once("spawn", () => resolve());
      proc.once("error", (err) => reject(err));
    });
  } catch (err) {
    const target = input.useDocker ? "docker" : "claude";
    const message = errorMessage(err);
    log.error("agent", `failed to spawn ${target}`, { error: message });
    yield {
      type: EVENT_TYPES.error,
      message: `Failed to spawn ${target}: ${message}`,
    };
    return;
  }
  // Best-effort stdin EPIPE guard — the process can die between
  // `spawn` and the write below for unrelated reasons (OOM, kill
  // -9), and we don't want a write-after-death to become another
  // uncaught error.
  proc.stdin.on("error", () => {});

  // stream-json input mode: stream the user turn as a single JSON
  // line to stdin, then close the pipe so the CLI knows no further
  // turns are coming. Writing before attaching the abort handler is
  // fine — if the write fails because the process already died for
  // other reasons, the readAgentEvents loop below surfaces it.
  const messageLine = await buildUserMessageLine(input.message, input.attachments);
  proc.stdin.write(messageLine);
  proc.stdin.end();

  const onAbort = () => {
    if (!proc.killed) proc.kill();
  };
  input.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    yield* readAgentEvents(
      proc,
      { chatSessionId: input.sessionId, mcpConfigured: input.mcpConfigPath !== undefined, startMarkerPath: input.startMarkerPath, spawnId: input.spawnId },
      input.abortSignal,
    );
  } finally {
    input.abortSignal?.removeEventListener("abort", onAbort);
    if (!proc.killed) proc.kill();
  }
}

export const claudeCodeBackend: LLMBackend = {
  id: "claude-code",
  capabilities: { sessionResume: true, mcp: true },
  runAgent: runClaudeAgent,
};
