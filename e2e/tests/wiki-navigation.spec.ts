// URL-driven navigation for the wiki plugin.
//
// Covers the routing contract established by plans/done/feat-wiki-url-sync.md
// and updated to path-based URLs in plans/done/feat-wiki-path-urls.md:
//
// - /wiki                    → index
// - /wiki/pages/<slug>       → page view
// - /wiki/log                → activity log
// - /wiki/lint-report        → lint report
//
// Also regressions:
//
// - TDZ in the immediate route watcher (navError declared after callApi
//   meant direct /wiki loads silently did nothing and rendered
//   "Wiki is empty").
// - Mount-vs-watcher race on direct /wiki/log or /wiki/pages/<slug>
//   loads (useFreshPluginData's GET returned the index payload,
//   clobbering the POST-driven log / page state when it resolved last).

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const INDEX_PAYLOAD = {
  action: "index",
  title: "Wiki Index",
  content: "# Wiki Index\n\nRoot page.",
  pageEntries: [
    { title: "Onboarding", slug: "onboarding", description: "Getting started", tags: [] },
    { title: "Architecture", slug: "architecture", description: "How things fit", tags: [] },
  ],
};

const PAGE_ONBOARDING = {
  action: "page",
  title: "Onboarding",
  pageName: "onboarding",
  content: "# Onboarding\n\nWelcome to the project.",
};

const LOG_PAYLOAD = {
  action: "log",
  title: "Activity Log",
  content: "## 2026-04-22\n- Did stuff",
};

// Slugs that the router MUST pass through unchanged to the API body.
// Reserved URL characters (space, `%`, `#`, `?`, `+`) are each a
// classic path-segment gotcha: the browser / Vue Router either
// percent-encodes them on push and decodes on read, or (if something
// is broken) collapses / mangles them. `%2F` in the address bar
// decodes to `/` in `route.params.slug` but it's a LEGAL slug in some
// workflows (pages keyed by a slug containing a literal slash) — the
// guard rejects it via `isSafeWikiSlug`, see DANGEROUS_URLS below.
// `..` is a security token (see DANGEROUS_URLS) so it is NOT in this
// table. Non-ASCII characters round-trip via UTF-8 percent-encoding
// and are included to lock in that behaviour.
const SAFE_SLUGS: readonly { label: string; slug: string }[] = [
  { label: "ASCII baseline", slug: "plain-ascii" },
  { label: "space", slug: "my notes" },
  { label: "percent literal", slug: "100%done" },
  { label: "hash/fragment char", slug: "#1-priority" },
  { label: "question mark", slug: "how-to?" },
  { label: "plus sign", slug: "C++tips" },
  { label: "ampersand", slug: "Q&A" },
  { label: "parens", slug: "note (copy 1)" },
  { label: "Japanese (kanji + kana)", slug: "さくらインターネット" },
  { label: "Korean (hangul)", slug: "한국어메모" },
  { label: "emoji (surrogate pair)", slug: "🎉party" },
];

// URLs that the router guard MUST redirect to `/wiki` without
// rendering a page. `%2F` decodes to `/` in route.params.slug, and
// `..%2Fsecrets` decodes to `../secrets` — both would otherwise reach
// the server's `wikiSlugify` fuzzy matcher and could match a different
// page. `/wiki/pages` (no slug) is malformed by construction.
const DANGEROUS_URLS: readonly { label: string; url: string }[] = [
  { label: "%2F in slug (decodes to /)", url: `/wiki/pages/${encodeURIComponent("a/b")}` },
  { label: "traversal via %2F", url: `/wiki/pages/${encodeURIComponent("../secrets")}` },
  { label: "bare `..` in slug", url: `/wiki/pages/${encodeURIComponent("..")}` },
  { label: "backslash in slug", url: `/wiki/pages/${encodeURIComponent("a\\b")}` },
  // `/wiki/pages` with no trailing slug matches the route regex
  // (section=pages, slug=undefined) and the guard bounces it.
  { label: "missing slug on pages section", url: "/wiki/pages" },
];

