# feat: a `datetime` field accepts a bare `YYYY-MM-DD` as an all-day value (#3304)

## Problem

In a collection whose `googleCalendar.map` puts `start` / `end` on `datetime`
columns, a locally-created record cannot become an all-day event without a
lint warning:

- `…T00:00` is pushed as a timed 0:00–24:00 event (no baseline says otherwise).
- A bare `2026-09-28` is already pushed as all-day (`toGoogleEventTime` →
  `rawGoogleTime` → `{ date }`), but the strict tier reports it as
  `not a YYYY-MM-DDTHH:MM datetime`.

## Decision (agreed on the issue thread)

Proposal A only: a `datetime` field accepts a bare date, meaning "all day".
The pull keeps writing all-day events as `…T00:00` (proposal B is NOT done), so
existing records do not change shape.

## Changes

1. **Lint** — `packages/core/src/collection/core/recordZ.ts`: the `datetime`
   case also accepts `parseIsoDate(value) !== null`. The message keeps its
   existing prefix and names the all-day shape.
2. **Form** — `useCollectionRendering.helpers.ts` `inputTypeFor`: a
   `datetime` whose value is a bare date renders as `date`, so the value is
   shown and survives a save (`datetime-local` would show it blank).
3. **Sort** — `sortItems.ts` `dateSortValue`: a bare date sorts at LOCAL
   midnight, the same instant `Date.parse` gives `…T00:00`. `Date.parse` reads
   a bare date as UTC, which put an all-day record at 09:00 in UTC+9.
4. **Docs** — `helps/google-calendar-collection.md` (All-day events),
   `helps/collection-skills.md` (the `datetime` field type).

## Out of scope

- The calendar "add" affordance (`createOnDate`) still seeds `…T00:00`.
- An all-day end date renders one day long (Google's exclusive end) — same as
  a `date` column today.
- A date-only record may be re-PATCHed once after its create, until the next
  pull rewrites it as `…T00:00` (`pushPlan.comparableText` does not equate the
  two spellings). This is today's behaviour; A does not change it.

## Tests

- Lint accepts a bare date in `datetime` (top level and a `table` sub-field),
  still rejects an impossible date (`2026-02-30`).
- `inputTypeFor("datetime", "2026-09-28")` → `date`.
- `dateSortValue("2026-09-28")` equals `dateSortValue("2026-09-28T00:00")` and
  sorts before `…T08:00` in any host timezone.
