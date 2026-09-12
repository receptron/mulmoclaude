#!/usr/bin/env node

// server/workspace/hooks/shared/sidecar.ts
import { readFileSync } from "node:fs";
import path2 from "node:path";

// packages/common/dist/envCoerce.js
var PORT_RANGE = Object.freeze({ min: 0, max: 65535 });

// packages/common/dist/index.js
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// server/utils/time.ts
var ONE_SECOND_MS = 1e3;
var ONE_MINUTE_MS = 6e4;
var SUBPROCESS_PROBE_TIMEOUT_MS = 5 * ONE_SECOND_MS;
var STARTUP_FAILURE_FORCE_EXIT_MS = 5 * ONE_SECOND_MS;
var CLI_SUBPROCESS_TIMEOUT_MS = 5 * ONE_MINUTE_MS;

// server/workspace/hooks/shared/workspace.ts
import { homedir } from "node:os";
import path from "node:path";
function workspaceRoot() {
  return process.env.CLAUDE_PROJECT_DIR ?? path.join(homedir(), "mulmoclaude");
}

// server/workspace/hooks/shared/sidecar.ts
var TOKEN_FILE = ".session-token";
var PORT_FILE = ".server-port";
function serverHost() {
  return process.env.MULMOCLAUDE_HOST ?? "127.0.0.1";
}
function readSidecar(rel) {
  try {
    return readFileSync(path2.join(workspaceRoot(), rel), "utf-8").trim();
  } catch {
    return "";
  }
}
function readToken() {
  return readSidecar(TOKEN_FILE);
}
function readPort() {
  const raw = readSidecar(PORT_FILE);
  if (!raw) return null;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > PORT_RANGE.min && port <= PORT_RANGE.max ? port : null;
}
function buildAuthPost(pathname, body) {
  const token = readToken();
  const port = readPort();
  if (!token || port === null) return null;
  const headers = {
    Authorization: `Bearer ${token}`
  };
  const init = { method: "POST", headers };
  if (body !== void 0) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return {
    url: `http://${serverHost()}:${port}${pathname}`,
    init
  };
}
var DEFAULT_TIMEOUT_MS = 2 * ONE_SECOND_MS;
async function safePost(req, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!req) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(req.url, { ...req.init, signal: controller.signal });
  } catch {
  } finally {
    clearTimeout(timer);
  }
}
var LOG_TIMEOUT_MS = ONE_SECOND_MS;
async function serverLog(namespace, message, options = {}) {
  const body = {
    namespace,
    message,
    level: options.level ?? "info",
    ...options.data ? { data: options.data } : {}
  };
  const req = buildAuthPost("/api/hooks/log", body);
  await safePost(req, LOG_TIMEOUT_MS);
}

// server/workspace/hooks/shared/stdin.ts
var isOptionalRecord = (value) => value === void 0 || isRecord(value);
function isHookPayload(value) {
  return isRecord(value) && isOptionalRecord(value.tool_input) && isOptionalRecord(value.tool_response);
}
function chunkToBuffer(chunk) {
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.alloc(0);
}
async function readHookPayload() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunkToBuffer(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return isHookPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function extractFilePath(payload) {
  const fromInput = payload.tool_input?.file_path;
  if (typeof fromInput === "string") return fromInput;
  const fromResponse = payload.tool_response?.filePath;
  if (typeof fromResponse === "string") return fromResponse;
  return "";
}
function extractCommand(payload) {
  const command = payload.tool_input?.command;
  return typeof command === "string" ? command : "";
}
function extractToolName(payload) {
  return typeof payload.tool_name === "string" ? payload.tool_name : "";
}
function extractSessionId(payload) {
  const sessionId = payload.session_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : void 0;
}

// server/workspace/hooks/handlers/configRefresh.ts
var PATTERNS = [/[\\/]\.claude[\\/]skills[\\/][^\\/]+[\\/]SKILL\.md$/, /[\\/]config[\\/]scheduler[\\/]tasks\.json$/];
async function handleConfigRefresh(payload) {
  const tool = extractToolName(payload);
  if (tool !== "Write" && tool !== "Edit") return;
  const filePath = extractFilePath(payload);
  if (!filePath) return;
  if (!PATTERNS.some((pattern) => pattern.test(filePath))) return;
  const req = buildAuthPost("/api/config/refresh");
  await safePost(req);
}

// packages/core/dist/templatePath-k_WNbL_Q.js
var TEMPLATES_PREFIX = "templates/";
function isSafeTemplatePath(value) {
  if (value.length === 0 || value.includes("\\") || value.startsWith("/")) return false;
  return value.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== ".." && /^[A-Za-z0-9._-]+$/.test(seg));
}
function isSafeActionTemplatePath(value) {
  return value.startsWith(TEMPLATES_PREFIX) && isSafeTemplatePath(value);
}

