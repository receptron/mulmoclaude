import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileOps } from "gui-chat-protocol";
import type { OpFailure } from "@mulmoclaude/mulmoscript-plugin/server";
import { parseSuppliedRoot, resolveStoryWriteTarget, type ParsedStoryRoot, type StoryWriteGuards } from "../../../server/api/routes/mulmoScriptWriteRoot.ts";

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

/**
 * A root the way production gets one — through the parser, because nothing else can mint the
 * brand (#3086). A test cannot fake a root any more than a route can, which is the point.
 */
function named(root: string): ParsedStoryRoot {
  const parsed = parseSuppliedRoot(root);
  assert.ok(parsed.ok, `${root} is a legal root spelling`);
  return parsed.root;
}

const DEFAULT_OPS = { id: "default-artifacts" } as unknown as FileOps;
const ACME_OPS = { id: "acme-artifacts" } as unknown as FileOps;

const REFUSED_ROOT: OpFailure = { ok: false, code: "bad_request", error: "this host cannot write to a named root" };
const REFUSED_PATH: OpFailure = { ok: false, code: "bad_request", error: "not a stories path" };

/** Guards that allow everything and hand back one FileOps per root. */
function permissiveGuards(overrides: Partial<StoryWriteGuards> = {}): StoryWriteGuards {
  return {
    guardStoryWriteRoot: () => null,
    guardStoryWirePath: () => null,
    artifactsForRoot: (root) => (root === undefined ? DEFAULT_OPS : root === named("acme") ? ACME_OPS : null),
    ...overrides,
  };
}

describe("resolveStoryWriteTarget — what it permits", () => {
  it("hands back the DEFAULT root's FileOps when no root is named", () => {
    const target = resolveStoryWriteTarget(permissiveGuards(), "stories/a.json", undefined);
    assert.deepEqual(target, { ok: true, artifacts: DEFAULT_OPS });
  });

  it("hands back the NAMED root's FileOps, not the default's — the whole point", () => {
    const target = resolveStoryWriteTarget(permissiveGuards(), "stories/a.json", named("acme"));
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
      named("acme"),
    );
    assert.deepEqual(seen, [{ filePath: "stories/a.json", root: named("acme") }]);
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
      named("acme"),
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
    const target = resolveStoryWriteTarget(permissiveGuards(), "stories/a.json", named("never-registered"));
    assert.deepEqual(target, { ok: false, unregisteredRoot: named("never-registered") });
  });

  it("NEVER falls back to the default root on any refusal — the silent failure this exists for", () => {
    const refusals: StoryWriteTarget[] = [
      resolveStoryWriteTarget(permissiveGuards({ guardStoryWriteRoot: () => REFUSED_ROOT }), "stories/a.json", named("acme")),
      resolveStoryWriteTarget(permissiveGuards({ guardStoryWirePath: () => REFUSED_PATH }), "stories/a.json", named("acme")),
      resolveStoryWriteTarget(permissiveGuards(), "stories/a.json", named("never-registered")),
    ];
    refusals.forEach((target) => {
      assert.equal(target.ok, false);
      assert.equal("artifacts" in target, false, "a refusal must not carry any FileOps at all");
    });
  });
});

type StoryWriteTarget = ReturnType<typeof resolveStoryWriteTarget>;

/**
 * Which root a request NAMED — and the one shape that must not be forgiven.
 *
 * Absent means the default root. A malformed one does NOT: folding it into the default writes to
 * and reads from the default root's identically-named script while the caller believes it named
 * another. That is the defect #3015 fixed at the dispatch entry (`guardSuppliedRoot`), and this
 * PR reintroduced it on the REST transport until round 1 — found independently by Codex and by
 * re-reading `dispatch.ts`, whose comment describes this exact failure.
 *
 * Both directions, because a parser that refuses everything passes the refusal half alone.
 */
describe("parseSuppliedRoot", () => {
  it("reads an absent root as the default", () => {
    assert.deepEqual(parseSuppliedRoot(undefined), { ok: true, root: undefined });
  });

  it("reads an empty string as the default — a query param or JSON field serialised from nothing", () => {
    assert.deepEqual(parseSuppliedRoot(""), { ok: true, root: undefined });
  });

  it("passes a named root through unchanged, including odd but legal ids", () => {
    for (const root of ["acme", "acme-docs", "a", "repo/with/slashes", " leading-space"]) {
      assert.deepEqual(parseSuppliedRoot(root), { ok: true, root }, `${root} is a string and survives`);
    }
  });

  it("REFUSES every present non-string rather than folding it into the default", () => {
    for (const root of [123, 0, null, true, false, ["acme"], [], { id: "acme" }]) {
      const parsed = parseSuppliedRoot(root);
      assert.equal(parsed.ok, false, `a ${Array.isArray(root) ? "array" : typeof root} root must be refused, not defaulted`);
    }
  });

  it("names the type it refused, because an array is what a repeated ?root= actually produces", () => {
    const fromRepeatedQuery = parseSuppliedRoot(["acme", "widgets"]);
    assert.equal(fromRepeatedQuery.ok, false);
    assert.match(fromRepeatedQuery.ok ? "" : fromRepeatedQuery.error, /array/);
    const fromNumber = parseSuppliedRoot(7);
    assert.match(fromNumber.ok ? "" : fromNumber.error, /number/);
  });

  it("never answers ok with a non-string root — the property the callers rely on", () => {
    for (const root of [undefined, "", "acme", 123, null, ["a"], { a: 1 }, true]) {
      const parsed = parseSuppliedRoot(root);
      if (parsed.ok) assert.ok(parsed.root === undefined || typeof parsed.root === "string");
    }
  });
});
