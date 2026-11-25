// Template files emitted by the CLI. Inline string constants —
// keeping them out of `src/templates/*.ts` so tsc / eslint don't
// trip on the placeholder syntax (`{{PLUGIN_NAME}}`) or on the
// `.vue` SFC syntax inside template strings.
//
// Each entry: relative path under the new plugin directory + raw
// content (with placeholders). The CLI substitutes placeholders and
// writes the file verbatim — no parsing, no other transformations.
//
// ─────────────────────────────────────────────────────────────────
// MAINTENANCE — keep `PACKAGE_JSON` (devDeps) and `VITE_CONFIG`
// in sync with the in-tree reference plugin (`packages/plugins/
// bookmarks-plugin/`). When that one bumps `vite` / `typescript` /
// `vite-plugin-dts` / `@vitejs/plugin-vue`, copy the same caret ranges
// here. The same goes for build-config tweaks (e.g. dropping
// `rollupTypes: true` for TS-major bumps). See CLAUDE.md →
// "Plugin scaffold sync" for the exact procedure.
// ─────────────────────────────────────────────────────────────────

export interface TemplateFile {
  /** POSIX-style path relative to the new plugin's root. */
  path: string;
  /** Raw content with placeholders. */
  content: string;
}

// Sole placeholder. Substituted in package.json + README.
export const PLUGIN_NAME_PLACEHOLDER = "{{PLUGIN_NAME}}";

const PACKAGE_JSON = `{
  "name": "${PLUGIN_NAME_PLACEHOLDER}",
  "version": "0.1.0",
  "description": "MulmoClaude runtime plugin scaffolded with create-mulmoclaude-plugin.",
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./vue": {
      "types": "./dist/vue.d.ts",
      "import": "./dist/vue.js",
      "require": "./dist/vue.js",
      "default": "./dist/vue.js"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "vite build",
    "typecheck": "vue-tsc --noEmit",
    "lint": "eslint src",
    "dev": "vite build --watch"
  },
  "peerDependencies": {
    "gui-chat-protocol": "^1.2.0",
    "vue": "^3.5.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^6.0.11",
    "eslint": "^9.0.0",
    "gui-chat-protocol": "^1.2.0",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.0.0",
    "vite": "^8.3.7",
    "vite-plugin-dts": "^5.1.2",
    "vue": "^3.5.45",
    "vue-eslint-parser": "^10.0.0",
    "vue-tsc": "^3.3.14",
    "zod": "^4.6.7"
  },
  "license": "MIT"
}
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "noEmit": true,
    "jsx": "preserve"
  },
  "include": ["src/**/*"]
}
`;

const VITE_CONFIG = `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import dts from "vite-plugin-dts";

// Two bundles, two externals strategies (mirrors the in-tree
// bookmarks-plugin reference):
//
// - dist/index.js (server) — self-contained. The mulmoclaude
//   runtime loader extracts the package into
//   ~/mulmoclaude/plugins/.cache/<pkg>/<ver>/ and dynamic-imports
//   it. There's no node_modules underneath, so any bare import left
//   external would fail to resolve at load time. Inline
//   gui-chat-protocol (just the identity definePlugin function) and
//   zod so the server module is self-contained.
//
// - dist/vue.js (browser) — vue and gui-chat-protocol/vue stay
//   external; the host provides Vue via the importmap and the
//   useRuntime() composable resolves to the host's instance through
//   gui-chat-protocol/vue (also via importmap).
// No \`rollupTypes: true\`: that would route declaration emit through
// @microsoft/api-extractor, whose bundled tsc lags behind real
// TypeScript releases and silently emits empty d.ts when the
// workspace is on a newer major. \`compilerOptions.rootDir: "src"\`
// keeps the per-file emit at \`dist/<file>.d.ts\` (matching the
// package.json exports map).
export default defineConfig({
  plugins: [
    vue(),
    dts({
      include: ["src/**/*.{ts,vue}"],
      outDir: "dist",
      compilerOptions: { rootDir: "src" },
    }),
  ],
  build: {
    lib: {
      entry: { index: "src/index.ts", vue: "src/vue.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => \`\${entryName}.js\`,
    },
    rollupOptions: {
      external: ["vue", "gui-chat-protocol/vue"],
      output: {
        // The host runtime loader injects a stylesheet from
        // \`\${assetBase}/dist/style.css\`. Vite's default would name
        // the CSS after the package; pin it to style.css.
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) return "style.css";
          return assetInfo.name ?? "[name]";
        },
      },
    },
    minify: false,
    sourcemap: true,
  },
});
`;

