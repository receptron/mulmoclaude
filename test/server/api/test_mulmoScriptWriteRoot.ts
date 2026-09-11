import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileOps } from "gui-chat-protocol";
import type { OpFailure } from "@mulmoclaude/mulmoscript-plugin/server";
import { resolveStoryWriteTarget, type StoryWriteGuards } from "../../../server/api/routes/mulmoScriptWriteRoot.ts";

/**
 * Where a mulmoScript WRITE lands.
 *
 * The failure this covers is silent: the executors resolve a wire path (`stories/…`) against
 * whatever `FileOps` they are handed, and `stories/deck.json` is a perfectly good path in EVERY
 * registered root — so a context built for the wrong one writes into the wrong deck and reports
 * success. Nothing downstream can notice (#3019, and the same hole on the REST transport until
 * #3077).
 *
 * Both directions, because only one of them fails loudly: what it PERMITS (the right FileOps for
 * the named root) and what it REFUSES (each guard, and an unregistered root) — and, above all,
 * that a refusal never degrades into the default root's FileOps.
 */

const DEFAULT_OPS = { id: "default-artifacts" } as unknown as FileOps;
const ACME_OPS = { id: "acme-artifacts" } as unknown as FileOps;

const REFUSED_ROOT: OpFailure = { ok: false, code: "bad_request", error: "this host cannot write to a named root" };
const REFUSED_PATH: OpFailure = { ok: false, code: "bad_request", error: "not a stories path" };

/** Guards that allow everything and hand back one FileOps per root. */
function permissiveGuards(overrides: Partial<StoryWriteGuards> = {}): StoryWriteGuards {
  return {
    guardStoryWriteRoot: () => null,
    guardStoryWirePath: () => null,
    artifactsForRoot: (root) => (root === undefined ? DEFAULT_OPS : root === "acme" ? ACME_OPS : null),
    ...overrides,
  };
}

describe("resolveStoryWriteTarget — what it permits", () => {
  it("hands back the DEFAULT root's FileOps when no root is named", () => {
    const target = resolveStoryWriteTarget(permissiveGuards(), "stories/a.json", undefined);
    assert.deepEqual(target, { ok: true, artifacts: DEFAULT_OPS });
  });

  it("hands back the NAMED root's FileOps, not the default's — the whole point", () => {
    const target = resolveStoryWriteTarget(permissiveGuards(), "stories/a.json", "acme");
    assert.deepEqual(target, { ok: true, artifacts: ACME_OPS });
  });

  it("judges the path AGAINST the root, since the same path is valid in every one", () => {
    const seen: { filePath: unknown; root: string | undefined }[] = [];
    resolveStoryWriteTarget(
      permissiveGuards({
        guardStoryWirePath: (filePath, root) => {
          seen.push({ filePath, root });
          return null;
        },
      }),
      "stories/a.json",
      "acme",
    );
    assert.deepEqual(seen, [{ filePath: "stories/a.json", root: "acme" }]);
  });
});

describe("resolveStoryWriteTarget — what it refuses", () => {
  it("stops at the write-root guard, without asking anything else", () => {
    let pathAsked = false;
    let artifactsAsked = false;
    const target = resolveStoryWriteTarget(
      permissiveGuards({
        guardStoryWriteRoot: () => REFUSED_ROOT,
        guardStoryWirePath: () => {
          pathAsked = true;
          return null;
        },
        artifactsForRoot: () => {
          artifactsAsked = true;
          return DEFAULT_OPS;
        },
      }),
      "stories/a.json",
      "acme",
    );
    assert.deepEqual(target, { ok: false, failure: REFUSED_ROOT });
    assert.equal(pathAsked, false, "a refused root is not asked about its path");
    assert.equal(artifactsAsked, false, "and never reaches a FileOps");
  });

  it("stops at the wire-path guard, without reaching a FileOps", () => {
    let artifactsAsked = false;
    const target = resolveStoryWriteTarget(
      permissiveGuards({
        guardStoryWirePath: () => REFUSED_PATH,
        artifactsForRoot: () => {
          artifactsAsked = true;
          return DEFAULT_OPS;
        },
      }),
      "../escape.json",
      undefined,
    );
    assert.deepEqual(target, { ok: false, failure: REFUSED_PATH });
    assert.equal(artifactsAsked, false);
  });

  it("reports an unregistered root by name instead of writing somewhere else", () => {
    const target = resolveStoryWriteTarget(permissiveGuards(), "stories/a.json", "never-registered");
    assert.deepEqual(target, { ok: false, unregisteredRoot: "never-registered" });
  });

  it("NEVER falls back to the default root on any refusal — the silent failure this exists for", () => {
    const refusals: StoryWriteTarget[] = [
      resolveStoryWriteTarget(permissiveGuards({ guardStoryWriteRoot: () => REFUSED_ROOT }), "stories/a.json", "acme"),
      resolveStoryWriteTarget(permissiveGuards({ guardStoryWirePath: () => REFUSED_PATH }), "stories/a.json", "acme"),
      resolveStoryWriteTarget(permissiveGuards(), "stories/a.json", "never-registered"),
    ];
    refusals.forEach((target) => {
      assert.equal(target.ok, false);
      assert.equal("artifacts" in target, false, "a refusal must not carry any FileOps at all");
    });
  });
});

type StoryWriteTarget = ReturnType<typeof resolveStoryWriteTarget>;