function pagePayload(slug: string) {
  // Unique per slug so the test can assert "THIS slug rendered"
  // rather than "some page rendered".
  return {
    action: "page",
    title: slug,
    pageName: slug,
    content: `# ${slug}\n\nSENTINEL-BODY ${slug}`,
  };
}

async function mockWikiApi(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/wiki",
    async (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        const slug = new URL(req.url()).searchParams.get("slug");
        if (slug === "onboarding") return route.fulfill({ json: { data: PAGE_ONBOARDING } });
        if (slug) return route.fulfill({ json: { data: pagePayload(slug) } });
        return route.fulfill({ json: { data: INDEX_PAYLOAD } });
      }
      if (req.method() === "POST") {
        const body = (req.postDataJSON() ?? {}) as { action?: string; pageName?: string };
        if (body.action === "page" && body.pageName === "onboarding") {
          return route.fulfill({ json: { data: PAGE_ONBOARDING } });
        }
        if (body.action === "page" && body.pageName) {
          return route.fulfill({ json: { data: pagePayload(body.pageName) } });
        }
        if (body.action === "log") return route.fulfill({ json: { data: LOG_PAYLOAD } });
        return route.fulfill({ json: { data: INDEX_PAYLOAD } });
      }
      return route.fallback();
    },
  );
}

