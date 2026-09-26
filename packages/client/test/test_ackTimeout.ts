import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACK_TIMEOUT_MARGIN_MS, DEFAULT_REPLY_TIMEOUT_MS } from "@mulmobridge/protocol";
import { resolveAckTimeoutMs } from "../src/ackTimeout.js";
import { readBridgeEnvOptions } from "../src/options.js";

const SIX_MINUTES_MS = 6 * 60 * 1000;

function resolveCollecting(options: Record<string, string | number | boolean>): { ackTimeoutMs: number; warnings: string[] } {
  const warnings: string[] = [];
  const ackTimeoutMs = resolveAckTimeoutMs(options, (message) => warnings.push(message));
  return { ackTimeoutMs, warnings };
}

describe("resolveAckTimeoutMs", () => {
  it("keeps today's 6 minutes when nothing is configured (or the scrape was opted out of)", () => {
    assert.deepEqual(resolveCollecting({}), { ackTimeoutMs: SIX_MINUTES_MS, warnings: [] });
  });

  it("waits the configured reply limit plus the margin", () => {
    assert.deepEqual(resolveCollecting({ replyTimeoutMs: "1800000" }), { ackTimeoutMs: 1_800_000 + ACK_TIMEOUT_MARGIN_MS, warnings: [] });
  });

  it("reads the value the env scrape produces from BRIDGE_REPLY_TIMEOUT_MS / <TRANSPORT>_BRIDGE_REPLY_TIMEOUT_MS", () => {
    const shared = readBridgeEnvOptions("discord", { BRIDGE_REPLY_TIMEOUT_MS: "600000" });
    assert.equal(resolveCollecting(shared).ackTimeoutMs, 600_000 + ACK_TIMEOUT_MARGIN_MS);
    const specific = readBridgeEnvOptions("discord", { BRIDGE_REPLY_TIMEOUT_MS: "600000", DISCORD_BRIDGE_REPLY_TIMEOUT_MS: "900000" });
    assert.equal(resolveCollecting(specific).ackTimeoutMs, 900_000 + ACK_TIMEOUT_MARGIN_MS);
  });

  it("warns once and falls back to the default for an unusable value — the same fallback the server takes", () => {
    const { ackTimeoutMs, warnings } = resolveCollecting({ replyTimeoutMs: "30m" });
    assert.equal(ackTimeoutMs, DEFAULT_REPLY_TIMEOUT_MS + ACK_TIMEOUT_MARGIN_MS);
    const [warning, ...rest] = warnings;
    assert.deepEqual(rest, []);
    assert.match(warning ?? "", /^\[bridge\] replyTimeoutMs="30m"/);
  });
});
