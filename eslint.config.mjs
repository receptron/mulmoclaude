import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import sonarjs from "eslint-plugin-sonarjs";
import securityPlugin from "eslint-plugin-security";
import importPlugin from "eslint-plugin-import";
import vuePlugin from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";
import vueI18n from "@intlify/eslint-plugin-vue-i18n";

// sonarjs ships type-aware rules of its own. They sit dormant without a
// TypeScript program, so enabling `projectService` below wakes them — at the
// `error` severity sonarjs's preset sets, on code they had never linted before.
//
// Derived from the plugin's own `requiresTypeChecking` metadata rather than a
// hand-listed set, so a sonarjs upgrade that adds type-aware rules can't
// silently start failing CI. Intersected with what `recommended` actually turns
// on: 14 of the 70 type-aware rules are `off` there, and naming them here would
// ENABLE them rather than downgrade them (`strings-comparison` alone adds 32
// findings that way). This set is exactly what `projectService` wakes — every
// rule in it is dormant today, so it weakens no gate that currently runs.
const sonarRecommendedRules = sonarjs.configs.recommended?.rules ?? {};
const isEnabled = (level) => {
  const severity = Array.isArray(level) ? level[0] : level;
  return severity !== undefined && severity !== "off" && severity !== 0;
};

const sonarTypeAwareRulesAsWarn = Object.fromEntries(
  Object.entries(sonarjs.rules ?? {})
    .filter(([name, rule]) => rule?.meta?.docs?.requiresTypeChecking && isEnabled(sonarRecommendedRules[`sonarjs/${name}`]))
    .map(([name]) => [`sonarjs/${name}`, "warn"]),
);

