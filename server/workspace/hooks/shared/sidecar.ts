// Read the bearer token and server port from sidecar files the
// parent server writes on each startup. Hooks POST back to the
// parent server using these — they need to run without any
// runtime config baked in.
//
// Strict integer parsing on the port: a crafted file value like
// `80@attacker.example` would otherwise change the request
// authority and exfiltrate the bearer token off-host. Same
// hardening applied as the Codex review on PR #1284.

import { readFileSync } from "node:fs";
import path from "node:path";
import { PORT_RANGE } from "@mulmoclaude/common";
import { ONE_SECOND_MS } from "../../../utils/time.js";
import { workspaceRoot } from "./workspace.js";

const TOKEN_FILE = ".session-token";
const PORT_FILE = ".server-port";

// In Docker mode the parent server lives on the host's 127.0.0.1
// which the container can't reach via plain loopback. The Docker
// spawn plumbing sets MULMOCLAUDE_HOST=host.docker.internal so
// fetch() resolves to the host server. Outside Docker (or when the
// var is unset) we fall back to the loopback address.
export function serverHost(): string {
  return process.env.MULMOCLAUDE_HOST ?? "127.0.0.1";
}

function readSidecar(rel: string): string {
  try {
    return readFileSync(path.join(workspaceRoot(), rel), "utf-8").trim();
  } catch {
    return "";
  }
}

export function readToken(): string {
  return readSidecar(TOKEN_FILE);
}

export function readPort(): number | null {
  const raw = readSidecar(PORT_FILE);
  if (!raw) return null;
  const port = Number.parseInt(raw, 10);
  // Strictly ABOVE the range floor: 0 is a valid port to BIND (it asks the OS
  // for an ephemeral one) but never one to connect to, and this value is read
  // to reach the server.
  return Number.isInteger(port) && port > PORT_RANGE.min && port <= PORT_RANGE.max ? port : null;
}

// Build an authenticated POST request against the parent server.
// Returns null when token / port are missing (server isn't up yet);
// caller treats null as a silent no-op so a one-off hook miss
// during startup doesn't surface as a tool error.
// `Parameters<typeof fetch>[1]` derives the request-init shape
// from the global `fetch` type rather than naming `RequestInit`
// directly — keeps the file lint-clean under our shared no-undef
// config without needing a custom DOM-types tsconfig for the hook
// bundle.
type FetchInit = Parameters<typeof fetch>[1];

export interface PostRequest {
  url: string;
  init: FetchInit;
}

export function buildAuthPost(pathname: string, body?: unknown): PostRequest | null {
  const token = readToken();
  const port = readPort();
  if (!token || port === null) return null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const init: FetchInit = { method: "POST", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return {
    url: `http://${serverHost()}:${port}${pathname}`,
    init,
  };
}

// 2 s default timeout. PostToolUse hooks block Claude CLI's tool
// turn until the script exits, so a slow / hung parent server
// (refresh deadlock, GC pause, unrelated long-running route) would
// leave the user's Write/Edit appearing frozen. The refresh-style
// POSTs are fire-and-forget anyway; if the server can't respond
// inside that window, the file is already on disk and the next
// restart picks it up.
const DEFAULT_TIMEOUT_MS = 2 * ONE_SECOND_MS;

export async function safePost(req: PostRequest | null, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  if (!req) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(req.url, { ...req.init, signal: controller.signal });
  } catch {
    // Server might be restarting / unreachable / timed out — silent
    // fail is fine; the file is on disk and the next manual restart
    // picks it up.
  } finally {
    clearTimeout(timer);
  }
}

// Forward a structured log line into the server's logger via
// `POST /api/hooks/log`. Handlers call this after each meaningful
// side-effect (mirror copy, delete, etc.) so the user can verify
// from server logs that the hook fired and what it did. The endpoint
// authenticates via bearer token (same as every other internal hook
// POST); a missing token / port is the silent no-op safePost
// already handles. 1 s timeout — logging shouldn't stall the user's
// tool turn even if the server is briefly slow.
const LOG_TIMEOUT_MS = ONE_SECOND_MS;

export async function serverLog(namespace: string, message: string, options: { level?: "info" | "warn" | "error"; data?: object } = {}): Promise<void> {
  const body = {
    namespace,
    message,
    level: options.level ?? "info",
    ...(options.data ? { data: options.data } : {}),
  };
  const req = buildAuthPost("/api/hooks/log", body);
  await safePost(req, LOG_TIMEOUT_MS);
}
