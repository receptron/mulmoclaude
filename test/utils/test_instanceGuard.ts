// The rule that stops a second MulmoClaude on one workspace (#3079).
//
// Every branch here decides whether a launch happens, and the failure the guard
// exists to prevent is SILENT — two instances sharing a `.session-token`, with
// plugin views simply never rendering on one of them. So the abnormal inputs
// matter as much as the normal ones: a `.server-port` that is empty, truncated
// mid-write, or left behind by a killed instance must all read as "nobody
// there" rather than stopping a launch that should have happened.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  findLiveInstancePort,
  instanceGuardMessage,
  parsePublishedPort,
  serverPortPathIn,
  SERVER_PORT_FILENAME,
  shouldStopForRunningInstance,
} from "../../server/utils/instance-guard.mjs";
import type { ServerPresence } from "../../server/utils/launcher/detect-server.d.mts";

describe("parsePublishedPort", () => {
  it("reads the value the server publishes, trailing newline included", () => {
    assert.equal(parsePublishedPort("3001\n"), 3001);
    assert.equal(parsePublishedPort("3001"), 3001);
    assert.equal(parsePublishedPort("  3100  \n"), 3100);
  });

  it("accepts the range boundaries", () => {
    assert.equal(parsePublishedPort("1"), 1);
    assert.equal(parsePublishedPort("65535"), 65535);
  });

  it("rejects a port outside the range", () => {
    assert.equal(parsePublishedPort("0"), null);
    assert.equal(parsePublishedPort("65536"), null);
    assert.equal(parsePublishedPort("-1"), null);
  });

  it("rejects an absent or empty file", () => {
    assert.equal(parsePublishedPort(null), null);
    assert.equal(parsePublishedPort(undefined), null);
    assert.equal(parsePublishedPort(""), null);
    assert.equal(parsePublishedPort("   \n"), null);
  });

  it("rejects a value that is not a whole number", () => {
    assert.equal(parsePublishedPort("3001.5"), null);
    assert.equal(parsePublishedPort("not-a-port"), null);
    assert.equal(parsePublishedPort("3001 3002"), null);
    assert.equal(parsePublishedPort("NaN"), null);
    assert.equal(parsePublishedPort("Infinity"), null);
  });

  it("rejects a non-string, which is what a failed read hands it", () => {
    assert.equal(parsePublishedPort(42), null);
    assert.equal(parsePublishedPort({}), null);
  });
});

describe("shouldStopForRunningInstance", () => {
  it("stops when an instance answers and multiples are not allowed", () => {
    assert.equal(shouldStopForRunningInstance({ livePort: 3001, allowMultiple: false }), true);
  });

  it("proceeds when nothing answers", () => {
    assert.equal(shouldStopForRunningInstance({ livePort: null, allowMultiple: false }), false);
  });

  it("proceeds when the user opted in, answered or not", () => {
    assert.equal(shouldStopForRunningInstance({ livePort: 3001, allowMultiple: true }), false);
    assert.equal(shouldStopForRunningInstance({ livePort: null, allowMultiple: true }), false);
  });
});

describe("instanceGuardMessage", () => {
  it("names where the running instance is and both ways out", () => {
    const message = instanceGuardMessage(3001);
    assert.match(message, /http:\/\/localhost:3001/);
    assert.match(message, /MULMOCLAUDE_WORKSPACE_PATH/);
    assert.match(message, /--allow-multiple-instances/);
  });

  // The message is printed from three callers, and one of them is the
  // `yarn wait:backend --reset` step of `yarn dev`. `yarn dev` is a compound
  // `a && b && c` script and yarn appends trailing args to the LAST command only,
  // where `concurrently` silently swallows them — so `yarn dev
  // --allow-multiple-instances` never reaches that guard. Measured, not assumed
  // (Codex review, PR #3107). Leading with the env var is what keeps the advice
  // true from every caller; a message that offered only the flag would be telling
  // `yarn dev` users to run something that does nothing.
  it("leads with the env var, the only opt-in that works from every caller", () => {
    const message = instanceGuardMessage(3001);
    assert.match(message, /MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES=1/);
    const envAt = message.indexOf("MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES=1");
    const flagAt = message.indexOf("--allow-multiple-instances");
    assert.ok(envAt < flagAt, "the env var must be offered before the flag");
    assert.match(message, /NOT `yarn dev`/, "the message must say where the flag does not work");
  });
});

