// E2E for an all-day bare date (`YYYY-MM-DD`) stored in a `datetime` field.
// `datetime-local` renders such a value blank, and a save then writes the blank
// back — so the edit form must offer a date picker holding the value, at the
// top level and inside a table row alike.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const ALL_DAY = "2026-09-28";

const MEETINGS = {
  collection: {
    slug: "meetings",
    title: "Meetings",
    icon: "event",
    source: "user",
    schema: {
      title: "Meetings",
      icon: "event",
      dataPath: "data/meetings/items",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true, required: true },
        name: { type: "string", label: "Name", required: true },
        at: { type: "datetime", label: "At" },
        slots: { type: "table", label: "Slots", of: { when: { type: "datetime", label: "When" } } },
      },
      displayField: "name",
    },
  },
  items: [
    { id: "offsite", name: "Offsite", at: ALL_DAY, slots: [{ when: ALL_DAY }] },
    { id: "standup", name: "Standup", at: "2026-09-28T09:30", slots: [{ when: "2026-09-28T09:30" }] },
  ],
};

async function mockMeetings(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/collections/meetings",
    (route) => route.fulfill({ json: MEETINGS }),
  );
}

async function openEditor(page: Page, itemId: string): Promise<void> {
  await page.goto(`/collections/meetings?selected=${itemId}`);
  await expect(page.getByTestId("collections-detail")).toBeVisible();
  await page.getByTestId("collections-detail-edit").click();
}

test.describe("datetime field holding an all-day bare date", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
    await mockMeetings(page);
  });

  test("edits a bare date with a date picker that shows it, top level and in a table row", async ({ page }) => {
    await openEditor(page, "offsite");
    const topLevel = page.getByTestId("collections-input-at");
    await expect(topLevel).toHaveAttribute("type", "date");
    await expect(topLevel).toHaveValue(ALL_DAY);
    const rowInput = page.getByTestId("collections-table-slots").locator("input").first();
    await expect(rowInput).toHaveAttribute("type", "date");
    await expect(rowInput).toHaveValue(ALL_DAY);
  });

  test("keeps the date+time picker for a timed value", async ({ page }) => {
    await openEditor(page, "standup");
    await expect(page.getByTestId("collections-input-at")).toHaveAttribute("type", "datetime-local");
    await expect(page.getByTestId("collections-table-slots").locator("input").first()).toHaveAttribute("type", "datetime-local");
  });
});
