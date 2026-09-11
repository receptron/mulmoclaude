// Pure helpers for the presentMulmoScript View. Kept separate so their
// logic is unit-testable without mounting the Vue component. Ported from
// the host's `src/plugins/presentMulmoScript/helpers.ts`; the SSE-stream
// helpers did not move — per-beat generation progress now arrives on the
// plugin pubsub channel (see `core/contract.ts`).

import { sameRoot } from "../core/contract";
import { isRecord } from "./support";

/**
 * Decide whether a beat should be rendered automatically at
 * script load time. Text-based beats (slides, charts, etc.) are
 * auto-rendered only when the script has no characters —
 * characters must be rendered first so they can be referenced by
 * any character-using beat.
 */
export function shouldAutoRenderBeat(
  beat: { image?: { type?: string | undefined } | undefined },
  hasCharacters: boolean,
  autoRenderTypes: readonly string[],
): boolean {
  if (hasCharacters) return false;
  const type = beat.image?.type;
  if (typeof type !== "string") return false;
  return autoRenderTypes.includes(type);
}

/**
 * Of the given character keys, return those whose image is not
 * yet loaded and is not currently rendering. Used to fetch only
 * what's missing after a movie-generation event arrives.
 */
export function getMissingCharacterKeys(keys: readonly string[], images: Record<string, unknown>, renderState: Record<string, string | undefined>): string[] {
  return keys.filter((charKey) => !images[charKey] && renderState[charKey] !== "rendering");
}

/**
 * A schema shape that exposes `safeParse` — matches Zod's API
 * without pulling the dep into this module.
 */
export interface SafeParseSchema {
  safeParse: (value: unknown) => { success: boolean };
}

/**
 * Validate a candidate Beat JSON string against a schema.
 * Returns false on any JSON parse error or schema mismatch.
 */
export function validateBeatJSON(json: string, schema: SafeParseSchema): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  return schema.safeParse(parsed).success;
}

/**
 * Stable structural equality for two MulmoScripts via JSON
 * canonicalisation. We compare the full re-serialised string
 * rather than walking keys because (a) MulmoScript is
 * deeply-nested and Object.keys-recursion would be ~50 lines, and
 * (b) `JSON.stringify` already preserves insertion order, which
 * `mulmoScriptSchema.safeParse` keeps stable across runs of the
 * same input. False positives (= "differ" when they don't) only
 * cost an extra `emit("updateResult", ...)` which is a no-op when
 * data hasn't actually changed.
 */
