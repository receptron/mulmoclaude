// Tests for the bridge port rules (#3084).
//
// Both directions, because the whole point of the change is the abnormal side:
// before it, a typo ran silently on the default, `=0` was impossible, and
// EADDRINUSE surfaced as an unhandled error naming no env var.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { describeListenError, resolveWebhookPort } from "../src/port.ts";
import { listenWebhook } from "../src/index.ts";

const ENV_VAR = "LINE_BRIDGE_PORT";
const FALLBACK = 3002;

const resolve = (raw: string | undefined) => resolveWebhookPort(raw, FALLBACK, ENV_VAR);

describe("resolveWebhookPort — configured", () => {
  it("a valid port is used as given", () => {
    assert.deepEqual(resolve("3100"), { ok: true, port: 3100 });
  });

  it("0 is accepted — it asks the OS for a free port", () => {
    // The regression that made this issue worth filing: `Number("0") || 3002`
    // read 0 as falsy, so the documented escape hatch was unreachable.
    assert.deepEqual(resolve("0"), { ok: true, port: 0 });
  });

  it("both range bounds are inclusive", () => {
    assert.deepEqual(resolve("65535"), { ok: true, port: 65535 });
    assert.equal(resolve("65536").ok, false);
    assert.equal(resolve("-1").ok, false);
  });
});

describe("resolveWebhookPort — unconfigured", () => {
  it("unset, empty and whitespace-only take the default", () => {
    [undefined, "", " ", "\t\n"].forEach((raw) => {
      assert.deepEqual(resolve(raw), { ok: true, port: FALLBACK }, `expected the default for ${JSON.stringify(raw)}`);
    });
  });
});

describe("resolveWebhookPort — unusable", () => {
  it("a typo is reported, not silently replaced by the default", () => {
    const result = resolve("302a");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /LINE_BRIDGE_PORT="302a"/);
    assert.match(result.message, /0 to 65535/);
    assert.match(result.message, /unset it to use 3002/);
  });

  it("every shape of junk is rejected", () => {
    ["302a", "a302", "99999", "-1", "3002.5", "NaN", "Infinity", "true", "null", "1_000", "３００２", "80@attacker.example", "3002 3003", "[]"].forEach(
      (raw) => {
        assert.equal(resolve(raw).ok, false, `expected rejection for ${JSON.stringify(raw)}`);
      },
    );
  });

  it("the message always names the env var — each bridge has its own", () => {
    ["WHATSAPP_BRIDGE_PORT", "TWILIO_WEBHOOK_PORT", "WEBHOOK_PORT"].forEach((envVar) => {
      const result = resolveWebhookPort("nope", 3009, envVar);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.message.includes(envVar), `${envVar} missing from: ${result.message}`);
    });
  });
});

describe("describeListenError", () => {
  it("EADDRINUSE names the port, the env var, and the =0 way out", () => {
    const message = describeListenError(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }), 3002, ENV_VAR);
    assert.match(message, /Port 3002 is already in use/);
    assert.match(message, /Set LINE_BRIDGE_PORT to a free port/);
    assert.match(message, /LINE_BRIDGE_PORT=0/);
  });

  it("EACCES points at the privileged-port rule", () => {
    const message = describeListenError(Object.assign(new Error("listen EACCES"), { code: "EACCES" }), 80, ENV_VAR);
    assert.match(message, /Port 80 needs elevated privileges/);
    assert.match(message, /LINE_BRIDGE_PORT/);
  });

  it("an unknown failure still names the port and the knob", () => {
    assert.match(describeListenError(new Error("boom"), 3002, ENV_VAR), /Failed to listen on port 3002 \(set LINE_BRIDGE_PORT to change it\): boom/);
  });

  it("a non-Error throw does not become [object Object]", () => {
    assert.match(describeListenError({ message: "weird" }, 3002, ENV_VAR), /weird/);
    assert.doesNotMatch(describeListenError({ message: "weird" }, 3002, ENV_VAR), /\[object Object\]/);
  });
});

describe("listenWebhook", () => {
  const withEnv = async (value: string | undefined, run: () => Promise<void>): Promise<void> => {
    const before = process.env[ENV_VAR];
    if (value === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = value;
    try {
      await run();
    } finally {
      if (before === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = before;
    }
  };

  it("reports the port actually bound, so `=0` prints a usable URL", async () => {
    await withEnv("0", async () => {
      let started: ReturnType<typeof listenWebhook>;
      try {
        const bound = await new Promise<number>((settle, reject) => {
          started = listenWebhook(express(), { envVar: ENV_VAR, fallback: FALLBACK, onFatal: reject }, settle);
        });
        assert.ok(bound > 0 && bound <= 65535, `expected a real ephemeral port, got ${bound}`);
      } finally {
        started?.close();
      }
    });
  });

  it("an unusable value stops the bind — the bridge never listens on the default", async () => {
    await withEnv("302a", async () => {
      const messages: string[] = [];
      const server = listenWebhook(express(), { envVar: ENV_VAR, fallback: FALLBACK, onFatal: (message) => messages.push(message) }, () => {
        throw new Error("onReady must not run for an unusable port");
      });
      assert.equal(server, undefined);
      assert.equal(messages.length, 1);
      assert.match(messages[0] ?? "", /not a usable port/);
    });
  });

  it("EADDRINUSE is explained instead of crashing unhandled", async () => {
    // Both servers listen with NO host argument, the way a bridge does: Node
    // then binds `::` dual-stack. Pinning the first one to "0.0.0.0" instead
    // does NOT collide on macOS — the second bind succeeds on `::` and the
    // test proves nothing (it silently did, before this comment existed).
    const occupied = http.createServer();
    await new Promise<void>((done) => occupied.listen(0, () => done()));
    const address = occupied.address();
    const taken = typeof address === "object" && address !== null ? address.port : 0;
    let attempted: ReturnType<typeof listenWebhook>;
    try {
      await withEnv(String(taken), async () => {
        const message = await new Promise<string>((settle, reject) => {
          attempted = listenWebhook(express(), { envVar: ENV_VAR, fallback: FALLBACK, onFatal: settle }, () => reject(new Error("bind should have failed")));
        });
        assert.match(message, new RegExp(`Port ${taken} is already in use`));
        assert.match(message, /LINE_BRIDGE_PORT/);
      });
    } finally {
      attempted?.close();
      await new Promise<void>((done) => occupied.close(() => done()));
    }
  });
});
