// Tests for internal workspace link handling:
//
// 1. Sidebar preview cards: clicking a card with <a> tags in its
//    markdown preview should select the result, NOT follow the link.
// 2. Text-response content: clicking a workspace-path link should
//    navigate to the appropriate view (wiki, files) instead of
//    creating a new session.
// 3. External links in text-response should still open normally
//    (not intercepted by workspace routing).

import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

// A text-response whose markdown body contains a workspace-path link
// (wiki page) and an external link.
const TEXT_WITH_LINKS = {
  text: "Created page: [Test Page](data/wiki/pages/test-page.md)\n\nSource: [External](https://example.com)\n\nSee also: [config](config/settings.json)",
  role: "assistant",
};

const WIKI_INDEX = {
  action: "index",
  title: "Wiki Index",
  content: "# Wiki Index\n\n- [Test Page](pages/test-page.md) — test",
  pageEntries: [{ title: "Test Page", slug: "test-page", description: "test" }],
};

const WIKI_PAGE = {
  action: "page",
  title: "test-page",
  content: "# Test Page\n\nContent here.",
  pageName: "test-page",
};

test.describe("internal link navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page, {
      sessions: [
        {
          id: "link-test-session",
          title: "Link Test",
          roleId: "general",
          startedAt: "2026-04-20T10:00:00Z",
          updatedAt: "2026-04-20T10:05:00Z",
          preview: "Created page",
        },
      ],
    });

    // Session transcript with a text-response containing workspace links.
    await page.route(
      (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
      (route) => {
        const method = route.request().method();
        if (method === "POST") return route.fulfill({ json: { ok: true } });
        return route.fulfill({
          json: [
            { type: "session_meta", roleId: "general", sessionId: "link-test-session" },
            { type: "text", source: "user", message: "Create a wiki page" },
            {
              type: "tool_result",
              source: "tool",
              result: {
                uuid: "text-result-1",
                toolName: "text-response",
                title: "Assistant",
                message: "Created page",
                data: TEXT_WITH_LINKS,
              },
            },
          ],
        });
      },
    );

    // Wiki API mock: index and page responses.
    await page.route(
      (url) => url.pathname === "/api/wiki",
      (route) => {
        const method = route.request().method();
        if (method === "GET") {
          const slug = new URL(route.request().url()).searchParams.get("slug");
          if (slug) return route.fulfill({ json: { data: WIKI_PAGE } });
          return route.fulfill({ json: { data: WIKI_INDEX } });
        }
        // POST: page navigation
        return route.fulfill({ json: { data: WIKI_PAGE } });
      },
    );
  });

  test("sidebar preview link click selects result without navigating away", async ({ page }) => {
    await page.goto("/chat/link-test-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // The sidebar should show the text-response preview card.
    const previewCard = page.getByTestId("tool-results-scroll").locator("> div.cursor-pointer").nth(1);
    await expect(previewCard).toBeVisible();

    // Click the preview card (which contains markdown-rendered <a> tags).
    await previewCard.click();

    // Should still be on the same session (not a new session).
    await expect(page).toHaveURL(/\/chat\/link-test-session/);
  });

  test("clicking workspace wiki link navigates to wiki view", async ({ page }) => {
    await page.goto("/chat/link-test-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Select the text-response result to show it in the canvas.
    const previewCard = page.getByTestId("tool-results-scroll").locator("> div.cursor-pointer").nth(1);
    await previewCard.click();

    // Find the wiki page link in the rendered markdown content.
    const wikiLink = page.locator('.text-response-content-wrapper a[href*="wiki/pages"]');
    await expect(wikiLink).toBeVisible();

    // Click the workspace link.
    await wikiLink.click();

    // Should navigate to the /wiki/pages/<slug> path.
    await expect(page).toHaveURL(/\/wiki\/pages\/test-page$/);
  });

  test("clicking workspace file link navigates to files view", async ({ page }) => {
    await page.goto("/chat/link-test-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Select the text-response result.
    const previewCard = page.getByTestId("tool-results-scroll").locator("> div.cursor-pointer").nth(1);
    await previewCard.click();

    // Find the config file link.
    const fileLink = page.locator('.text-response-content-wrapper a[href="config/settings.json"]');
    await expect(fileLink).toBeVisible();

    // Click the file link.
    await fileLink.click();

    // Should navigate to /files/<path> (PR #633 migrated from
    // query-string to path-based form — `/files/config/settings.json`
    // rather than `/files?path=config/settings.json`).
    await expect(page).toHaveURL(/\/files\/config\/settings\.json$/);
  });
});
