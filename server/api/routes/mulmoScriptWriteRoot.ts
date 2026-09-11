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
  guardStoryWriteRoot: (root: string | undefined) => OpFailure | null;
  /** Does that wire path belong to that root? `null` = yes. */
  guardStoryWirePath: (filePath: unknown, root?: string) => OpFailure | null;
  /** The artifacts `FileOps` bound to that root, or `null` when it is not registered. */
  artifactsForRoot: (root: string | undefined) => FileOps | null;
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
export type SuppliedRoot = { ok: true; root: string | undefined } | { ok: false; error: string };

export function parseSuppliedRoot(value: unknown): SuppliedRoot {
  if (value === undefined) return { ok: true, root: undefined };
  if (typeof value !== "string") return { ok: false, error: `mulmoScript root must be a string, got ${Array.isArray(value) ? "array" : typeof value}` };
  return { ok: true, root: value === "" ? undefined : value };
}

export type StoryWriteTarget =
  /** Write here. */
  | { ok: true; artifacts: FileOps }
  /** A guard refused, with the sentence it wrote. */
  | { ok: false; failure: OpFailure }
  /** No `FileOps` exists for that root — the caller answers 400 naming it. */
  | { ok: false; unregisteredRoot: string | undefined };

/**
 * Decide where a write goes.
 *
 * Returns the FileOps to write through, or the refusal — never a default-root fallback, which is
 * the failure this exists to prevent. `root` is already normalized by the caller: absent, empty
 * and wrong-typed all arrive here as `undefined`, meaning the host's default root.
 */
export function resolveStoryWriteTarget(guards: StoryWriteGuards, filePath: unknown, root: string | undefined): StoryWriteTarget {
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
