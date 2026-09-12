import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { SESSION_A, SESSION_B } from "../fixtures/sessions";

import { ONE_SECOND_MS } from "../../server/utils/time.ts";

test.beforeEach(async ({ page }) => {
  await mockAllApis(page);
});

// Helper: open the session-history side panel and wait for sessions
// to load. The toggle is idempotent — callers that open the panel
// twice in a row (e.g. between two session selects) should call
// this helper both times; selecting a session does not auto-close
// the panel.
async function openHistoryWithSessions(page: Page) {
  const toggle = page.getByTestId("session-history-toggle-off");
  // Panel is only closed when the off-state toggle is present; no-op
  // if the panel is already open.
  if (await toggle.isVisible()) {
    await toggle.click();
  }
  await page.locator(`[data-testid="session-item-${SESSION_A.id}"]`).waitFor({ state: "visible", timeout: 5 * ONE_SECOND_MS });
}

test.describe("session navigation via URL", () => {
  test("/ redirects to /chat with a session ID in the URL", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/\/chat\//);
    expect(page.url()).toMatch(/\/chat\/[\w-]+/);
  });

  test("/chat creates a new session", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForURL(/\/chat\//);
    expect(page.url()).toMatch(/\/chat\/[\w-]+/);
  });

  test("clicking a session in history changes the URL", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForURL(/\/chat\//);

    await openHistoryWithSessions(page);
    await page.locator(`[data-testid="session-item-${SESSION_A.id}"]`).click();

    await page.waitForURL(new RegExp(SESSION_A.id));
    expect(page.url()).toContain(SESSION_A.id);
  });

  test("browser back / forward round-trips the previous session", async ({ page }) => {
    // With /history gone, the side panel is DOM state, not a route.
    // Stack after two session selects: [..., /chat/<initial>,
    // /chat/A, /chat/B]. Back → /chat/A, forward → /chat/B.
    await page.goto("/chat");
    await page.waitForURL(/\/chat\//);

    await openHistoryWithSessions(page);
    await page.locator(`[data-testid="session-item-${SESSION_A.id}"]`).click();
    await page.waitForURL(new RegExp(SESSION_A.id));

    await page.locator(`[data-testid="session-item-${SESSION_B.id}"]`).click();
    await page.waitForURL(new RegExp(SESSION_B.id));

    await page.goBack();
    await page.waitForURL(new RegExp(SESSION_A.id));

    await page.goForward();
    await page.waitForURL(new RegExp(SESSION_B.id));
    // Explicit URL assertion — waitForURL above already throws on
    // timeout, but the linter's assertion detector doesn't recognise
    // `waitForURL` as one. This restates the same contract.
    expect(page.url()).toContain(SESSION_B.id);
  });

  test("direct URL to an existing session loads it", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    await page.waitForURL(new RegExp(SESSION_A.id));
    await expect(page.getByTestId("app-title")).toBeVisible();
  });

  test("direct URL to a non-existent session falls back to new session", async ({ page }) => {
    await page.goto("/chat/nonexistent-session-xyz");
    // App tries loadSession → 404 → createNewSession → replace URL
    await expect(async () => {
      expect(page.url()).not.toContain("nonexistent-session-xyz");
    }).toPass({ timeout: 10 * ONE_SECOND_MS });
    await expect(page.getByTestId("app-title")).toBeVisible();
  });

  test("page reload preserves the session URL", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    await page.waitForURL(new RegExp(SESSION_A.id));
    await page.reload();
    await page.waitForURL(new RegExp(SESSION_A.id));
    expect(page.url()).toContain(SESSION_A.id);
  });
});

