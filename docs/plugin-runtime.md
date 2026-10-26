# Runtime plugins

Workspace-installed and repo-shipped GUI chat plugins that load at server boot without being part of the build-time bundle. Tracks issue [#1043](https://github.com/receptron/mulmoclaude/issues/1043) C-2.

A runtime plugin is a published npm package that exports a `gui-chat-protocol` `ToolPlugin`: an MCP `TOOL_DEFINITION`, a server-side `execute()` handler, and Vue components (`viewComponent` for the canvas, `previewComponent` for the message preview). The plugin's tarball lives in the workspace (or under `node_modules/` for presets); the boot loader extracts and registers it with the runtime registry, then the frontend dynamic-imports the View when the LLM calls the tool.

There are **two sources** of runtime plugins, both feeding the same registry:

| Source             | Where it lives                                                                                                                                                                                     | Who controls it  | Use case                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------ |
| **Preset**         | `node_modules/<pkg>/`, listed in [`server/plugins/preset-list.ts`](../server/plugins/preset-list.ts) (kept under `server/` so it's available at runtime in Docker, where `config/` is not mounted) | repo / committer | First-launch UX. Plugins that ship with mulmoclaude.   |
| **User-installed** | `~/mulmoclaude/plugins/<pkg>.tgz`, listed in `~/mulmoclaude/plugins/plugins.json`                                                                                                                  | end user         | Per-workspace extensions the user installs themselves. |

`PRESET_PLUGINS` is currently empty — the framework is in place but no preset ships by default. Past attempts to preset `@gui-chat-plugin/weather` produced "name collides with already-loaded runtime plugin" warnings on every boot for users who had also installed it via the workspace ledger; until that double-source state is handled cleanly, presets stay empty and `@gui-chat-plugin/weather` is just one of the packages a user can install themselves.

On tool-name collision the preset wins (loaded first). Static built-in MCP tools win over both.

## User scenarios

### Scenario 1: user installs a plugin (walkthrough with `@gui-chat-plugin/weather`)

[`@gui-chat-plugin/weather`](https://www.npmjs.com/package/@gui-chat-plugin/weather) is a good first plugin to install — it exports `fetchWeather` (Japan Meteorological Agency, free public API, no key required) and ships both the server-side handler and a Vue View, so it exercises the whole runtime pipeline (MCP dispatch + canvas render).

Phase D (the `yarn plugin:install` CLI) is not yet shipped. Until then, the install path is manual:

```bash
mkdir -p ~/mulmoclaude/plugins
cd "$(mktemp -d)" && npm pack @gui-chat-plugin/weather
mv gui-chat-plugin-weather-*.tgz ~/mulmoclaude/plugins/

# Append an entry to ~/mulmoclaude/plugins/plugins.json
# (create the file with `[]` first if it doesn't exist):
#   [
#     {
#       "name": "@gui-chat-plugin/weather",
#       "version": "0.1.0",
#       "tgz": "gui-chat-plugin-weather-0.1.0.tgz",
#       "installedAt": "2026-05-02T00:00:00.000Z"
#     }
#   ]
```

Restart the server. Boot log:

```text
[plugins/runtime] loaded requested=1 succeeded=1
[plugins/runtime] registered runtime plugins presets=0 userInstalled=1 registered=1 collisions=0
```

Then in the browser:

1. Open a chat session at [http://localhost:5173](http://localhost:5173).
2. Send "東京の天気おしえて".
3. The LLM calls `fetchWeather`; the canvas renders the weather View (⛅ + Tailwind styling) with the JMA forecast for Tokyo.

Substitute any other `gui-chat-protocol`-shaped package the same way — the steps above are not weather-specific.

### Scenario 2: mix preset + user-installed

Both sources merge into the same registry. The user-installed plugin sees presets and vice versa; on collision the preset wins. (Currently no presets ship — see the table above — so the practical layout is "user-installed only".)

### Scenario 3: collisions

There are three flavours of collision and the behaviour differs by source:

1. **Runtime plugin name collides with a manifest-listed GUI plugin or a pure MCP tool** (everything fed into `MCP_PLUGIN_NAMES` plus `mcpToolDefs` keys: `notify`, `readXPost`, `searchX`, plus the manifest entries in [`src/plugins/server.ts`](../src/plugins/server.ts)). The runtime loader **rejects** the entry at registration time. The boot log records this:

   ```text
   [plugins/registry] skipping runtime plugin — name collides with static tool plugin=@x/notify-clone tool=notify
   ```

2. **Runtime plugin name collides with a build-time-bundled GUI plugin that is NOT in the manifest** (the legacy entries in [`src/tools/index.ts`](../src/tools/index.ts) under keys like `"text-response"`, `manageScheduler`, etc. that aren't agent-callable). The runtime loader does NOT see these names; it accepts the runtime entry. The frontend's `getPlugin(name)` lookup checks the static map first, so the build-time entry shadows the runtime one for rendering. The runtime entry is still listed by `getAllPluginNames()` and visible to MCP, so this state is best avoided — use a different `TOOL_DEFINITION.name` for runtime plugins.

3. **Runtime-vs-runtime collision** (preset and user-installed both register the same `TOOL_DEFINITION.name`, or two user-installed plugins do). First-loaded wins; presets are loaded before user-installed, so a preset always wins. The skipped entry is logged with `reason=runtime`.

Future work (out of scope for this PR): reject case 2 at registration time too, by feeding the static-map keys into `MCP_PLUGIN_NAMES`-equivalent collision sets server-side.

## Test scenarios

### Manual smoke (user-installed plugin)

Install `@gui-chat-plugin/weather` (or any other `gui-chat-protocol`-shaped plugin) into the workspace ledger first — see _Scenario 1_ above — then:

```bash
yarn install
yarn dev
```

Expected boot log (with weather installed in the ledger):

```text
[plugins/runtime] loaded requested=1 succeeded=1
[plugins/runtime] registered runtime plugins presets=0 userInstalled=1 registered=1 collisions=0
```

Then in the browser at [http://localhost:5173](http://localhost:5173):

1. Open a chat session.
2. Send "東京の天気おしえて".
3. Verify the canvas renders the weather View with current Tokyo weather.

If the View does not render, check devtools Network for the dynamic-import of `/api/plugins/runtime/%40gui-chat-plugin%2Fweather/<version>/dist/vue.js` (should be 200) and `/dist/style.css`.

### Manual: encoded traversal is blocked

```bash
TOKEN=$(cat ~/mulmoclaude/.session-token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Origin: http://localhost:5173" \
  "http://localhost:3001/api/plugins/runtime/%2E%2E%2F%2E%2E%2Fetc/passwd/dist/index.js"
# expect: 404
```

The asset endpoint is unauthenticated (browsers can't attach `Authorization` to a `<script type="module">` fetch). The trust boundary is the runtime registry: only `(pkg, version)` pairs the server registered itself can resolve. An attacker-controlled URL never reaches `path.join` with a server-controlled root.

### Automated: Playwright end-to-end (browser side)

```bash
yarn dev          # server + vite must be up
npx tsx scripts/verify-phase-c.mts
```

Asserts:

- `/api/plugins/runtime/list` returns the preset (and any user-installed) entries.
- Each plugin's `dist/vue.js` and `dist/style.css` fetch as 200.
- Dynamic-importing `dist/vue.js` resolves the bare `import "vue"` (via importmap) to the host's Vue instance — `HostVue === PluginVue`.
- The plugin module exports a `viewComponent` and a `previewComponent` that the runtime registry can index.

### Automated: server-side unit tests

```bash
npx tsx --test test/plugins/test_preset_loader.ts
npx tsx --test test/plugins/test_runtime_loader.ts
npx tsx --test test/plugins/test_runtime_registry.ts
npx tsx --test test/api/routes/test_runtimePluginRoot.ts
```

Cover:

- `loadPresetPlugins` reads every entry from `server/plugins/preset-list.ts`, resolves it against `node_modules/<pkg>/`, and produces `RuntimePlugin` records with non-empty version + valid `TOOL_DEFINITION`.
- `loadPluginFromCacheDir` (used by both loader paths) handles missing `package.json`, malformed JSON, missing `TOOL_DEFINITION`, wrong shape, missing entry file, and the legacy `main` fallback.
- `registerRuntimePlugins` enforces the collision policy: static names win, runtime first-loaded wins on intra-runtime collision, repeated registration replaces the set.
- `pluginAssetScope` gives the verified scope a registered plugin's assets are served from: a plugin installed into the workspace is anchored at the workspace, so a cache folder replaced by a link out is refused; a preset at its own realpath. Encoded `../` in either segment never matches a registered name.

### Automated: Docker MCP smoke

```bash
npx tsx --test test/agent/test_mcp_docker_smoke.ts
```

Verifies the MCP child process boots inside the Docker sandbox (the runtime loader runs in a `runtimeReady` Promise instead of top-level await because the container's tsx output target is cjs).

## How to add a preset

1. Add the package as a dep:

   ```bash
   yarn add @some-org/some-plugin
   ```

2. Append an entry to [`server/plugins/preset-list.ts`](../server/plugins/preset-list.ts):

   ```ts
   export const PRESET_PLUGINS: readonly PresetPlugin[] = [{ packageName: "@gui-chat-plugin/weather" }, { packageName: "@some-org/some-plugin" }];
   ```

3. Restart the server.

The plugin's tool name must NOT collide with any static MCP tool or any other runtime plugin (the registration log will reject collisions).

## How to write a plugin

There are two supported plugin shapes. **For new plugins prefer the factory shape** — it gives the plugin a scoped `runtime` with `pubsub` / `files` / `log` / `fetch` / `notify` and lets the host enforce per-plugin namespaces. The legacy shape stays supported so existing `@gui-chat-plugin/*` packages keep working without changes.

### Factory shape (recommended, requires `gui-chat-protocol@^0.3`)

```ts
// src/index.ts — server side
import { definePlugin } from "gui-chat-protocol";
import { z } from "zod";

const Args = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("save"), payload: z.unknown() }),
  z.object({ kind: z.literal("load") }),
]);

export default definePlugin(({ pubsub, files, log }) => ({
  TOOL_DEFINITION: {
    type: "function",
    name: "myTool",
    description: "…",
    parameters: { type: "object", properties: { /* … */ }, required: ["kind"] },
  },
  async myTool(rawArgs: unknown) {
    const args = Args.parse(rawArgs);
    switch (args.kind) {
      case "save": {
        await files.data.write("state.json", JSON.stringify(args.payload));
        pubsub.publish("changed", {});
        log.info("state saved");
        return { ok: true };
      }
      case "load":
        return { ok: true, state: (await files.data.exists("state.json"))
          ? JSON.parse(await files.data.read("state.json"))
          : null };
      default: {
        const exhaustive: never = args;
        throw new Error(`unknown kind: ${JSON.stringify(exhaustive)}`);
      }
    }
  },
}));
```

```vue
<!-- src/View.vue — browser side -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRuntime } from "gui-chat-protocol/vue";

const { pubsub, openUrl, locale } = useRuntime();

const items = ref<{ id: string; url: string }[]>([]);

let unsub: (() => void) | undefined;
onMounted(() => {
  unsub = pubsub.subscribe("changed", () => { /* refetch */ });
});
onUnmounted(() => unsub?.());
</script>
```

> **`<script setup>` ref-unwrap gotcha**: top-level refs (including any `ComputedRef` you return from a composable like `useT()`) are **auto-unwrapped** in the template. Write `{{ t.title }}`, never `{{ t.value.title }}` — the latter compiles to `unref(t).value.title` (double unwrap = `undefined.value.title` at runtime).

The `setup` function passed to `definePlugin` runs **once** at plugin load. Destructure the runtime in the closure and reference `pubsub` / `files` / etc. as bare names from inside handlers — no `context.` threading per call. The setup must NOT do real I/O (`await files.data.read(...)` etc.) at top level; only define handlers that do I/O when called.

The factory pattern's per-plugin scoping (closure over `pkgName`) is what makes the namespace enforcement structural rather than convention-based — the plugin literally cannot spell another plugin's pubsub channel or write into another plugin's data dir through the API.

### Legacy shape (`@gui-chat-plugin/weather` and friends)

```ts
// src/index.ts
export const TOOL_DEFINITION = { type: "function", name: "fetchWeather", description: "…", parameters: { /* … */ } };
export async function fetchWeather(_context: unknown, args: { city: string }) { /* … */ }
```

The package's `dist/index.js` is what the server dynamic-imports for `TOOL_DEFINITION`; `dist/vue.js` is what the browser dynamic-imports for the components. Both must be pre-bundled (no bare imports beyond `vue` and `gui-chat-protocol*`, which the host resolves via importmap / its own `node_modules`).

### Reference plugin

[`packages/plugins/bookmarks-plugin/`](../packages/plugins/bookmarks-plugin/) is a small (~70-line server / ~50-line View) reference plugin built on the factory shape. It exercises every API surface — pubsub publish + subscribe, `files.data` for the bookmarks JSON, `files.config` for sort prefs, locale-aware view text, Zod-discriminated args with exhaustive switch. Read this before writing your first plugin.

### OAuth-using plugins (`@mulmoclaude/spotify-plugin` pattern, #1162)

A plugin that integrates with an OAuth provider (Spotify / GitHub / Apple Music / …) needs ONE host-side hook the dispatch surface alone can't provide: a stable HTTP path the provider's redirect URL can hit. The host exposes a generic endpoint:

```
GET /api/plugins/runtime/oauth-callback/:alias?code=…&state=…&error=…
```

Bearer-auth-EXEMPT (the browser comes back from the provider with no `Authorization` header). The host routes by `:alias`, looks up the plugin in the runtime registry, and forwards the query params to the plugin as a dispatch call:

```ts
plugin.execute({}, { kind: "oauthCallback", code, state, error });
```

The plugin handles state validation, code-for-token exchange, and persistence. Host code stays generic — no provider-specific logic.

#### Why an alias instead of the npm package name?

Spotify's Developer Dashboard rejects redirect URIs containing percent-encoded `@` / `/` characters. Putting the npm scoped name (`@mulmoclaude/spotify-plugin`) directly in the URL path forced those encodings; even though browsers accept them, Spotify's URL validator does not. Each OAuth-using plugin therefore declares its own short, lowercase, alphanumeric alias (`^[a-z0-9][a-z0-9-]{0,30}$`). Boot-time alias collisions are logged and the second plugin's alias is dropped; its dispatch surface still works.

#### Plugin-side recipe

1. **Declare the alias** as a top-level named export in the plugin's `dist/index.js` entry:
   ```ts
   export const OAUTH_CALLBACK_ALIAS = "spotify";
   ```
   The host loader picks it up regardless of factory vs legacy plugin shape.

2. **`connect` kind**: View calls `runtime.dispatch({ kind: "connect", redirectUri })` where the View computes
   ```ts
   const redirectUri = `${window.location.origin}/api/plugins/runtime/oauth-callback/spotify`;
   ```
   Plugin generates PKCE `code_verifier` + a single-use `state`, stores them in-memory keyed by `state`, returns `{ data: { authorizeUrl } }`. View opens the URL.

3. **`oauthCallback` kind**: invoked automatically by the host's generic endpoint. Plugin validates `state` (CSRF defence), exchanges `code + code_verifier` at the provider's token endpoint (using `runtime.fetch` with an `allowedHosts: [<provider-token-host>]` allowlist), persists tokens via `runtime.files.config`, and returns `{ html?: string; message?: string }`. The host renders `html` to the browser; if absent, it falls back to a minimal "OAuth complete" / "OAuth failed" page.

4. **Token refresh**: plugin's API client wraps `runtime.fetch` with a proactive-refresh-near-expiry + 401 → refresh → retry-once loop. A second 401 after refresh surfaces as `auth_expired` so the user reconnects rather than churning the token endpoint.

5. **Provider-specific Client ID**: store via `runtime.files.config` (e.g. `client.json`). The View has a "Configure" form that posts to a `kind: "configure"` dispatch action. PKCE means no Client Secret — that's a Spotify-specific simplification but applies to most modern OAuth providers.

#### What ends up in host code

For Spotify, the answer is: **one route entry** on the runtime-plugin router (the generic OAuth callback above) plus an alias index in the runtime registry. No provider-specific config. Adding GitHub / Apple Music / … reuses the same endpoint by declaring a different `OAUTH_CALLBACK_ALIAS`.

#### Reference

[`packages/plugins/spotify-plugin/`](../packages/plugins/spotify-plugin/) is the reference implementation. PR 1 ships the OAuth surface only (`connect` / `oauthCallback` / `status` / `diagnose`); PR 2 adds the listening-data kinds + the View. Plan: [`plans/done/feat-spotify-plugin.md`](../plans/done/feat-spotify-plugin.md), tracking issue: #1162.

## API reference (factory shape)

```ts
interface PluginRuntime {
  pubsub: { publish<T>(eventName: string, payload: T): void };
  locale: string;                                    // host snapshot at plugin load time
  files:  { data: FileOps; config: FileOps };        // see below
  log:    { debug; info; warn; error };              // (msg, data?) → void
  fetch:  (url, opts?: PluginFetchOptions) => Promise<Response>;
  fetchJson: <T>(url, opts?: PluginFetchJsonOptions<T>) => Promise<T>;
  notify: (msg: { title; body?; level? }) => void;   // → host notifications channel
}

interface FileOps {
  read(rel): Promise<string>;
  readBytes(rel): Promise<Uint8Array>;
  write(rel, content): Promise<void>;                // atomic
  readDir(rel): Promise<string[]>;
  stat(rel): Promise<{ mtimeMs; size }>;
  exists(rel): Promise<boolean>;
  unlink(rel): Promise<void>;
}
```

```ts
// Browser side (gui-chat-protocol/vue)
interface BrowserPluginRuntime {
  pubsub:  { subscribe<T>(eventName, handler): () => void };
  locale:  Ref<string>;                              // reactive — host locale picker safe
  log:     { debug; info; warn; error };
  openUrl: (url: string) => void;                    // target=_blank + noopener,noreferrer
  notify:  (msg: { title; body?; level? }) => void;
}
```

`pubsub.publish("changed")` on the server fans to channel `plugin:<pkg>:changed`. `pubsub.subscribe("changed", h)` on the browser subscribes to the same channel. Plugin authors only ever see the short event name (`"changed"`); the platform handles the prefix.

## Path conventions (platform contract)

> All `runtime.files.{data,config}.*` `rel` arguments are **POSIX-relative paths** (`/` separated). The platform internally:
>
> 1. Replaces `\` with `/` (Windows `path.join` repair)
> 2. Runs `path.posix.normalize` to fold `..`, `.`, repeated `/`
> 3. Resolves against the plugin's scope root (`~/mulmoclaude/data/plugins/<sanitised-pkg>/` or `~/mulmoclaude/config/plugins/<sanitised-pkg>/`)
> 4. Rejects (`throw`) anything that escapes the scope root
>
> Plugin authors should never need `node:path`. The recommended ESLint preset (below) enforces that. If a plugin author misuses `node:path` on Windows anyway, the normalisation step still produces a valid POSIX path — the contract handles the mistake gracefully without compromising the traversal anchor.

Example:

```ts
await files.data.write("books/2026/journal.jsonl", json);   // ✓
await files.data.write(`books/${bookId}/journal.jsonl`, j); // ✓ template literal
await files.data.read("../../etc/passwd");                  // ✗ throws
```

## ESLint preset

`gui-chat-protocol` exports a flat-config preset that bans the platform-bypass imports:

```js
// plugin/eslint.config.mjs
import tseslint from "typescript-eslint";
import vueParser from "vue-eslint-parser";
import pluginPreset from "gui-chat-protocol/eslint-preset";

export default [
  { files: ["src/**/*.ts"],  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaVersion: "latest", sourceType: "module" } } },
  { files: ["src/**/*.vue"], languageOptions: { parser: vueParser, parserOptions: { parser: tseslint.parser, ecmaVersion: "latest", sourceType: "module" } } },
  ...pluginPreset.map((entry) => ({ ...entry, files: ["src/**/*.{ts,vue}"] })),
];
```

The preset turns these into errors:

| Rule | Why |
|---|---|
| `no-restricted-imports` for `fs` / `node:fs` / `fs/promises` / `node:fs/promises` | Use `runtime.files.data` / `runtime.files.config` |
| `no-restricted-imports` for `path` / `node:path` | Use POSIX template literals — paths are platform-normalised |
| `no-console` | Use `runtime.log.*` so output lands in the central log files |

Allowed Node built-ins: `node:crypto` (`randomUUID` etc.), `node:url` (URL parsing).

When you see `import { something } from "node:fs"` in plugin source — even one — that's the audit signal. The plugin is reaching around the platform; review carefully.

## Action discriminator pattern (recommended)

The runtime plugin dispatch route hands the LLM's `tool_use` block to your handler unchanged. The LLM can put anything in there, so handlers must validate before branching. The idiomatic pattern is a Zod discriminated union + exhaustive `switch`:

```ts
const Args = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("save"),   payload: SomeSchema }),
  z.object({ kind: z.literal("load") }),
  z.object({ kind: z.literal("delete"), id: z.string() }),
]);

async function handler(rawArgs: unknown) {
  const args = Args.parse(rawArgs);   // type-narrow + validate in one step
  switch (args.kind) {
    case "save":   return save(args.payload);
    case "load":   return load();
    case "delete": return remove(args.id);
    default: { const exhaustive: never = args; throw new Error(`unknown: ${JSON.stringify(exhaustive)}`); }
  }
}
```

The `default: never` line is the safety net — if you add a new `kind` to `Args` later but forget to add a `case`, TypeScript fails the build instead of the new path silently dropping into the throw at runtime.

## Related

- [`docs/manual-testing.md`](manual-testing.md) — broader manual test scenarios for the app
- [`plans/done/feat-plugin-c2-impl.md`](../plans/done/feat-plugin-c2-impl.md) — the original C-2 rollout plan
- [`plans/done/feat-plugin-runtime-extensions-1110.md`](../plans/done/feat-plugin-runtime-extensions-1110.md) — this PR's plan
- Issue [#1043](https://github.com/receptron/mulmoclaude/issues/1043) — plugin SDK / dynamic install / marketplace umbrella
- Issue [#1110](https://github.com/receptron/mulmoclaude/issues/1110) — runtime extensions spec (factory pattern, scoped pubsub, files split, ESLint preset)
