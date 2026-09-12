// Shared registry of the boolean CLI flags that mirror an env var.
// Single source of truth for: the launcher's argv→env injection
// (`packages/mulmoclaude/bin/mulmoclaude.js`), the launcher `--help`
// text, and the server-side argv awareness in `server/system/env.ts`.
//
// Kept as plain `.mjs` for the same reason as `dev-plugin-args.mjs` /
// `port.mjs`: the launcher runs BEFORE tsx is wired up, so it can't
// import from a `.ts` file. Sibling `cli-flags.d.mts` carries the
// type declarations.
//
// Each flag is a launch-time boolean toggle that was previously only
// reachable via a `VAR=1` env-var prefix — awkward on Windows
// PowerShell `npx`, in IDE/launcher run configs, and for quick ad-hoc
// debugging. Setting `<flag>` is equivalent to exporting `<env>=1`;
// the env var stays supported in parallel (CI scripts / existing docs
// rely on it). Secret-bearing vars (auth token, API keys) are
// deliberately NOT here — argv is visible via `ps` and shell history,
// so those stay env-only. (#1089 + bundle.)

/** @type {ReadonlyArray<{ flag: string, env: string, help: string }>} */
export const CLI_FLAGS = Object.freeze([
  { flag: "--disable-sandbox", env: "DISABLE_SANDBOX", help: "Run without the Docker sandbox (= DISABLE_SANDBOX=1)" },
  {
    flag: "--disable-macos-reminders",
    env: "DISABLE_MACOS_REMINDER_NOTIFICATIONS",
    help: "Disable the macOS Reminder notification sink (= DISABLE_MACOS_REMINDER_NOTIFICATIONS=1)",
  },
  { flag: "--persist-tool-calls", env: "PERSIST_TOOL_CALLS", help: "Also persist tool_call events to the session jsonl (= PERSIST_TOOL_CALLS=1)" },
  { flag: "--journal-force-run", env: "JOURNAL_FORCE_RUN_ON_STARTUP", help: "Run the journal pass immediately on startup (= JOURNAL_FORCE_RUN_ON_STARTUP=1)" },
  {
    flag: "--chat-index-force-run",
    env: "CHAT_INDEX_FORCE_RUN_ON_STARTUP",
    help: "Run the chat-index pass immediately on startup (= CHAT_INDEX_FORCE_RUN_ON_STARTUP=1)",
  },
  {
    flag: "--allow-multiple-instances",
    env: "MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES",
    help: "Start even when one is already running against this workspace (= MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES=1)",
  },
]);

/**
 * Map present CLI flags to the `{ ENV: "1" }` overrides the launcher
 * merges into the spawned server's env. Pure — caller passes argv in.
 */
export function flagEnvOverrides(argv) {
  const overrides = {};
  for (const { flag, env } of CLI_FLAGS) {
    if (argv.includes(flag)) overrides[env] = "1";
  }
  return overrides;
}

/** Render the aligned `--help` lines for the flag block. */
export function cliFlagHelpLines() {
  const width = Math.max(...CLI_FLAGS.map(({ flag }) => flag.length));
  return CLI_FLAGS.map(({ flag, help }) => `  ${flag.padEnd(width)}  ${help}`).join("\n");
}
