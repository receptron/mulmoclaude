# fix: sync create-mulmoclaude-plugin's toolchain ranges with the canonical plugin (#3683)

## Problem

`docs/plugin-development.md` requires the scaffold's `PACKAGE_JSON` `devDependencies` to match
`packages/plugins/bookmarks-plugin/package.json`. Six ranges have drifted below it
(`@vitejs/plugin-vue`, `vite`, `vite-plugin-dts`, `vue`, `vue-tsc`, `zod`).

## Change

Raise those six ranges in `packages/create-mulmoclaude-plugin/src/template.ts` to the canonical values.
Nothing else in the template changes (`typescript` already matches; `eslint`, `typescript-eslint` and
`vue-eslint-parser` are not in the canonical manifest).

Add `packages/create-mulmoclaude-plugin/test/test_toolchain_sync.ts`, which reads both manifests and fails when
any devDependency they share differs in range, or when a documented toolchain dep is missing from either side
(`gui-chat-protocol` exempt — see Out of scope). The rule was documentation-only, which is how the drift happened.

## Verification

Build the CLI, scaffold a plugin into a scratch directory, `yarn install`, then `build` / `typecheck` /
`lint` the generated plugin, and confirm the installed versions satisfy the new floors. The package's
own tests (`yarn workspace create-mulmoclaude-plugin test`) and typecheck. For the new test: the pre-PR template,
a canonical-only bump, and a dep removed from the template must each turn it red.

## Out of scope

`gui-chat-protocol` `^1.2.0` (template) vs `^2.1.0` (canonical) — a major difference outside the
documented toolchain sync; separate decision.
