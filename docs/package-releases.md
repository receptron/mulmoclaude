# Package dependencies and what has to be published

This repo publishes ~54 packages to npm from one tree. The question this document
answers is the one that keeps being answered wrong: **I changed something — what do I
have to publish, and does the user actually get it?**

Three incidents are why it exists.

- `@mulmoclaude/markdown-utils@1.3.1` shipped a regex with polynomial backtracking. The
  fix (CodeQL #402) landed in the repo and stayed there for days, because nothing said
  "this package now differs from what npm serves". Every npm consumer kept running the
  unfixed copy — `core` depends on it at **runtime** rather than bundling it.
- `@mulmoclaude/core@1.8.0` was published without a git tag, so "which commit is this
  version?" had no answer. Reconstructing it needed the published tarball's file list.
- `mulmoclaude@1.4.0` shipped `0.x` caret ranges. A caret does **not** float across
  minors below 1.0, so six days of publishes reached nobody.

---

## The graph

Dependencies flow one way. Nothing below depends on anything above it.

```text
  mulmoclaude  (the launcher — the only package end users install)
       │  depends on 18 internal packages, AND ships the app itself:
       │  files: bin/ client/ server/ src/  ← built app code, via prepack
       ▼
  ┌─────────────────────────────┬──────────────────────────────┐
  │  @mulmoclaude/*-plugin      │  @mulmobridge/<service>       │
  │  accounting, chart,         │  slack, discord, line,        │
  │  collection, google, html,  │  telegram, whatsapp, … (23)   │
  │  markdown, mulmoscript      │                               │
  └──────────────┬──────────────┴───────────────┬───────────────┘
                 ▼                              ▼
        @mulmoclaude/core  (8 dependents)   @mulmobridge/client  (27)
                 │                              │
                 ▼                              ▼
        @mulmoclaude/markdown-utils (3)   @mulmobridge/protocol  (28)
                 │                        @mulmobridge/webhook-runtime (6)
                 ▼                              │
              @mulmoclaude/common  (32 dependents — the widest blast radius)
```

`@receptron/task-scheduler` (2 dependents) and `@mulmobridge/web-push` (1) sit beside
the leaves. `@mulmobridge/chat-service` and `@mulmobridge/mock-server` depend only on
`protocol`.

Regenerate this whenever it looks stale:

```bash
node -e '
const fs=require("fs"),path=require("path");const INT=/^(@mulmoclaude\/|@mulmobridge\/|@receptron\/|mulmoclaude$)/;
const dirs=["packages","packages/bridges","packages/plugins","packages/services"].flatMap(r=>fs.existsSync(r)?fs.readdirSync(r).map(d=>path.join(r,d)):[]);
const rev={};for(const d of dirs){const p=path.join(d,"package.json");if(!fs.existsSync(p))continue;const j=JSON.parse(fs.readFileSync(p));
for(const s of ["dependencies","devDependencies","peerDependencies"])for(const k of Object.keys(j[s]||{}))if(INT.test(k))(rev[k]??=new Set()).add(j.name);}
Object.entries(rev).sort((a,b)=>b[1].size-a[1].size).forEach(([k,v])=>console.log(v.size.toString().padStart(3),k));'
```

---

## What has to be published

### The rule

**Publish the package you changed. Its dependents usually do NOT need republishing.**

Every internal range is a caret on a `1.x` version, and a caret floats across minors and
patches at or above 1.0. A consumer declaring `^1.3.1` installs `1.3.2` the moment it
exists — no republish of the consumer required. That is why the `markdown-utils` fix
reached everyone the instant it was published, without touching `core`.

Two things break that rule:

- **`0.x` versions.** `^0.23.0` means `>=0.23.0 <0.24.0`. A consumer pinned there is
  frozen out of everything after it, which is exactly what `mulmoclaude@1.4.0` did. Keep
  published packages at `1.x` or higher.
- **Bundling.** A dependent that inlines the dependency at build time carries a *copy*,
  so the fix does not reach its users until the dependent is rebuilt and republished.
  Check before assuming:

  ```bash
  npm view <dependent> dependencies          # still a real dependency → floats, fine
  curl -sL "$(npm view <dependent> dist.tarball)" | tar -tz | grep <the-module>
  ```

  `@mulmoclaude/core` keeps `common` and `markdown-utils` as runtime dependencies (they
  are not in its tarball), so fixes there flow through without a core release.

### Publish order — bottom-up, launcher last

When a release spans several packages, publish each dependency **before** anything that
imports it:

```text
@mulmoclaude/common → @mulmoclaude/markdown-utils → @mulmoclaude/core → @mulmoclaude/*-plugin ─┐
@mulmobridge/protocol → @mulmobridge/client → @mulmobridge/<service> ──────────────────────────┤
@mulmobridge/webhook-runtime → the 6 webhook bridges ──────────────────────────────────────────┤
                                                                                               ▼
                                                                              mulmoclaude (launcher)
```

Backwards, you publish a package whose code calls an export npm does not serve yet. It
compiles here — the workspace resolves to the source — and fails for everyone else.

Each step is the same loop: bump → sweep that package's declared ranges → validate →
commit + tag → publish → release notes. Only then start the next package.

### Publish a dependent as well when

- it **imports something the published dependency does not have**. This is the case that
  bites: #2643 moved the runner's outer ring into core, and `server/remoteHost/` began
  importing `startResilientHostRunner` — absent from `@mulmoclaude/core@1.9.0`. Core had
  to ship as `1.10.0`, with the ranges swept, before the launcher could go at all. Here
  the range sweep is load-bearing rather than tidy;
- the range must move across a **major**;
- an already-installed user must get the fix without re-resolving. A caret only helps at
  install time; a lockfile pins what it pins.

### The launcher is the exception that catches people

`mulmoclaude` does not merely depend on the other packages. Its `files` include
`bin/ client/ server/ src/`, filled by `prepack` (`bin/prepare-dist.js`) from this
repo's own `server/` and `src/`. So:

> **Any change to app code — `server/`, `src/` — reaches npm users only through a
> `mulmoclaude` publish.** No amount of package publishing delivers it.

Use `/publish-mulmoclaude` for that, never the generic flow, and never bump the
launcher's `version` in a `chore(release)` commit that publishes something else.

---

## Before publishing anything: what is actually drifting?

A version equal to npm's latest does **not** mean the source matches what shipped. Only
the tag tells you that.

```bash
yarn audit:releases              # every publishable workspace: local / npm / state / detail
yarn audit:releases --code-only  # just the ones needing a decision

# or, for one package by hand
git diff "@scope/name@$(npm view @scope/name version)" HEAD -- packages/<dir>

# the launcher is the exception — its shipped source is not all under its own dir
git diff "mulmoclaude@$(npm view mulmoclaude version)" HEAD -- \
  packages/mulmoclaude server src Dockerfile.sandbox sandbox-entrypoint.sh
```

**The launcher is audited across the repo root too.** `packages/mulmoclaude/server/`
and `src/` are not in git — `prepack` copies them in from the repo root at pack time —
so a diff scoped to `packages/mulmoclaude` sees none of the app code. The audit widens
the launcher's pathspec to the roots `bin/prepare-dist.js` copies (`server`, `src`,
`Dockerfile.sandbox`, `sandbox-entrypoint.sh`); every other workspace stays scoped to
its own directory. Without this the launcher read `clean` while the change only it
could ship sat undelivered (#2827).

`state` is the useful column:

| state | meaning |
|---|---|
| `clean` | nothing that feeds the tarball has changed, judged against **the package's own `files`** plus `src/` and `bin/` (which produce the shipped `dist/`) and README (npm ships it regardless). Tests and tsconfig land here only because no package here lists them in `files` — a package that starts shipping them is classified accordingly |
| `code drift` | unreleased behaviour in something the package ships: `src/` or `bin/` (they become `dist/`), any root listed in its `files`, or README. For the launcher this also covers the repo-root `server/` and `src/` that `prepack` copies in |
| `manifest drift` | a **published** `package.json` field moved — `dependencies`, `exports`, `files`, `bin`, `engines`, … A dependency-range sweep shows up here; it reaches users at this package's next release, so it is a decision, not an emergency |
| `untagged` | published, but no tag, so drift **cannot be measured** — fix the tag first |
| `unpublished` | never went to npm — decide whether it is meant to |
| `error` | the check itself failed (registry unreachable, git failure). Reported rather than silently folded into `clean`, and the command exits non-zero |

A failed lookup is never converted into an audit state. An audit that answers "nothing
to do" when it means "I could not tell" is worse than no audit.

If the diff is empty because **the tag is missing**, that is its own finding: fix it
before relying on the answer. Do not tag the version-bump commit by reflex — it is
often on a feature branch, so it predates other merges the publish actually contained.
Identify the commit from the published tarball instead:

```bash
curl -sL "$(npm view @scope/name@X.Y.Z dist.tarball)" | tar -tz   # which modules are in?
npm view @scope/name time --json                                  # when was it cut?
```

then tag the main-line commit whose tree matches, and say why in the commit or issue.
`@mulmoclaude/core@1.8.0` was tagged this way: the tarball contained
`firestoreSafeResult` but not `presenceBeat`, which placed it exactly at the merge of
PR #2639 rather than at the branch-local bump.

---

## Rules for release PRs

These four rules used to live in `CLAUDE.md`, which now keeps a one-line summary of each and points here.

### `chore(release)` commits — never bump the launcher preemptively

A `chore(release)` commit that publishes a shared workspace package (e.g. `@mulmoclaude/core`, `@mulmoclaude/collection-plugin`) MUST bump only that package's `version` and the launcher's DEP RANGE for it (to keep the `launcherSync.mjs` workspace-lockstep invariant green). It MUST NOT bump the launcher's OWN `version` field — that field is reserved for the `/publish-mulmoclaude` workflow that actually publishes the npm launcher.

Rationale: the launcher-sync gate enforces `launcherRange.lowerBound == workspace.version` for dep ratchet, but it never touches or checks the launcher's OWN `version`. Bumping the launcher preemptively "for tidiness" while skipping the actual npm publish creates a silent drift where `packages/mulmoclaude/package.json` runs ahead of npm's latest — future readers can't tell what the next actual publish should be, and end up either skipping the drafted-but-unpublished identity (leaving numbering gaps) or publishing a version whose intent no longer matches the current code. See #1945 for the pattern that motivated this rule.

When to bump `packages/mulmoclaude/package.json`'s `version`:
- Inside the `/publish-mulmoclaude` flow, right before the actual `npm publish`. That commit becomes the identity of the release.
- Never as part of a `chore(release)` that publishes only shared packages.

### Internal dep ranges — always track the latest published version

Every declared range on a workspace-internal package (`@mulmoclaude/*`, `@mulmobridge/*`, `mulmoclaude`) MUST equal `^<latest version published to npm>`, in **every** `package.json` that declares it — `dependencies`, `devDependencies` and `peerDependencies` alike, in bridges and plugins, not just the launcher.

Whenever you publish a workspace package, sweep every consumer's range to the new version in the same PR.

Rationale: a caret range on a `0.x` package does **not** float across minor versions — `^0.23.0` resolves to `>=0.23.0 <0.24.0`. So a stale range doesn't merely look untidy, it *pins consumers to an old line* and silently withholds everything published since. This is not hypothetical: `mulmoclaude@1.3.0` shipped `@mulmoclaude/core: ^0.23.0` while npm had already served 0.24 through 0.28, so npm-installed users could not receive any of it. The `launcherSync.mjs` gate only checks the launcher, so nothing catches the same drift in the other ~50 workspaces.

To audit before a release:

```bash
# for each internal dep name, compare every declared range against npm's latest
npm view <pkg> version --registry https://registry.npmjs.org/
```

A range update reaches users only through that consumer's own next release, so it does not force an immediate republish of all 50 packages — but it MUST be in the tree before the consumer is published next.

### A plugin declares host-provided packages as `peer` + `dev` — never `dependencies`

A `packages/plugins/*-plugin` is always installed **alongside a host** — `mulmoclaude` or
`mulmoterminal` — and both hosts declare `@mulmoclaude/core` themselves. So core is supplied by
the host, and a plugin MUST declare it as:

```jsonc
"peerDependencies":  { "@mulmoclaude/core": "^<latest>" },  // the host must provide it
"devDependencies":   { "@mulmoclaude/core": "^<latest>" }   // so the plugin builds/tests standalone
```

and MUST NOT list it under `dependencies`. Same for anything else the host owns
(`gui-chat-protocol`, `vue`, `echarts` — see the existing `peerDependencies` blocks).

Rationale: `dependencies` makes npm install a **second copy of core nested under the plugin**,
so the plugin and the host each get their own module instance. Anything core keeps in module
state (registries, watchers, caches) then silently exists twice, and the plugin talks to the
copy the host never sees. A peer range instead *fails loudly* when the host is too old, which is
the behaviour you want. `check:launcher-sync` verifies the launcher satisfies these peers
("no peer-dep violations"); nothing catches a wrongly-placed `dependencies` entry, so it is on
you at review time.

`collection-plugin` is the reference shape. When a plugin imports core, moving the entry out of
`dependencies` means **adding** it to `peerDependencies` and `devDependencies` — deleting it
outright leaves an imported package undeclared.

### Tag every publish — no untagged releases

Every `npm publish` of a workspace package MUST be accompanied by a git tag `@scope/name@X.Y.Z` (no `v` prefix) on the published commit, plus a GH release (`--latest=false`). The `/publish` skill does this — do NOT publish by hand and skip the tag.

Rationale: the tag is the ONLY reliable marker of "what commit this npm version was cut from". Answering *"which packages changed since their last release and need republishing?"* is a `git diff <name>@<version> HEAD -- <dir>` — which is impossible when the tag is missing. This is not hypothetical: the `1.0.0` plugins (`@mulmoclaude/*-plugin`) were published to npm without `@…@1.0.0` tags (a bulk `0.x → 1.0.0` re-version), so release-drift detection for them had to fall back to guessing the version-bump commit. `version` in `package.json` == npm's latest tells you it was published, but NOT whether the current source differs from what shipped — only the tag does.

When you discover a past publish that was never tagged, create the tag retroactively on the commit that bumped `version` to the published value (best effort), so future drift detection works.

---

## Release mechanics

`/publish` owns the steps. What it enforces, and why each matters:

| Step | Why |
|---|---|
| version bump + **every declared range swept** to the new version | ranges are the record of intent; a stale one hides which line a consumer was built against |
| commit + tag **before** `npm publish` | publish is irreversible; the tarball must correspond to a tagged commit |
| the launcher takes **two** tags: `vX.Y.Z` (app release, `--latest`) **and** `mulmoclaude@X.Y.Z` (what `audit:releases` reads) | the `v` form is an app-release convention the audit does not know, so a launcher tagged only `vX.Y.Z` reports as `untagged`. `/publish-mulmoclaude` §9b carries the procedure |
| tag `@scope/name@X.Y.Z`, never `vX.Y.Z` | `v` prefixes belong to app releases (`/release-app`) |
| GitHub release with `--latest=false` | a package release must not displace the app's latest |
| `docs/CHANGELOG.md` entry | the only place a reader finds out a package moved and why |

Verify the tarball before publishing, not after — and verify **the tarball**, not the
working tree. `npm pack --dry-run` prints file names only, so grepping `dist/` in the
checkout passes happily for a file that `files` / `.npmignore` excludes. Pack it, extract
it, and look inside:

```bash
cd packages/<dir>
TARBALL=$(npm pack --silent)                  # the real archive, not a listing
UNPACKED=$(mktemp -d /tmp/packcheck.XXXXXX)
tar -xzf "$TARBALL" -C "$UNPACKED" --strip-components=1
grep -r "<a string only the new code contains>" "$UNPACKED"   # the ARCHIVE, not the checkout
```

Grepping `dist/` in the checkout instead would pass for a file that `files` or
`.npmignore` excludes — the check would confirm the build, not the artifact.

A vite-built package emits one bundled `index.js` plus per-module `.d.ts`, so "my new
module is missing from the tarball" is usually wrong — the code is in the bundle. Grep
for a distinctive string rather than looking for a filename. `@mulmoclaude/core@1.9.0`
was checked exactly this way (`"circular reference"`, `"no presence write acknowledged"`,
`presenceStaleAfterMs`), and the same technique identified which commit the untagged
`1.8.0` had been cut from.