test.describe("wiki navigation — URL sync", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
    await mockWikiApi(page);
  });

  test("direct /wiki load renders the index page list", async ({ page }) => {
    // Regression guard: a TDZ inside the immediate URL watcher used to
    // swallow the POST silently and leave the view stuck on the empty
    // state.
    await page.goto("/wiki");
    await expect(page.getByTestId("wiki-page-entry-onboarding")).toBeVisible();
    await expect(page.getByTestId("wiki-page-entry-architecture")).toBeVisible();
    // Empty-state copy must NOT show when the index has entries.
    await expect(page.getByText("Wiki is empty", { exact: false })).toHaveCount(0);
  });

  test("clicking a page card updates the URL and renders the page", async ({ page }) => {
    await page.goto("/wiki");
    await expect(page.getByTestId("wiki-page-entry-onboarding")).toBeVisible();

    await page.getByTestId("wiki-page-entry-onboarding").click();

    await page.waitForURL(/\/wiki\/pages\/onboarding$/);
    // h1 comes from the rendered page markdown; h2 is the view header.
    await expect(page.getByRole("heading", { level: 1, name: "Onboarding" })).toBeVisible();
    await expect(page.getByText("Welcome to the project.")).toBeVisible();
  });

  test("clicking the Log tab switches to /wiki/log", async ({ page }) => {
    await page.goto("/wiki");
    await expect(page.getByText("Onboarding")).toBeVisible();

    await page.getByRole("button", { name: /Log/ }).click();

    await page.waitForURL(/\/wiki\/log$/);
    await expect(page.getByText("Did stuff")).toBeVisible();
  });

  test("direct /wiki/log load renders log content, not index", async ({ page }) => {
    // Regression guard: useFreshPluginData's mount GET returns the
    // index payload; if it resolves after the POST-driven log fetch
    // on a direct load, the log content was clobbered.
    await page.goto("/wiki/log");

    await expect(page.getByText("Did stuff")).toBeVisible();
    // Page-card rows from the index must not appear here.
    await expect(page.getByTestId("wiki-page-entry-onboarding")).toHaveCount(0);
    await expect(page.getByTestId("wiki-page-entry-architecture")).toHaveCount(0);
  });

  test("direct /wiki/pages/onboarding load renders the page", async ({ page }) => {
    await page.goto("/wiki/pages/onboarding");

    await expect(page.getByRole("heading", { level: 1, name: "Onboarding" })).toBeVisible();
    await expect(page.getByText("Welcome to the project.")).toBeVisible();
  });

  test("clicking an in-content [[wiki-link]] resets scrollTop on the destination page", async ({ page }) => {
    // Regression guard: the action='page' Content tab container kept
    // its scrollTop across page->page navigation because it was the
    // only branch missing ref="scrollRef", so the watch(content)
    // reset silently no-op'd. The destination page would land at
    // wherever the source page was scrolled to, not at the top.
    const filler = "Filler paragraph for scrollable height.\n\n".repeat(80);
    const PAGE_FROM = {
      action: "page",
      title: "from-page",
      pageName: "from-page",
      content: `# From\n\n${filler}\nGo to [[to-page]] now.\n`,
    };
    const PAGE_TO = {
      action: "page",
      title: "to-page",
      pageName: "to-page",
      content: `# To\n\nSENTINEL-DEST-TOP\n\n${filler}`,
    };
    await page.route(
      (url) => url.pathname === "/api/wiki",
      async (route) => {
        const body = (route.request().postDataJSON() ?? {}) as { pageName?: string };
        if (body.pageName === "from-page") return route.fulfill({ json: { data: PAGE_FROM } });
        if (body.pageName === "to-page") return route.fulfill({ json: { data: PAGE_TO } });
        return route.fulfill({ json: { data: INDEX_PAYLOAD } });
      },
    );

    await page.goto("/wiki/pages/from-page");
    const wikiBody = page.getByTestId("wiki-page-body");
    await expect(wikiBody).toBeVisible();
    // The scrollable container is WikiPageBody's parent — the div
    // that now carries ref="scrollRef" in src/plugins/wiki/View.vue.
    const scrollContainer = wikiBody.locator("xpath=..");
    const SOURCE_SCROLL_PX = 400;
    await scrollContainer.evaluate((element, top) => {
      element.scrollTop = top as number;
    }, SOURCE_SCROLL_PX);
    expect(await scrollContainer.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await page.locator('.wiki-link[data-page="to-page"]').click();
    await page.waitForURL(/\/wiki\/pages\/to-page$/);
    await expect(page.getByText("SENTINEL-DEST-TOP")).toBeVisible();

    // Same DOM container is reused (action stays 'page'); the fix's
    // ref="scrollRef" lets the watch(content) reset scrollTop to 0.
    await expect(scrollContainer).toHaveJSProperty("scrollTop", 0, { timeout: 2000 });
  });

  test("navigating from a page back to the index strips the slug from the URL (#655 follow-up)", async ({ page }) => {
    // Regression: buildWikiRouteParams({ kind: "index" }) used to
    // return `{}`, but Vue Router's named-route navigation does NOT
    // clear previously-set optional params. The old URL `section` /
    // `slug` would leak into the push, leaving the user on
    // `/wiki/pages/foo` after clicking the Index tab, while the View
    // rendered the index. Empty-string params now force a clean URL.
    await page.goto("/wiki/pages/onboarding");
    await expect(page.getByRole("heading", { level: 1, name: "Onboarding" })).toBeVisible();

    // Click the Index tab (first button in the tab bar).
    await page.getByRole("button", { name: /Index/ }).click();

    await expect(async () => {
      const parsed = new URL(page.url());
      expect(parsed.pathname).toMatch(/^\/wiki\/?$/);
    }).toPass({ timeout: 5000 });
    await expect(page.getByTestId("wiki-page-entry-onboarding")).toBeVisible();
  });

  test("navigating from a page to the log clears the slug (#655 follow-up)", async ({ page }) => {
    // Same stale-param concern as the index case, but the log
    // destination still has a section — only the slug needs
    // clearing. `/wiki/pages/foo` → log click must land on
    // `/wiki/log`, not `/wiki/log/foo`.
    await page.goto("/wiki/pages/onboarding");
    await expect(page.getByRole("heading", { level: 1, name: "Onboarding" })).toBeVisible();

    await page.getByRole("button", { name: /Log/ }).click();

    await page.waitForURL(/\/wiki\/log$/);
    await expect(page.getByText("Did stuff")).toBeVisible();
  });

  // Table-driven round-trip for reserved / non-ASCII characters:
  // navigate straight to /wiki/pages/<encoded>, assert the API saw
  // the decoded slug verbatim (sentinel body renders in the DOM).
  // Mirrors the fixture table in e2e/tests/files-path-url.spec.ts.
  for (const { label, slug } of SAFE_SLUGS) {
    test(`safe slug round-trips: ${label}`, async ({ page }) => {
      await page.goto(`/wiki/pages/${encodeURIComponent(slug)}`);
      await expect(page.getByText(`SENTINEL-BODY ${slug}`).first()).toBeVisible();
    });
  }

  // Guard-rejection table. The router guard in `src/router/guards.ts`
  // must intercept each of these before the view runs — landing the
  // user on `/wiki` (index) and NEVER hitting the page fetch for the
  // dangerous slug.
  for (const { label, url } of DANGEROUS_URLS) {
    test(`guard redirects to /wiki: ${label}`, async ({ page }) => {
      // Fail loudly if anything ever asks for the dangerous page —
      // this is the whole point of the guard.
      const forbiddenRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().endsWith("/api/wiki") && req.method() === "POST") {
          const body = (req.postDataJSON() ?? {}) as { action?: string; pageName?: string };
          if (body.action === "page" && body.pageName) forbiddenRequests.push(body.pageName);
        }
      });

      await page.goto(url);

      // Guard replaces to /wiki — final URL has no path / log / lint
      // segment, and the index renders.
      await expect(page.getByTestId("wiki-page-entry-onboarding")).toBeVisible();
      await expect(async () => {
        const parsed = new URL(page.url());
        // Accept `/wiki` or `/wiki/` — `replace:true` with empty
        // params may yield either depending on browser normalisation.
        expect(parsed.pathname).toMatch(/^\/wiki\/?$/);
      }).toPass({ timeout: 5000 });

      // Defence-in-depth: check no page fetch was made for any
      // dangerous pageName. (It's OK for the index to fetch.)
      expect(forbiddenRequests).toEqual([]);
    });
  }
});