// packages/core/dist/skill-bridge/index.js
import { mkdirSync, readFileSync as readFileSync2, renameSync, rmSync, writeFileSync } from "node:fs";
import path3 from "node:path";
var DATA_SKILLS_DIR = path3.join("data", "skills");
var CLAUDE_SKILLS_DIR = path3.join(".claude", "skills");
var SKILL_FILENAME = "SKILL.md";
var SCHEMA_FILENAME = "schema.json";
var SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
var RM_RE = /^\s*rm\s+((?:-[a-zA-Z]+\s+)+)['"]?data\/skills\/([a-z0-9-]+)\/?['"]?\s*$/;
var RECURSIVE_FLAG_RE = /[rR]/;
function dataSkillDir(workspaceRoot2, slug) {
  return path3.join(workspaceRoot2, DATA_SKILLS_DIR, slug);
}
function claudeSkillDir(workspaceRoot2, slug) {
  return path3.join(workspaceRoot2, CLAUDE_SKILLS_DIR, slug);
}
function isAllowlisted(relSegments) {
  if (relSegments.length === 1) return relSegments[0] === SKILL_FILENAME || relSegments[0] === SCHEMA_FILENAME;
  return isSafeActionTemplatePath(relSegments.join("/"));
}
function bridgeTargetFromDataPath(workspaceRoot2, filePath) {
  const staging = path3.join(workspaceRoot2, DATA_SKILLS_DIR);
  const rel = path3.relative(staging, filePath);
  if (!rel || rel.startsWith("..") || path3.isAbsolute(rel)) return null;
  const [slug, ...relSegments] = rel.split(path3.sep);
  if (!slug || relSegments.length === 0) return null;
  if (!SLUG_RE.test(slug)) return null;
  if (!isAllowlisted(relSegments)) return null;
  return {
    slug,
    relSegments
  };
}
function slugFromRmCommand(command) {
  const match = RM_RE.exec(command);
  if (!match) return null;
  const [, flags = "", slug = ""] = match;
  if (!RECURSIVE_FLAG_RE.test(flags)) return null;
  return SLUG_RE.test(slug) ? slug : null;
}
function mirrorSkillWrite(workspaceRoot2, target) {
  const { slug, relSegments } = target;
  const src = path3.join(dataSkillDir(workspaceRoot2, slug), ...relSegments);
  const content = readFileSync2(src, "utf-8");
  const dest = path3.join(claudeSkillDir(workspaceRoot2, slug), ...relSegments);
  const destDir = path3.dirname(dest);
  mkdirSync(destDir, { recursive: true });
  const tmp = path3.join(destDir, `.${path3.basename(dest)}.${process.pid}.tmp`);
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, dest);
  return {
    src,
    dest
  };
}
function mirrorSkillDelete(workspaceRoot2, slug) {
  const dest = claudeSkillDir(workspaceRoot2, slug);
  rmSync(dest, {
    recursive: true,
    force: true
  });
  return { dest };
}

// packages/core/dist/dist-BzoA9pDR.js
Object.freeze({
  min: 0,
  max: 65535
});
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasStringProp(value, key) {
  return isRecord2(value) && typeof value[key] === "string";
}
function errorMessage(err, fallback) {
  if (err instanceof Error) return err.message;
  if (hasStringProp(err, "details") && err.details) return err.details;
  if (hasStringProp(err, "message") && err.message) return err.message;
  if (fallback !== void 0) return fallback;
  return String(err);
}

