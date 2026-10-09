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

const mergeRanges = (ranges: CharRange[]): CharRange[] =>
  [...ranges]
    .sort((left, right) => left.start - right.start)
    .reduce<CharRange[]>((merged, range) => {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) {
        return [...merged.slice(0, -1), { start: last.start, end: Math.max(last.end, range.end) }];
      }
      return [...merged, range];
    }, []);

/** Splits `text` into runs, marking every occurrence of every non-empty highlight.
 *  Overlapping or touching highlights become one marked run. */
export const splitExcerpt = (text: string, highlights: readonly string[] = []): ExcerptSegment[] => {
  const ranges = mergeRanges(highlights.filter((needle) => needle.length > 0).flatMap((needle) => occurrencesOf(text, needle)));
  const { segments, cursor } = ranges.reduce<{ segments: ExcerptSegment[]; cursor: number }>(
    (acc, range) => ({
      segments: [
        ...acc.segments,
        ...(range.start > acc.cursor ? [{ text: text.slice(acc.cursor, range.start), highlighted: false }] : []),
        { text: text.slice(range.start, range.end), highlighted: true },
      ],
      cursor: range.end,
    }),
    { segments: [], cursor: 0 },
  );
  return cursor < text.length ? [...segments, { text: text.slice(cursor), highlighted: false }] : segments;
};