const ESLINT_CONFIG = `// Plugin-author ESLint config — extends the gui-chat-protocol preset
// to ban node:fs / node:path / console / direct fetch so any platform
// bypass shows up at lint time.
//
// The preset is parser-agnostic; pair it with a TypeScript parser
// (and a Vue parser if your plugin has SFCs) here in your own config
// so the plugin doesn't have to ship a parser dep.

import tseslint from "typescript-eslint";
import vueParser from "vue-eslint-parser";
import pluginPreset from "gui-chat-protocol/eslint-preset";

export default [
  // TypeScript parsing for .ts files.
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
  },
  // Vue SFC parsing for .vue files.
  {
    files: ["src/**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, ecmaVersion: "latest", sourceType: "module" },
    },
  },
  // Apply the gui-chat-protocol restrictions to all plugin source.
  ...pluginPreset.map((entry) => ({ ...entry, files: ["src/**/*.{ts,vue}"] })),
];
`;

const GITIGNORE = `node_modules/
dist/
*.tgz
.DS_Store
`;

const SHIMS_VUE = `// Vite/Vue plugin SFC shim — tells \`tsc --noEmit\` that \`.vue\`
// imports resolve to a Vue Component. The actual SFC parsing happens
// at build time via @vitejs/plugin-vue.

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
`;

const DEFINITION_TS = `// Tool schema. Lives in its own module so both the server entry
// (index.ts) and the browser entry (vue.ts) can import it without
// dragging in the factory body, Zod, or any other server-only code.
//
// \`name: "incrementCounter" as const\` narrows the literal so
// \`definePlugin\`'s \`PluginFactoryResult<N>\` requires a handler
// exported under exactly this key.

export const TOOL_DEFINITION = {
  type: "function" as const,
  name: "incrementCounter" as const,
  description: "Increment, reset, or read a counter stored in the user's workspace.",
  parameters: {
    type: "object" as const,
    properties: {
      kind: { type: "string", enum: ["increment", "reset", "get"] },
      by: { type: "number", description: "increment delta (default 1)" },
    },
    required: ["kind"],
  },
};
`;

const INDEX_TS = `// Plugin server entry — runs inside the host's Node process.
//
// Demonstrates the v0.3 runtime API end-to-end on a tiny surface:
//   - definePlugin factory with destructured runtime
//   - files.data for persistent state (backup target)
//   - pubsub.publish on every mutation so multi-tab views auto-refresh
//   - Zod-discriminated args + exhaustive switch
//
// node:fs / node:path / console / direct fetch are all unused —
// every I/O goes through the runtime. The eslint preset enforces it.

import { createSerialLock, definePlugin } from "gui-chat-protocol";
import { z } from "zod";
import { TOOL_DEFINITION } from "./definition";

export { TOOL_DEFINITION };

const Counter = z.object({ value: z.number().int() });
type Counter = z.infer<typeof Counter>;

const Args = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("increment"), by: z.number().optional() }),
  z.object({ kind: z.literal("reset") }),
  z.object({ kind: z.literal("get") }),
]);

const COUNTER_FILE = "counter.json";
const DEFAULT: Counter = { value: 0 };

export default definePlugin(({ pubsub, files, log }) => {
  // Serialise read-modify-write so two parallel \`increment\` calls
  // don't both read the same snapshot and silently drop one update.
  const withWriteLock = createSerialLock();

  async function read(): Promise<Counter> {
    if (!(await files.data.exists(COUNTER_FILE))) return DEFAULT;
    const raw = await files.data.read(COUNTER_FILE);
    return Counter.parse(JSON.parse(raw));
  }

  async function write(counter: Counter): Promise<void> {
    await files.data.write(COUNTER_FILE, JSON.stringify(counter, null, 2));
    pubsub.publish("changed", counter);
  }

  return {
    TOOL_DEFINITION,

    async incrementCounter(rawArgs: unknown) {
      const args = Args.parse(rawArgs);
      switch (args.kind) {
        case "increment": {
          return withWriteLock(async () => {
            const current = await read();
            const next: Counter = { value: current.value + (args.by ?? 1) };
            await write(next);
            log.info("counter incremented", { from: current.value, to: next.value });
            return { ok: true, counter: next };
          });
        }
        case "reset": {
          return withWriteLock(async () => {
            await write(DEFAULT);
            return { ok: true, counter: DEFAULT };
          });
        }
        case "get": {
          return { ok: true, counter: await read() };
        }
        default: {
          const exhaustive: never = args;
          throw new Error(\`unknown kind: \${JSON.stringify(exhaustive)}\`);
        }
      }
    },
  };
});
`;

