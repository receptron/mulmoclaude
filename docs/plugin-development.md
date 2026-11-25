# Plugin Development

This is the consolidated reference for **creating** or **editing** a plugin in MulmoClaude. Read this when you're about to touch `packages/plugins/<name>-plugin/` or `src/plugins/<name>/`. For day-to-day work that doesn't touch a plugin's surface, the load-bearing rules in [`CLAUDE.md`](../CLAUDE.md) are enough.

Related docs:
- [`docs/developer.md`](developer.md) — full developer guide (envs / scripts / process map / workspace layout)
- [`docs/plugin-runtime.md`](plugin-runtime.md) — runtime / npm-package plugin internals (the `/api/plugins/runtime/:pkg/*` dispatch surface, OAuth callback flow, role gating)
- [`CLAUDE.md`](../CLAUDE.md) — section "Package dependency direction" — the import-direction rule that applies to **every** code edit, plugin or not (load-bearing across all sessions, not duplicated here)

There are two flavours of plugin in this repo:

| Kind | Lives at | Distribution | Examples |
|---|---|---|---|
| **Built-in plugin** | `src/plugins/<name>/` | bundled into the host's Vite client + Express server | wiki, news, presentMulmoScript |
| **Runtime plugin** | `packages/plugins/<name>-plugin/` | standalone `@mulmoclaude/<name>-plugin` npm package, dispatched via `/api/plugins/runtime/:pkg`, gated by roles | bookmarks, chart, collection, debug, edgar, email, form, html, markdown, recipe-book, spotify, todo, x |

**Default to runtime plugin** for per-feature integrations (Spotify / GitHub / Apple Music / weather / bookmarks / …). Built-in is appropriate only for surfaces deeply tied to the host shell (wiki, news, the `presentMulmoScript` canvas).

---

## Plugin-vs-host boundary (always apply)

Per-feature integrations live in `packages/plugins/<name>-plugin/`. Host code (`server/`, `src/plugins/`, `src/config/`) only gets **generic infrastructure that benefits multiple plugins** — never provider-specific code.

