---
description: Publish the `mulmoclaude` npm package — with dep audit, workspace drift check, tarball test, and cascade publish of stale @mulmobridge/* dependents
---

## Publish MulmoClaude

`mulmoclaude` is a launcher that bundles the whole app into one npm package. Unlike `/publish` (which handles a single self-contained package), this flow has three traps that bit us on 0.1.0:

1. The package's `dependencies` must cover every `import "…"` in `server/` — the root `package.json` isn't shipped, so implicit inheritance doesn't exist.
2. `@mulmobridge/*` workspace packages can drift — local `src/` adds exports without a version bump, so `npm install` resolves to an older published `dist/` that's missing them. All dependents fail at runtime.
3. `prepare-dist.js` runs via `prepack`, so both `npm pack` and `npm publish` invoke it — but you still need `yarn build` first (for `dist/client/`) and `yarn build:packages` if any workspace package was bumped. (Earlier versions used `prepublishOnly`, which npm 10+ no longer fires on `npm pack`, so the §4 tarball test silently shipped a 4-file stub.)

### CI coverage — the first-line defence

**As of PR #669 / #688**, all three traps run automatically on every PR that touches the launcher via `.github/workflows/mulmoclaude_smoke.yaml`, driven by `scripts/mulmoclaude/smoke.mjs`:

- **§1 deps audit** → `scripts/mulmoclaude/deps.mjs` — bare imports + dynamic `import("pkg")` in `server/*.ts` checked against `packages/mulmoclaude/package.json` (including `optionalDependencies` / `peerDependencies`).
- **§2 workspace drift** → `scripts/mulmoclaude/drift.mjs` — local `src/index.ts` value-export lines compared against the **registry-published** dist (fetched from `registry.npmjs.org` + `unpkg`), not `node_modules` — the workspace symlink would otherwise always match.
- **§4 tarball boot** → `scripts/mulmoclaude/tarball.mjs` — `npm pack` + clean install + launcher start with `DISABLE_SANDBOX=1` and a stubbed `claude` CLI + HTTP 200 on `/`.

**Before releasing, the go/no-go is: "latest `MulmoClaude publish smoke` run on `main` is green."** Run the manual steps below only if you need to cover a scenario CI doesn't (e.g. the `--force publish` path, or publishing a cascaded `@mulmobridge/*` dep).

Run every step; a "ready banner + HTTP 200" in /tmp is the go/no-go for the manual fallback.

### 0. Preconditions

- On a branch (never main), clean working tree or deliberate uncommitted changes only.
- Logged in: `npm whoami`.

```bash
git status
npm whoami
```

### 1. Dependency audit (catches "ERR_MODULE_NOT_FOUND at runtime")

CI runs this on every PR. To reproduce locally:

```bash
node scripts/mulmoclaude/deps.mjs
```

The script walks `server/**/*.ts`, extracts every bare `import`/`export`-from specifier AND every literal `import("pkg")` dynamic import, and compares against the union of `dependencies` + `optionalDependencies` + `peerDependencies` in `packages/mulmoclaude/package.json`. Exit 0 when clean; exit 1 + one-line-per-missing-package on failure. Built-ins are pulled from `node:module`'s `builtinModules` so they track whatever Node version you're running.

For each missing package, read the root `package.json` for the version and add it to `packages/mulmoclaude/package.json`. Use `optionalDependencies` when the import has a `try/catch` fallback (e.g. native modules that may fail to build) — `node-pty` in `server/system/credentials.ts` is the canonical example.

### 2. Workspace drift check (catches "X does not provide an export named Y")

If local `packages/<name>/src/` has more value-exports than the already-published `dist/`, consumers installing mulmoclaude from the registry will resolve the stale dist at runtime and crash with `does not provide an export named X`.

CI runs this on every PR. Reproduce locally:

```bash
node scripts/mulmoclaude/drift.mjs            # PR mode — pending-publish is a note
node scripts/mulmoclaude/drift.mjs --release  # release mode — pending-publish FAILS
```

**Use `--release` when you are actually publishing.** A package bumped but not yet
published is fine on an ordinary PR — the bump is the acknowledgement, and blocking would
stop a PR that did the right thing while the cascade publish is pending. At publish time
it is the blocker itself: the launcher declares `^<that version>`, whose lower bound is
not on the registry, so `npx mulmoclaude@<next>` fails with ETARGET (#3099).

The script fetches each `@mulmobridge/<name>`'s `latest` dist-tag from `registry.npmjs.org`, pulls the entry file from `unpkg`, and compares its value-export line count against `packages/<name>/src/index.ts`. **Comparing against `node_modules/@mulmobridge/<name>/dist/` would miss the problem** — that path is a yarn workspace symlink into `packages/<name>/`, so `yarn build:packages` rebuilds it from the current src and `src == dist` always.

Output uses a `→ published v<X.Y.Z>` suffix to name both sides; a `⚠` prefix is the signal the package needs a bump + republish before mulmoclaude can be published.

For each drifted package:

```bash
# Bump in that package's package.json, then:
yarn install
yarn build:packages
cd packages/<name> && npm publish --access public --registry https://registry.npmjs.org/
# Tag + GitHub release: see §7.
```

> MUST pass `--registry https://registry.npmjs.org/` on every `npm publish`
> below. The environment's default registry is a private mirror, so
> without it the package publishes to the wrong registry (or fails auth).

