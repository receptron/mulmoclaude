# Google Calendar sync — mirror a Google calendar into a collection

A collection can keep itself in sync with one of the user's Google calendars.
Add a `googleCalendar` block to its `schema.json` and the host pulls changed
events on a schedule and writes them as records — **without calling you**. No
tool call, no tokens spent per sync, so hourly syncing is free.

This is the mechanism for *keeping a collection fresh*. For one-off reads and
for deleting events, use the `google` tool — see
[The `google` tool](google.md). There is no bundled calendar collection: you
author the schema when the user asks for one.

## Both directions

| Direction | How | When it runs |
| --- | --- | --- |
| Google → collection | the `googleCalendar` block | hourly, on creation, and on the **Sync** button |
| collection → Google | the **Push to Google** button | whenever the user clicks it |
| collection → Google | `"autoPush": true` in the block | hourly, immediately before each pull |
| collection → Google, deletions | `"propagateDeletes": true` in the block | with every push. Off by default; see "Deleting" |

When a user asks for "two-way sync", `autoPush` is the answer: set it and each
scheduled run pushes local edits up and then pulls Google's changes down, as one
cycle. Without it the pull is automatic and the push is a button they must
remember to press — which is why the order used to matter so much.

It is **opt-in and off by default**, and that is deliberate: a push writes to a
calendar other people may be reading, so turning it on is the user's call. Ask
before you add it.

## Requirements

The user's Google account must be linked (`google` tool, `kind: "status"`). If
it isn't, sync silently does nothing until they link it in settings.

## The block

```jsonc
{
  "fields": {
    "gid":   { "type": "string",   "label": "ID",   "primary": true },
    "title": { "type": "string",   "label": "Event" },
    "on":    { "type": "datetime", "label": "Start" },
    "until": { "type": "datetime", "label": "End" }
  },
  "primaryKey": "gid",
  "displayField": "title",
  "calendarField": "on",
  "calendarEndField": "until",
  "dataPath": "data/collections/my-schedule/items",

  "googleCalendar": {
    "calendarId": "primary",
    "map": { "title": "summary", "on": "start", "until": "end" },
    "autoPush": true
  }
}
```

- `calendarId` — the calendar to read. `"primary"` (as in the example) and
  omitting the key entirely both mean the user's primary calendar. For any
  other calendar, get its id from the `google` tool
  (`kind: "calendarListCalendars"`).
- `map` — **your field name → the Google event field**. Pick whatever field
  names suit the collection; the map absorbs the difference. Map at least one
  field: an empty map syncs records that carry only the event id, so the user
  would see rows with no content.
- `autoPush` — push local edits on the sync schedule, just before each pull.
  Omit it (the default) and the push stays a button. See "Both directions".
- `propagateDeletes` — delete the Google event when its record is deleted here.
  Omit it (the default) and a local deletion is reported and nothing else. See
  "Deleting".

Mappable event fields, two-way first: `summary`, `start`, `end`, `description`,
`location`, `colorId`.

Pull-only in this sync — the pull fills them, the push never sends them, so
Google always wins. Some of these Google would accept a write for
(`transparency`, and `eventType` at creation); this sync deliberately does not
send any of them: `htmlLink`, `status`, `updated` (Google's own last-modified
time),
`transparency` (`"transparent"` when the event does not consume the attendee's
time; `""` means opaque), `eventType` (all six Google returns: `default` / `birthday` / `focusTime` /
`fromGmail` / `outOfOffice` / `workingLocation`), `hangoutLink` (the Meet URL),
`recurringEventId`, `originalStartTime`, `selfResponseStatus` and
`conferenceVideoUri`.

`recurringEventId` and `originalStartTime` are how a recurring series stays
legible. The sync asks Google to expand recurrences, so a weekly meeting arrives
as one event per occurrence; `recurringEventId` names the series each occurrence
came from (`""` for a one-off), and `originalStartTime` is the slot the
occurrence held before anyone dragged it — so a moved occurrence reads as a move
rather than as a deletion plus a new event. Map them when the user asks why one
calendar edit produced a large batch of record changes.

### `selfResponseStatus` and `conferenceVideoUri`

These two are not Google field names. Google answers `attendees` as an ARRAY and
`conferenceData` as an array inside an object, and a collection field holds one
value — so each is folded down to the single scalar the collection asks it for.
The rest of those structures is dropped; there is no way to map the attendee
list itself.

**`selfResponseStatus`** — the signed-in user's own `responseStatus`:
`needsAction`, `declined`, `tentative` or `accepted`.

