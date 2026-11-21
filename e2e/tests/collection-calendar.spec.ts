// E2E coverage for the collection calendar view (feat-collections-calendar-view).
// Any collection with a `date` field gains a table↔calendar toggle; the
// calendar lays each record on its day cell and lists undated records in a
// "No date" tray. A collection with no date field shows no toggle at all.
// Clicking any day cell — or any record chip — opens the day (time-allocation)
// view, where a `calendarTimeField` time string renders records as proportional
// blocks / single lines / all-day chips. Selecting a record shows its detail in
// the day view's right pane and mirrors the selection into `?selected=`.
//
// Records are placed on the 15th of the *current* month so they land on
// the calendar's default-visible grid without mocking the clock.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const today = new Date();
const MID = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-15`;

const EVENTS = {
  collection: {
    slug: "events",
    title: "Events",
    icon: "event",
    source: "user",
    schema: {
      title: "Events",
      icon: "event",
      dataPath: "data/events/items",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true, required: true },
        name: { type: "string", label: "Name", required: true },
        on: { type: "date", label: "Date" },
      },
      displayField: "name",
      calendarField: "on",
    },
  },
  items: [
    { id: "launch", name: "Launch party", on: MID },
    { id: "someday", name: "Someday item", on: "" },
  ],
};

// A date-bearing collection with ZERO records — the toggle must still
// appear so the empty-day create affordance is reachable.
const EVENTS_EMPTY = {
  collection: { ...EVENTS.collection, slug: "events-empty", schema: { ...EVENTS.collection.schema, dataPath: "data/events-empty/items" } },
  items: [],
};

// A date + free-form time collection: exercises the day view's three
// renderings via `calendarTimeField`. All three land on the 15th.
const AGENDA = {
  collection: {
    slug: "agenda",
    title: "Agenda",
    icon: "event",
    source: "user",
    schema: {
      title: "Agenda",
      icon: "event",
      dataPath: "data/agenda/items",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true, required: true },
        name: { type: "string", label: "Name", required: true },
        on: { type: "date", label: "Date" },
        time: { type: "string", label: "Time" },
        location: { type: "string", label: "Location" },
      },
      displayField: "name",
      calendarField: "on",
      calendarTimeField: "time",
    },
  },
  items: [
    { id: "block", name: "Workshop", on: MID, time: "14:00-17:00", location: "Room 5" }, // range → block
    { id: "line", name: "Standup", on: MID, time: "09:30", location: "Hall" }, // start only → single line
    { id: "allday", name: "Conference", on: MID, time: "終日", location: "Expo" }, // no clock → all-day strip
  ],
};

// A collection whose calendar anchor is a `datetime` field — the clock lives in
// the field value, and day-view create must prefill a valid datetime-local.
const DTEVENTS = {
  collection: {
    slug: "dtevents",
    title: "Meetings",
    icon: "event",
    source: "user",
    schema: {
      title: "Meetings",
      icon: "event",
      dataPath: "data/dtevents/items",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true, required: true },
        name: { type: "string", label: "Name", required: true },
        at: { type: "datetime", label: "At" },
      },
      displayField: "name",
      calendarField: "at",
    },
  },
  items: [{ id: "kickoff", name: "Kickoff", at: `${MID}T14:30` }],
};

// A date + enum collection: the enum is the colour field, so chips on every
// calendar surface (month grid AND the day view, timed or all-day) tint by the
// value's palette colour. No time field → every record sits in the day view's
// all-day strip, which must carry the colour just like the timed chips.
const COLORED = {
  collection: {
    slug: "colored-events",
    title: "Colored",
    icon: "event",
    source: "user",
    schema: {
      title: "Colored",
      icon: "event",
      dataPath: "data/colored-events/items",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true, required: true },
        name: { type: "string", label: "Name", required: true },
        on: { type: "date", label: "Date" },
        status: { type: "enum", label: "Status", values: ["todo", "doing", "done"] },
      },
      displayField: "name",
      calendarField: "on",
    },
  },
  // "doing" is enum index 1 → the sky palette entry (badge `bg-sky-100`).
  items: [{ id: "review", name: "Review", on: MID, status: "doing" }],
};

// COLORED with one built-in toggle opted out via `builtinViews` (#3677).
const withBuiltinViews = (slug: string, builtinViews: Record<string, boolean>) => ({
  ...COLORED,
  collection: { ...COLORED.collection, slug, schema: { ...COLORED.collection.schema, builtinViews } },
});
const COLORED_NO_KANBAN = withBuiltinViews("colored-no-kanban", { kanban: false });
const COLORED_NO_CALENDAR = withBuiltinViews("colored-no-calendar", { calendar: false });

// A Google Calendar mirror: its `end` is exclusive, so an all-day event on the
// 15th is stored ending at 16T00:00 and must not spill onto the 16th (#3323).
// PLAIN holds the same dates without a sync, where the end stays inclusive.
const NEXT = `${MID.slice(0, 8)}16`;
const gcalSchema = (slug: string, sync: boolean) => ({
  title: "Mirror",
  icon: "event",
  dataPath: `data/${slug}/items`,
  primaryKey: "id",
  fields: {
    id: { type: "string", label: "ID", primary: true, required: true },
    name: { type: "string", label: "Name", required: true },
    start: { type: "datetime", label: "Start" },
    end: { type: "datetime", label: "End" },
  },
  displayField: "name",
  calendarField: "start",
  calendarEndField: "end",
  ...(sync ? { googleCalendar: { calendarId: "primary", map: { name: "summary", start: "start", end: "end" } } } : {}),
});
const ALL_DAY_ITEM = { id: "offsite", name: "Offsite", start: `${MID}T00:00`, end: `${NEXT}T00:00` };
const MIRROR = {
  collection: { slug: "mirror", title: "Mirror", icon: "event", source: "user", schema: gcalSchema("mirror", true) },
  items: [ALL_DAY_ITEM],
};
const PLAIN = {
  collection: { slug: "plain", title: "Plain", icon: "event", source: "user", schema: gcalSchema("plain", false) },
  items: [ALL_DAY_ITEM],
};

// A collection with NO date field — must never show the calendar toggle.
const CONTACTS = {
  collection: {
    slug: "contacts",
    title: "Contacts",
    icon: "people",
    source: "user",
    schema: {
      title: "Contacts",
      icon: "people",
      dataPath: "data/contacts/items",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true, required: true },
        name: { type: "string", label: "Name", required: true },
      },
    },
  },
  items: [{ id: "jane", name: "Jane Doe" }],
};

async function mockCollections(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/collections/events",
    (route) => route.fulfill({ json: EVENTS }),
  );
  await page.route(
    (url) => url.pathname === "/api/collections/events-empty",
    (route) => route.fulfill({ json: EVENTS_EMPTY }),
  );
  await page.route(
    (url) => url.pathname === "/api/collections/agenda",
    (route) => route.fulfill({ json: AGENDA }),
  );
  await page.route(
    (url) => url.pathname === "/api/collections/dtevents",
    (route) => route.fulfill({ json: DTEVENTS }),
  );
  await page.route(
    (url) => url.pathname === "/api/collections/contacts",
    (route) => route.fulfill({ json: CONTACTS }),
  );
  await page.route(
    (url) => url.pathname === "/api/collections/colored-events",
    (route) => route.fulfill({ json: COLORED }),
  );
  await page.route(
    (url) => url.pathname === "/api/collections/colored-no-kanban",
    (route) => route.fulfill({ json: COLORED_NO_KANBAN }),
  );
  await page.route(
    (url) => url.pathname === "/api/collections/colored-no-calendar",
    (route) => route.fulfill({ json: COLORED_NO_CALENDAR }),
  );
  await page.route(
    (url) => url.pathname === "/api/collections/mirror",
    (route) => route.fulfill({ json: MIRROR }),
  );
  await page.route(
    (url) => url.pathname === "/api/collections/plain",
    (route) => route.fulfill({ json: PLAIN }),
  );
}

test.describe("collection calendar view", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
    await mockCollections(page);
  });

  test("shows the table↔calendar toggle for a date-bearing collection", async ({ page }) => {
    await page.goto("/collections/events");
    await expect(page.getByTestId("collection-view-toggle-table")).toBeVisible();
    await expect(page.getByTestId("collection-view-toggle-calendar")).toBeVisible();
  });

  test("renders a record on its day cell and opens detail in the day view on chip click", async ({ page }) => {
    await page.goto("/collections/events");
    await page.getByTestId("collection-view-toggle-calendar").click();
    // Grid + the record's chip on the 15th.
    await expect(page.getByTestId("collection-calendar")).toBeVisible();
    await expect(page.getByTestId(`collection-calendar-day-${MID}`)).toBeVisible();
    const chip = page.getByTestId("collection-calendar-chip-launch");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText("Launch party");
    // Clicking the chip opens the day view with the record in its right pane,
    // and mirrors the selection into the URL so the link is shareable.
    await chip.click();
    await expect(page.getByTestId("collection-day-view")).toBeVisible();
    await expect(page.getByTestId("collection-day-view-detail")).toBeVisible();
    await expect(page.getByTestId("collections-detail")).toBeVisible();
    await expect(page.getByTestId("collections-detail-title")).toHaveText("launch");
    await expect(page).toHaveURL(/[?&]selected=launch\b/);
  });

  test("a ?selected= deep link opens the record modal without forcing the calendar view", async ({ page }) => {
    // #1675: previously the deep link forced the collection to `calendar` and
    // opened the day popup, which also permanently overwrote the user's saved
    // view mode via the localStorage watcher. It now respects whatever view
    // the user is in (default: table) and just opens the record modal.
    await page.goto("/collections/agenda?selected=block");
    await expect(page.getByTestId("collections-detail")).toBeVisible();
    await expect(page.getByTestId("collections-detail-title")).toHaveText("block");
    // Neither the calendar grid nor the day popup should have been forced open.
    await expect(page.getByTestId("collection-calendar")).toHaveCount(0);
    await expect(page.getByTestId("collection-day-view")).toHaveCount(0);
  });

  test("navigating back to the collection without ?selected= closes the record modal", async ({ page }) => {
    await page.goto("/collections/agenda?selected=block");
    await expect(page.getByTestId("collections-detail")).toBeVisible();
    // Reopening the collection without a selection must not leave a stale modal.
    await page.goto("/collections/agenda");
    await expect(page.getByTestId("collections-detail")).toHaveCount(0);
    await expect(page.getByTestId("collection-day-view")).toHaveCount(0);
  });

  test("closing the record modal via its X clears the selection", async ({ page }) => {
    await page.goto("/collections/agenda?selected=block");
    await expect(page.getByTestId("collections-detail")).toBeVisible();
    // The modal's close button tears it down and drops ?selected= from the URL.
    await page.getByTestId("collections-detail-close").click();
    await expect(page.getByTestId("collections-detail")).toHaveCount(0);
    await expect(page).not.toHaveURL(/selected=/);
  });

  test("lists undated records in the No date tray", async ({ page }) => {
    await page.goto("/collections/events");
    await page.getByTestId("collection-view-toggle-calendar").click();
    await expect(page.getByTestId("collection-calendar-no-date")).toBeVisible();
    await expect(page.getByTestId("collection-calendar-undated-someday")).toBeVisible();
    // The undated record has no day-cell chip.
    await expect(page.getByTestId("collection-calendar-chip-someday")).toHaveCount(0);
  });

  test("selecting an undated record shows the shared record modal, not the day popup", async ({ page }) => {
    await page.goto("/collections/events");
    await page.getByTestId("collection-view-toggle-calendar").click();
    // An undated record has no day to place on a timeline → its detail opens in
    // the shared record modal and no day popup appears.
    await page.getByTestId("collection-calendar-undated-someday").click();
    await expect(page.getByTestId("collection-day-view")).toHaveCount(0);
    await expect(page.getByTestId("collections-record-modal")).toBeVisible();
    await expect(page.getByTestId("collections-detail-title")).toHaveText("someday");
  });

  test("clicking a day opens the day view; its + button creates with the date prefilled", async ({ page }) => {
    await page.goto("/collections/events");
    await page.getByTestId("collection-view-toggle-calendar").click();
    // Any day cell is a keyboard-operable button that opens the day view.
    const empty = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-20`;
    const cell = page.getByTestId(`collection-calendar-day-${empty}`);
    await expect(cell).toHaveAttribute("role", "button");
    await expect(cell).toHaveAttribute("tabindex", "0");
    await cell.click();
    // The day view opens; its + button starts a create prefilled to that day.
    await expect(page.getByTestId("collection-day-view")).toBeVisible();
    await page.getByTestId("collection-day-view-create").click();
    // The create form renders INSIDE the day view's right pane — the popup stays
    // open and the form must NOT fall through to the panel below the grid.
    await expect(page.getByTestId("collection-day-view")).toBeVisible();
    await expect(page.getByTestId("collection-day-view-detail")).toBeVisible();
    await expect(page.getByTestId("collections-create")).toBeVisible();
    await expect(page.getByTestId("collections-record-modal")).toHaveCount(0);
    await expect(page.getByTestId("collections-input-on")).toHaveValue(empty);
  });

  test("closing the day popup mid-create does not re-open the draft in the shared modal", async ({ page }) => {
    await page.goto("/collections/events");
    await page.getByTestId("collection-view-toggle-calendar").click();
    const empty = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-20`;
    await page.getByTestId(`collection-calendar-day-${empty}`).click();
    await page.getByTestId("collection-day-view-create").click();
    await expect(page.getByTestId("collections-create")).toBeVisible();

    // Closing the whole day popup must discard the in-progress create — it must
    // NOT fall through and re-appear in the centred record modal (Codex P2 #1656).
    await page.getByTestId("collection-day-view-close").click();
    await expect(page.getByTestId("collection-day-view")).toHaveCount(0);
    await expect(page.getByTestId("collections-record-modal")).toHaveCount(0);
    await expect(page.getByTestId("collections-create")).toHaveCount(0);
  });

  test("calendar view hides the top Add button (create happens via the day view +)", async ({ page }) => {
    await page.goto("/collections/events");
    // Present in the table view…
    await expect(page.getByTestId("collections-add-item")).toBeVisible();
    await page.getByTestId("collection-view-toggle-calendar").click();
    await expect(page.getByTestId("collection-calendar")).toBeVisible();
    // …and gone in the calendar, where the day view's + is the only create entry.
    await expect(page.getByTestId("collections-add-item")).toHaveCount(0);
  });

  test("clicking a day cell opens the day view; its chips select into the detail pane", async ({ page }) => {
    await page.goto("/collections/events");
    await page.getByTestId("collection-view-toggle-calendar").click();
    // Activating the day cell (a keyboard-operable button) opens the day view;
    // the clock-less record sits in the all-day strip (events has no time field).
    const cell = page.getByTestId(`collection-calendar-day-${MID}`);
    await cell.focus();
    await cell.press("Enter");
    await expect(page.getByTestId("collection-day-view")).toBeVisible();
    const chip = page.getByTestId("collection-day-view-allday-launch");
    await expect(chip).toBeVisible();
    // Selecting it shows the detail in the right pane WITHOUT closing the popup.
    await chip.click();
    await expect(page.getByTestId("collection-day-view")).toBeVisible();
    await expect(page.getByTestId("collection-day-view-detail")).toBeVisible();
    await expect(page.getByTestId("collections-detail-title")).toHaveText("launch");
  });

  // The day popup is `fixed inset-0`, so a chat started from the record it
  // hosts would begin underneath it. Sending takes the popup down along with
  // the detail (#3220), and the seed still names the record — the id is read
  // off the open record before the close clears it.
  test("record chat from the day popup closes the popup and keeps the record scope", async ({ page }) => {
    await page.goto("/collections/events");
    await page.getByTestId("collection-view-toggle-calendar").click();
    const cell = page.getByTestId(`collection-calendar-day-${MID}`);
    await cell.focus();
    await cell.press("Enter");
    await expect(page.getByTestId("collection-day-view")).toBeVisible();
    await page.getByTestId("collection-day-view-allday-launch").click();
    await expect(page.getByTestId("collection-day-view-detail")).toBeVisible();

    await page.getByTestId("collections-detail-chat-input").fill("when is this?");
    const agentPost = page.waitForRequest((req) => req.url().endsWith("/api/agent") && req.method() === "POST");
    await page.getByTestId("collections-detail-chat-send").click();

    expect((await agentPost).postDataJSON().message).toBe("/events id=launch when is this?");
    await expect(page.getByTestId("collection-day-view")).toHaveCount(0);
    await expect(page.getByTestId("collections-detail")).toHaveCount(0);
  });

  // The popup can now be dismissed by something that is not a close control —
  // sending the record chat box — which removes the focused textarea out from
  // under the user. Focus then sits on <body> and Tab restarts from the top of
  // the document. CollectionRecordModal has always restored focus to whatever
  // opened it; the day popup does too. Asserted on the X because it is the one
  // dismissal that does not also navigate away from the page holding the cell.
  test("closing the day popup returns focus to the day cell that opened it", async ({ page }) => {
    await page.goto("/collections/events");
    await page.getByTestId("collection-view-toggle-calendar").click();
    const cell = page.getByTestId(`collection-calendar-day-${MID}`);
    await cell.focus();
    await cell.press("Enter");
    await expect(page.getByTestId("collection-day-view")).toBeVisible();

    await page.getByTestId("collection-day-view-close").click();
    await expect(page.getByTestId("collection-day-view")).toHaveCount(0);
    await expect(cell).toBeFocused();
  });

  test("day view renders blocks, single lines, and the all-day strip from a time field", async ({ page }) => {
    await page.goto("/collections/agenda");
    await page.getByTestId("collection-view-toggle-calendar").click();
    // Activate the day cell (keyboard) to open the day view, clear of the chips.
    const cell = page.getByTestId(`collection-calendar-day-${MID}`);
    await cell.focus();
    await cell.press("Enter");
    await expect(page.getByTestId("collection-day-view")).toBeVisible();
    // "14:00-17:00" → a proportional block; "09:30" → a single line (both chips).
    const blockChip = page.getByTestId("collection-day-view-chip-block");
    await expect(blockChip).toBeVisible();
    await expect(page.getByTestId("collection-day-view-chip-line")).toBeVisible();
    // The chip shows a non-date/time field under the title, not the time range.
    await expect(blockChip).toContainText("Workshop");
    await expect(blockChip).toContainText("Room 5");
    await expect(blockChip).not.toContainText("14:00");
    // "終日" has no parseable clock → the bottom all-day strip.
    await expect(page.getByTestId("collection-day-view-allday-allday")).toBeVisible();
    // Selecting an entry opens its detail in the right pane; the popup stays open.
    await page.getByTestId("collection-day-view-chip-block").click();
    await expect(page.getByTestId("collection-day-view")).toBeVisible();
    await expect(page.getByTestId("collection-day-view-detail")).toBeVisible();
    await expect(page.getByTestId("collections-detail-title")).toHaveText("block");
  });

  test("day view all-day chips carry the enum colour, not the slate default", async ({ page }) => {
    await page.goto("/collections/colored-events");
    await page.getByTestId("collection-view-toggle-calendar").click();
    // Open the day via keyboard so the click doesn't land on (and select) the
    // record's chip — an unselected chip shows its palette colour.
    const cell = page.getByTestId(`collection-calendar-day-${MID}`);
    await cell.focus();
    await cell.press("Enter");
    await expect(page.getByTestId("collection-day-view")).toBeVisible();
    // The record has no time field → it lands in the all-day strip. Its enum
    // value "doing" (palette index 1 → sky) must tint the chip; before the fix
    // the all-day strip was hardcoded slate, dropping the colour.
    const chip = page.getByTestId("collection-day-view-allday-review");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveClass(/bg-sky-100/);
    await expect(chip).not.toHaveClass(/bg-slate-50/);
  });

  test("a Google mirror's all-day event stays on its day; the same dates in a plain collection span both", async ({ page }) => {
    const chipIn = (day: string) => page.getByTestId(`collection-calendar-day-${day}`).getByTestId("collection-calendar-chip-offsite");
    await page.goto("/collections/mirror");
    await page.getByTestId("collection-view-toggle-calendar").click();
    await expect(chipIn(MID)).toBeVisible();
    await expect(chipIn(NEXT)).toHaveCount(0);

    await page.goto("/collections/plain");
    await page.getByTestId("collection-view-toggle-calendar").click();
    await expect(chipIn(MID)).toBeVisible();
    await expect(chipIn(NEXT)).toBeVisible();
  });

  test("day-view create on a datetime-anchored collection prefills a valid datetime", async ({ page }) => {
    await page.goto("/collections/dtevents");
    await page.getByTestId("collection-view-toggle-calendar").click();
    // A datetime anchor still drives the day view (its clock renders the block)…
    const cell = page.getByTestId(`collection-calendar-day-${MID}`);
    await cell.focus();
    await cell.press("Enter");
    await expect(page.getByTestId("collection-day-view-chip-kickoff")).toBeVisible();
    await page.getByTestId("collection-day-view-create").click();
    // …and create seeds the datetime-local input with midnight (not a bare date).
    await expect(page.getByTestId("collections-create")).toBeVisible();
    await expect(page.getByTestId("collections-input-at")).toHaveValue(`${MID}T00:00`);
  });

  test("keyboard-activating a chip selects it into the day view's detail pane", async ({ page }) => {
    await page.goto("/collections/events");
    await page.getByTestId("collection-view-toggle-calendar").click();
    // Enter on a focused chip selects the record and opens the day view with its
    // detail in the right pane (the `.self` guard keeps the keydown from also
    // firing the cell's own open handler).
    const chip = page.getByTestId("collection-calendar-chip-launch");
    await chip.focus();
    await chip.press("Enter");
    await expect(page.getByTestId("collection-day-view-detail")).toBeVisible();
    await expect(page.getByTestId("collections-detail-title")).toHaveText("launch");
  });

  test("shows the toggle and a working calendar for an empty date-bearing collection", async ({ page }) => {
    await page.goto("/collections/events-empty");
    // Toggle is reachable even with zero records…
    await expect(page.getByTestId("collection-view-toggle-calendar")).toBeVisible();
    await page.getByTestId("collection-view-toggle-calendar").click();
    await expect(page.getByTestId("collection-calendar")).toBeVisible();
    // …and the day view's create affordance bootstraps the first record.
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-10`;
    await page.getByTestId(`collection-calendar-day-${day}`).click();
    await page.getByTestId("collection-day-view-create").click();
    await expect(page.getByTestId("collections-create")).toBeVisible();
    await expect(page.getByTestId("collections-input-on")).toHaveValue(day);
  });

  test("shows no calendar toggle for a date-less collection", async ({ page }) => {
    await page.goto("/collections/contacts");
    await expect(page.getByTestId("collections-row-jane")).toBeVisible();
    await expect(page.getByTestId("collection-view-toggle-calendar")).toHaveCount(0);
  });

  test("builtinViews.calendar=false hides the calendar toggle but keeps kanban", async ({ page }) => {
    await page.goto("/collections/colored-no-calendar");
    await expect(page.getByTestId("collection-view-toggle-kanban")).toBeVisible();
    await expect(page.getByTestId("collection-view-toggle-calendar")).toHaveCount(0);
  });

  test("builtinViews.kanban=false hides the kanban toggle; calendar chips keep the enum colour", async ({ page }) => {
    await page.goto("/collections/colored-no-kanban");
    await page.getByTestId("collection-view-toggle-calendar").click();
    await expect(page.getByTestId("collection-view-toggle-kanban")).toHaveCount(0);
    // "doing" → sky. The colour field must not depend on the kanban toggle being offered.
    await expect(page.getByTestId("collection-calendar-chip-review")).toHaveClass(/bg-sky-100/);
  });

  // The view-mode reload-survives test lives in collection-state-persist.spec.ts
  // alongside the rest of the shared localStorage state coverage.
});