const VUE_TS = `// Vue entry — exports the canvas component the host runtime plugin
// loader dynamic-imports as \`dist/vue.js\`.

import View from "./View.vue";
import { TOOL_DEFINITION } from "./definition";

export const plugin = {
  toolDefinition: TOOL_DEFINITION,
  viewComponent: View,
};
`;

const VIEW_VUE = `<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRuntime } from "gui-chat-protocol/vue";
import { useT } from "./lang";

interface Counter {
  value: number;
}

interface DispatchResult {
  ok?: boolean;
  counter?: Counter;
}

export interface Props {
  selectedResult: { counter?: Counter };
}
const props = defineProps<Props>();

const { pubsub, dispatch, log } = useRuntime();
const t = useT();

// Seed from the latest tool result so the first paint matches what
// the LLM call returned, even before the refetch fires.
const counter = ref<Counter>(props.selectedResult.counter ?? { value: 0 });
const busy = ref(false);

async function refetch(): Promise<void> {
  try {
    const result = await dispatch<DispatchResult>({ kind: "get" });
    if (result?.ok && result.counter) counter.value = result.counter;
  } catch (err) {
    log.warn("refetch failed", { error: String(err) });
  }
}

async function increment(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await dispatch<DispatchResult>({ kind: "increment", by: 1 });
    if (result?.ok && result.counter) counter.value = result.counter;
  } catch (err) {
    log.warn("increment failed", { error: String(err) });
  } finally {
    busy.value = false;
  }
}

async function reset(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await dispatch<DispatchResult>({ kind: "reset" });
    if (result?.ok && result.counter) counter.value = result.counter;
  } catch (err) {
    log.warn("reset failed", { error: String(err) });
  } finally {
    busy.value = false;
  }
}

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  void refetch();
  unsubscribe = pubsub.subscribe("changed", () => void refetch());
});

onUnmounted(() => {
  unsubscribe?.();
});
</script>

<template>
  <div class="counter">
    <h1>{{ t.title }}</h1>
    <p class="value">{{ counter.value }}</p>
    <div class="actions">
      <button :disabled="busy" @click="increment">{{ t.increment }}</button>
      <button :disabled="busy" @click="reset">{{ t.reset }}</button>
    </div>
  </div>
</template>

<style scoped>
.counter {
  padding: 1rem;
  font-family: system-ui, sans-serif;
}
.value {
  font-size: 3rem;
  font-weight: 600;
  margin: 1rem 0;
}
.actions {
  display: flex;
  gap: 0.5rem;
}
button {
  padding: 0.5rem 1rem;
  border-radius: 0.25rem;
  border: 1px solid #ccc;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
`;

const LANG_EN = `export default {
  title: "Counter",
  increment: "Increment",
  reset: "Reset",
};
`;

const LANG_JA = `export default {
  title: "カウンター",
  increment: "+1",
  reset: "リセット",
};
`;

const LANG_INDEX = `// Plugin-local i18n. Translation tables travel with the plugin
// bundle. The plugin reads the host's locale via \`useRuntime()\` and
// looks up its own table reactively.

import { computed } from "vue";
import { useRuntime } from "gui-chat-protocol/vue";
import en from "./en";
import ja from "./ja";

const MESSAGES = { en, ja } as const;
type LocaleKey = keyof typeof MESSAGES;

function isSupportedLocale(value: string): value is LocaleKey {
  // Own-property only: a host locale of \`constructor\` / \`toString\` must
  // fall through to \`en\`, not match an inherited Object.prototype member
  // (which would then index MESSAGES to a function and blank every label).
  return Object.hasOwn(MESSAGES, value);
}

export function useT() {
  const { locale } = useRuntime();
  return computed(() => (isSupportedLocale(locale.value) ? MESSAGES[locale.value] : MESSAGES.en));
}
`;

