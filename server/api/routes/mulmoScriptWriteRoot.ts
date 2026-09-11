// Which stories root a mulmoScript request NAMES, and — for a write — whether it may land there.
//
// Extracted as a pure decision because it is the one place a wrong answer is silent: the
// executors take a WIRE path (`stories/…`) and resolve it against whatever `FileOps` they are
// given, so a context built for the wrong root writes a named root's script into the DEFAULT
// root's identically-named file and reports success (#3019, and the same hole on this transport
// until #3077). Nothing downstream can notice — `stories/deck.json` is a perfectly good path in
// both roots.
//
// The three steps and their ORDER mirror the package's dispatch handler
// (`createMulmoScriptDispatchHandler` → `saveKind` / `updateKind`), so one update means one thing
// whether it arrived over dispatch or over REST. The guards are injected rather than imported so
// this file can be driven without the plugin runtime.

import type { FileOps } from "gui-chat-protocol";
import type { OpFailure } from "@mulmoclaude/mulmoscript-plugin/server";

/** The three ops primitives this decision needs — injected so the rule is testable alone. */
export interface StoryWriteGuards {
  /** May this host write to that root at all? `null` = yes. */
  guardStoryWriteRoot: (root: ParsedStoryRoot) => OpFailure | null;
  /** Does that wire path belong to that root? `null` = yes. */
  guardStoryWirePath: (filePath: unknown, root?: ParsedStoryRoot) => OpFailure | null;
  /** The artifacts `FileOps` bound to that root, or `null` when it is not registered. */
  artifactsForRoot: (root: ParsedStoryRoot) => FileOps | null;
}

/**
 * The root a request named: absent, or the string it gave, or a refusal.
 *
 * Absent stays the default root; `""` is absent (a query param or JSON field serialised from an
 * empty value). **Present but not a string is REFUSED, not folded into the default** — that fold
 * is the defect #3015 fixed on the dispatch transport, and its comment says why: a host that
 * serialises a root wrongly would write to, and read from, the DEFAULT root's identically-named
 * script while believing it named another. Reading `?root=` twice gives an array, which is
 * exactly that shape arriving by accident.
 */
export type SuppliedRoot = { ok: true; root: ParsedStoryRoot } | { ok: false; error: string };

/**
 * A stories root that HAS been through `parseSuppliedRoot`, or the default root.
 *
 * The brand is what makes the rule a type rather than a convention (#3086). A plain string is no
 * longer assignable where a root is expected, so a request value cannot reach a story op without
 * passing through the parser — and the parser is the one place that refuses a malformed one.
 *
 * That convention had been enforced by a textual sweep, and a review spent five rounds on
 * spellings it missed (a same-file helper, a typed binding, `let root; root = raw;`, …). A
 * textual rule has infinitely many blind spellings; a type has none.
 *
 * `undefined` is a legitimate value and needs no brand: it means the host's default root, which
 * is what every pre-root caller meant.
 */
export type ParsedStoryRoot = (string & { readonly __parsedStoryRoot: unique symbol }) | undefined;

/**
 * The ONLY place a `ParsedStoryRoot` is minted — and a type GUARD, not a cast.
 *
 * A brand is normally minted with `as`, which this repo forbids and its lint enforces. A
 * user-defined predicate says the same thing with a condition the compiler can see, and the
 * condition here is the real one: a named root is a non-empty string that has already been shown
 * to BE a string by the caller below. Every other file gets the brand only by calling
 * `parseSuppliedRoot`.
 */
const isNamedStoryRoot = (value: string): value is string & ParsedStoryRoot => value.length > 0;

export function parseSuppliedRoot(value: unknown): SuppliedRoot {
  if (value === undefined) return { ok: true, root: undefined };
  if (typeof value !== "string") return { ok: false, error: `mulmoScript root must be a string, got ${Array.isArray(value) ? "array" : typeof value}` };
  // An empty string is "no root named" — a query param or JSON field serialised from an empty
  // value — and so is anything the predicate declines, which is the same case by another route.
  return isNamedStoryRoot(value) ? { ok: true, root: value } : { ok: true, root: undefined };
}

export type StoryWriteTarget =
  /** Write here. */
  | { ok: true; artifacts: FileOps }
  /** A guard refused, with the sentence it wrote. */
  | { ok: false; failure: OpFailure }
  /** No `FileOps` exists for that root — the caller answers 400 naming it. */
  | { ok: false; unregisteredRoot: ParsedStoryRoot };

/**
 * Decide where a write goes.
 *
 * Returns the FileOps to write through, or the refusal — never a default-root fallback, which is
 * the failure this exists to prevent. `root` has already been through `parseSuppliedRoot` above,
 * so only two shapes reach here: `undefined` (the caller named no root, or an empty one) and a
 * non-empty string. A wrong-typed root never arrives — it was refused with a 400 before this
 * ran, precisely so it could not be mistaken for the first case.
 */
export function resolveStoryWriteTarget(guards: StoryWriteGuards, filePath: unknown, root: ParsedStoryRoot): StoryWriteTarget {
  const rootRefusal = guards.guardStoryWriteRoot(root);
  if (rootRefusal) return { ok: false, failure: rootRefusal };
  // The path is checked AGAINST the root, not on its own: `stories/deck.json` is well-formed in
  // every root, so the pair is what the guard can actually judge.
  const pathRefusal = guards.guardStoryWirePath(filePath, root);
  if (pathRefusal) return { ok: false, failure: pathRefusal };
  const artifacts = guards.artifactsForRoot(root);
  if (artifacts === null) return { ok: false, unregisteredRoot: root };
  return { ok: true, artifacts };
}