`""` means Google reported none, and that is the COMMON case, not an edge one:
an event with no attendees has no entry to mark as the user, which is most of a
personal calendar. So it reads as "nothing said", never as "not going".

Filter with **`!= "declined"`**, never with `== "accepted"` — the second hides
every solo event too. A `flag` field is the usual way:

```jsonc
"fields": {
  "rsvp":    { "type": "string", "label": "RSVP" },
  "onMySchedule": {
    "type": "flag",
    "label": "Mine",
    "where": [{ "field": "rsvp", "op": "ne", "value": "declined" }]
  }
},
"googleCalendar": { "map": { "rsvp": "selfResponseStatus" } }
```

**`conferenceVideoUri`** — the URL that joins the meeting, taken from the
`video` entry point. `""` when the event has no conference, and also when its
only entry points are a phone number or a dial-in page: a column named for
joining that sometimes held `tel:` would be worse than one the caller can see is
empty.

`hangoutLink` already carries this for Google Meet. `conferenceVideoUri` is what
reaches a calendar whose meetings are Zoom or Teams. A Meet event fills both, so
map whichever the user's calendar actually uses.

`description` is the event body, and Google stores limited **HTML** in it. It is
kept verbatim — mirroring it through a plain-text field and pushing it back would
strip the user's formatting. Give it a `text` field, and do not "clean it up" on
the way in.

Mapping a column the user already filled by hand (a `notes` column, say) onto
`description` means the next push sends that text to Google. That is usually what
they want, but say so before you write the map.

## The primary field is the event id

Do **not** map the primary field. It always receives the Google event id, which
is what lets a re-sync update an existing record instead of duplicating it.
Declaring it in `map` is a schema error.

Use `datetime` (not `date`) for start/end when events have real clock times —
the calendar day view then draws each record as a proportional time block.

## All-day events

A `datetime` column stores an all-day event mirrored from Google as
`2026-07-17T00:00`, because that is where the day view places it. That is also
exactly how a real midnight appointment is stored — so a record CREATED locally
with `…T00:00` is pushed as a midnight event, never as an all-day one.

To create an all-day event in a `datetime` column (a calendar that mixes timed
and all-day events), write a **bare date** on both ends instead:
`start: "2026-07-17"`, `end: "2026-07-18"`. A bare date is a valid `datetime`
value, it is pushed as Google's `start.date` / `end.date`, and the record form
edits it with a date picker. After the next sync it reads back as `…T00:00`
and stays all-day.

For a calendar whose events are ALL all-day, give start/end a **`date`** column
instead. Google's bare date is then kept verbatim, and a record the user creates
by typing two dates is pushed as a real all-day event.

```jsonc
"fields": {
  "on":    { "type": "date", "label": "From" },
  "until": { "type": "date", "label": "To" }
},
"googleCalendar": { "map": { "on": "start", "until": "end" } }
```

Google's all-day `end` is **exclusive** — it is the day AFTER the last day, so a
single day on the 17th is `on: 2026-07-17`, `until: 2026-07-18`. Records
mirrored from Google already carry it that way. Say so when the user asks why
the end date "looks a day late"; do not offset it, because the push sends the
stored value straight back.

An existing all-day event stays all-day when its dates are edited, whatever the
column type: the push reads what Google last reported for that event and keeps
its kind. Only a record with no such history — one created locally — depends on
the column type.

To create a one-off all-day event without a collection, use the `google` tool's
`calendarCreateEvent` with a bare date on both ends.

## When sync runs