describe("serverPortPathIn", () => {
  it("names the sidecar inside the workspace", () => {
    assert.equal(serverPortPathIn("/tmp/ws"), path.join("/tmp/ws", SERVER_PORT_FILENAME));
  });

  it("mirrors the filename the server actually publishes", () => {
    assert.equal(SERVER_PORT_FILENAME, ".server-port");
  });
});

describe("findLiveInstancePort", () => {
  const reading = (text: string) => async (): Promise<string> => text;
  const answering = (presence: ServerPresence) => async (): Promise<ServerPresence> => presence;

  it("reports the port when a MulmoClaude answers there", async () => {
    const found = await findLiveInstancePort("/ws/.server-port", {
      read: reading("3001\n"),
      probe: answering("mulmoclaude"),
    });
    assert.equal(found, 3001);
  });

  it("probes the port the file names, not a default", async () => {
    const probed: number[] = [];
    await findLiveInstancePort("/ws/.server-port", {
      read: reading("3100\n"),
      probe: async (port: number): Promise<ServerPresence> => {
        probed.push(port);
        return "mulmoclaude";
      },
    });
    assert.deepEqual(probed, [3100]);
  });

  it("reports nothing when the file is gone", async () => {
    const found = await findLiveInstancePort("/ws/.server-port", {
      read: async () => {
        throw new Error("ENOENT");
      },
      probe: answering("mulmoclaude"),
    });
    assert.equal(found, null);
  });

  it("treats a stale file whose port is dead as nobody there", async () => {
    const found = await findLiveInstancePort("/ws/.server-port", {
      read: reading("3001\n"),
      probe: answering("absent"),
    });
    assert.equal(found, null);
  });

  it("treats another app on that port as nobody there", async () => {
    const found = await findLiveInstancePort("/ws/.server-port", {
      read: reading("3001\n"),
      probe: answering("foreign"),
    });
    assert.equal(found, null);
  });

  it("does not probe at all when the file names nothing usable", async () => {
    let probes = 0;
    const found = await findLiveInstancePort("/ws/.server-port", {
      read: reading(""),
      probe: async (): Promise<ServerPresence> => {
        probes += 1;
        return "mulmoclaude";
      },
    });
    assert.equal(found, null);
    assert.equal(probes, 0);
  });

  it("reports nothing when the probe itself throws", async () => {
    const found = await findLiveInstancePort("/ws/.server-port", {
      read: reading("3001\n"),
      probe: async (): Promise<ServerPresence> => {
        throw new Error("socket exploded");
      },
    });
    assert.equal(found, null);
  });
});

// The guard carries its own copy of "what counts as a published port", because
// the launcher runs before tsx and cannot reach the TypeScript one
// (`scripts/lib/devServerPort.ts` → `server/utils/envCoerce.ts`, which is
// deliberately NOT `.mjs` so `env.ts` stays type-checked).
//
// A second opinion about that is #2650 one level down — the dev client watching
// one port while the server bound another — so the copies are pinned to each
// other here rather than left to agree by inspection. If envCoerce's rule
// changes, this goes red instead of the two silently diverging.
describe("parsePublishedPort agrees with the server's own port rule", () => {
  it("matches scripts/lib/devServerPort.ts over a generated corpus", async () => {
    const { parsePublishedPort: reference } = await import("../../scripts/lib/devServerPort.js");

    const corpus: string[] = [
      "",
      " ",
      "   \n",
      "\t",
      "0",
      "1",
      "80",
      "3001",
      "3001\n",
      "  3001  \n",
      "65535",
      "65536",
      "99999",
      "-1",
      "-3001",
      "3001.0",
      "3001.5",
      "1e3",
      "0x1f",
      "+3100",
      "NaN",
      "Infinity",
      "-Infinity",
      "not-a-port",
      "3001 3002",
      "3001abc",
      "null",
      "undefined",
    ];
    // Every integer near each boundary the two rules could disagree about.
    for (const centre of [0, 1, 1024, 65534, 65535, 65536]) {
      for (const delta of [-1, 0, 1]) corpus.push(String(centre + delta));
    }

    let compared = 0;
    for (const raw of corpus) {
      assert.equal(parsePublishedPort(raw), reference(raw), `disagreement on ${JSON.stringify(raw)}`);
      compared += 1;
    }
    // The null case: the guard accepts anything, the reference takes `string | null`.
    assert.equal(parsePublishedPort(null), reference(null));
    compared += 1;

    assert.ok(compared >= 45, `expected a real corpus, compared ${compared}`);
  });
});