// server/workspace/hooks/handlers/skillBridge.ts
var bridgeTargetFromDataPath2 = (filePath) => bridgeTargetFromDataPath(workspaceRoot(), filePath);
var slugFromRmCommand2 = (command) => slugFromRmCommand(command);
async function refreshConfig() {
  await safePost(buildAuthPost("/api/config/refresh"));
}
async function handleWriteOrEdit(payload) {
  const filePath = extractFilePath(payload);
  if (!filePath) return;
  const target = bridgeTargetFromDataPath2(filePath);
  if (target === null) return;
  const relPath = target.relSegments.join("/");
  try {
    const { src, dest } = mirrorSkillWrite(workspaceRoot(), target);
    await refreshConfig();
    await serverLog("skill-bridge", `mirrored ${src} \u2192 ${dest}`, { data: { slug: target.slug, relPath, op: "write" } });
  } catch (err) {
    await serverLog("skill-bridge", `mirror write failed for slug=${target.slug} (${relPath})`, {
      level: "error",
      data: { slug: target.slug, relPath, error: errorMessage(err) }
    });
  }
}
async function handleBash(payload) {
  const command = extractCommand(payload);
  if (!command) return;
  const slug = slugFromRmCommand2(command);
  if (slug === null) return;
  try {
    const { dest } = mirrorSkillDelete(workspaceRoot(), slug);
    await refreshConfig();
    await serverLog("skill-bridge", `removed ${dest}`, { data: { slug, op: "delete" } });
  } catch (err) {
    await serverLog("skill-bridge", `mirror delete failed for slug=${slug}`, {
      level: "error",
      data: { slug, error: errorMessage(err) }
    });
  }
}
async function handleSkillBridge(payload) {
  const tool = extractToolName(payload);
  if (tool === "Write" || tool === "Edit") {
    await handleWriteOrEdit(payload);
    return;
  }
  if (tool === "Bash") {
    await handleBash(payload);
  }
}

// server/workspace/hooks/handlers/wikiSnapshot.ts
import path5 from "node:path";

// packages/core/dist/slug-BpjumQfe.js
function isSafeSlug(slug) {
  if (slug.length === 0) return false;
  if (slug === "." || slug === "..") return false;
  if (slug.includes("/") || slug.includes("\\")) return false;
  if (slug.includes("\0")) return false;
  return true;
}

// packages/core/dist/wiki/paths.js
import path4 from "node:path";
function wikiSlugFromAbsPath(absPath, pagesDir) {
  const rel = path4.relative(pagesDir, absPath);
  if (rel.length === 0) return null;
  if (path4.isAbsolute(rel)) return null;
  if (rel.includes(path4.sep)) return null;
  if (!rel.endsWith(".md")) return null;
  const slug = rel.slice(0, -3);
  if (!isSafeSlug(slug)) return null;
  return slug;
}

// server/workspace/hooks/handlers/wikiSnapshot.ts
var WIKI_PAGES_REL = path5.join("data", "wiki", "pages");
async function handleWikiSnapshot(payload) {
  const tool = extractToolName(payload);
  if (tool !== "Write" && tool !== "Edit") return;
  const filePath = extractFilePath(payload);
  if (!filePath) return;
  const wikiPagesDir = path5.join(workspaceRoot(), WIKI_PAGES_REL);
  const slug = wikiSlugFromAbsPath(filePath, wikiPagesDir);
  if (slug === null) return;
  const envChatSessionId = process.env.MULMOCLAUDE_CHAT_SESSION_ID;
  const payloadSessionId = extractSessionId(payload);
  const sessionId = envChatSessionId && envChatSessionId.length > 0 ? envChatSessionId : payloadSessionId;
  const body = sessionId === void 0 ? { slug } : { slug, sessionId };
  const req = buildAuthPost("/api/wiki/internal/snapshot", body);
  await safePost(req);
}

// server/workspace/hooks/dispatcher.ts
var HANDLERS = [handleWikiSnapshot, handleConfigRefresh, handleSkillBridge];
async function runHandler(handler, payload) {
  try {
    await handler(payload);
  } catch {
  }
}
async function main() {
  const payload = await readHookPayload();
  if (!payload) return;
  await Promise.all(HANDLERS.map((handler) => runHandler(handler, payload)));
}
main().catch(() => {
});
