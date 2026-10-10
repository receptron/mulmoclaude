import type { ExcerptField, FormField, InputField } from "./types";

export interface ExcerptSegment {
  text: string;
  highlighted: boolean;
}

interface CharRange {
  start: number;
  end: number;
}

export const isInputField = (field: FormField): field is InputField => field.type !== "excerpt";

export const isExcerptField = (field: FormField): field is ExcerptField => field.type === "excerpt";

const escapeRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A lookahead matches every start, so a phrase that overlaps itself ("aa" in "aaa") is marked throughout.
const occurrencesOf = (text: string, needle: string): CharRange[] =>
  Array.from(text.matchAll(new RegExp(`(?=${escapeRegExp(needle)})`, "g")), (match) => ({ start: match.index, end: match.index + needle.length }));

// Accumulators are extended in place: rebuilding them per range made a many-match excerpt quadratic.
const mergeRanges = (ranges: CharRange[]): CharRange[] =>
  [...ranges]
    .sort((left, right) => left.start - right.start)
    .reduce<CharRange[]>((merged, range) => {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
      return merged;
    }, []);

const segmentsFor = (text: string, range: CharRange, gapStart: number): ExcerptSegment[] => [
  ...(range.start > gapStart ? [{ text: text.slice(gapStart, range.start), highlighted: false }] : []),
  { text: text.slice(range.start, range.end), highlighted: true },
];

/** Splits `text` into runs, marking every occurrence of every non-empty highlight.
 *  Overlapping or touching highlights become one marked run. */
export const splitExcerpt = (text: string, highlights: readonly string[] = []): ExcerptSegment[] => {
  const ranges = mergeRanges(highlights.filter((needle) => needle.length > 0).flatMap((needle) => occurrencesOf(text, needle)));
  const marked = ranges.flatMap((range, index) => segmentsFor(text, range, ranges[index - 1]?.end ?? 0));
  const tailStart = ranges[ranges.length - 1]?.end ?? 0;
  return tailStart < text.length ? [...marked, { text: text.slice(tailStart), highlighted: false }] : marked;
};