test.describe("page routing — direct page loads", () => {
  test("/files loads the files page", async ({ page }) => {
    await page.goto("/files");
    await expect(page.getByTestId("app-title")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/files");
  });

  test("/automations loads the automations page", async ({ page }) => {
    await page.goto("/automations");
    await expect(page.getByTestId("app-title")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/automations");
  });

  test("/wiki loads the wiki page", async ({ page }) => {
    await page.goto("/wiki");
    await expect(page.getByTestId("app-title")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/wiki");
  });
});

// Every legacy / removed / unknown route redirects to a new home so
// existing bookmarks survive. The shape of each assertion is identical
// ("goto X, the final pathname matches Y") so a table-driven test
// covers them all without per-case boilerplate.
test.describe("page routing — legacy / redirected", () => {
  const REDIRECTS: readonly { label: string; from: string; toMatch: RegExp; expectedPathnameMatch: RegExp }[] = [
    {
      label: "/calendar → /automations (Calendar view removed)",
      from: "/calendar",
      toMatch: /\/automations(?:$|\?)/,
      expectedPathnameMatch: /^\/automations$/,
    },
    {
      label: "/scheduler → /automations (bookmark preservation for #758)",
      from: "/scheduler",
      toMatch: /\/automations(?:$|\?)/,
      expectedPathnameMatch: /^\/automations$/,
    },
    // Skills + Roles moved into the Settings modal (Management group);
    // the old standalone routes now redirect to /chat so existing
    // bookmarks don't 404.
    { label: "/skills → /chat (moved into Settings modal)", from: "/skills", toMatch: /\/chat/, expectedPathnameMatch: /^\/chat/ },
    { label: "/roles → /chat (moved into Settings modal)", from: "/roles", toMatch: /\/chat/, expectedPathnameMatch: /^\/chat/ },
    { label: "unknown path → /chat (catch-all)", from: "/does-not-exist", toMatch: /\/chat/, expectedPathnameMatch: /^\/chat/ },
    // The old /history route is gone; the catch-all redirects anything
    // unknown (including deep /history/<filter> bookmarks) to /chat.
    { label: "/history → /chat (legacy bookmark)", from: "/history", toMatch: /\/chat/, expectedPathnameMatch: /^\/chat/ },
    { label: "/history/<filter> → /chat (legacy deep bookmark)", from: "/history/unread", toMatch: /\/chat/, expectedPathnameMatch: /^\/chat/ },
  ];

  for (const { label, from, toMatch, expectedPathnameMatch } of REDIRECTS) {
    test(label, async ({ page }) => {
      await page.goto(from);
      await page.waitForURL(toMatch);
      expect(new URL(page.url()).pathname).toMatch(expectedPathnameMatch);
    });
  }
});

// Counterpart of the `page routing` groups above: same routes, but
// reached by clicking the launcher buttons above the canvas rather
// than typing the URL. The launcher's button → URL contract is
// independent of the router accepting the URL, so we keep both
// surfaces covered.
async function clickLauncherAndAssertPath(page: Page, key: string, expectedPath: string): Promise<void> {
  await page.goto("/chat");
  await page.waitForURL(/\/chat\//);

  await page.getByTestId(`plugin-launcher-${key}`).click();

  await page.waitForURL(new RegExp(`${expectedPath}(?:$|\\?)`));
  expect(new URL(page.url()).pathname).toBe(expectedPath);
}

test.describe("page routing via launcher buttons", () => {
  test("Actions button navigates to /automations", async ({ page }) => {
    await clickLauncherAndAssertPath(page, "automations", "/automations");
  });

  test("Wiki button navigates to /wiki", async ({ page }) => {
    await clickLauncherAndAssertPath(page, "wiki", "/wiki");
  });

  // Skills and Roles are no longer launcher buttons — they moved into
  // the Settings modal (Management group).

  test("Files button navigates to /files with no path param", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForURL(/\/chat\//);

    await page.getByTestId("plugin-launcher-files").click();

    await page.waitForURL(/\/files(?:$|\?)/);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/files");
    expect(url.searchParams.get("path")).toBeNull();
  });

  // The Chat button is a dedicated control (not a TARGETS entry): it
  // resumes-or-creates a chat rather than pushing a fixed route, and it
  // stays visible on every page so the session-history chrome can be
  // chat-only.
  test("Chat button is always visible and returns to /chat from another page", async ({ page }) => {
    await page.goto("/wiki");
    await page.waitForURL(/\/wiki/);

    // Chat-only chrome (history side panel + role selector) is gone here.
    await expect(page.getByTestId("session-history-side-panel")).toBeHidden();
    await expect(page.getByTestId("role-selector-btn")).toBeHidden();

    // The Chat button persists and lands back on /chat, where the role
    // selector reappears.
    await expect(page.getByTestId("plugin-launcher-chat")).toBeVisible();
    await page.getByTestId("plugin-launcher-chat").click();
    await page.waitForURL(/\/chat\//);
    await expect(page.getByTestId("role-selector-btn")).toBeVisible();
  });
});