Update mulmoclaude's refs to the new versions. If `chat-service` depends on `protocol`, bump its dep there too.

### 3. Build

```bash
yarn install         # picks up any new deps from §1
yarn build           # builds workspace packages AND dist/client (Vite)
```

### 3.5. README content check (catches "npm-shown README is stale")

`packages/mulmoclaude/README.md` is the file npm displays on the package page. It is hand-curated, NOT auto-copied from the repo root README — so every release should re-read it against what's actually shipping. Run BEFORE §4 / §6.

Open `packages/mulmoclaude/README.md` and verify each of:

- **Features added since the last release** are reflected (collections / Discover / Contribute, Marp slides, sandbox credential flags, new bridges, voice input, plugin authoring, etc.) — at least a one-line mention each.
- **Removed / renamed features** no longer appear (don't ship `npx mulmoclaude --old-flag` examples after the flag was renamed).
- **CLI flags** in the "Options" table match `bin/mulmoclaude.js` exactly. Diff: `grep -E "^  --" packages/mulmoclaude/bin/mulmoclaude.js | head -20`.
- **Env vars** (`MULMOCLAUDE_AUTH_TOKEN`, `SANDBOX_FORWARD_SSH_AGENT`, `SANDBOX_MOUNT_CONFIGS`, `GEMINI_API_KEY`, `DISABLE_SANDBOX`) match the launcher's behaviour.
- **Bridge npm names** (`@mulmobridge/<x>`) match what's currently published. New bridges added since last release? Add them. Drop any deprecated.
- **Length** is in the right zone — the file is a focused npm landing page, not a full developer guide. Don't paste in the full repo README (~700 lines today). Target: ~150-200 lines; defer the rest to `docs/` in the repo via links.

When in doubt about a feature's npm-user relevance, default to including a short mention with a "see docs/<file>.md" link rather than a full how-to.

The README is shipped via `package.json`'s standard inclusion — no explicit `files: [...]` entry needed for it. Confirm it's in the tarball:

```bash
cd packages/mulmoclaude && npm pack --dry-run 2>&1 | grep -E "README" | head -3
# expect: npm notice <kB> README.md
```

### 4. Local tarball test — verified by CI on every PR, rerun locally when needed

`prepare-dist` runs via `prepack`, so `npm pack` exercises the exact same flow `npm publish` would. CI runs the full pack → clean install → boot → HTTP 200 probe on every PR; before releasing, confirm the latest `MulmoClaude publish smoke` run on `main` is green.

To reproduce locally (e.g. when debugging a CI failure):

```bash
node scripts/mulmoclaude/smoke.mjs   # all three stages: deps, drift, tarball
# — or just the tarball step —
node scripts/mulmoclaude/tarball.mjs
```

The one-liner equivalent, if you want to see the launcher boot by hand:

```bash
yarn package
# → packages/mulmoclaude/mulmoclaude-<X.Y.Z>.tgz
# (cleans stale tarballs + runs yarn build + npm pack with prepack hook)

rm -rf /tmp/mc-test && mkdir /tmp/mc-test && cd /tmp/mc-test
npm init -y >/dev/null
npm install /abs/path/to/mulmoclaude-<X.Y.Z>.tgz
./node_modules/.bin/mulmoclaude --no-open --port 3097 &
LAUNCHER=$!
# wait up to 20 s for the ready banner, then probe /
( while ! curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3097/ 2>/dev/null | grep -q 200; do sleep 1; done; echo OK )
kill $LAUNCHER
```

Expected: **`✓ MulmoClaude is ready` banner + `HTTP 200`**. Any ERR_MODULE_NOT_FOUND, export errors, or port crashes → stop and fix before publishing. (If the smoke CI already failed on this PR, the launcher log is attached as an Actions artifact — check there first before reproducing locally.)

### 5. Test-only version rule

When iterating (known-broken 0.1.0 → fixed 0.1.1), keep the published version on a throwaway `0.1.x` line and **don't commit the bumps** until a real test-passed version is confirmed. The `console.log("mulmoclaude X.Y.Z")` string inside `bin/mulmoclaude.js` must match the `package.json` version — update both together (both uncommitted while iterating). Recent versions read `version` dynamically from `package.json`, so only `package.json` needs the bump — confirm with `grep "mulmoclaude \${version}" packages/mulmoclaude/bin/mulmoclaude.js` before touching bin.

### 5.5. Sync the ROOT `package.json` version

The launcher's `packages/mulmoclaude/package.json` version is the identity that ships to npm. But the ROOT `package.json` is the identity `/release-app` tags — and they MUST stay in lockstep so a v0.9.5 GitHub Release always corresponds to `mulmoclaude@0.9.5` on npm (no "which one am I running?" ambiguity).

`/publish-mulmoclaude` bumps ROOT to the same version as the launcher, in the same commit. `/release-app` then just reads root, tags it, and writes CHANGELOG — it does NOT bump root again.

```bash
# Same X.Y.Z as the launcher bump in §5.
node -e "const fs=require('fs');const p='package.json';const d=JSON.parse(fs.readFileSync(p,'utf8'));d.version='<X.Y.Z>';fs.writeFileSync(p, JSON.stringify(d,null,2)+'\n');"
jq -r .version package.json   # → <X.Y.Z>
jq -r .version packages/mulmoclaude/package.json   # must match
```

### 6. Publish

```bash
cd packages/mulmoclaude && npm publish --access public --registry https://registry.npmjs.org/
```

Verify. The verify's `npx` step needs `--registry=https://registry.npmjs.org/` explicitly — the local environment's default registry is a private mirror that lags the public npm registry by a few minutes after a fresh publish, so the plain `npx --yes mulmoclaude@X.Y.Z` fails with `ETARGET / No matching version found` even when npm.org already has it:

```bash
npm view mulmoclaude version --registry https://registry.npmjs.org/
rm -rf /tmp/npx-fresh && mkdir /tmp/npx-fresh && cd /tmp/npx-fresh
npx --yes --registry=https://registry.npmjs.org/ mulmoclaude@<X.Y.Z> --version
```

§2's drift check compares source against published `dist/` for four `@mulmobridge/*` packages only — it says nothing about whether a dep's *version* was ever published at all, in either scope. That gap is what this step covers: before publishing the launcher, verify every internal dep in `packages/mulmoclaude/package.json`'s `dependencies` (both `@mulmoclaude/*` and `@mulmobridge/*`) resolves on the public registry:

```bash
yarn check:published-deps   # node scripts/mulmoclaude/publishedDeps.mjs
```

It reads every `@mulmoclaude/*` / `@mulmobridge/*` the launcher declares — in
`dependencies`, `optionalDependencies` and `peerDependencies` alike — finds each one's
workspace manifest by READING the `name` fields rather than guessing a path from the
package name (the workspace is not flat: `@mulmoclaude/core` is `packages/core`, only the
plugins live under `packages/plugins/`), and asks the registry whether that exact version
is published. Exit 1 on anything unpublished; an unreachable registry is reported and does
NOT block, because a flaky network is not evidence of an unpublished version.

This replaces the hand-run shell loop that used to live here — the one that caught the
`@mulmobridge/client` 1.1.0-vs-1.0.2 blocker on 1.16.0, which every automated gate had
passed (#3099).

### 7. Tag + GitHub release for cascade-bumped @mulmobridge/* / @mulmoclaude/* packages

§7 covers ONLY the shared packages that got bumped + published in §2 / §6 (the `@mulmobridge/*` and `@mulmoclaude/*` scoped packages). They each get a `--latest=false` package release. The app-level `mulmoclaude` release is separate and **mandatory** — see §9.

```bash
# Per bumped package:
git tag "@mulmobridge/<name>@<X.Y.Z>"
git push origin "@mulmobridge/<name>@<X.Y.Z>"
gh release create "@mulmobridge/<name>@<X.Y.Z>" \
  --generate-notes --latest=false \
  --title "@mulmobridge/<name>@<X.Y.Z>" \
  --notes "$(cat <<'EOF'
## Highlights

- <what changed — one or two bullets>

📦 **npm**: [`@mulmobridge/<name>@<X.Y.Z>`](https://www.npmjs.com/package/@mulmobridge/<name>/v/<X.Y.Z>)

---

EOF
)"
```

`--latest=false` is mandatory for package releases so they don't displace the latest `vX.Y.Z` app release.

### 8. Commit + PR (version bumps + CHANGELOG)

Commit the real (non-test) version bumps + dep additions **and the §9 CHANGELOG entry**, push to a feature branch, open a PR. Never push directly to main. **The root `package.json` bump from §5.5 MUST be part of this commit** so the app release reads the correct version straight away.

```bash
git add package.json \
        packages/protocol/package.json packages/chat-service/package.json \
        packages/mulmoclaude/package.json packages/mulmoclaude/bin/mulmoclaude.js \
        docs/CHANGELOG.md \
        yarn.lock
git commit -m "chore(mulmoclaude): bump launcher + root to X.Y.Z"
git push -u origin <branch>
gh pr create --title "..." --body "..."
```

### 9. App GitHub release (`vX.Y.Z`) + CHANGELOG — mark **latest**

A launcher publish is not done until it has a visible, changelog-backed `latest` release. Fold this in here (don't defer to a separate `/release-app` run) so `npx mulmoclaude@X.Y.Z` always corresponds to a `vX.Y.Z` release + CHANGELOG entry.

**MUST run `date +%Y-%m-%d`** for the release date — never guess it.

**9a. CHANGELOG** (write it as part of the §8 PR). Prepend a `## [X.Y.Z] - YYYY-MM-DD` section to `docs/CHANGELOG.md`, right below `## [Unreleased]`, in the app-release format:
- a one-line **bold tagline**,
- a `### Highlights` block with `#### <feature> (#issue, #pr)` subsections,
- a closing `Ships \`@mulmoclaude/core@<v>\`, …` line naming every scoped package version this launcher pulls in.

That last line is thirteen hand-typed `name@version` strings, so verify it rather than
trusting the retype — and note it answers "which versions does this launcher pull in?",
NOT "what did we publish this week" (1.9.0 and 1.10.0 used it for the latter, which is
why the check exists):

```bash
yarn check:changelog-ships   # compares the [X.Y.Z] Ships line against the launcher's deps
```

**9a-bis. Re-check the window between cutting the branch and merging it.** The section is written from the PRs merged as of the moment the release branch is cut — but `main` keeps moving while the release PR sits in CI and review, and everything that lands in that window ships in this release too. Run this after the §8 PR merges and BEFORE tagging:

```bash
BRANCH_POINT=$(git merge-base origin/main <release-branch>)   # or the bump commit's parent
git log --merges --oneline "$BRANCH_POINT"..origin/main
```

Read every PR it lists and fold the user-visible ones into the `## [X.Y.Z]` section with a follow-up docs PR. Release-plumbing and dependency-bump PRs need no entry; a behaviour change does. This is not hypothetical — 1.5.0 was one merge away from shipping without the fix for its most-reported symptom (#2563, browser translation breaking every icon glyph), because that PR landed in exactly this window.

**9b. Tag + release at the merged bump commit.** After the §8 PR merges, tag `main` (the tag MUST point at the commit whose root `package.json` is `X.Y.Z`):

```bash
git checkout main && git pull
git tag "vX.Y.Z"
git push origin "vX.Y.Z"        # release-flow exception to no-direct-push — confirm with the user first
LAST=$(git tag -l 'v*' --sort=-v:refname | sed -n 2p)   # previous app tag, for the compare link
gh release create "vX.Y.Z" --repo receptron/mulmoclaude --latest \
  --title "vX.Y.Z — <short description>" \
  --notes "$(cat <<'EOF'
## Highlights

### <Feature>

<one or two paragraphs — reuse the 9a CHANGELOG highlights>

## Full Changelog

See [CHANGELOG.md](https://github.com/receptron/mulmoclaude/blob/main/docs/CHANGELOG.md#xyz---yyyy-mm-dd).
EOF
)"
```

`--latest` is **mandatory** here — the opposite of §7's `--latest=false`. The app release is the version users see as current; only ONE release carries `latest`, and it is this one. The scoped `@mulmoclaude/*` / `@mulmobridge/*` package releases from §7 MUST stay `--latest=false` so they never displace it.

### Lessons that drove this skill (keep in mind when extending it)

- First publish of `mulmoclaude@0.1.0` crashed with `ERR_MODULE_NOT_FOUND: mulmocast` → §1 exists.
- Reinstall of `@mulmobridge/protocol@0.1.2` returned a build without `GENERATION_KINDS` even though the local source had it → §2 exists.
- `Port 3001 is already in use` silently timed out the ready poll → 0.1.2 added port fallback. If you see similar "ready never fires" reports, check for a port conflict first.
- A test publish on `0.1.x` should never land as a committed version on the branch — §5.
- The earliest §2 shell script compared `node_modules/@mulmobridge/*/dist` against `packages/*/src` — a yarn workspace symlink, so `yarn build:packages` made them identical and the check never fired on CI. Drift must compare against the **registry**-published dist (see `scripts/mulmoclaude/drift.mjs`).
- `npm pack` in npm 10+ no longer fires `prepublishOnly` — a §4 tarball smoke with the old hook would ship a 4-file stub (just `bin/*`). The package now uses `prepack`, which fires on both `npm pack` and `npm publish`. Caught by the smoke workflow's first real CI run.
- Dynamic `import("pkg")` with try/catch is a legit pattern for optional native modules (`node-pty`). The audit flags it anyway; declare the package in `optionalDependencies` to signal intent.
- The launcher's pre-flight refuses to start if `claude --version` fails AND if `~/.claude/*` are absent. CI uses a `claude` stub on PATH + `DISABLE_SANDBOX=1` to bypass both; the smoke only needs the server to serve `/`, no real agent calls.
- `mulmoclaude@0.9.5` failed the §6 `npx` verify with `ETARGET: @mulmoclaude/collection-plugin@^0.7.4` — a prior `chore(release)` had bumped `packages/plugins/collection-plugin/package.json` to 0.7.4 without publishing. The §2 drift check only audits `@mulmobridge/*`, so `@mulmoclaude/*` slipped through. §6 now includes a manual loop over every `@mulmoclaude/*` dep; extend `scripts/mulmoclaude/drift.mjs` to cover them when appetite for the CI change surfaces.
- v0.9.3 release-app tagged root=0.9.3 while `mulmoclaude@0.9.4` was already on npm — one patch of drift that made "which one am I running?" ambiguous. §5.5 (root bump in this flow) exists so the launcher npm version and the `/release-app` tag always match.
