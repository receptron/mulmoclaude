#!/usr/bin/env node

// MulmoClaude launcher — `npx mulmoclaude` entry point.
//
// Ships with server source (TypeScript) + pre-built client (Vite).
// Runs the server via tsx (TypeScript executor).

import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import { get as httpGet } from "http";
import { createRequire } from "module";
import { join, dirname, delimiter as PATH_DELIMITER } from "path";
import { fileURLToPath } from "url";

// Shared with `server/index.ts` — the launcher and the dev server use
// the same probe + fallback logic. See server/utils/port.mjs for why
// it's plain JS rather than TypeScript.
import { isPortFree, findAvailablePort, MAX_PORT_PROBES } from "../server/utils/port.mjs";
import { parseDevPluginArgs } from "../server/utils/dev-plugin-args.mjs";
import { cliFlagHelpLines, flagEnvOverrides } from "../server/utils/cli-flags.mjs";
import { parseEnvFile, mergeLaunchEnv, describeLaunchEnvLoad } from "../server/utils/launch-env.mjs";
import { findLiveInstancePort, instanceGuardMessage, serverPortPathIn, shouldStopForRunningInstance } from "../server/utils/instance-guard.mjs";
import { resolveWorkspacePath } from "../server/utils/workspace-path.mjs";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, "..");
const SERVER_ENTRY = join(PKG_DIR, "server", "index.ts");
const DEFAULT_PORT = 3001;

// ── Helpers ─────────────────────────────────────────────────

function log(msg) {
  console.log(`\x1b[36m[mulmoclaude]\x1b[0m ${msg}`);
}

function error(msg) {
  console.error(`\x1b[31m[mulmoclaude]\x1b[0m ${msg}`);
}