- **On creation** — the first sync starts as soon as the schema lands, so the
  collection is not empty while the user waits for the schedule. The same
  applies when you add a `googleCalendar` block to an existing collection.
  Each collection gets its OWN full walk: a calendar that another collection
  (or the `google` tool's `calendarSync`) has already read is still walked in
  full for the new one, because a sync cursor says how far the *calendar* has
  been read, not what *these records* hold (#2850).
- **Hourly** after that, in the background.
- **On demand** — the collection view has a Sync button. Tell the user about it
  if they want the calendar refreshed right now.

## What sync does

- New or edited events are written, keyed by event id. Only the mapped columns
  are overwritten: a column the map does not name (a local note the user keeps
  next to the event) survives the pull. The flip side is that a field you REMOVE
  from `map` keeps its last synced value rather than disappearing.
- Events deleted in Google are **deleted** from the collection.
- Only what changed since the last run is fetched, so a big calendar stays
  cheap after the first sync.
- The first run walks the whole calendar to establish a starting point. Note
  this covers **all** dates — Google does not allow a date window together with
  incremental sync — so a calendar with years of history produces a lot of
  records on that first pass.
- Because it covers all dates, a recurring event with **no end date** is
  expanded decades into the future, and one such series can produce hundreds of
  records. If a first sync reports that only part of the calendar was copied,
  that is the common cause — ask the user to give those series a finite end
  date. The report itself means the walk ran out of pages, which a big enough
  calendar can do on its own.

Records are ordinary collection records: the user can open, filter, and view
them like any other.

## Pushing local work back — the Push to Google button

The collection view has a **Push to Google** button next to Sync. It creates
events for records added locally and updates events for records edited locally.

**Order matters when the push is manual.** A pull overwrites a locally edited
record as soon as Google reports any change to that event, so: push first, then
sync. Syncing first can discard the edit that was waiting to be pushed. This is
exactly the trap `autoPush` closes — it runs the two in that order for the user.

What the button does and deliberately does not do:

- **Creates** an event for a record that never came from a sync.
- **Updates** only the fields the user actually changed, so attendees,
  reminders and recurrence rules stay untouched.
- **Never deletes, unless the collection asked it to.** See "Deleting" below;
  without `propagateDeletes` a record deleted locally leaves its Google event
  alone and the count is reported so the user knows.
- **Skips a record edited on both sides** and reports it, rather than picking a
  winner. The user resolves it by editing one side to match. Under `autoPush`
  the pull that follows leaves that record alone too, so the local edit is not
  destroyed while it waits — the cost is that the record stays behind Google
  until someone resolves it, and the host logs which records those are.
- Pushes `summary`, `start`, `end`, `description`, `location` and `colorId` —
  the two-way half of the list above. A column mapped to one of the pull-only
  fields is ignored by the push rather than rejected, so it keeps mirroring
  Google in one direction.

Reasons a record can be reported as skipped:

- **Its record id cannot be a Google event id.** Google requires 5-1024
  characters from `0-9a-v` (lower-case base32hex: digits plus `a`-`v`, so no
  `w`-`z`, no upper case, no hyphen). Records created through the UI get a
  valid generated id; a semantic id you authored (`team-standup`) cannot be
  used. Fix by recreating the record without setting the primary field, or by
  choosing an id that satisfies the rule.
- **No `start` / `end` is mapped, on a record being CREATED.** An event cannot
  be created without a span. Editing an existing event is unaffected — a changed
  title or colour is patched on its own.
- **The calendar reports no timezone**, and the stored clock carries no offset
  to fall back on.
- **Clearing an event colour** — Google has no way to unset one.

If the user only has `reader` access to the calendar, the whole push is refused
with that reason rather than failing event by event. A calendar the user can
reach by id but has not added to their calendar list has no role to check, so
the push goes ahead and reports Google's own refusal if the write turns out not
to be allowed — being unlisted is not treated as being read-only.

## Deleting

By default, a record deleted in the collection leaves its Google event alone.
The push reports the count and does nothing else, and the next sync brings the
record back — which is correct for a calendar Google owns, and wrong for one
where the collection is the primary copy.

`"propagateDeletes": true` in the `googleCalendar` block makes the push delete
those events too. **Ask the user before adding it**, the same as `autoPush` and
for a stronger reason: `autoPush` changes WHEN a write happens, this makes a
write irreversible.

Even on, the push **refuses an event that carries attendees** and reports it
instead. Deleting an invited event withdraws it from the guests' calendars,
which is a different act from tidying your own. **Any** attendee entry refuses,
including the one Google adds for the organiser — so an event only the user was
ever on is refused too, deliberately: telling the two apart means deciding which
entry is the user from a payload that may not say, and being wrong there
withdraws a real invitation. Either way, an event the user actually wants gone
is deleted with the `google` tool's `calendarDeleteEvent`, after confirming with
them.

The delete also carries the version the check was made against, so an attendee
added while the push was running makes Google refuse it rather than letting a
decision taken a moment earlier stand. That is reported like any other refusal;
pressing Push again re-checks.

There is no undo here and this app keeps no copy of what it deleted. Google
Calendar's own Trash holds a deleted event for a while, and that is where a
mistake is recovered from.

A deletion that carried stops being reported, because its baseline entry goes
with it. A deletion that was REFUSED keeps being reported on every push — the
event is still standing in Google, and the report is the only thing that says
so.

## Not for this

A `dataSource` (CSV-backed) collection is read-only and cannot declare
`googleCalendar`. Use a normal `dataPath` collection.
