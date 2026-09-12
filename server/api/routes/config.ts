import { Router, type Request, type Response } from "express";
import { execFile } from "node:child_process";
import {
  fromMcpEntries,
  isAppSettings,
  isAppSettingsPatch,
  loadMcpConfig,
  loadSettings,
  normaliseAppSettingsPatch,
  saveMcpConfig,
  saveSettings,
  toMcpEntries,
  type AppSettings,
  type AppSettingsPatch,
  type McpConfigFile,
  type McpServerEntry,
} from "../../system/config.js";
import { env } from "../../system/env.js";
import { readCspExtraSync } from "../../utils/files/csp-io.js";
import type { CspExtraHosts } from "../../../src/utils/html/previewCsp.js";
import { badRequest, serverError, type ApiResponse } from "../../utils/httpError.js";
import { errorMessage } from "../../utils/errors.js";
import { isRecord } from "../../utils/types.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";
import { log } from "../../system/logger/index.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { loadCustomDirs, saveCustomDirs, ensureCustomDirs, validateCustomDirs, type CustomDirEntry } from "../../workspace/custom-dirs.js";
import { loadReferenceDirs, saveReferenceDirs, validateReferenceDirs, type ReferenceDirEntry } from "../../workspace/reference-dirs.js";

// ── Scheduler overrides (#493) ──────────────────────────────────

import {
  keepValidOverrides,
  loadSchedulerOverrides,
  saveSchedulerOverrides,
  UTC_HH_MM_RE,
  type ScheduleOverrides,
} from "../../utils/files/scheduler-overrides-io.js";
import { applyScheduleOverride } from "../../events/scheduler-adapter.js";
import { SCHEDULE_TYPES } from "@receptron/task-scheduler";
import { ONE_SECOND_MS } from "../../utils/time.js";

// Public surface of /api/config. GET returns the full config tree so
// the client can render every section in one request. PUT surfaces are
// per-section to keep payloads small and validation obvious.
export interface ConfigResponse {
  settings: AppSettings;
  mcp: { servers: McpServerEntry[] };
  /** User-supplied CSP extension for sandboxed views (#1989), already
   *  validated server-side. The client threads it into the custom-view /
   *  file-preview CSP. Empty object ⇒ base policy only. */
  csp: CspExtraHosts;
  /** Read-only context for the macOS Reminders toggle (#2617). The
   *  client can see neither the server's platform nor its env, and a
   *  toggle that silently does nothing is worse than no toggle. */
  macosReminders: { supported: boolean; forcedOffByEnv: boolean };
}

type ConfigRes = ApiResponse<ConfigResponse>;

function buildFullResponse(): ConfigResponse {
  return {
    settings: loadSettings(),
    mcp: { servers: toMcpEntries(loadMcpConfig()) },
    csp: readCspExtraSync(),
    macosReminders: {
      supported: process.platform === "darwin",
      forcedOffByEnv: env.disableMacosReminderNotifications,
    },
  };
}

function isMcpPutBody(value: unknown): value is { servers: McpServerEntry[] } {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.servers)) return false;
  // Full shape validation happens inside fromMcpEntries (throws on
  // anything malformed). Here we just confirm the envelope.
  return value.servers.every((entry) => isRecord(entry) && "id" in entry && "spec" in entry);
}

// Parse an MCP payload through `fromMcpEntries` (which does the full
// shape validation and throws on anything malformed). On failure,
// respond 400 and return null so the caller can early-return.
function parseMcpPayloadOrFail(res: ConfigRes, servers: McpServerEntry[]): McpConfigFile | null {
  try {
    return fromMcpEntries(servers);
  } catch (err) {
    badRequest(res, errorMessage(err, "invalid mcp entries"));
    return null;
  }
}

// Run a filesystem save. On failure, log the raw error server-side
// (full triage detail kept in logs), respond 500 with the safe
// `fallback` message, and return false so the caller can early-return.
// Returns true on success. The raw `err.message` deliberately doesn't
// reach the client — same threat model as `asyncHandler`.
function runSaveOrFail(res: ConfigRes, save: () => void, fallback: string): boolean {
  try {
    save();
    return true;
  } catch (err) {
    log.error("config", `save failed: ${fallback}`, { error: errorMessage(err) });
    serverError(res, fallback);
    return false;
  }
}

const router = Router();

router.get(API_ROUTES.config.base, (_req: Request, res: Response<ConfigResponse>) => {
  res.json(buildFullResponse());
});

// Atomic save for both settings and MCP. Validates both payloads first
// (no writes happen until every input is known-good), then writes
// settings and captures the previous state so a subsequent saveMcpConfig
// failure can roll back. This is the endpoint the Settings modal should
// use; the per-section PUTs below remain for targeted updates.
interface PutConfigBody {
  settings: AppSettings;
  mcp: { servers: McpServerEntry[] };
}

function isPutConfigBody(value: unknown): value is PutConfigBody {
  if (!isRecord(value)) return false;
  return isAppSettings(value.settings) && isMcpPutBody(value.mcp);
}

