// Bundle the MCP broker (`server/agent/mcp-server.ts`) into a single ESM file
// at `server/build/mcp-server.mjs`. Run as `yarn build:mcp-broker` (chained
// from `yarn build`, and from every `yarn dev` variant before the server starts,
// so a dev checkout never serves a bundle older than its source: see
// scripts/lib/devChain.mjs).
//
// Why: the CLI spawns the broker per turn and waits ~5s for it to answer
// `initialize`. Under `tsx` over a Windows/macOS Docker bind mount that took
// 20-24 seconds (#2233 measured it), which is the `handlePermission not found`
// race in #2201. The cost is per-file: the broker's runtime graph is 292 files
// plus a CJS tree underneath, and #2233 found cold and warm runs equally slow —
// so it is work paid every turn, not a cache miss. Bundling makes it one file.
//
// Unlike `build-hooks.mjs`, the output is NOT committed: it is ~6 MB, and a blob
// that size rewritten on every build would bloat the repo. It is gitignored and
// produced by `yarn build`; `buildMulmoclaudeServer` falls back to `tsx` when it
// is absent, so a fresh checkout still runs before any build.

import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const ENTRY = "server/agent/mcp-server.ts";
const OUTFILE = "server/build/mcp-server.mjs";

// Native `.node` bindings cannot be inlined. duckdb reaches the graph through
// the collection store; left external it resolves from node_modules as before.
const NATIVE_EXTERNALS = ["@duckdb/*", "duckdb"];

// Puppeteer drives the headless browser `renderShapeScript` rasterises with. The
// renderer itself now lives in `@gui-chat-plugin/shapescript/render`, but the
// driver stays external either way: it is reached through a lazy dynamic import,
// ships its own browser download machinery, and inlining one into the broker
// would be tens of megabytes to support one optional tool. Left external the
// import resolves from node_modules where a browser exists and throws where it
// does not — which the tool's "Chromium is not installed" path already handles.
const BROWSER_EXTERNALS = ["puppeteer", "puppeteer-core"];

// `presentBrep`'s definition comes from `@gui-chat-plugin/brep`, whose core entry
// also holds the build. The broker only lists the tool (a call goes to the
// server over HTTP), and today the build is dropped from the bundle as unused:
// no asset here names replicad or `node:vm`. These are external for the day
// that stops being true. The package reaches the OpenCascade kernel through
// lazy dynamic imports, so left external it stays unloaded, as puppeteer does;
// inlined it would be megabytes of loader beside 22 MB of WebAssembly that the
// loader finds by path, which an inlined copy would not.
const KERNEL_EXTERNALS = ["replicad", "replicad-opencascadejs"];

// express / body-parser / debug are CJS and call `require()` at runtime, which
// an ESM bundle has no binding for — without this the broker dies at load with
// `Dynamic require of "tty" is not supported`.
const CJS_REQUIRE_SHIM = ["import { createRequire as __createRequire } from 'node:module';", "const require = __createRequire(import.meta.url);"].join("\n");

/** The esbuild options, exported so the reasoning behind each one is readable
 *  (and assertable) without running a build. */
export function brokerBuildOptions() {
  return {
    entryPoints: [path.join(repoRoot, ENTRY)],
    outfile: path.join(repoRoot, OUTFILE),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: [...NATIVE_EXTERNALS, ...BROWSER_EXTERNALS, ...KERNEL_EXTERNALS],
    // Dependencies are INLINED, not left external. Tried external
    // (`packages: "external"`) to keep the bundle at 505 KB instead of 12 MB —
    // it dies in the container with `Cannot find package
    // '@mulmoclaude/markdown-utils'`. The workspace packages are NTFS
    // junctions that dangle inside the Linux container (#1946 / #1982 / #2052);
    // the tsx path survives that via the ESM loader hook plus the
    // `/app/pkg_modules` NODE_PATH fallback, but a bundle resolving bare
    // specifiers from `server/build/` does not. Inlining sidesteps the whole
    // resolver problem — that, not just speed, is why this bundles deps.
    //
    // Minified because that trade is then about size alone: 12 MB -> 6 MB on a
    // 29.7 MB published launcher. Generated code nobody reads, and stack traces
    // still carry function names.
    minify: true,
    banner: { js: CJS_REQUIRE_SHIM },
    // Same rationale as build-hooks.mjs: an inline map's base64 churns on every
    // rebuild. The bundle is not committed, but a stable output still keeps
    // `yarn build` reproducible.
    sourcemap: false,
    logLevel: "silent",
    metafile: true,
  };
}

function report(result) {
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  console.log(`[build:mcp-broker] ${ENTRY} -> ${OUTFILE} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  for (const warning of result.warnings) {
    console.warn(`[build:mcp-broker] warning: ${warning.text}`);
  }
}

async function main() {
  report(await build(brokerBuildOptions()));
}

await main();
