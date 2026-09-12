// Tests for `server/utils/cli-flags.mjs` — the shared boolean-flag
// registry used by the npm launcher (`bin/mulmoclaude.js`) and the
// server-side env snapshot (`server/system/env.ts`). (#1089.)

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CLI_FLAGS, flagEnvOverrides, cliFlagHelpLines } from "../../server/utils/cli-flags.mjs";

describe("cli-flags CLI_FLAGS registry", () => {
  it("maps each --flag to a SCREAMING_SNAKE env var with a help string", () => {
    for (const { flag, env, help } of CLI_FLAGS) {
      assert.match(flag, /^--[a-z][a-z-]*[a-z]$/, `flag shape: ${flag}`);
      assert.match(env, /^[A-Z][A-Z0-9_]*$/, `env shape: ${env}`);
      assert.ok(help.length > 0, `help non-empty: ${flag}`);
    }
  });

  it("has unique flags and unique env vars (no accidental dup)", () => {
    const flags = CLI_FLAGS.map((entry) => entry.flag);
    const envs = CLI_FLAGS.map((entry) => entry.env);
    assert.equal(new Set(flags).size, flags.length);
    assert.equal(new Set(envs).size, envs.length);
  });

  it("covers exactly the six intended toggles", () => {
    assert.deepEqual(CLI_FLAGS.map((entry) => entry.flag).sort(), [
      "--allow-multiple-instances",
      "--chat-index-force-run",
      "--disable-macos-reminders",
      "--disable-sandbox",
      "--journal-force-run",
      "--persist-tool-calls",
    ]);
  });

  it("never exposes a secret-bearing env var as a flag (ps/history leak)", () => {
    const secrets = new Set(["MULMOCLAUDE_AUTH_TOKEN", "GEMINI_API_KEY", "X_BEARER_TOKEN", "RELAY_TOKEN", "RELAY_URL"]);
    for (const { env } of CLI_FLAGS) assert.equal(secrets.has(env), false, `must not flag-expose ${env}`);
  });
});

describe("cli-flags flagEnvOverrides", () => {
  it("returns an empty object when no flags are present", () => {
    assert.deepEqual(flagEnvOverrides(["--port", "3001", "--no-open"]), {});
  });

  it("maps a single present flag to its env override", () => {
    assert.deepEqual(flagEnvOverrides(["--disable-sandbox"]), { DISABLE_SANDBOX: "1" });
  });

  it("maps multiple present flags regardless of order", () => {
    assert.deepEqual(flagEnvOverrides(["--chat-index-force-run", "foo", "--disable-sandbox"]), {
      CHAT_INDEX_FORCE_RUN_ON_STARTUP: "1",
      DISABLE_SANDBOX: "1",
    });
  });

  it("ignores unknown flags", () => {
    assert.deepEqual(flagEnvOverrides(["--totally-unknown", "--disable-macos-reminders"]), {
      DISABLE_MACOS_REMINDER_NOTIFICATIONS: "1",
    });
  });

  it("does not enable a flag from a substring / partial match", () => {
    assert.deepEqual(flagEnvOverrides(["--disable-sandbox-extra", "disable-sandbox"]), {});
  });
});

describe("cli-flags cliFlagHelpLines", () => {
  it("renders one aligned line per flag", () => {
    const lines = cliFlagHelpLines().split("\n");
    assert.equal(lines.length, CLI_FLAGS.length);
    for (const { flag } of CLI_FLAGS) {
      assert.ok(
        lines.some((line) => line.includes(flag)),
        `help mentions ${flag}`,
      );
    }
  });

  it("pads flags to a common column so help text aligns", () => {
    const width = Math.max(...CLI_FLAGS.map((entry) => entry.flag.length));
    for (const line of cliFlagHelpLines().split("\n")) {
      const match = line.match(/^ {2}(\S+) +(\S.*)$/);
      assert.ok(match, `line shape: ${JSON.stringify(line)}`);
      const [, , helpText] = match;
      assert.ok(helpText !== undefined, `no help text captured: ${JSON.stringify(line)}`);
      assert.equal(line.indexOf(helpText), 2 + width + 2, "help column constant");
    }
  });
});