export default [
  {
    files: ["{src,test}/**/*.{js,ts,yaml,yml,vue}", "assets/html/js/**/*.js"],
  },
  {
    ignores: [
      // Runtime workspace files the app rewrites while it runs (scheduler
      // state, roles, dashboard, …) when the workspace IS the checkout. The
      // `prettier/prettier` rule below applies to every file, JSON included,
      // and eslint does not read `.gitignore` the way prettier does (#2873).
      "config",
      "lib",
      // Vendored SheetJS CE, kept byte-identical to its CDN tarball so the
      // provenance check in test/agent/test_vendoredSheetjs.ts can hold (#3316).
      "server/vendor",
      "packages/*/dist",
      "packages/bridges/*/dist",
      "packages/plugins/*/dist",
      "packages/services/*/dist",
      // Sample runtime plugin (#1110) — has its own eslint.config.mjs
      // that uses gui-chat-protocol/eslint-preset. The host's much
      // stricter rules (T[] over Array<T>, identifier length, etc.)
      // would force plugin authors to satisfy mulmoclaude conventions
      // they have no reason to know.
      "packages/plugins/bookmarks-plugin",
      // todo-plugin migration (#1145). Same exemption rationale as
      // bookmarks-plugin — has its own eslint config with
      // gui-chat-protocol/eslint-preset enforcing the platform-bypass
      // restrictions.
      "packages/plugins/todo-plugin",
      // mulmoclaude launcher copies server/client/shared src here at
      // publish time. Original sources are linted at their real paths.
      "packages/mulmoclaude/client",
      "packages/mulmoclaude/server",
      "packages/mulmoclaude/src",
      // Deliberately-minimal TS snippets that exercise the
      // import-extraction regex in scripts/mulmoclaude/deps.mjs.
      // They're inputs to a parser test, not production code.
      "test/scripts/mulmoclaude/fixtures",
      // esbuild output committed to git (`yarn build:hooks`
      // regenerates from server/workspace/hooks/dispatcher.ts into
      // server/build/). Linting the bundle is meaningless — it's
      // machine-formatted and would force formatter-friendly output
      // options on esbuild for no real win.
      "server/build/**",
    ],
  },
  eslint.configs.recommended,
  sonarjs.configs.recommended,
  securityPlugin.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  ...vuePlugin.configs["flat/recommended"],
  ...vueI18n.configs.recommended,
  {
    // Point `@intlify/vue-i18n/*` rules at the JSON cache generated
    // by `yarn dumpi18n` (which serialises src/lang/*.ts). Without
    // `localeDir`, the plugin can't validate key references and
    // surfaces a global "You need to set 'localeDir'" warning on
    // every lint run.
    settings: {
      "vue-i18n": {
        localeDir: ".i18n-cache/*.{json}",
        messageSyntaxVersion: "^11.0.0",
      },
    },
    rules: {
      // Material Icon ligatures, symbol glyphs, and technical
      // identifiers rendered verbatim in templates (inside
      // <span class="material-icons">, <code>, <kbd>) are not
      // translatable content. Filter them out centrally so real
      // translatable strings remain visible in the lint output.
      "@intlify/vue-i18n/no-raw-text": [
        "error",
        {
          ignoreNodes: ["code", "kbd", "pre", "tt", "v-pre"],
          ignorePattern:
            // snake_case single token → Material Icon name
            // (e.g. "chevron_left", "expand_more", "picture_as_pdf")
            // Also covers short lowercase single-word icon names
            // like "add" / "delete" / "edit" / "save" / "undo".
            "^(?:[a-z]+(?:_[a-z]+)*|↺|✕|‹|›|▲|▼|♪|⚠|📅|📊|☑|✓|○|🔑|📁|99\\+|·\\s*|\\+|:|\\s+)$",
          ignoreText: [
            "MulmoClaude",
            "GEMINI_API_KEY",
            ".env",
            "data/",
            "artifacts/",
            "flat",
            "by-name",
            "by-date",
            "claude mcp",
            "mcp__",
            "--allowedTools",
            "host.docker.internal",
            "/",
            "s",
            "?",
            "(",
            ")",
          ],
        },
      ],
    },
  },
  {
    files: ["**/utils/html_render.ts", "src/utils/dom/**/*.ts", "src/composables/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    languageOptions: {
      globals: {
        ...globals.es2021,
        ...globals.node,
      },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      indent: ["error", 2],
      // Loop iterators (i/j), throwaway (_), and the Result-pattern
      // discriminator (ok) are the only exempted short names. Everything
      // else — fs/os namespace imports, id/md/ms abbreviations, etc. —
      // must be ≥3 chars. Use named imports (e.g. `{ readFileSync }`
      // from "fs") and descriptive locals (`markdown`, `delayMs`,
      // `itemId`) instead.
      "id-length": [
        "error",
        {
          min: 3,
          // Don't flag object property keys — external API payloads
          // legitimately use short keys like `id`, `to`, `n`, `e`.
          properties: "never",
          exceptions: ["_", "i", "j", "ok"],
        },
      ],
      // Catch TDZ-style `use-before-define` (e.g. accessing a `const`
      // before its declaration line). #920. Function declarations are
      // exempt — TS hoists them safely, and top-down narrative-style
      // (`main()` first, helpers below) is a common pattern in the
      // codebase. Runtime type references are exempt via
      // `ignoreTypeReferences` — type position is erased at runtime,
      // so order doesn't affect execution.
      //
      // `typedefs: true` graduated to error after measuring zero
      // violations across the codebase — the codebase already orders
      // type/interface declarations correctly, so the rule is free
      // value going forward (catches future drift without churn).
      "no-use-before-define": "off",
      "@typescript-eslint/no-use-before-define": [
        "error",
        {
          functions: false,
          classes: true,
          variables: true,
          enums: true,
          typedefs: true,
          ignoreTypeReferences: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^__",
          varsIgnorePattern: "^__",
          caughtErrorsIgnorePattern: "^__",
        },
      ],
      "linebreak-style": ["error", "unix"],
      // `==`/`!=` triggers JS coercion (`null == undefined` → true,
      // `"" == 0` → true). `smart` keeps the `x == null` idiom (covers
      // both null and undefined in one check) so existing
      // null-or-undefined guards don't all need to be rewritten.
      // #921.
      eqeqeq: ["error", "smart"],
      "no-throw-literal": "error",
      "no-implicit-coercion": ["error", { boolean: true, number: true, string: true, disallowTemplateShorthand: false }],
      "no-unneeded-ternary": ["error", { defaultAssignment: false }],
      "no-else-return": ["error", { allowElseIf: false }],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-dynamic-delete": "error",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-useless-empty-export": "error",
      "@typescript-eslint/method-signature-style": ["error", "property"],
      "default-case-last": "error",
      "prefer-template": "error",
      "prefer-arrow-callback": "error",
      "arrow-body-style": ["error", "as-needed"],
      "no-multi-assign": "error",
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "no-self-compare": "error",
      "no-unmodified-loop-condition": "error",
      "no-constructor-return": "error",
      "import/no-duplicates": "error",
      "array-callback-return": "error",
      "default-param-last": "error",
      "no-new-wrappers": "error",
      "no-octal-escape": "error",
      "no-proto": "error",
      "no-script-url": "error",
      "no-useless-call": "error",
      "no-useless-concat": "error",
      "no-useless-rename": "error",
      radix: "error",
      "prefer-object-spread": "error",
      "prefer-numeric-literals": "error",
      "prefer-promise-reject-errors": "error",
      "no-lonely-if": "error",
      "no-floating-decimal": "error",
      "no-unused-private-class-members": "error",
      // `require-await` (and the type-checked variant) misfires on
      // Playwright route handlers, Express middleware, and any
      // framework-imposed async contract that returns a Promise
      // without `await`-ing inside. Off — signal-to-noise too low
      // without type information.
      "require-await": "off",
      "no-loop-func": "error",
      "no-new": "error",
      "no-undef-init": "error",
      "no-useless-return": "error",
      "prefer-regex-literals": "error",
      "prefer-exponentiation-operator": "error",
      // CLAUDE.md bans `as` casts outright ("MUST use type guards instead"),
      // but the rule's default `assertionStyle: "as"` only enforces the
      // *syntax*, so the ban was never machine-checked and the codebase
      // accumulated ~190 casts in production code (#2692). `never` is the
      // setting that matches the written rule.
      //
      // `error` since the backlog drained: a new cast now fails CI, which is
      // the whole point — the rule existed in prose for months and the count
      // only ever went up. Tests keep the permissive setting via the test
      // override below; the eight irreducible production casts are listed,
      // one reason each, in the allowlist block at the end of this file.
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/no-require-imports": "error",
      "@typescript-eslint/prefer-enum-initializers": "error",
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-anonymous-default-export": "error",
      "import/no-mutable-exports": "error",
      "import/no-self-import": "error",
      "import/no-useless-path-segments": "error",
      "consistent-return": "error",
      "class-methods-use-this": "error",
      "prefer-destructuring": "error",
      complexity: ["error", { max: 15 }],
      "max-depth": ["error", { max: 4 }],
      "max-params": ["error", { max: 6 }],
      // Ratcheted to `error` so no NEW function can exceed the 50-line
      // budget. Pre-existing violations that resist a behavior-preserving
      // split are pinned to `warn` in the grandfather block at the end of
      // this config (search "max-lines-per-function grandfather"). Drain
      // then delete entries there; do NOT add new files to it — a new
      // over-budget function must be split, not grandfathered.
      // skipBlankLines + skipComments so heavily-documented small
      // functions don't count as "long"; IIFEs kept in so top-level
      // `(() => { … })()` blocks are measured too.
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true, IIFEs: true }],
      quotes: "off",
      "no-shadow": "error",
      "no-param-reassign": "error",
      // "no-plusplus": "error",
      "preserve-caught-error": "off",
      "no-undef": "error",
      "prefer-const": "error",
      "no-return-assign": "error",
      "object-shorthand": "error",
      semi: ["error", "always"],
      "prettier/prettier": "error",
      "no-console": "off",
      "import/no-cycle": "error",
      "sonarjs/no-ignored-exceptions": "error",
      "sonarjs/todo-tag": "off",
      "sonarjs/no-commented-code": "off",
      // The rule has no depth option — it flags any nested ternary.
      // In practice most of our `a ? b : c ? d : e` chains are clean
      // option tables, not obfuscation. Disable rather than warn.
      "sonarjs/no-nested-conditional": "off",
      "sonarjs/cognitive-complexity": "error",
      // `@typescript-eslint/no-unused-vars` already covers this and
      // honours the `^__` ignore pattern (see its options above); the
      // sonarjs version has no configurable options so it can't
      // exempt intentionally-discarded destructuring targets like
      // `const { result: __result, ...rest } = ...`. Disable to avoid
      // double-reporting and to let the `__` convention work.
      "sonarjs/no-unused-vars": "off",
      // MulmoClaude is a local desktop app — spawning claude/docker/git
      // via PATH is normal operation, not a server-side injection risk.
      "sonarjs/no-os-command-from-path": "off",
      "sonarjs/cors": "off",
      // Every no-throw / side-effect-only test has been rewritten to
      // wrap its target call in `assert.doesNotThrow(...)` /
      // `assert.doesNotReject(...)` (batches #1999 + #2001), so the
      // rule no longer creates churn. Promoted to `error` so a new
      // assertion-less test can't slip in unnoticed — reviewers
      // caught them by eye before, CI enforces it now.
      "sonarjs/assertions-in-tests": "error",
      // ── eslint-plugin-security tuning ──────────────────────────
      // Three high-volume rules are disabled because they fire on
      // patterns that are normal in this codebase, drowning the
      // signal-rich rules:
      //   - detect-non-literal-fs-filename: every workspace-aware
      //     `fs.readFile(WORKSPACE_PATHS.foo)` looks "non-literal"
      //     to the rule. WORKSPACE_PATHS is a static constants table,
      //     not user input. Keeping this on produced 527 warnings
      //     and 0 actionable findings on first audit.
      //   - detect-object-injection: any `obj[key]` with a dynamic
      //     key trips it (incl. `arr[i]`, locale-keyed message maps).
      //     Famously high-FP; SonarJS covers the real cases via
      //     `sonarjs/no-built-in-shadow` etc. 329 warnings / 0
      //     actionable on first audit.
      //   - detect-non-literal-regexp: e2e tests build regexps from
      //     testid prefixes — controlled inputs, not attacker-supplied.
      //     27 warnings / 0 actionable.
      // The remaining rules (detect-eval-with-expression, detect-
      // child-process, detect-non-literal-require,
      // detect-pseudoRandomBytes,
      // detect-buffer-noassert, detect-disable-mustache-escape,
      // detect-no-csrf-before-method-override, detect-bidi-characters,
      // detect-new-buffer) stay as warnings — tripwires for future
      // additions, audited at PR review time.
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-object-injection": "off",
      "security/detect-non-literal-regexp": "off",
      // `detect-unsafe-regex` is graduated to error: every legitimate
      // site (currently the two regexes in `src/utils/image/htmlSrcAttrs.ts`)
      // already has a `// eslint-disable-next-line` with a ReDoS-safety
      // rationale and a unit test pinning the bound.
      "security/detect-unsafe-regex": "error",
      // `detect-possible-timing-attacks` graduates with it (#2736, 2026-08-02).
      // Its one finding compared a monotonic render-generation counter, not a
      // secret, and now carries a per-line disable saying so; measured at zero
      // over `src server test e2e e2e-live packages`.
      "security/detect-possible-timing-attacks": "error",
    },
    plugins: {
      prettier: prettierPlugin,
      import: importPlugin,
    },
  },
  {
    // Test & E2E override. Tests legitimately use things that the
    // sonarjs rule set flags as insecure in production code:
    // /tmp directories for fixtures, chmod bits in fs-permission
    // tests, http://localhost in CSRF / CORS tests. And Playwright
    // specs need the full browser global set. Narrow the override
    // to just those categories so no-shadow / cognitive-complexity /
    // no-unused-vars / no-floating-promises etc. stay at `error`
    // across the whole repo — those *do* catch real bugs in tests.
    files: ["test/**/*.{ts,js}", "e2e/**/*.{ts,js}", "e2e-live/**/*.{ts,js}", "packages/**/test/**/*.{ts,js}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "sonarjs/publicly-writable-directories": "off",
      "sonarjs/file-permissions": "off",
      "sonarjs/no-clear-text-protocols": "off",
      // MCP smoke test spawns tsx subprocess — safe in test context.
      "sonarjs/os-command": "off",
      // Playwright / jsdom-style specs commonly use `any`-ish casts
      // against DOM types to build minimal mocks. Keep
      // `no-explicit-any` at `error` in production code; demote to
      // warn inside tests.
      "@typescript-eslint/no-explicit-any": "warn",
      // Test files (describe/it blocks, seed helpers, fixture
      // builders) legitimately have long function bodies. The
      // 20-line target CLAUDE.md sets is for production code
      // readability — it doesn't map onto a describe() block that
      // happens to hold ten it() cases.
      "max-lines-per-function": "off",
      // Tests have a legitimate use for `as` that production code does not:
      // constructing input the types say is impossible, so the runtime guard
      // being tested has something to reject, and handing partial mocks to
      // code that wants a full interface. Writing a type guard to produce
      // deliberately-invalid data defeats the point of the test. Production
      // code stays on `assertionStyle: "never"` (#2692); this restores the
      // rule's default, which still enforces `as` over angle-bracket syntax.
      // The options must be spelled out: flat config keeps the options from
      // the previous match when an override supplies only a severity, so a
      // bare `"error"` here would inherit `never` and ban `as` in tests too.
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "as", objectLiteralTypeAssertions: "allow" }],
    },
  },
  {
    // Vue SFC override — must come AFTER the main rules block so
    // our per-rule overrides actually take effect (flat config's
    // last-match-wins semantics). `vue-eslint-parser` is needed so
    // `<script lang="ts">` is parsed correctly; without it, every
    // type annotation looks like a syntax error.
    files: ["**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        sourceType: "module",
        extraFileExtensions: [".vue"],
      },
      globals: {
        // Vue SFCs run in the browser; add globals so `document`,
        // `MouseEvent`, `HTMLElement`, `FileReader`, `alert`,
        // `window`, etc. aren't flagged as undefined.
        ...globals.browser,
      },
    },
    rules: {
      // MulmoClaude plugin convention: `View` / `Preview` are the
      // canonical component names per plugin directory
      // (`src/plugins/<name>/View.vue`). The Vue-recommended rule
      // against single-word names fights that on purpose.
      "vue/multi-word-component-names": "off",
      // Legitimate v-html usages (sanitised markdown / app-owned
      // HTML) carry per-line eslint-disable comments with a
      // rationale. Promote to error so any new unjustified usage
      // fails CI.
      "vue/no-v-html": "error",
      "vue/no-useless-mustaches": "error",
      "vue/no-useless-v-bind": "error",
      "vue/prefer-true-attribute-shorthand": "error",
      "vue/no-empty-component-block": "error",
      // Same ratchet (#2736, 2026-08-02): the rule's single finding was an
      // optional prop in a `withDefaults` component that already listed a
      // default for every other prop, so the house style was unanimous and the
      // `warn` guarded nothing. Zero findings across every SFC when promoted.
      "vue/require-default-prop": "error",
      // The `as`-cast ban reaches `<script>` only: typescript-eslint's rules
      // never visit the TEMPLATE body, which `vue-eslint-parser` exposes as a
      // separate AST. `@change="…($event.target as HTMLInputElement).value"`
      // was therefore invisible to `consistent-type-assertions` — 18 of them
      // across host and plugin components (#2692). `vue/no-restricted-syntax`
      // is the one rule that does walk that AST, so the same ban is spelled
      // here as a selector. `error` matches the script-side severity; both
      // graduated together once the template backlog reached zero.
      "vue/no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression",
          message: "Do not use any type assertions — narrow in <script> and pass the result to the template.",
        },
      ],
    },
  },
  // Plugin import restrictions — codify the loose-coupling pattern
  // the recent #1141 / #1143 work established. Plugin code under
  // `src/plugins/<name>/` must reach the host only through the
  // documented DI surface (`../api`, META types, scope wrapper); it
  // must NEVER import host-internal config, tool registry, or
  // server modules directly.
  //
  // Scope: plugin directories only. Top-level infra under
  // `src/plugins/{api,scope,metas,index,server,_extras,
  // server-bindings-types,meta-types}.ts` and the codegen output
  // (`_generated/`) are deliberately excluded — they ARE the host's
  // plugin infrastructure and need to import host config.
  //
  // Phase 1 (this rule): block what's already clean inside plugin
  // directories — `src/config/*`, `src/tools/*` (value imports),
  // `server/*`. These three were violation-free as of #1143.
  //
  // Phase 2 (deferred — separate cleanup PR): tighten by also
  // blocking `src/components/*` once the 4 cross-plugin component
  // imports today (textResponse → SentAttachmentChip, manageSource
  // → SourcesManager, wiki → PageChatComposer / FilterChip) have
  // been hoisted into a shared package or moved into the consuming
  // plugin's directory. Locking the door before the cleanup would
  // force the rule's violations into a single PR.
  {
    files: ["src/plugins/*/**/*.ts", "src/plugins/*/**/*.vue"],
    ignores: [
      // The codegen output ships with the bundle but isn't really
      // plugin code — it composes host registries. Excluded.
      "src/plugins/_generated/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // Patterns are picomatch globs evaluated against the
          // import specifier as written. `**/config/**` catches
          // `../config/foo`, `../../config/foo`, `../../../config/sub/bar`
          // — depth-agnostic so a plugin file at any nesting level
          // can't bypass the rule with extra `../` segments (Codex
          // iter-1 #1144). The leading `**` covers every relative
          // depth; the trailing `**` covers nested subpaths under
          // each guarded host directory.
          patterns: [
            {
              group: ["**/config/**"],
              message:
                "Plugin code must not import from `src/config/*`. Use `pluginEndpoints(scope)`, `pluginBuiltinRoleIds()`, or `pluginPageRoute(name)` from `../api` instead — the host wires those at boot via `installHostContext`.",
            },
            {
              group: ["**/tools/**"],
              message:
                "Plugin code must not import value bindings from the host tool registry (`src/tools/*`). Type imports are allowed (`PluginRegistration`, `ToolPlugin`).",
              allowTypeImports: true,
            },
            {
              group: ["**/server/**"],
              message: "Plugin code must not import server-side modules. Plugin executors run client-side; server-side helpers cross the protocol boundary.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  // Storage-virtualization seam (plans/done/refactor-storage-virtualization.md):
  // host + plugin code must read collection records through `storeFor(...)`
  // (the CollectionStore seam), never through the raw io readers — a direct
  // `listItems` / `readItem` import silently bypasses whatever storage
  // backend the collection actually has. Core's own internals import io
  // relatively, so restricting the package specifier leaves them free.
  // `src/plugins/` is excluded: the plugin-boundary block above configures
  // the SAME rule for those files, and flat-config rule configs replace
  // (not merge) — those files can't reach server-only core anyway.
  {
    files: ["server/**/*.ts", "src/**/*.ts", "packages/plugins/**/*.ts"],
    ignores: ["src/plugins/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@mulmoclaude/core/collection/server",
              importNames: ["listItems", "readItem", "writeItem", "deleteItem"],
              message:
                "Access records through `storeFor(collection)` — `.list()`/`.page()`/`.read()`, and `.write()`/`.delete()` (present only on writable stores). The raw io functions bypass the storage seam (plans/done/refactor-storage-virtualization.md).",
            },
          ],
        },
      ],
    },
  },
  // Type-aware pass. `projectService` builds the TypeScript program so rules can
  // reason about real types; that program is the whole cost (measured: five
  // rules cost the same as all 44), and it runs the full scope in ~26s over the
  // untyped pass.
  //
  // Only rules that earn that cost are on. The rest of `strictTypeChecked` was
  // measured across the repo and is dominated by style — `restrict-template-
  // expressions` alone accounts for 439 of its 1213 findings — which would bury
  // the two things type information is actually needed for here:
  //
  //   1. the `any` that `no-explicit-any` structurally cannot see (values from
  //      untyped libraries, `JSON.parse()`, `as unknown as T` double casts)
  //   2. mistakes no syntactic rule can catch at all (a dropped `await`, an
  //      async callback handed to a sync-only API, an object stringified into
  //      "[object Object]")
  //
  // Scoped to source: tests / e2e stay on the untyped pass to keep the program
  // small. Everything is `warn` per docs/lint-policy.md — a backlog to drain,
  // not a gate — so this can never fail CI on its own.
  {
    files: ["server/**/*.ts", "src/**/*.ts", "packages/**/src/**/*.ts"],
    languageOptions: {
      // Single-run mode (auto-on under CI and the eslint CLI) keeps one Program per tsconfig since
      // typescript-eslint 8.72.1, which runs this repo's many tsconfigs out of heap.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname, disallowAutomaticSingleRunInference: true },
    },
    rules: {
      // (1) `any` that survives no-explicit-any.
      // Ratcheted in #2885: the backlog this was waiting on is drained of
      // everything fixable without a cast or a behaviour change. What is left
      // is three families that a rewrite cannot reach, pinned by file in the
      // grandfather block at the end of this file.
      "@typescript-eslint/no-unsafe-assignment": "error",
      // Drained and ratcheted in #2736 (2026-08-02): all four measured ZERO over
      // `src server test e2e e2e-live packages` once their last finding was
      // fixed. Read those counts only after `yarn build:packages` — with
      // `packages/*/dist` missing, every `@mulmoclaude/*` import is an
      // unresolved type and these report ~2700 phantom findings. CI builds
      // packages before both typecheck and lint, so the gate sees the real
      // numbers.
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      // Zero findings today — on to keep it that way.
      "@typescript-eslint/no-unsafe-enum-comparison": "warn",
      "@typescript-eslint/no-unsafe-declaration-merging": "warn",
      // (2) Bugs only the type checker can see.
      // Drained to zero and ratcheted, same as the promise rules above. Every
      // remaining `String(x)` on a possibly-object value is either a real read
      // (now going through a typed helper) or a last-resort fallback carrying an
      // audited eslint-disable with its reason. A new one is a regression, not a
      // warning to file behind 168 others.
      "@typescript-eslint/no-base-to-string": "error",
      // Drained to zero and ratcheted to `error` per docs/lint-policy.md — a
      // dropped `await` or an async callback handed to a sync-only API is a
      // real bug, and the backlog for these three is empty, so there is nothing
      // to grandfather. Re-introducing one now fails CI instead of joining a
      // warning list nobody reads.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // Same backlog treatment for the sonarjs rules this block wakes.
      ...sonarTypeAwareRulesAsWarn,

      // Eight of those woken rules had drained to 1-2 findings each, which is a
      // `warn` guarding nothing. Every finding was triaged in #2736 (2026-08-02)
      // and is now either fixed or carries a per-line disable naming what was
      // checked, so each rule measured ZERO over `src server test e2e e2e-live
      // packages` before promotion. Outside this block sonarjs's own preset
      // already sets them to `error` (dormant with no TS program), so this only
      // closes the gap on typed source — the code they actually run on.
      //
      // `sonarjs/reduce-initial-value` deliberately did NOT graduate. Both of its
      // findings are seedless folds whose sole caller already returns/throws on an
      // empty array, so seeding them bought an unreachable branch and a widened
      // return type. Each site carries a comment naming its upstream guard; the
      // rule stays a `warn` so a genuinely unguarded fold still surfaces.
      //
      // `no-unsafe-assignment` was the last of the five still carrying a backlog
      // (19 findings). #2885 drained it to the sites that need a cast or a
      // behaviour change to move, so it graduated too — with those sites listed
      // in the grandfather block rather than the whole rule left at `warn`.
      //
      // `sonarjs/function-return-type` graduated in the same pass. Its 12
      // findings all live in 8 files where the union return IS the contract
      // (a parser answering `T | null`, a tool handler answering one of several
      // result shapes); narrowing them changes what callers receive, so they are
      // grandfathered by file instead of rewritten.
      "sonarjs/function-return-type": "error",
      "sonarjs/deprecation": "error",
      "sonarjs/argument-type": "error",
      "sonarjs/no-selector-parameter": "error",
      "sonarjs/no-undefined-argument": "error",
      "sonarjs/concise-regex": "error",
      // `sonarjs/no-redundant-optional` left this list — see the repo-wide
      // `off` at the bottom of this file for why the flag invalidates it.
      "sonarjs/no-try-promise": "error",
      "sonarjs/post-message": "error",
      // Same treatment, measured in #2800: zero findings over `src server test
      // e2e e2e-live packages scripts batch config` — the paths `yarn lint`
      // passes, so a wider scope than the six above.
      // It does NOT collide with `no-floating-promises` above, despite both
      // ruling on `void expr` — S3735 returns early on a promise operand, so the
      // `void somePromise()` that rule asks for is never reported. Checked by
      // forcing this rule on a probe: `void syncFn()` reported, `void asyncFn()`
      // not. `src/composables/useContentDisplay.ts` relies on that.
      "sonarjs/void-use": "error",

      // Three of those woken rules are off entirely rather than warned. Each
      // was checked against all of its findings in this repo, and none of them
      // pointed at a bug — the first would have introduced one.
      //
      // `no-alphabetical-sort` wants `localeCompare` on every bare `.sort()`.
      // Its real target is `[10, 9, 1].sort()` returning `[1, 10, 9]`; this
      // repo has no numeric sort like that. What it flags instead is sorting
      // that must stay locale-INDEPENDENT: the Twilio request signature
      // (`Object.keys(params).sort()`, where the server recomputes the same
      // order to verify), frontmatter keys, record ids, ISO-dated filenames.
      // `localeCompare` varies with ICU data and locale, so following the rule
      // makes those non-deterministic — a broken signature, not a fixed sort.
      "sonarjs/no-alphabetical-sort": "off",
      // `prefer-regexp-exec` prefers `re.exec(str)` over `str.match(re)` for a
      // marginal speed win on non-global patterns. It inverts subject and
      // pattern at every call site — `url.match(/status\/(\d+)/)` reads as "does
      // this url match", `/status\/(\d+)/.exec(url)` reads pattern-first — for
      // no correctness difference.
      "sonarjs/prefer-regexp-exec": "off",
      // `no-misleading-array-reverse` catches in-place `.sort()`/`.reverse()` on
      // an array someone else still holds. Every finding here mutates an array
      // the same function just built (`picked`, `removed`, `missing`) or a fresh
      // `readdir` result — nothing is shared, so there is no one to surprise.
      "sonarjs/no-misleading-array-reverse": "off",
      // `different-types-comparison` calls a comparison redundant when the types
      // say it cannot vary. All 17 of its findings here guard a value that IS
      // `undefined`/`null` at runtime and only looks impossible to the checker:
      //   - `record[key] !== undefined` — `noUncheckedIndexedAccess` is off (it
      //     is not part of `strict`), so an index read is typed as the value
      //     type while returning undefined for a missing key.
      //   - `JSON.stringify(v) === undefined` — the lib types say `string`, but
      //     it does return undefined for undefined/function/symbol input.
      //   - `headers.get(name) !== SECRET` — `get()` returns null when absent.
      // Deleting these would strip real guards; the Telegram one is a webhook
      // secret check, and the JSON one is followed by `.length`. The rule's
      // premise only holds once `noUncheckedIndexedAccess` is on — revisit then.
      "sonarjs/different-types-comparison": "off",
    },
  },
  // The eight production casts the `as`-cast ban (#2692) could not remove.
  // Each is here because the assertion is the LEAST bad option at that site,
  // not because nobody got to it — the reasoning also sits at the call site.
  //
  // Listed in config rather than as inline `eslint-disable` comments, per the
  // issue: an allowlist is greppable, reviewable in one place, and cannot be
  // added to without touching this file. **Its cost is granularity** — the
  // rule is off for the whole FILE, so a NINTH cast added to one of these
  // would not be flagged. Keep the entries pointed at small files, and drop
  // an entry the moment its cast goes.
  {
    files: [
      // Widens `Jsonify<T>` to the channel's `JsonObject` at the ONE place
      // that reasoning is allowed to live; eight handlers used to re-argue it.
      "packages/core/src/remote-host/index.ts",
      // `doc.data() as Command`: narrowing it means narrowing the published
      // `onExpire` signature MulmoTerminal also implements.
      "packages/core/src/remote-host/server/hostRunner.ts",
      // Persisted books are deliberately looser than their types (legacy
      // `fiscalYearEnd: "Q1"`); a predicate would lock users out of them.
      "packages/plugins/accounting-plugin/src/server/io.ts",
      // `loadSchedulerItems` / `loadUserTasks` rewrite the file they read, so
      // dropping unrecognised entries here would delete the user's data.
      "server/utils/files/json.ts",
      // `E` is the caller's generic — nothing inside can check it.
      "src/plugins/api.ts",
      // The single claimed step of the aggregator pipeline; the claim itself
      // is checked against every live aggregator by test_meta_aggregation.ts.
      "src/plugins/metas.ts",
      // Proving `ToolDefinition.parameters` means shipping a JSON-Schema
      // validator to the browser for a field nothing on this path reads.
      "src/tools/runtimeLoader.ts",
      // `T` belongs to the plugin; validating the payload is its job.
      "src/utils/plugin/runtime.ts",
    ],
    rules: {
      "@typescript-eslint/consistent-type-assertions": "off",
    },
  },
  // Build + release scripts. `yarn lint` never reached them, so 21 files that
  // CI depends on — the build driver, the launcher sync gate, the npm smoke
  // check — carried no lint at all (#2736).
  //
  // They run on Node at build time over files this repo owns, never over a
  // request, so the rules that are about app-code readability at scale are
  // relaxed here rather than forcing a rewrite of working tooling. Everything
  // that catches a real defect — the `as` ban, unused vars, `prefer-const`,
  // `eqeqeq`, the security tripwires — stays on.
  {
    files: ["scripts/**/*.{ts,mts,mjs,js}", "batch/**/*.ts", "build-config/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node, NodeJS: "readonly" },
    },
    rules: {
      // A build script's audience is whoever is debugging the build, and its
      // shape follows the tool it drives; `main()` reading top-to-bottom is
      // clearer here than the same logic split across six named helpers.
      complexity: "off",
      "sonarjs/cognitive-complexity": "off",
      "max-lines-per-function": "off",
      // `fs`, `os`, `sh`, `pkg` are the idiom in this layer.
      "id-length": "off",
    },
  },
  // `x?: T | undefined` is not redundant under `exactOptionalPropertyTypes`:
  // with that flag on, `x?: T` REJECTS an explicit `undefined` while
  // `x?: T | undefined` accepts it, so the spelling this rule wants removed is
  // the one that says "absent and undefined mean the same thing here". Off
  // repo-wide rather than per-file — every tsconfig sets the flag.
  // Turn it back on if the flag ever comes off.
  {
    rules: { "sonarjs/no-redundant-optional": "off" },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Grandfather lists (#2885). Same contract as `max-lines-per-function`
  // above, and the same rules from docs/lint-policy.md: the rule is `error`
  // everywhere, and only the sites that cannot move without a cast or a
  // behaviour change are pinned back to `warn` HERE, by file, with the reason.
  //
  //   - Never add a file. A new finding must be fixed, not listed.
  //   - Drain, then delete. When a file's findings are gone, remove its entry;
  //     when a block is empty, delete the block.
  //
  // Listed by file rather than left as a rule-wide or directory-wide `warn`
  // precisely so a NEW occurrence in an unlisted file fails CI.
  // ─────────────────────────────────────────────────────────────────────────

  // `no-unsafe-assignment`, three families that a rewrite cannot reach:
  //
  //  (a) `const parsed: T = JSON.parse(...)` / `await res.json()`. `JSON.parse`
  //      is typed `any`, and the repo bans `as`, so the alternatives are a
  //      runtime schema check on every parse — which REJECTS payloads that
  //      pass today — or nothing. These sites already carry the shape they
  //      expect in the annotation; the parse itself is guarded by try/catch.
  //  (b) `Object.create(null)` assigned to a typed `Record`. TypeScript types
  //      `Object.create` as `any`, and the null prototype is load-bearing —
  //      with a plain `{}`, `agg["__proto__"] = v` hits the inherited setter
  //      and the entry vanishes with no collision reported (src/tools/index.ts
  //      came out of the Codex review on #1156).
  //  (c) `req.body` destructuring. Express types it `any`; `requestBodyRecord`
  //      narrows it to `unknown`, but the tiles then have to reach
  //      `writeDashboard` as `DashboardTile[]`, so the honest fix is per-tile
  //      validation — new behaviour, not a typing change.
  {
    files: [
      // (a)
      "packages/core/src/google/fsJson.ts",
      "packages/relay/src/durable-object.ts",
      "packages/relay/src/webhooks/line.ts",
      "packages/relay/src/webhooks/telegram.ts",
      "server/agent/backend/claude-code.ts",
      "server/services/translation/llm.ts",
      "server/utils/files/json.ts",
      "server/workspace/chat-index/summarizer.ts",
      "src/utils/api.ts",
      // (b)
      "src/plugins/metas.ts",
      "src/tools/index.ts",
      // (c)
      "server/api/routes/dashboard.ts",
    ],
    rules: { "@typescript-eslint/no-unsafe-assignment": "warn" },
  },

  // `function-return-type`: the union return IS the contract at these sites —
  // a parser answering `T | null`, a tool handler answering one of several
  // result shapes. Narrowing them changes what every caller receives, so this
  // is a design change per call site, not a lint cleanup.
  {
    files: [
      "packages/core/src/collection/core/deriveAll.ts",
      "packages/core/src/collection/core/where.ts",
      "packages/core/src/collection/registry/registryIndex.ts",
      "packages/core/src/collection/registry/server/registriesConfig.ts",
      "packages/core/src/collection/server/manageTool.ts",
      "packages/core/src/remote-host/index.ts",
      "packages/markdown-utils/src/markdown/mermaidExtension.ts",
      "server/api/routes/roles.ts",
    ],
    rules: { "sonarjs/function-return-type": "warn" },
  },

  // The three regex rules used to be `warn` for the whole of `scripts/**`,
  // which let a genuinely dangerous new pattern in anywhere under that tree.
  // They are `error` there now, with the three remaining files listed:
  //
  //  - `deps.mjs` scans this repo's own TS for import statements. Rewriting
  //    those multi-alternative patterns as a scanner risks the dependency
  //    audit itself, and the input is first-party source rather than a
  //    request, so the backtracking is a build-speed question.
  //  - `launcherSync.mjs` / `check-readme-translations.mjs` are `safe-regex`
  //    FALSE POSITIVES. Measured on the pathological input each pattern is
  //    supposed to blow up on (40,000 chars): every one returns in ~0.1 ms,
  //    i.e. linear. They are listed rather than rewritten because there is
  //    nothing wrong to fix.
  {
    files: ["scripts/mulmoclaude/deps.mjs", "scripts/mulmoclaude/launcherSync.mjs", "scripts/packages/check-readme-translations.mjs"],
    rules: {
      "sonarjs/super-linear-regex": "warn",
      "sonarjs/regex-complexity": "warn",
      "security/detect-unsafe-regex": "warn",
    },
  },

  eslintConfigPrettier,
];