test.describe("wiki navigation — from manageWiki tool result", () => {
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
    await mockWikiApi(page);

    // Session transcript with a manageWiki INDEX tool result.
    await page.route(
      (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
      (route) =>
        route.fulfill({
          json: [
            { type: "session_meta", roleId: "general", sessionId: "wiki-session" },
            { type: "text", source: "user", message: "Show the wiki" },
            {
              type: "tool_result",
              source: "tool",
              result: {
                uuid: "wiki-index-result",
                toolName: "manageWiki",
                title: INDEX_PAYLOAD.title,
                message: "Index loaded",
                data: INDEX_PAYLOAD,
              },
            },
          ],
        }),
    );
  });

  test("clicking a page card in a tool-result index navigates to /wiki", async ({ page }) => {
    await page.goto("/chat/wiki-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Select the wiki index tool result in the right sidebar.
    await page.getByText(`Wiki Index`, { exact: false }).first().click();
    await expect(page.getByTestId("wiki-page-entry-onboarding")).toBeVisible();

    await page.getByTestId("wiki-page-entry-onboarding").click();

    // From /chat, clicking a page card should land on the shareable
    // wiki path. Chat-specific params like ?result= must NOT bleed
    // through — the URL should be exactly /wiki/pages/<slug>.
    await page.waitForURL(/\/wiki\/pages\/onboarding$/);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/wiki/pages/onboarding");
    expect(url.search).toBe("");
    await expect(page.getByRole("heading", { level: 1, name: "Onboarding" })).toBeVisible();
  });

  test("Chat button returns to /chat from /wiki (session-tab bar is chat-only)", async ({ page }) => {
    await page.goto("/chat/wiki-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Leave /chat for /wiki. The session-history chrome is now
    // chat-only, so the session-tab bar unmounts off /chat.
    await page.goto("/wiki");
    await expect(page.getByTestId("wiki-page-entry-onboarding")).toBeVisible();
    expect(page.url()).toContain("/wiki");
    await expect(page.getByTestId("session-tab-wiki-session")).toBeHidden();

    // The always-visible Chat button in the top bar is the way back
    // into a conversation (resumes the most recent chat).
    await page.getByTestId("plugin-launcher-chat").click();
    await page.waitForURL(/\/chat\//);
    expect(new URL(page.url()).pathname).toMatch(/^\/chat\//);
  });
});