export function isSameScript(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * True when a beat can have a generated video clip on disk — used to
 * decide whether to probe the beat-movie endpoint. `moviePrompt`
 * beats produce a per-beat movie file; `html_tailwind` beats with
 * `animation` set (either `true` or an options object) produce an
 * `_animated.mp4` render.
 */
export function beatMayHaveMovie(beat: { moviePrompt?: string; image?: { type?: string; animation?: unknown } }): boolean {
  if (beat.moviePrompt) return true;
  return beat.image?.type === "html_tailwind" && Boolean(beat.image.animation);
}

/**
 * True for a beat whose image merely REFERENCES another beat's image
 * (`image: { type: "beat", id }` — mulmoBeatReferenceMediaSchema). Such a
 * beat owns no asset of its own, so there is nothing to generate for it:
 * the View hides the Generate button (offering it produced a render that
 * could never succeed on its own terms).
 */
export function isBeatImageReference(beat: { image?: { type?: string; [key: string]: unknown } }): boolean {
  return beat.image?.type === "beat";
}

/** Whether the beat editor has anything to edit.
 *
 *  Any beat type, not just `slide`: `@mulmocast/beat-editor` renders and edits all eight
 *  (`textSlide` / `markdown` / `chart` / `mermaid` / `image` / `movie` / `slide` /
 *  `html_tailwind`). The all-slide test this replaces was a limit of the OLD iframe deck
 *  editor, which only understood decks — it stayed in place through the migration and kept a
 *  markdown script read-only for no reason.
 *
 *  Empty / missing `beats[]` is false: there is nothing to edit, and the per-beat list already
 *  renders an empty state. */
export function hasEditableBeats(script: unknown): boolean {
  if (!isRecord(script)) return false;
  const { beats } = script;
  return Array.isArray(beats) && beats.length > 0;
}

/** A single MulmoScript beat as the View consumes it — every field
 *  optional so the empty-beat fallback (`effectiveBeat` on an
 *  out-of-range index) is a valid instance without a cast. */
export interface Beat {
  speaker?: string;
  text?: string;
  id?: string;
  imagePrompt?: string;
  moviePrompt?: string;
  image?: { type: string; [key: string]: unknown };
  /** Beat duration in seconds. The mulmocast schema notes this is
   *  "Used only when the text is empty" — the silent-beat Play loop
   *  uses it as the auto-advance timer (#1073). */
  duration?: number;
}

/** Resolve the beat the View should render at `index`: the user's
 *  in-place edit (`overrides`) wins over the on-disk beat, and an
 *  out-of-range index yields an empty beat so callers can read
 *  `.text` / `.image` without a guard. */
export function effectiveBeat(overrides: Record<number, Beat>, beats: readonly Beat[], index: number): Beat {
  return overrides[index] ?? beats[index] ?? {};
}

const BEAT_TOOLTIP_MAX_CHARS = 80;

/** Beat-strip hover tooltip: the beat text, truncated with an ellipsis
 *  past the cap. Missing text yields an empty string. Text of exactly
 *  the cap length is returned whole (only a longer string is cut). */
export function beatTooltip(text: string | undefined): string {
  const value = text ?? "";
  return value.length > BEAT_TOOLTIP_MAX_CHARS ? `${value.slice(0, BEAT_TOOLTIP_MAX_CHARS)}…` : value;
}

/** The prompt for a character image, or "" when the key or its prompt
 *  is absent — the character strip renders the empty string as no
 *  caption rather than `undefined`. */
export function characterPrompt(images: Record<string, { prompt?: string }> | undefined, key: string): string {
  return images?.[key]?.prompt ?? "";
}

/** Is the in-editor JSON for a beat currently valid? A missing entry
 *  (source editor never opened) validates the empty string, which is
 *  not parseable JSON, so it reports invalid rather than throwing. */
export function isValidBeat(source: string | undefined, schema: SafeParseSchema): boolean {
  return validateBeatJSON(source ?? "", schema);
}

/** A story as the wire addresses it: the path plus the root it is relative to (absent = the
 *  host's default root). The PAIR is the identity — see `staleSince`. */
export interface StoryRef {
  filePath: string;
  root?: string | undefined;
}

/**
 * Stale-response guard: a per-beat / per-character response is stale once the View has
 * navigated to a different result.
 *
 * The identity is the PAIR `(root, filePath)`, not the path — `stories/deck.json` exists in
 * every registered root (#3014), so comparing paths alone lets one repository's deck accept
 * another's late response while both are open under the same name. `sameRoot` reads an absent
 * root as the host's default rather than as "different", which is what keeps every pre-root
 * caller's behaviour byte-identical.
 *
 * Keeping the direction pinned matters — an inverted check would let script A's late responses
 * write into script B's state.
 */
export function staleSince(current: StoryRef, requested: StoryRef): boolean {
  return current.filePath !== requested.filePath || !sameRoot(current.root, requested.root);
}

const JSON_INDENT = 2;

/** Pretty-print a script (or any value) as the source-editor / clipboard
 *  text — two-space indent, matching what the beat and disk views emit. */
export function scriptSourceText(value: unknown): string {
  return JSON.stringify(value, null, JSON_INDENT);
}

/** Basename for a download `<a download>` attribute, falling back when
 *  the path has no basename. Mirrors the exact existing behaviour, and
 *  it has a sharp edge: `.pop()` returns "" (not undefined) for a
 *  trailing slash or empty path, and `??` does NOT replace "", so those
 *  yield an empty filename rather than the fallback. Server paths always
 *  carry a basename, so this never bites in practice — pinned so a later
 *  reader doesn't "simplify" `??` to `||` and change behaviour. */
export function downloadFilename(path: string, fallback: string): string {
  return path.split("/").pop() ?? fallback;
}

/** Narrow a script-supplied silent-beat duration to a safe positive number.
 *  Zero / negative / NaN / Infinity / non-number collapse the auto-advance
 *  timer to an immediate fire, which races the Play loop through every silent
 *  beat in a single tick (#1365) — fall back to the default so a run of silent
 *  beats stays watchable. The script's own valid `duration` always wins. */
export function resolveSilentAdvanceSeconds(raw: unknown, defaultSec: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : defaultSec;
}

/** Delete every own enumerable key of each record, in place. Used to reset the
 *  View's per-beat / per-character reactive maps between scripts — passing the
 *  reactive proxies mutates them so the template re-renders empty. Replaces a
 *  wall of hand-rolled `Object.keys(map).forEach(delete)` loops. */
export function clearReactiveRecords(...records: object[]): void {
  records.forEach((record) => {
    Object.keys(record).forEach((key) => Reflect.deleteProperty(record, key));
  });
}

/**
 * Whether a `focusout` means focus actually LEFT `container`, rather than moving between two
 * fields inside it.
 *
 * The distinction decides whether pending edits are written: treating every focusout as a
 * departure would write on each hop between inputs, and treating none as one would let the user
 * walk away with the last keystroke unsaved.
 *
 * `null` is focus going nowhere the document can name — clicking the page chrome, or the window
 * losing focus. That counts as leaving: the editor is no longer where the typing goes.
 */
export function focusLeftContainer(container: Node | null, movedTo: EventTarget | null): boolean {
  if (!container) return false;
  if (!(movedTo instanceof Node)) return true;
  return !container.contains(movedTo);
}
