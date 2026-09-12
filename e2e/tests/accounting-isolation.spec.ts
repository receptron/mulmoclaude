// Accounting plugin surface guard. The accounting (double-entry
// bookkeeping) app has a first-class UI entry point — a launcher
// button and a /accounting route — reachable by any user regardless
// of role. What stays role-gated is the `manageAccounting` *tool*
// (LLM access): it must NOT appear in the default (General) Role's
// availablePlugins. This file guards both halves of that contract:
// the UI entry point is present, and the tool surface stays clean.

import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

test.beforeEach(async ({ page }) => {
  await mockAllApis(page);
});

test.describe("accounting plugin — UI entry point + tool isolation", () => {
  test("PluginLauncher renders an accounting button that navigates to /accounting", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForURL(/\/chat\//);
    await expect(page.getByTestId("app-title")).toBeVisible();
    // The launcher buttons use plugin-launcher-{key} testids; the
    // accounting plugin registers one in the first group.
    const accountingButton = page.getByTestId("plugin-launcher-accounting");
    await expect(accountingButton).toHaveCount(1);
    await accountingButton.click();
    await page.waitForURL(/\/accounting$/);
    await expect(page.getByTestId("accounting-app")).toBeVisible();
  });

  test("/accounting URL resolves to the accounting view", async ({ page }) => {
    await page.goto("/accounting");
    await expect(page.getByTestId("app-title")).toBeVisible();
    const { pathname } = new URL(page.url());
    expect(pathname).toBe("/accounting");
    await expect(page.getByTestId("accounting-app")).toBeVisible();
  });

  test("Roles settings tab surfaces no manageAccounting plugin on a fresh workspace", async ({ page }) => {
    // Smoke check that the Roles tab (Settings modal → Roles) doesn't
    // accidentally surface the accounting tool — currently passes
    // because the Roles view only renders custom roles on a fresh
    // workspace, so the assertion is more of a "the surface is clean"
    // guard than a strict role-config check.
    //
    // The strict "the General role's availablePlugins must not
    // include manageAccounting" invariant lives in
    // test/roles/test_role_schema.ts (`describe("General role
    // isolation")`). That unit test is the real regression guard;
    // this e2e check stays as a defense against a future RolesView
    // change that starts surfacing built-in role plugin lists with
    // manageAccounting on display.
    //
    // Roles moved out of the standalone /roles route into the Settings
    // modal, so we reach the surface via the gear button → Roles tab.
    await page.goto("/chat");
    await page.waitForURL(/\/chat\//);
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("settings-tab-roles").click();
    await expect(page.getByTestId("roles-view-root")).toBeVisible();
    await expect(page.getByText("manageAccounting")).toHaveCount(0);
  });
});
