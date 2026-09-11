import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { mulmoScriptOps } from "../../../server/plugins/mulmoscript-server.ts";
import { parseSuppliedRoot, type ParsedStoryRoot } from "../../../server/api/routes/mulmoScriptWriteRoot.ts";

/**
 * The brand's guarantees, asserted where a future change TRIPS OVER them.
 *
 * Everything below is a compile-time claim: `yarn typecheck` covers `test/`, so widening
 * `ParsedStoryRoot` back to a plain string, or making a root optional again, breaks this file.
 * Before it existed the same facts were verified by hand and written into the PR body, where
 * nothing would ever check them again (#3086 round 2, Codex).
 *
 * `@ts-expect-error` is the usual way to pin a negative and this repo forbids it, so the
 * negatives are conditional types instead: `Assert<NotAssignable<string, ParsedStoryRoot>>` fails
 * its own constraint the moment `string` becomes assignable. That is stricter than
 * `@ts-expect-error`, which passes whenever ANY error appears on the line.
 */

/** Compiles only when `T` is exactly `true`. */
type Assert<T extends true> = T;
/** `true` when `A` is NOT assignable to `B`. */
type NotAssignable<A, B> = [A] extends [B] ? false : true;
/** `true` when `A` IS assignable to `B`. */
type Assignable<A, B> = [A] extends [B] ? true : false;

type Ops = typeof mulmoScriptOps;

// ── What must NOT be a root ────────────────────────────────────────────────
// A request value arrives as `string | undefined` after any hand-rolled check, and a literal is
// what a hand-written call site reaches for. Both were accepted before the brand, and each was a
// live defect: #3076 and #3077 found four places that passed one.
type __RawUnionIsNotARoot = Assert<NotAssignable<string | undefined, ParsedStoryRoot>>;
type __RawStringIsNotARoot = Assert<NotAssignable<string, ParsedStoryRoot>>;
type __LiteralIsNotARoot = Assert<NotAssignable<"acme", ParsedStoryRoot>>;

// ── What MUST be one ──────────────────────────────────────────────────────
// `undefined` is the host's default root and needs no brand — every pre-root caller meant it.
type __UndefinedIsARoot = Assert<Assignable<undefined, ParsedStoryRoot>>;
// And the parser's output is, which is the only way to get one.
type ParsedOutput = Extract<ReturnType<typeof parseSuppliedRoot>, { ok: true }>["root"];
type __ParserMintsARoot = Assert<Assignable<ParsedOutput, ParsedStoryRoot>>;
// A root is still a string underneath, which is what lets the raw ops object be assigned to the
// narrowed type at all — the parameters are checked contravariantly, so the brand may only
// REJECT more, never accept more.
type __ARootIsStillAString = Assert<Assignable<ParsedStoryRoot, string | undefined>>;

// ── The root is REQUIRED, not optional ────────────────────────────────────
// Optional let a caller mean the default root by SILENCE, and an aliased call
// (`const rs = ops.resolveStory; rs(p)`) then compiled and read the default root — invisible to
// the textual sweep this replaced (#3086 round 1, Codex). `length` is the arity: exactly 2 when
// required, `1 | 2` when optional.
type __ResolveStoryDemandsARoot = Assert<Assignable<Parameters<Ops["resolveStory"]>["length"], 2>>;
type __BeatImageDemandsARoot = Assert<Assignable<Parameters<Ops["beatImageOp"]>["length"], 3>>;
type __MovieStatusDemandsARoot = Assert<Assignable<Parameters<Ops["movieStatusOp"]>["length"], 2>>;

// ── The narrowed ops reject a raw root ────────────────────────────────────
// The point of the whole change, stated against the exported object rather than the type alias.
//
// Stated as "what may be PASSED", never as "what function is assignable to this one": parameters
// are contravariant, so `(p: string, root: string | undefined) => never` IS assignable to the
// narrowed signature, and an assertion written that way quietly tests the opposite of its name.
type RootArgument<F extends (...args: never[]) => unknown, I extends number> = Parameters<F>[I];
type __ResolveStoryRejectsARawRoot = Assert<NotAssignable<string, RootArgument<Ops["resolveStory"], 1>>>;
type __BeatImageRejectsARawRoot = Assert<NotAssignable<string | undefined, RootArgument<Ops["beatImageOp"], 2>>>;
type __ParsedRootIsAcceptedAsTheArgument = Assert<Assignable<ParsedStoryRoot, RootArgument<Ops["resolveStory"], 1>>>;

// The same, where the root rides in an options object rather than a position — the shape a
// hand-written list of members missed, and the one `runStoryOp` hid behind for a whole round.
type __RenderBeatRejectsARawRoot = Assert<NotAssignable<string, RootArgument<Ops["renderBeatOp"], 0>["root"]>>;
type __PublishGenerationRejectsARawRoot = Assert<NotAssignable<string, RootArgument<Ops["publishGeneration"], 5>["root"]>>;
type __RunStoryOpRejectsARawRoot = Assert<NotAssignable<string, RootArgument<Ops["runStoryOp"], 1>["root"]>>;

// The factory's own backend is not reachable through the exported ops at all. It is the one
// root-taking surface that cannot be narrowed — `artifactsFor(root: string)` belongs to an object
// this module builds — so it is removed instead, and `artifactsForRoot` answers the same question.
type __BackendIsNotReachable = Assert<NotAssignable<"backend", keyof Ops>>;

describe("the story-root brand", () => {
  it("mints a root only through the parser, and an empty one means the default", () => {
    const named = parseSuppliedRoot("acme");
    assert.deepEqual(named, { ok: true, root: "acme" });
    assert.deepEqual(parseSuppliedRoot(""), { ok: true, root: undefined });
    assert.deepEqual(parseSuppliedRoot(undefined), { ok: true, root: undefined });
    assert.equal(parseSuppliedRoot(["acme"]).ok, false);
  });
});