Examples of generic host infra:
- the `/api/plugins/runtime/:pkg/dispatch` route
- the asset-mount route
- the `/api/plugins/runtime/:pkg/oauth/callback` route (#1162)

A new "Spotify route" or "GitHub route" in `server/api/routes/` is a smell — re-think whether the work belongs in the plugin package and whether the host's infra needs a *generic* extension instead.

---

## Built-in plugin path

### Plugin owns its identity

Each built-in plugin declares its `toolName`, `apiRoutes`, `workspaceDirs`, and `staticChannels` in its own `src/plugins/<name>/meta.ts`. Host aggregators (`API_ROUTES`, `TOOL_NAMES`, `WORKSPACE_DIRS`, `PUBSUB_CHANNELS`) auto-merge those contributions via `defineHostAggregate` — host code holds zero plugin-specific literals.

### The 6 plugin-local files + 3 host barrels

Adding a built-in plugin touches:

**Plugin-local (6 files under `src/plugins/<name>/`):**

- `meta.ts` — `definePluginMeta({ toolName, apiRoutesKey?, apiRoutes?, workspaceDirs?, staticChannels? })`
- `definition.ts` — MCP `ToolDefinition`; derive `TOOL_NAME = META.toolName`, endpoint types from `typeof META.apiRoutes`
- `index.ts` — `PluginRegistration` (View / Preview wrapped via `wrapWithScope(scope, …)`, executor calls `pluginEndpoints<E>(scope)`)
- `View.vue` / `Preview.vue` — Vue surfaces; call `useRuntime()` from `gui-chat-protocol/vue` for the typed `endpoints` map

**Host barrels (3 files):**

- `src/plugins/metas.ts` — append the META to `BUILT_IN_PLUGIN_METAS`
- `src/plugins/index.ts` — append the registration to `BUILT_IN_PLUGINS`
- `src/plugins/server.ts` — append `{ def, endpoint }` to `BUILT_IN_SERVER_BINDINGS` (skip for GUI-only plugins like wiki)

**Optional endpoint surface:**

- `server/api/routes/<name>.ts` — Express route handlers (only when the plugin owns endpoints)
- `src/main.ts` — entry in the host endpoint registry passed to `installHostContext({ endpoints })`

Adding to a Role's `availablePlugins` (`src/config/roles.ts`) is separate — roles gate which plugins each chat sees, independent of plugin registration.

### Standalone routes + inline previews must scope

Standalone routes (`/todos`, `/calendar`, …) and inline file previews (`FileContentRenderer` rendering `data/todos/todos.json`) must wrap the plugin component with `<PluginScopedRoot pkg-name :endpoints>` so descendant `useRuntime()` calls resolve. The plugin registry's `wrapWithScope` already covers chat-mounted variants.

---

## Runtime plugin path

Use the scaffold:

```bash
npx create-mulmoclaude-plugin <name>
```

That stamps `packages/plugins/<name>-plugin/` with a working `package.json` + Vite + TypeScript config + ESLint config. From there, see [`docs/plugin-runtime.md`](plugin-runtime.md) for the dispatch / runtime protocol details.

### Plugin scaffold sync (`packages/create-mulmoclaude-plugin`)

The scaffold CLI embeds `package.json` + `vite.config.ts` + `tsconfig.json` + ESLint config as **string literals** in `packages/create-mulmoclaude-plugin/src/template.ts`. Newly-generated plugins inherit those literals verbatim, so they DO NOT pick up version bumps you make to the in-tree plugins.

**When you bump a build-toolchain dep** (`vite` / `typescript` / `vite-plugin-dts` / `@vitejs/plugin-vue` / `vue`) or change the build-config shape (e.g. dropping `rollupTypes: true` for a TS-major bump), apply the same change to `packages/create-mulmoclaude-plugin/src/template.ts` in the **same PR**:

1. Update the `PACKAGE_JSON` template's `devDependencies` caret ranges to match `packages/plugins/bookmarks-plugin/package.json` (the canonical reference).
2. If the build-config shape changed, mirror it into `VITE_CONFIG` (the multi-line string just below).
3. Run `yarn workspace create-mulmoclaude-plugin run build` to regenerate the CLI's own dist.
4. Optionally bump the CLI's own `version` and re-publish if external users will fetch via `npx`.

Step 1 is asserted by `packages/create-mulmoclaude-plugin/test/test_toolchain_sync.ts`: every devDependency the template and `bookmarks-plugin` both declare must carry the same range (`gui-chat-protocol` is exempt while the template stays on the 1.x protocol), so a bump made on one side only turns `yarn test` red.

If you forget step 2, generated plugins ship with stale toolchains and may hit the same issue you just fixed in the in-tree plugin (e.g. empty `.d.ts` from api-extractor + TS 6).

**The same applies to how strictly a plugin is checked**, and that half is easier to miss because nothing about a generated plugin looks broken:

- `TSCONFIG` must carry `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. `strict: true` does not include either, so a template with only `strict` hands every new plugin a weaker checker than any in-tree one. It is byte-identical to `bookmarks-plugin/tsconfig.json` — diff against that.
- `PACKAGE_JSON`'s `typecheck` must be `vue-tsc`, not `tsc`, for as long as the template ships `src/View.vue`. `tsc` parses no `.vue` file whatsoever: it reports zero for a template and a `<script setup>` body that nobody checked, which reads exactly like a clean run (#2778).

Both are asserted by `packages/create-mulmoclaude-plugin/test/test_template.ts`, and the in-tree equivalents by `test/config/test_packageStrictFlags.ts` — that one sweeps every `packages/**/tsconfig*.json` for the flags (after `extends` resolution) and every `.vue`-bearing package for `vue-tsc`.

---

## Build orchestration rules (plugin-relevant subset)

The full overview is in [`CLAUDE.md`](../CLAUDE.md) under "Build orchestration". The plugin-specific bits:

- **Runtime plugin** workspace selection: lives at `packages/plugins/<name>-plugin/`, package name `@mulmoclaude/<name>-plugin`, has `scripts.build`. The build driver (`scripts/build-workspaces.mjs`) auto-discovers it from tier 4 — **no `package.json` edit needed**.
- **NEVER** name a non-runtime-plugin package `@mulmoclaude/foo-plugin` (e.g. a helper library). The build driver will try to run its `build` script in tier 4, after every consumer has already been built. Pick `@mulmoclaude/foo` / `@mulmoclaude/foo-helpers` / move it into `@mulmoclaude/core` instead.
- Non-bridge, non-runtime-plugin workspaces (e.g. `@receptron/*`, `@mulmobridge/mock-server`) **MUST** be added to the explicit tier-1 / tier-2 enumeration in the root `package.json` — auto-discovery won't pick them up.

---

## Plugin-aware host aggregators

When adding a plugin's `meta.ts`, its contributions auto-merge into these centralised constants — **never** edit the aggregator records directly for a plugin literal:

| Aggregator | Source of truth | Plugin contribution |
|---|---|---|
| `API_ROUTES` | `src/config/apiRoutes.ts` | `META.apiRoutes` |
| `TOOL_NAMES` | `src/config/toolNames.ts` | `META.toolName` |
| `WORKSPACE_DIRS` / `WORKSPACE_PATHS` | `server/workspace/paths.ts` | `META.workspaceDirs` |
| `PUBSUB_CHANNELS` | `src/config/pubsubChannels.ts` | `META.staticChannels` |

Edits to a plugin's `meta.ts` propagate; collisions surface as boot-time diagnostics on the bell (first-write-wins semantics).

---

## Splitting a long `prompt` into an injected part and reference files

A tool definition's `prompt` is injected into the system prompt on every turn. When it is long, a definition may also declare:

```ts
export const TOOL_DEFINITION = {
  name: "presentThing",
  description: "…",
  prompt: FULL_TEXT, // unchanged: hosts that don't know the split inject this
  promptCompact: "When to use it, the must-follow rules. Read {{promptFilesDir}}/guide.md before the first call.",
  promptFiles: { "guide.md": GUIDE_MD }, // file name → CONTENT (import the .md as a string at build time)
};
```

- Keep `prompt` as the full text. A host that does not support the split, or that could not write the files, injects it unchanged — so adopting the split never breaks an older host.
- `promptFiles` carries file **contents**, not paths: the host writes them, so there is no package-root lookup to break under ESM/CJS or the runtime-plugin cache. Names are relative and `/`-separated; anything that could leave the directory is rejected.
- `{{promptFilesDir}}` is the only way to refer to the directory. Each host replaces it with the path **its agent** can read: MulmoClaude uses `config/helps/plugins/<package>/` (workspace-relative — the agent's cwd is the workspace natively and in Docker); MulmoTerminal, whose agent starts in a project directory, uses an absolute path. Never write a literal path.
- The directory is named after the npm package (`node_modules` layout), supplied by the host — a runtime plugin's package name, or `packageName` on a built-in binding — so two packages can never share one.
- For a **plugin**, MulmoClaude's MCP tool description still carries the full `prompt` (`description` + `prompt`), so a tool loaded via `ToolSearch` sees everything either way. A **host MCP tool** publishes only `definition.description`, so once its split applies the full guidance lives ONLY in the prompt file — keep every rule that must be followed without reading it (data loss, silently wrong writes) in `promptCompact`.
- Host MCP tools (`server/agent/mcp-tools/`) take the same `promptCompact` / `promptFiles` fields plus `packageName` on the `McpTool` object (see `manageCollection`).
- Shared implementation: `@mulmoclaude/core/prompt-files` (`renderToolPrompt`, `syncPromptFiles`).

---

## When you need shared code across plugins

You don't import from another plugin (that's a peer-tier violation — see the dependency-direction rule in [`CLAUDE.md`](../CLAUDE.md)). Instead:

1. **Pull the shared code OUT of the plugin into `@mulmoclaude/core`** under a new subpath (e.g. `@mulmoclaude/core/<feature>` + optionally `@mulmoclaude/core/<feature>/server`).
2. Both plugins (and any consumer) import from core.

The canonical example is [`plans/done/refactor-shared-core.md`](../plans/done/refactor-shared-core.md): `isSafeActionTemplatePath` / `discoverCollections` / `whenMatches` used to live inside `@mulmoclaude/collection-plugin`. The skill-bridge and collection-watchers services needed them, so they reached uphill into the plugin — a violation that forced a `tier 3 → 4 → 3` build-order shuffle and a `--first=notifier` flag (PR #1789). PR #1795 extracted the engine into `@mulmoclaude/core/collection/server`; everyone now consumes from core and the build order is irrelevant.

---

## Quick checklist when creating a runtime plugin

1. `npx create-mulmoclaude-plugin <name>` from the repo root.
2. Implement the plugin's MCP tool + Vue View / Preview inside `packages/plugins/<name>-plugin/`.
3. If you need shared infra: import from `@mulmoclaude/core/<subpath>` — DO NOT import from another `*-plugin`.
4. Add to a role's `availablePlugins` in `src/config/roles.ts` if you want it gated to a specific role.
5. `yarn build:packages` confirms tier 4 auto-discovers your new workspace.
6. Smoke-test: `yarn dev`, switch to the role, dispatch the tool from the chat.

## Quick checklist when creating a built-in plugin

1. Use an existing built-in (`src/plugins/wiki/` or `src/plugins/news/`) as a template — copy the 4 plugin-local files (`meta.ts` / `definition.ts` / `index.ts` / `View.vue` + `Preview.vue` if any).
2. Append to the 3 host barrels: `src/plugins/metas.ts`, `src/plugins/index.ts`, `src/plugins/server.ts`.
3. If the plugin owns endpoints, add `server/api/routes/<name>.ts` and wire it from `src/main.ts`'s endpoint registry.
4. `yarn typecheck:vue` confirms the META → aggregator merge typechecks.
5. Add to a role's `availablePlugins` if role-gated.
