// E2E for useHealth — the /api/health fetch that populates the
// geminiAvailable + sandboxEnabled refs. The refs drive UI affordances
// in the header (lock icon + tooltip) and elsewhere. We exercise the
// two response shapes and verify the lock-button tooltip reflects
// them.

import { test, expect, type Page, type Route } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

import { ONE_SECOND_MS } from "../../server/utils/time.ts";

function urlEndsWith(suffix: string): (url: URL) => boolean {
  return (url) => url.pathname === suffix;
}

async function mockHealth(page: Page, body: { geminiAvailable: boolean; sandboxEnabled: boolean }) {
  await page.route(urlEndsWith("/api/health"), (route: Route) => route.fulfill({ json: body }));
}

test.describe("health check (useHealth)", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("sandboxEnabled=true → lock button shows 'Sandbox enabled' tooltip", async ({ page }) => {
    await mockHealth(page, { geminiAvailable: true, sandboxEnabled: true });
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    const lockBtn = page.getByTestId("sandbox-lock-button");
    await expect(lockBtn).toHaveAttribute("title", "Sandbox enabled (Docker)", {
      timeout: 3 * ONE_SECOND_MS,
    });
  });

  test("sandboxEnabled=false → lock button shows 'No sandbox' tooltip", async ({ page }) => {
    await mockHealth(page, { geminiAvailable: false, sandboxEnabled: false });
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    const lockBtn = page.getByTestId("sandbox-lock-button");
    await expect(lockBtn).toHaveAttribute("title", "No sandbox (Docker not found)", { timeout: 3 * ONE_SECOND_MS });
  });

  test("fetch failure defaults gemini off + keeps sandbox displayed", async ({ page }) => {
    // Return 500 so the try/catch in useHealth falls into the catch
    // branch (geminiAvailable → false, sandboxEnabled unchanged).
    await page.route(urlEndsWith("/api/health"), (route: Route) => route.fulfill({ status: 500 }));
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Page didn't crash — lock button still rendered.
    await expect(page.getByTestId("sandbox-lock-button")).toBeVisible();
  });
});