function checkClaude() {
  try {
    execSync("claude --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function pickOpenCommand() {
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "start";
  return "xdg-open";
}

// Poll the server until it answers an HTTP request, then call `onReady`.
// Gives up after ~15s so the launcher doesn't hang forever on a crash loop.
function waitUntilReady(portNum, onReady) {
  const startedAt = Date.now();
  const timeoutMs = 15000;
  const intervalMs = 300;

  // `function` declarations (not arrow consts) so the mutual
  // reference between `attempt` and `retry` works without TDZ
  // ordering problems. Both forms are hoisted to the top of the
  // enclosing function scope.
  function attempt() {
    const req = httpGet({ host: "127.0.0.1", port: portNum, path: "/", timeout: 1000 }, (res) => {
      res.resume();
      onReady();
    });
    req.on("error", retry);
    req.on("timeout", () => {
      req.destroy();
      retry();
    });
  }

  function retry() {
    if (Date.now() - startedAt > timeoutMs) return;
    setTimeout(attempt, intervalMs);
  }

  attempt();
}

function printReadyBanner(url) {
  const bar = "─".repeat(50);
  console.log("");
  console.log(`\x1b[32m${bar}\x1b[0m`);
  console.log(`\x1b[32m  ✓ MulmoClaude is ready\x1b[0m`);
  console.log(`\x1b[32m  → ${url}\x1b[0m`);
  console.log(`\x1b[32m  Press Ctrl+C to stop.\x1b[0m`);
  console.log(`\x1b[32m${bar}\x1b[0m`);
  console.log("");
}

// ── Parse args ──────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: npx mulmoclaude [options]
       npx mulmoclaude create-shortcut [--dir <path>] [--yes]

Commands:
  create-shortcut      Create a clickable MulmoClaude.app (macOS) so the
                       app can be started without a terminal

Options:
  --port <number>      Server port (default: ${DEFAULT_PORT})
  --no-open            Don't open browser automatically
  --dev-plugin <path>  Load a plugin from a local project dir for development
                       (repeatable). Path can be absolute or relative to cwd.
                       The dir must have package.json and dist/index.js
                       (run \`yarn build\` or \`yarn dev\` in the plugin first).
${cliFlagHelpLines()}
  --version            Show version
  --help               Show this help
`);
  process.exit(0);
}

if (args.includes("--version")) {
  const { version } = require(join(PKG_DIR, "package.json"));
  console.log(`mulmoclaude ${version}`);
  process.exit(0);
}

// Generates the clickable app bundle and exits — it never starts a
// server. Imported lazily because the icon builder pulls in `sharp`,
// which nothing else on the launch path needs.
if (args[0] === "create-shortcut") {
  const { runCreateShortcut } = await import("../server/utils/launcher/create-shortcut.mjs");
  const { version } = require(join(PKG_DIR, "package.json"));
  process.exit(await runCreateShortcut(args.slice(1), { version }));
}

const { requestedPort, portExplicit } = parsePortArg();
const noOpen = args.includes("--no-open");
const devPluginPaths = resolveDevPluginPaths();

function resolveDevPluginPaths() {
  const result = parseDevPluginArgs(args, process.cwd());
  if (!result.ok) {
    error(result.reason);
    process.exit(1);
  }
  for (const { rawInput, absPath } of result.resolved) {
    log(`[dev-plugin] ${rawInput} → ${absPath}`);
  }
  return result.resolved.map((entry) => entry.absPath);
}

function parsePortArg() {
  const idx = args.indexOf("--port");
  if (idx === -1) return { requestedPort: DEFAULT_PORT, portExplicit: false };
  const raw = args[idx + 1];
  if (raw === undefined) {
    error("--port requires a value (integer 1..65535)");
    process.exit(1);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1 || parsed > 65535) {
    error(`Invalid --port value: "${raw}" (expected integer 1..65535)`);
    process.exit(1);
  }
  return { requestedPort: parsed, portExplicit: true };
}

// ── Pre-flight checks ───────────────────────────────────────

if (!checkClaude()) {
  error("Claude Code CLI not found.");
  error("");
  error("Install it first:");
  error("  npm install -g @anthropic-ai/claude-code");
  error("  claude auth login");
  error("");
  error("Then try again: npx mulmoclaude");
  process.exit(1);
}

log("Claude Code CLI ✓");

if (!existsSync(SERVER_ENTRY)) {
  error(`Server source not found at ${SERVER_ENTRY}`);
  process.exit(1);
}

// ── Load `<launch-dir>/.env` ────────────────────────────────

// So `npx mulmoclaude` users keep secrets (e.g. GEMINI_API_KEY) next to where
// they launch — NOT inside the isolated ~/mulmoclaude workspace. Shell-exported
// vars win over the file, so `export GEMINI_API_KEY=…` still takes precedence.
//
// Before the port is resolved, because `MULMOCLAUDE_WORKSPACE_PATH` can come
// from this file: the single-instance guard below has to look at the same
// `.server-port` the spawned server will, and the server sees the merged value.
const launchEnvPath = join(process.cwd(), ".env");
const { exists: launchEnvExists, parsed: launchEnvParsed } = parseEnvFile(launchEnvPath);
const { env: baseEnv, loadedKeys, skippedKeys } = mergeLaunchEnv(process.env, launchEnvParsed);
const launchEnvSummary = describeLaunchEnvLoad({ path: launchEnvPath, exists: launchEnvExists, loadedKeys, skippedKeys });
if (launchEnvSummary) log(launchEnvSummary);

// ── Refuse a second instance on this workspace ──────────────

// The icon launcher has always checked; this path did not, and walked forward
// off a busy port into a second server nobody asked for (#3079). Asked here
// rather than left to the server so the stop arrives before
// "Starting MulmoClaude on port …" claims otherwise.
const allowMultipleInstances = args.includes("--allow-multiple-instances") || baseEnv.MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES === "1";
const workspacePath = resolveWorkspacePath({ processEnv: baseEnv });
const livePort = allowMultipleInstances ? null : await findLiveInstancePort(serverPortPathIn(workspacePath));
if (livePort !== null && shouldStopForRunningInstance({ livePort, allowMultiple: allowMultipleInstances })) {
  error(instanceGuardMessage(livePort));
  process.exit(1);
}

// ── Resolve a usable port ───────────────────────────────────

// Check the requested port before spawning the server — an explicit
// --port that's taken is a hard error (respect the user's choice),
// while the default can walk forward to the next free slot so casual
// double-launches don't crash.
const port = await chooseAvailablePort(requestedPort, portExplicit);

async function chooseAvailablePort(requested, explicit) {
  if (await isPortFree(requested)) return requested;
  if (explicit) {
    error(`Port ${requested} is already in use. Stop the other process or pick a different --port.`);
    process.exit(1);
  }
  const fallback = await findAvailablePort(requested + 1);
  if (fallback === null) {
    error(`Port ${requested} is in use and no free port found in ${requested}..${requested + MAX_PORT_PROBES - 1}.`);
    process.exit(1);
  }
  log(`Port ${requested} busy → using ${fallback} instead. (Pass --port <N> to pin.)`);
  return fallback;
}

// ── Start server ────────────────────────────────────────────

log(`Starting MulmoClaude on port ${port}...`);

// Resolve tsx's CLI entry via Node's module resolution so this works
// whether tsx is nested (`npx`/local install) or hoisted (`npm i -g`).
// tsx doesn't export `./cli`, so locate via its package.json + `bin`.
let tsxCli;
try {
  const tsxPkgJson = require.resolve("tsx/package.json");
  // Path is the resolved location of tsx's own package.json under
  // node_modules — not user-influenced, so the dynamic require is
  // safe. require.resolve already validated the path.
  // eslint-disable-next-line security/detect-non-literal-require -- resolved package.json path from require.resolve, not user input
  const tsxPkg = require(tsxPkgJson);
  tsxCli = join(dirname(tsxPkgJson), tsxPkg.bin);
} catch {
  error("Failed to locate 'tsx' — the package may be installed incorrectly.");
  process.exit(1);
}

const serverEnv = {
  ...baseEnv,
  NODE_ENV: "production",
  PORT: String(port),
};
if (devPluginPaths.length > 0) {
  serverEnv.MULMOCLAUDE_DEV_PLUGINS = devPluginPaths.join(PATH_DELIMITER);
}
// Hand the shell-shadowed `.env` keys to the server so it can raise an
// in-app notification (#2604). The log line above is easy to scroll past,
// and a user who edits `.env` while a stale shell export wins gets no
// other hint that the file is being ignored. Key NAMES only, never values.
// Deleted first, not just conditionally set: this var is ours to
// compute, and a value inherited from the shell (or from the `.env` we
// just merged) would otherwise reach the server and be reported as a
// conflict that does not exist.
delete serverEnv.MULMOCLAUDE_SHADOWED_ENV_KEYS;
if (skippedKeys.length > 0) {
  serverEnv.MULMOCLAUDE_SHADOWED_ENV_KEYS = skippedKeys.join(",");
}
// Boolean CLI flags that mirror an env var (#1089 + bundle): inject
// the corresponding VAR=1 into the spawned server so the flag is
// equivalent to the env-var prefix. The server reads these via
// server/system/env.ts.
for (const [flagEnv, value] of Object.entries(flagEnvOverrides(args))) {
  serverEnv[flagEnv] = value;
  log(`[flag] ${flagEnv}=${value}`);
}

const server = spawn(process.execPath, [tsxCli, SERVER_ENTRY], {
  cwd: PKG_DIR,
  env: serverEnv,
  stdio: "inherit",
});

// Print a ready banner + optionally open the browser once the server
// actually responds — not a fixed-delay timer, so the banner appears
// right when the UI is reachable.
const url = `http://localhost:${port}`;
waitUntilReady(port, () => {
  printReadyBanner(url);
  if (noOpen) return;
  const openCmd = pickOpenCommand();
  try {
    // openCmd is a hard-coded literal; url is http://localhost:<numeric-port>.
    execSync(`${openCmd} ${url}`, { stdio: "pipe" });
  } catch {
    log(`Open your browser: ${url}`);
  }
});

// Graceful shutdown
process.on("SIGINT", () => {
  server.kill("SIGTERM");
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.kill("SIGTERM");
  process.exit(0);
});

server.on("exit", (code) => {
  process.exit(code ?? 1);
});
