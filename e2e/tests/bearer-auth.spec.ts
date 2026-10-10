// Bearer-token auth (#272) end-to-end smoke. Scope for Phase 1:
//
//   1. Vite plugin injects the token into `<meta name="mulmoclaude-auth">`
//      when serving index.html. `playwright.config.ts` sets
//      `MULMOCLAUDE_AUTH_TOKEN=e2e-test-token` so we have a
//      predictable value here.
//   2. Every request made by the Vue app through `apiFetch` carries
//      `Authorization: Bearer <token>`.
//
// We don't spawn the real Express server in E2E (only `yarn dev:client`),
// so the existing `mockAllApis` still intercepts `/api/*`. The
// intercept handlers inspect the Authorization header to prove the
// client is sending it correctly.

import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { E2E_AUTH_TOKEN } from "../fixtures/authToken";

test("meta tag contains the bearer token injected by Vite plugin", async ({ page }) => {
  await mockAllApis(page);
  await page.goto("/");

  const metaContent = await page.locator('meta[name="mulmoclaude-auth"]').getAttribute("content");
  expect(metaContent).toBe(E2E_AUTH_TOKEN);
});

test("apiFetch attaches Authorization: Bearer <token> to /api/* requests", async ({ page }) => {
  await mockAllApis(page);

  // Capture the Authorization header on the very first /api/health
  // request (triggered by useHealth composable on app boot).
  let capturedAuth: string | null = null;
  await page.route(
    (url) => url.pathname === "/api/health",
    async (route) => {
      capturedAuth = route.request().headers()["authorization"] ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "OK",
          geminiAvailable: false,
          sandboxEnabled: false,
        }),
      });
    },
  );

  await page.goto("/");
  // Wait for the boot-time health check to fire. The app renders the
  // title on mount; waiting for it gives the useHealth fetch time to
  // complete.
  await expect(page.getByTestId("app-title")).toBeVisible();

  expect(capturedAuth).toBe(`Bearer ${E2E_AUTH_TOKEN}`);
});