const README = `# ${PLUGIN_NAME_PLACEHOLDER}

MulmoClaude runtime plugin scaffolded with \`create-mulmoclaude-plugin\`.

The included sample is a counter — one tool (\`incrementCounter\`)
with three actions (increment / reset / get), persistent state in
\`files.data\`, pubsub on every mutation, and a Vue View that
reflects changes live across tabs. Use it as a starting point;
rename and reshape as you go.

## Build

\`\`\`bash
yarn install
yarn build
\`\`\`

\`yarn build\` produces \`dist/index.js\` (server entry) and
\`dist/vue.js\` (browser entry) plus matching \`.d.ts\` files.

## Develop against MulmoClaude

For now the smoothest local-development path is \`yarn link\`:

\`\`\`bash
# In this plugin directory:
yarn link

# In the mulmoclaude monorepo:
yarn link ${PLUGIN_NAME_PLACEHOLDER}

# Add the plugin to mulmoclaude's preset list (server/plugins/preset-list.ts)
# or install it via the runtime install UI.

yarn dev   # mulmoclaude
\`\`\`

A first-class "install from local path" workflow is being tracked at
[receptron/mulmoclaude#1159](https://github.com/receptron/mulmoclaude/issues/1159) PR2 / PR3.

When you edit plugin source you need to rebuild
(\`yarn build\` or \`yarn dev\` — \`vite build --watch\`) and ask
mulmoclaude to reload the plugin (restart server is the current
fallback).

## Publish

When the plugin is ready:

\`\`\`bash
npm publish
\`\`\`

## Plugin runtime API

This plugin uses the \`gui-chat-protocol\` v1.2 runtime API:

- \`definePlugin(({ pubsub, files, log }) => ({ TOOL_DEFINITION, [toolName]: handler }))\` —
  factory that receives the runtime itself, so handlers close over the
  destructured pieces and call them bare (no \`runtime.\` prefix).
- \`createSerialLock()\` — returns a \`withWriteLock(fn)\` that runs
  read-modify-write handlers one at a time, so parallel tool calls
  can't overwrite each other's snapshot.
- \`files.data\` — persistent JSON / text under
  \`~/mulmoclaude/data/plugins/<encoded-pkg>/\`. Backup target.
- \`files.config\` — per-machine UI prefs.
- \`pubsub.publish(channel, payload)\` — broadcast to every
  open tab of mulmoclaude. The View calls \`pubsub.subscribe\` to
  refresh when mutations land.
- \`log\` — structured logging that lands in the host's log
  file.
- Browser side: \`useRuntime()\` (from \`gui-chat-protocol/vue\`)
  exposes \`pubsub\`, \`dispatch\` (calls back into the server
  handler), \`locale\`, \`openUrl\`, and \`log\`.

The eslint preset (\`gui-chat-protocol/eslint-preset\`) bans direct
\`node:fs\` / \`node:path\` / \`console\` / \`fetch\` calls — every
I/O goes through the runtime.

## Layout

\`\`\`
src/
  index.ts          server: definePlugin factory, persistent state, pubsub
  definition.ts     TOOL_DEFINITION shared between server + browser
  vue.ts            browser: { toolDefinition, viewComponent }
  View.vue          canvas SFC, useRuntime + dispatch + pubsub.subscribe
  shims-vue.d.ts    Vue SFC type shim for tsc
  lang/
    en.ts           translation table
    ja.ts           Japanese translations
    index.ts        useT() composable that reads runtime.locale
\`\`\`

## License

MIT
`;

export const TEMPLATE_FILES: TemplateFile[] = [
  { path: "package.json", content: PACKAGE_JSON },
  { path: "tsconfig.json", content: TSCONFIG },
  { path: "vite.config.ts", content: VITE_CONFIG },
  { path: "eslint.config.mjs", content: ESLINT_CONFIG },
  { path: ".gitignore", content: GITIGNORE },
  { path: "README.md", content: README },
  { path: "src/index.ts", content: INDEX_TS },
  { path: "src/definition.ts", content: DEFINITION_TS },
  { path: "src/vue.ts", content: VUE_TS },
  { path: "src/View.vue", content: VIEW_VUE },
  { path: "src/shims-vue.d.ts", content: SHIMS_VUE },
  { path: "src/lang/en.ts", content: LANG_EN },
  { path: "src/lang/ja.ts", content: LANG_JA },
  { path: "src/lang/index.ts", content: LANG_INDEX },
];

export function applyPlaceholders(content: string, pluginName: string): string {
  return content.split(PLUGIN_NAME_PLACEHOLDER).join(pluginName);
}
