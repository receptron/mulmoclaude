import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

test.describe("LockStatusPopup", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("clicking the lock button opens the popup", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    const lockBtn = page.getByTestId("sandbox-lock-button");
    await expect(lockBtn).toBeVisible();

    // Popup is not visible initially.
    await expect(page.getByTestId("sandbox-test-query").first()).toBeHidden();

    await lockBtn.click();

    // Sandbox test query buttons appear. The exact count is the
    // length of SANDBOX_TEST_QUERIES in LockStatusPopup.vue — keep
    // them in sync when adding / removing sample queries.
    const queries = page.getByTestId("sandbox-test-query");
    await expect(queries.first()).toBeVisible();
    await expect(queries).toHaveCount(5);
  });

  test("clicking a test query closes the popup", async ({ page }) => {
    // Block the agent route so sendMessage doesn't try to stream —
    // we only care that the popup closes after the click.
    await page.route(
      (url) => url.pathname === "/api/agent",
      (route) => route.fulfill({ status: 500, body: "" }),
    );

    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByTestId("sandbox-lock-button").click();

    const firstQuery = page.getByTestId("sandbox-test-query").first();
    await expect(firstQuery).toBeVisible();
    await firstQuery.click();

    await expect(firstQuery).toBeHidden();
  });

  test("clicking outside closes the popup", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByTestId("sandbox-lock-button").click();

    const firstQuery = page.getByTestId("sandbox-test-query").first();
    await expect(firstQuery).toBeVisible();

    // Click somewhere neutral (the main chat area, not the button /
    // popup) — the click-outside guard should close the popup.
    await page.locator("body").click({ position: { x: 400, y: 400 } });

    await expect(firstQuery).toBeHidden();
  });

  test("credential block renders live /api/sandbox state when enabled", async ({ page }) => {
    // Override /api/health so the popup takes the sandbox-on branch,
    // and /api/sandbox so the credential block gets data to render.
    // Registered BEFORE mockAllApis below so Playwright's
    // "last-registered-first" order picks these up.
    await page.route(
      (url) => url.pathname === "/api/health",
      (route) =>
        route.fulfill({
          json: { status: "OK", geminiAvailable: false, sandboxEnabled: true },
        }),
    );
    await page.route(
      (url) => url.pathname === "/api/sandbox",
      (route) =>
        route.fulfill({
          json: { sshAgent: true, mounts: ["gh", "gitconfig"] },
        }),
    );

    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByTestId("sandbox-lock-button").click();

    // The credential block only renders when sandbox is enabled,
    // distinguishing it from the "no sandbox" branch (which hides
    // the block entirely).
    await expect(page.getByTestId("sandbox-credentials-block")).toBeVisible();

    const sshLine = page.getByTestId("sandbox-credentials-ssh");
    await expect(sshLine).toContainText("forwarded");
    // The negative string ("not forwarded") starts with "not" — check
    // it isn't leaking into the positive case.
    await expect(sshLine).not.toContainText("not forwarded");

    const mountsLine = page.getByTestId("sandbox-credentials-mounts");
    await expect(mountsLine).toContainText("gh, gitconfig");
  });

  test("credential block hides when sandbox is disabled", async ({ page }) => {
    // The default mockAllApis returns sandboxEnabled=false, which is
    // exactly this branch. Nothing to override; the popup just opens
    // and the credential block should be absent.
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByTestId("sandbox-lock-button").click();

    // Query buttons appear (sandbox-off popup still has them)…
    await expect(page.getByTestId("sandbox-test-query").first()).toBeVisible();
    // …but the credential block is gated on sandboxEnabled.
    await expect(page.getByTestId("sandbox-credentials-block")).toBeHidden();
  });
});
