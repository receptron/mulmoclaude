import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRelayBridgeOptions } from "../../server/events/resolveRelayBridgeOptions.js";

// Tiny env-builder so test cases stay readable. Anything passed
// here is the literal env shape the helper is given — no merging
// with `process.env`.
function env(values: Record<string, string | undefined>): Readonly<Record<string, string | undefined>> {
  return values;
}

describe("resolveRelayBridgeOptions — blanket form", () => {
  it("returns empty object when no relevant vars are set", () => {
    assert.deepEqual(resolveRelayBridgeOptions("line", env({})), {});
  });

  it("picks up RELAY_DEFAULT_ROLE and lowerCamels the key", () => {
    assert.deepEqual(resolveRelayBridgeOptions("line", env({ RELAY_DEFAULT_ROLE: "general" })), { defaultRole: "general" });
  });

  it("blanket fallback applies to any platform when no per-platform override is set", () => {
    const fixture = env({ RELAY_DEFAULT_ROLE: "general" });
    assert.deepEqual(resolveRelayBridgeOptions("line", fixture), { defaultRole: "general" });
    assert.deepEqual(resolveRelayBridgeOptions("whatsapp", fixture), { defaultRole: "general" });
    assert.deepEqual(resolveRelayBridgeOptions("teams", fixture), { defaultRole: "general" });
  });

  it("ignores empty-string env values", () => {
    assert.deepEqual(resolveRelayBridgeOptions("line", env({ RELAY_DEFAULT_ROLE: "" })), {});
  });

  it("ignores undefined env values", () => {
    assert.deepEqual(resolveRelayBridgeOptions("line", env({ RELAY_DEFAULT_ROLE: undefined })), {});
  });
});

describe("resolveRelayBridgeOptions — per-platform overrides", () => {
  it("RELAY_LINE_DEFAULT_ROLE applies to platform=line and not to others", () => {
    const fixture = env({ RELAY_LINE_DEFAULT_ROLE: "line-support" });
    assert.deepEqual(resolveRelayBridgeOptions("line", fixture), { defaultRole: "line-support" });
    assert.deepEqual(resolveRelayBridgeOptions("whatsapp", fixture), {});
    assert.deepEqual(resolveRelayBridgeOptions("teams", fixture), {});
  });

  it("per-platform beats blanket on conflict", () => {
    const fixture = env({
      RELAY_DEFAULT_ROLE: "general",
      RELAY_LINE_DEFAULT_ROLE: "line-support",
      RELAY_WHATSAPP_DEFAULT_ROLE: "sales",
    });
    assert.deepEqual(resolveRelayBridgeOptions("line", fixture), { defaultRole: "line-support" });
    assert.deepEqual(resolveRelayBridgeOptions("whatsapp", fixture), { defaultRole: "sales" });
    assert.deepEqual(resolveRelayBridgeOptions("teams", fixture), { defaultRole: "general" });
  });

  it("normalises dashed platform names to underscored env prefixes", () => {
    const fixture = env({ RELAY_GOOGLE_CHAT_DEFAULT_ROLE: "internal" });
    assert.deepEqual(resolveRelayBridgeOptions("google-chat", fixture), { defaultRole: "internal" });
    // The dashed env name should not be matched (dashes break shells)
    const dashedEnv = env({ "RELAY_GOOGLE-CHAT_DEFAULT_ROLE": "ignored" });
    assert.deepEqual(resolveRelayBridgeOptions("google-chat", dashedEnv), {});
  });

  it("blank platform name returns blanket-only resolution", () => {
    const fixture = env({ RELAY_DEFAULT_ROLE: "general", RELAY_LINE_DEFAULT_ROLE: "line-support" });
    assert.deepEqual(resolveRelayBridgeOptions("", fixture), { defaultRole: "general" });
  });
});

describe("resolveRelayBridgeOptions — reply timeout", () => {
  it("forwards RELAY_REPLY_TIMEOUT_MS, with the per-platform form winning", () => {
    const fixture = env({ RELAY_REPLY_TIMEOUT_MS: "600000", RELAY_LINE_REPLY_TIMEOUT_MS: "1800000" });
    assert.deepEqual(resolveRelayBridgeOptions("line", fixture), { replyTimeoutMs: "1800000" });
    assert.deepEqual(resolveRelayBridgeOptions("teams", fixture), { replyTimeoutMs: "600000" });
  });
});

describe("resolveRelayBridgeOptions — secret / unknown-key allowlist", () => {
  it("does NOT leak RELAY_TOKEN into bridgeOptions", () => {
    const fixture = env({ RELAY_TOKEN: "super-secret-bearer", RELAY_URL: "wss://example.com" });
    assert.deepEqual(resolveRelayBridgeOptions("line", fixture), {});
  });

  it("does NOT leak per-platform unknown keys (e.g. RELAY_LINE_TOKEN if it ever existed)", () => {
    const fixture = env({ RELAY_LINE_TOKEN: "ignored", RELAY_LINE_URL: "ignored" });
    assert.deepEqual(resolveRelayBridgeOptions("line", fixture), {});
  });

  it("RELAY_TOKEN alongside RELAY_DEFAULT_ROLE: only the recognised key is forwarded", () => {
    const fixture = env({ RELAY_TOKEN: "secret", RELAY_DEFAULT_ROLE: "general" });
    assert.deepEqual(resolveRelayBridgeOptions("line", fixture), { defaultRole: "general" });
  });
});

describe("resolveRelayBridgeOptions — defensive edge cases", () => {
  it("ignores unrelated env vars (no RELAY_ prefix)", () => {
    const fixture = env({ NODE_ENV: "test", PORT: "3001", SLACK_BOT_TOKEN: "xoxb-…" });
    assert.deepEqual(resolveRelayBridgeOptions("line", fixture), {});
  });

  it("an env name that is exactly `RELAY_` (no tail) is ignored", () => {
    assert.deepEqual(resolveRelayBridgeOptions("line", env({ RELAY_: "x" })), {});
  });

  it("an env name that is exactly `RELAY_LINE_` (no tail) is ignored", () => {
    assert.deepEqual(resolveRelayBridgeOptions("line", env({ RELAY_LINE_: "x" })), {});
  });
});
