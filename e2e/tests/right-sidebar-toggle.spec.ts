// E2E for useRightSidebar — the button that opens/closes the Tool
// Call History sidebar, and the localStorage persistence of that
// preference. Companion to localstorage.spec.ts, which covers the
// reload path; this file covers the interactive toggle path.

import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

test.describe("right sidebar toggle (useRightSidebar)", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("clicking the header button shows/hides the sidebar", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // The sidebar has a unique heading "Tool Call History" (h2).
    const sidebarHeading = page.getByRole("heading", {
      name: "Tool Call History",
    });
    await expect(sidebarHeading).toBeHidden();

    const toggleBtn = page.getByTitle("Tool call history", { exact: true });
    await toggleBtn.click();
    await expect(sidebarHeading).toBeVisible();

    await toggleBtn.click();
    await expect(sidebarHeading).toBeHidden();
  });

  test("toggle state persists to localStorage", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    await page.getByTitle("Tool call history", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Tool Call History" })).toBeVisible();

    const stored = await page.evaluate(() => localStorage.getItem("right_sidebar_visible"));
    expect(stored).toBe("true");

    // Close → stored becomes "false".
    await page.getByTitle("Tool call history", { exact: true }).click();
    const stored2 = await page.evaluate(() => localStorage.getItem("right_sidebar_visible"));
    expect(stored2).toBe("false");
  });

  test("is hidden on plugin views even when the preference is on", async ({ page }) => {
    // User has the panel toggled on — should still hide on wiki /
    // automations etc. because those views have no agent context.
    // (Skills/Roles moved into the Settings modal, so /skills and
    // /roles are no longer plugin routes — they redirect to /chat.)
    await page.addInitScript(() => localStorage.setItem("right_sidebar_visible", "true"));

    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();
    // Panel and toggle button both visible on chat.
    await expect(page.getByRole("heading", { name: "Tool Call History" })).toBeVisible();
    await expect(page.getByTitle("Tool call history", { exact: true })).toBeVisible();

    for (const route of ["/wiki", "/automations", "/files"] as const) {
      await page.goto(route);
      await expect(page.getByTestId("app-title")).toBeVisible();
      // Panel content gone.
      await expect(page.getByRole("heading", { name: "Tool Call History" })).toBeHidden();
      // Toggle button gone (dead control suppression).
      await expect(page.getByTitle("Tool call history", { exact: true })).toBeHidden();
    }

    // Returning to chat restores the panel at the user's saved preference.
    await page.goto("/chat");
    await expect(page.getByRole("heading", { name: "Tool Call History" })).toBeVisible();
    await expect(page.getByTitle("Tool call history", { exact: true })).toBeVisible();
  });
});
