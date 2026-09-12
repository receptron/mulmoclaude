// Regression guard for the wiki renderer's full path:
//
//   rewriteMarkdownImageRefs(...) -> renderWikiLinks(...) -> marked.parse(...)
//
// `files-html-preview.spec.ts` covers the rewrite-through-FilesView
// path; this spec exercises the wiki plugin's own View so the three
// transformers can't drift independently (e.g. if someone reorders
// them and accidentally feeds marked's HTML into rewriteMarkdownImageRefs
// which expects raw markdown).

import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const WIKI_PAGE = {
  action: "page",
  title: "Onboarding",
  pageName: "onboarding",
  content: "# Onboarding\n\nSee the [[setup]] guide.\n\n![flow](../images/flow.png)\n",
};

test.describe("wiki plugin — rendering", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page, {
      sessions: [
        {
          id: "wiki-session",
          title: "Wiki Session",
          roleId: "general",
          startedAt: "2026-04-12T10:00:00Z",
          updatedAt: "2026-04-12T10:05:00Z",
        },
      ],
    });

    // Session transcript with a manageWiki tool result whose data
    // includes a page with a relative-up image ref.
    await page.route(
      (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
      (route) =>
        route.fulfill({
          json: [
            {
              type: "session_meta",
              roleId: "general",
              sessionId: "wiki-session",
            },
            { type: "text", source: "user", message: "Open onboarding" },
            {
              type: "tool_result",
              source: "tool",
              result: {
                uuid: "wiki-result-1",
                toolName: "manageWiki",
                title: WIKI_PAGE.title,
                message: "Page loaded",
                data: WIKI_PAGE,
              },
            },
          ],
        }),
    );

    // useFreshPluginData re-fetches on mount; hand it back the same
    // page payload so the watch-triggered refresh doesn't blank the
    // content.
    await page.route(
      (url) => url.pathname === "/api/wiki",
      (route) => route.fulfill({ json: { data: WIKI_PAGE } }),
    );
  });

  test("renders a relative image ref via /api/files/raw", async ({ page }) => {
    await page.goto("/chat/wiki-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Select the wiki tool result in the sidebar → mounts the wiki View.
    // Preview renders as "Wiki: <title>".
    await page.getByText(`Wiki: ${WIKI_PAGE.title}`).click();

    // marked.parse turns `![flow](...)` into an <img alt="flow">.
    const img = page.locator("img[alt='flow']");
    await expect(img).toBeVisible();
    const src = await img.getAttribute("src");
    // basePath for a wiki page is `wiki/pages`, so `../images/flow.png`
    // resolves to `wiki/images/flow.png` and is routed through the
    // workspace file server.
    expect(src).toContain("/api/files/raw");
    expect(src).toContain("flow.png");
    // Relative-up prefix stripped.
    expect(src).not.toContain("..");
  });
});
