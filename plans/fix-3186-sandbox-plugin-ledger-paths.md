# fix(sandbox): translate the Claude plugin ledger's host paths for the container (#3186)

## Symptom

With the Docker sandbox on, **every** installed Claude Code plugin is inert — skills,
slash commands, MCP servers and hooks all absent, with no error or warning. Reported
by @kusui26 in #3186; it is also the real cause of #3175's "`Skill` invocations = 0",
which #3184 hypothesised but could not confirm.

## Root cause

`dockerBindMountArgs` mounts the host's Claude config dir at `/home/node/.claude` and
`buildDockerSpawnArgs` sets `HOME=/home/node`. The CLI's two plugin ledgers store
**host absolute paths**:

| file | key |
|---|---|
| `<claudeConfigDir>/plugins/known_marketplaces.json` | `installLocation` |
| `<claudeConfigDir>/plugins/installed_plugins.json` | `installPath` |

Neither path exists under the container's `HOME`, so every marketplace resolves as
`cache-miss` and every plugin with it. Nothing translates the prefix — the sandbox
already does the equivalent for `localhost` → `host.docker.internal`.

Both files must be translated. The reporter measured that either one alone leaves the
agent without plugins, and that `claude plugin list` reporting `enabled` does **not**
mean the agent received anything — the success signal is the `init` event.

## Verification method (used throughout)

A synthetic marketplace + plugin carrying all four plugin surfaces (slash command,
skill, `SessionStart` hook, dependency-free stdio MCP server), installed into an
isolated `CLAUDE_CONFIG_DIR` so the developer's real `~/.claude` is never written.
Ground truth is the same plugin run on the **host**; the container arms are compared
against that, reading the `init` event of
`claude -p --output-format stream-json --verbose`.

## Decision: rewrite the ledgers, do NOT mirror-mount

A second approach was built and measured: mount the host config dir a second time at
its **own host path** inside the container, so the stored paths resolve verbatim. One
`-v`, no rewriting, and it does make plugins load.

It was rejected. It changes the marker the CLI writes into the plugin cache:

| | plugins load | cache marker |
|---|---|---|
| host (ground truth) | yes | `.in_use` |
| mirror mount (`:ro` and rw alike) | yes | `.orphaned_at` |
| ledger rewrite | yes | `.in_use` — matches the host |

`.orphaned_at` is the CLI's "this cache entry may be swept" marker: the real config dir
carries `.last_inuse_sweep`, `.in_use` on every current install, and `.orphaned_at` only
on a superseded version. Mirror-mounting leaves the ledger pointing outside the CLI's own
cache root, so the in-cache copy reads as unreferenced — which would hand the user's live
plugins to the sweeper on the **host**. Loading the plugins is not worth that.

The rewrite also works on Windows, which the mirror cannot: a Windows-shaped mount target
is rejected outright and takes the whole `docker run` down with it.

## Approach

1. **`server/agent/pluginLedgerPaths.ts` — pure, no fs.**
   - `toContainerConfigPath(hostConfigDir, value, sep)` → the container spelling, or
     `null` when the value is not ours to touch. `sep` is a parameter so the Windows
     rule is assertable from a POSIX runner (the discipline `toPosixRelPath` already
     established here).
   - Only a value **under the config dir** and **free of `.` / `..` segments** is
     rewritten — the line #3184 drew. Windows compares case-insensitively.
   - `rewriteKnownMarketplaces` / `rewriteInstalledPlugins` walk the two shapes through
     type guards and return new objects.
   - **An entry that cannot be rewritten is left verbatim, never dropped.** Dropping it
     would uninstall a plugin; leaving it reproduces exactly today's behaviour for it.
2. **`server/agent/pluginLedgerMount.ts` — the fs half.** Reads both ledgers (skipping a
   missing one, the no-plugins case), rewrites, writes session-scoped copies under
   `tmpdir()` with `writeFileAtomicSync`, returns the two `-v … :ro` pairs. Returns no
   mounts when there is nothing to translate.
3. **`server/agent/backend/claude-code.ts`** splices those args in beside
   `refDirArgs` — the channel reference dirs already use. The overlay must come after
   the `.claude` directory mount, which that ordering gives.

Keeping the two copies `:ro` is deliberate: it also stops the container writing
container-shaped paths back into the host's ledger.

## Not fixed here (state in the PR)

- A marketplace added from a local path **outside** the config dir still does not load —
  its tree is not mounted at all. Measured: mirror mount and rewrite fail identically, so
  this is neither caused nor worsened here. Separate issue.
- The `:ro` ledger copies mean an in-container `/plugin install` or marketplace refresh
  cannot update the ledger.

## Tests

`test/agent/test_plugin_ledger_paths.ts` against the pure module: under/outside the
config dir, traversal rejection, the config dir itself, Windows separator and case,
malformed ledger shapes surviving untouched, and entries that cannot be rewritten
surviving verbatim.

End-to-end, the synthetic plugin is driven through the argv the code actually builds and
the `init` event compared against the host baseline.

## Docs

- `packages/core/assets/helps/error-recovery.md` — a section for "plugins are silently
  inert in the sandbox", since the agent reads that file before asking the user anything
  on a tool failure. Bump `@mulmoclaude/core` when `assets/helps/*` changes.
- `docs/claude-docker-boundary.md` — a line on where plugins run.