router.put(API_ROUTES.config.base, (req: Request<unknown, unknown, PutConfigBody>, res: ConfigRes) => {
  const { body } = req;
  log.info("config", "PUT base: start");
  if (!isPutConfigBody(body)) {
    log.warn("config", "PUT base: invalid payload");
    badRequest(res, "Invalid config payload");
    return;
  }
  const mcpCfg = parseMcpPayloadOrFail(res, body.mcp.servers);
  if (!mcpCfg) return;

  // Snapshot previous settings so we can roll back if the second
  // write fails — a cross-file atomic write isn't possible, but
  // rollback keeps the pair consistent from the user's perspective.
  const previousSettings = loadSettings();
  if (!runSaveOrFail(res, () => saveSettings(body.settings), "saveSettings failed")) {
    return;
  }
  if (!runSaveOrFail(res, () => saveMcpConfig(mcpCfg), "saveMcpConfig failed")) {
    // Best-effort rollback; if it fails too, the original mcp error
    // is already on the wire.
    try {
      saveSettings(previousSettings);
    } catch (err) {
      log.error("config", "PUT base: rollback also failed", { error: errorMessage(err) });
    }
    return;
  }
  log.info("config", "PUT base: ok");
  res.json(buildFullResponse());
});

router.put(API_ROUTES.config.settings, (req: Request<unknown, unknown, AppSettingsPatch>, res: ConfigRes) => {
  const { body } = req;
  log.info("config", "PUT settings: start");
  if (!isAppSettingsPatch(body)) {
    log.warn("config", "PUT settings: invalid payload");
    badRequest(res, "Invalid AppSettings payload");
    return;
  }
  // Merge the PUT body (a partial patch — fields the caller doesn't
  // own can be omitted) onto the existing on-disk settings so a tab
  // that knows about only some fields (e.g. Tools tab sends only
  // `extraAllowedTools`, Map tab sends only `googleMapsApiKey`)
  // doesn't wipe fields owned by other tabs.
  //
  // `null` in the patch is a sentinel for "clear this field":
  // normaliseAppSettingsPatch drops the entry from the patch, AND we
  // must also delete it from the merged result so the existing
  // value doesn't leak through the spread.
  const existing = loadSettings();
  const merged: AppSettings = { ...existing, ...normaliseAppSettingsPatch(body) };
  if (body.effortLevel === null) {
    delete merged.effortLevel;
  }
  // chatModel null-sentinel (#2923) — mirrors effortLevel. Clearing the
  // field is what restores "follow ~/.claude/settings.json", so it must
  // leave settings.json without the key rather than with a stale value.
  if (body.chatModel === null) {
    delete merged.chatModel;
  }
  // Chat-index null-sentinel (#1944): "off" is the documented default
  // (chatIndexMode() maps undefined → "off"), so the tab sends `null`
  // to drop the field entirely and keep settings.json free of default
  // values. Without this delete, the previous on-disk value would
  // leak through the spread and stay set.
  if (body.chatIndex === null) {
    delete merged.chatIndex;
  }
  // Journal null-sentinel — mirrors chatIndex / effortLevel.
  if (body.journal === null) {
    delete merged.journal;
  }
  if (!runSaveOrFail(res, () => saveSettings(merged), "saveSettings failed")) {
    return;
  }
  log.info("config", "PUT settings: ok");
  res.json(buildFullResponse());
});

router.put(API_ROUTES.config.mcp, (req: Request<unknown, unknown, { servers: McpServerEntry[] }>, res: ConfigRes) => {
  const { body } = req;
  log.info("config", "PUT mcp: start", { servers: Array.isArray(body?.servers) ? body.servers.length : undefined });
  if (!isMcpPutBody(body)) {
    log.warn("config", "PUT mcp: invalid envelope");
    badRequest(res, "Invalid mcp payload envelope");
    return;
  }
  // fromMcpEntries rejects malformed client input (400). saveMcpConfig
  // can fail for server-side reasons like disk/permission errors (500).
  const cfg = parseMcpPayloadOrFail(res, body.servers);
  if (!cfg) return;
  if (!runSaveOrFail(res, () => saveMcpConfig(cfg), "saveMcpConfig failed")) {
    return;
  }
  log.info("config", "PUT mcp: ok", { servers: body.servers.length });
  res.json(buildFullResponse());
});

// ── Workspace custom directories (#239) ──────────────────────────

router.get(API_ROUTES.config.workspaceDirs, (_req: Request, res: Response<{ dirs: CustomDirEntry[] }>) => {
  res.json({ dirs: loadCustomDirs() });
});

