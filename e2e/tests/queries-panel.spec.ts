// E2E for the role-specific "quick queries" panel extracted into
// useQueriesPanel. The default role has a non-empty `queries` array
// so the Suggestions button is rendered on every session mount.

import { test, expect, type Page, type Route } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

import { ONE_SECOND_MS } from "../../server/utils/time.ts";

function urlEndsWith(suffix: string): (url: URL) => boolean {
  return (url) => url.pathname === suffix;
}

// Capture the POST body sent to /api/agent so we can assert that a
// click on a quick-query actually fired sendMessage with the right
// text.
async function captureAgentPost(page: Page): Promise<{ getBody: () => string | null }> {
  let capturedBody: string | null = null;
  await page.route(urlEndsWith("/api/agent"), (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    capturedBody = route.request().postData();
    // Return an empty SSE stream so sendMessage resolves cleanly.
    return route.fulfill({
      body: "\n",
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  return { getBody: () => capturedBody };
}

test.describe("queries panel (useQueriesPanel)", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("Suggestions button toggles the query list", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    const toggle = page.getByTestId("suggestions-btn");
    await expect(toggle).toBeVisible();

    // Pick a known query from the default role (see src/config/roles.ts).
    const firstQuery = page.getByRole("button", {
      name: "Tell me about this app, MulmoClaude.",
    });
    await expect(firstQuery).toBeHidden();

    await toggle.click();
    await expect(firstQuery).toBeVisible();

    await toggle.click();
    await expect(firstQuery).toBeHidden();
  });

  test("plain click on a query sends it as a message", async ({ page }) => {
    const captured = await captureAgentPost(page);
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    await page.getByTestId("suggestions-btn").click();
    const query = page.getByRole("button", {
      name: "Tell me about this app, MulmoClaude.",
    });
    await expect(query).toBeVisible();
    await query.click();

    // sendMessage posts to /api/agent with the query text in the body.
    await expect.poll(() => captured.getBody(), { timeout: 3 * ONE_SECOND_MS }).not.toBeNull();
    const body = captured.getBody();
    expect(body).toContain("Tell me about this app, MulmoClaude.");

    // Panel collapses after click.
    await expect(query).toBeHidden();
  });

  test("Shift+click on a query fills the input without sending", async ({ page }) => {
    const captured = await captureAgentPost(page);
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    await page.getByTestId("suggestions-btn").click();
    const query = page.getByRole("button", {
      name: "Tell me about this app, MulmoClaude.",
    });
    await expect(query).toBeVisible();
    await query.click({ modifiers: ["Shift"] });

    // Textarea now contains the query text…
    const textarea = page.getByTestId("user-input");
    await expect(textarea).toHaveValue("Tell me about this app, MulmoClaude.");

    // …and no message was sent.
    // eslint-disable-next-line sonarjs/no-fixed-wait-in-tests -- negative assertion: Shift+click fills the input but must NOT send; the absence of an /api/agent POST has no observable signal.
    await page.waitForTimeout(300);
    expect(captured.getBody()).toBeNull();
  });
});