router.put(
  API_ROUTES.config.workspaceDirs,
  asyncHandler<Request<unknown, unknown, { dirs: unknown }>, ApiResponse<{ dirs: CustomDirEntry[] }>>("config", "save failed", async (req, res) => {
    const { body } = req;
    log.info("config", "PUT workspace-dirs: start");
    if (!isRecord(body) || !("dirs" in body)) {
      log.warn("config", "PUT workspace-dirs: invalid envelope");
      badRequest(res, "expected { dirs: [...] }");
      return;
    }
    const result = validateCustomDirs(body.dirs);
    if ("error" in result) {
      log.warn("config", "PUT workspace-dirs: validation failed", { error: result.error });
      badRequest(res, result.error);
      return;
    }
    saveCustomDirs(result.entries);
    ensureCustomDirs(result.entries);
    log.info("config", "PUT workspace-dirs: ok", { dirs: result.entries.length });
    res.json({ dirs: result.entries });
  }),
);

// ── Reference directories (#455) ────────────────────────────────

router.get(API_ROUTES.config.referenceDirs, (_req: Request, res: Response<{ dirs: ReferenceDirEntry[] }>) => {
  res.json({ dirs: loadReferenceDirs() });
});

router.put(
  API_ROUTES.config.referenceDirs,
  asyncHandler<Request<unknown, unknown, { dirs: unknown }>, ApiResponse<{ dirs: ReferenceDirEntry[] }>>("config", "save failed", async (req, res) => {
    const { body } = req;
    log.info("config", "PUT reference-dirs: start");
    if (!isRecord(body) || !("dirs" in body)) {
      log.warn("config", "PUT reference-dirs: invalid envelope");
      badRequest(res, "expected { dirs: [...] }");
      return;
    }
    const result = validateReferenceDirs(body.dirs);
    if ("error" in result) {
      log.warn("config", "PUT reference-dirs: validation failed", { error: result.error });
      badRequest(res, result.error);
      return;
    }
    saveReferenceDirs(result.entries);
    log.info("config", "PUT reference-dirs: ok", { dirs: result.entries.length });
    res.json({ dirs: result.entries });
  }),
);

router.get(API_ROUTES.config.schedulerOverrides, (_req: Request, res: Response<{ overrides: ScheduleOverrides }>) => {
  res.json({ overrides: loadSchedulerOverrides() });
});

router.put(
  API_ROUTES.config.schedulerOverrides,
  asyncHandler<Request<unknown, unknown, { overrides: unknown }>, ApiResponse<{ overrides: ScheduleOverrides }>>("config", "save failed", async (req, res) => {
    const { body } = req;
    log.info("config", "PUT scheduler-overrides: start");
    if (!isRecord(body) || !("overrides" in body)) {
      log.warn("config", "PUT scheduler-overrides: invalid envelope");
      badRequest(res, "expected { overrides: { ... } }");
      return;
    }
    const raw = body.overrides;
    if (!isRecord(raw)) {
      log.warn("config", "PUT scheduler-overrides: overrides not an object");
      badRequest(res, "overrides must be an object");
      return;
    }
    const overrides = keepValidOverrides(raw);
    saveSchedulerOverrides(overrides);

    // Apply to running task-manager immediately
    for (const [taskId, ovr] of Object.entries(overrides)) {
      if (typeof ovr.intervalMs === "number" && ovr.intervalMs > 0) {
        await applyScheduleOverride(taskId, {
          type: SCHEDULE_TYPES.interval,
          intervalMs: ovr.intervalMs,
        });
      } else if (typeof ovr.time === "string" && UTC_HH_MM_RE.test(ovr.time)) {
        await applyScheduleOverride(taskId, {
          type: SCHEDULE_TYPES.daily,
          time: ovr.time,
        });
      }
    }

    log.info("config", "PUT scheduler-overrides: ok", { tasks: Object.keys(overrides).length });
    res.json({ overrides: loadSchedulerOverrides() });
  }),
);

// ── Connectors (read-only) ──────────────────────────────────────

export interface ConnectorEntry {
  name: string;
  connected: boolean;
}

const MCP_LIST_TIMEOUT_MS = 60 * ONE_SECOND_MS;
const CLAUDE_AI_PREFIX = "claude.ai ";
const CONNECTED_PATTERN = /[✓✔] Connected/;

export function parseConnectors(stdout: string): ConnectorEntry[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith(CLAUDE_AI_PREFIX) && line.includes(":"))
    .map((line) => ({
      name: line.slice(CLAUDE_AI_PREFIX.length, line.indexOf(":")),
      connected: CONNECTED_PATTERN.test(line),
    }));
}

function listClaudeMcpServers(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", ["mcp", "list"], { timeout: MCP_LIST_TIMEOUT_MS }, (err, stdout) => {
      if (err) return reject(err);
      return resolve(stdout);
    });
  });
}

router.get(
  API_ROUTES.config.connectors,
  asyncHandler("config", "failed to list connectors", async (_req: Request, res: Response) => {
    try {
      const stdout = await listClaudeMcpServers();
      res.json({ connectors: parseConnectors(stdout) });
    } catch (err) {
      log.warn("config", "claude mcp list failed — returning empty connectors", { error: errorMessage(err) });
      res.json({ connectors: [] });
    }
  }),
);

export default router;
