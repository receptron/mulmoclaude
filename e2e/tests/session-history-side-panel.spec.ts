// E2E for the session-history side-panel toggle (#707).
//
// Covers:
// - Toggle button visible in both Single and Stack canvas views
// - Clicking the toggle adds SessionHistoryPanel as the leftmost
//   column (w-80) next to the existing chat sidebar / canvas
// - State persists in localStorage across reloads
// - Panel renders the session list fetched via /api/sessions
// - Panel only appears on /chat — navigating to /files etc. hides it
//   even when the preference is on

import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { SESSION_A, SESSION_B } from "../fixtures/sessions";

test.describe("session-history side-panel toggle", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page, { sessions: [SESSION_A, SESSION_B] });
    // Each Playwright test gets a fresh browser context with empty
    // localStorage by default, so the side-panel preference starts
    // OFF without needing an init-script reset. Tests that want the
    // panel pre-enabled set it up inline before `page.goto`.
  });

  test("Single view: toggle button hidden → visible shows the left session-history column", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Off by default — side-panel DOM is absent.
    await expect(page.getByTestId("session-history-side-panel")).toBeHidden();
    await expect(page.getByTestId("session-history-toggle-off")).toBeVisible();

    // Click the toggle — SessionTabBar disappears, panel appears with
    // its own toggle in the header.
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();
    // Only one toggle-on button (in the panel) — the SessionTabBar is
    // unmounted so its toggle is gone too.
    await expect(page.getByTestId("session-history-toggle-on")).toHaveCount(1);

    const sidePanel = page.getByTestId("session-history-side-panel");
    await expect(sidePanel.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
    await expect(sidePanel.getByTestId(`session-item-${SESSION_B.id}`)).toBeVisible();
  });

  test("Stack view: toggle button (lives in SessionTabBar) controls the side-panel", async ({ page }) => {
    // Preset localStorage to Stack layout so we don't have to flip
    // it via the UI first.
    await page.addInitScript(() => {
      localStorage.setItem("canvas_layout_mode", "stack");
    });

    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Side panel off initially in Stack too.
    await expect(page.getByTestId("session-history-side-panel")).toBeHidden();

    // Toggle lives in SessionTabBar (top bar Row 2) — the same
    // button is used regardless of Single / Stack layout. Flipping
    // it reveals the leftmost session-history column, which Stack
    // normally has no sidebar for at all.
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();
    await expect(page.getByTestId("session-history-side-panel").getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
  });

  test("preference persists in localStorage across reloads", async ({ page }) => {
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();

    const stored = await page.evaluate(() => localStorage.getItem("side_panel_visible"));
    expect(stored).toBe("1");

    // Reload — panel should still be visible without clicking again.
    await page.reload();
    await expect(page.getByTestId("app-title")).toBeVisible();
    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();
  });

  test("clicking a session in the side panel navigates to /chat/:id", async ({ page }) => {
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();

    // The panel uses the shared SessionHistoryPanel component, so
    // clicking a session item triggers the load-session handler
    // that drives /chat navigation.
    await page.getByTestId("session-history-side-panel").getByTestId(`session-item-${SESSION_A.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${SESSION_A.id}`));
  });

  test("opening the side panel replaces the SessionTabBar entirely", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // SessionTabBar is present with its tabs and toggle when the panel is off.
    await expect(page.getByTestId(`session-tab-${SESSION_A.id}`)).toBeVisible();
    await expect(page.getByTestId("session-history-toggle-off")).toBeVisible();

    // Click the toggle — SessionTabBar unmounts completely; the panel
    // takes over and carries its own toggle in the header.
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();
    await expect(page.getByTestId(`session-tab-${SESSION_A.id}`)).toBeHidden();
    await expect(page.getByTestId("session-history-toggle-off")).toBeHidden();

    // The in-panel toggle returns to the tabs-on-top layout.
    await page.getByTestId("session-history-toggle-on").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeHidden();
    await expect(page.getByTestId(`session-tab-${SESSION_A.id}`)).toBeVisible();
  });

  test("side panel is chat-only — hidden off /chat, restored on return", async ({ page }) => {
    // Enable the toggle on /chat first so the preference is on.
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();

    // Navigate off chat — the session-history chrome is chat-only, so
    // the panel unmounts even though `sidePanelVisible` is still on.
    await page.goto("/files");
    await expect(page.getByTestId("session-history-side-panel")).toBeHidden();

    // Returning to /chat restores it (the preference persisted).
    await page.goto("/chat");
    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();
  });

  test("leaving /chat while the panel is expanded still renders the plugin page", async ({ page }) => {
    // Regression: the side panel is chat-only chrome and unmounts off
    // /chat, but the canvas/sidebar stay gated by `!sidePanelExpanded`.
    // Without resetting the transient expanded flag on chat→non-chat,
    // navigating away while expanded would blank the body.
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();

    // Expand to full-width, then navigate off chat via the Files button.
    await page.getByTestId("session-history-expand-off").click();
    // Confirm the expand actually took effect — otherwise the test could
    // pass even if the toggle broke, since it never reproduces the bug.
    await expect(page.getByTestId("session-history-expand-on")).toBeVisible();
    await page.getByTestId("plugin-launcher-files").click();
    await page.waitForURL(/\/files(?:$|\?)/);

    // The plugin page renders — the body is not blanked.
    await expect(page.getByTestId("files-view-root")).toBeVisible();
    await expect(page.getByTestId("session-history-side-panel")).toBeHidden();
  });
});

// SessionTabBar lives in the same chat-only chrome row as the
// session-history toggle, so its per-tab info tests sit alongside the
// panel tests above. Verifies that each existing session shows a
// visible label under the role icon, plus supplemental indicators
// (unread dot, origin glyph) on tabs that carry those flags.
test.describe("session tab bar — visible per-tab info", () => {
  test("shows a short label under the role icon on each tab", async ({ page }) => {
    await mockAllApis(page, { sessions: [SESSION_A, SESSION_B] });
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    const tabA = page.getByTestId(`session-tab-${SESSION_A.id}`);
    const tabB = page.getByTestId(`session-tab-${SESSION_B.id}`);

    // Assert on the distinguishing suffix ("session A" / "session B")
    // rather than the shared "Hello from" prefix — otherwise the test
    // would pass even if the tabs got swapped and each rendered the
    // wrong session's label.
    await expect(tabA).toContainText("session A");
    await expect(tabB).toContainText("session B");

    // Tab tooltip keeps the full preview for users who want more.
    await expect(tabA).toHaveAttribute("title", SESSION_A.preview ?? "");
    await expect(tabB).toHaveAttribute("title", SESSION_B.preview ?? "");
  });

  test("shows an unread dot on inactive tabs that have unread replies", async ({ page }) => {
    await mockAllApis(page, {
      sessions: [
        { ...SESSION_A, hasUnread: true },
        { ...SESSION_B, hasUnread: false },
      ],
    });
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    const tabA = page.getByTestId(`session-tab-${SESSION_A.id}`);
    const tabB = page.getByTestId(`session-tab-${SESSION_B.id}`);

    // Dot is an aria-labeled span inside the tab.
    await expect(tabA.getByLabel("New reply")).toBeVisible();
    await expect(tabB.getByLabel("New reply")).toBeHidden();
  });

  test("shows an origin glyph for non-human-started sessions", async ({ page }) => {
    await mockAllApis(page, {
      sessions: [
        { ...SESSION_A, origin: "scheduler" },
        { ...SESSION_B, origin: "bridge" },
      ],
    });
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    const tabA = page.getByTestId(`session-tab-${SESSION_A.id}`);
    const tabB = page.getByTestId(`session-tab-${SESSION_B.id}`);

    await expect(tabA.getByLabel("Started by scheduler")).toBeVisible();
    await expect(tabB.getByLabel("Started by bridge")).toBeVisible();
  });

  test("unread count surfaces on the Chat button after the user leaves /chat", async ({ page }) => {
    // The session-tab bar is chat-only, so its per-tab unread dots
    // unmount off /chat. The aggregate unread count instead rides the
    // always-visible Chat button (SessionCountBadges), so the user can
    // still tell replies are waiting from any page — without that, the
    // unread signal would vanish the moment they navigate away.
    await mockAllApis(page, {
      sessions: [
        { ...SESSION_A, hasUnread: true },
        { ...SESSION_B, hasUnread: true },
      ],
    });

    const chatBtn = page.getByTestId("plugin-launcher-chat");

    // On /chat, the Chat button already carries the unread badge.
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await expect(chatBtn.getByTestId("session-count-unread")).toBeVisible();

    // Navigate off chat. The tab bar (and its per-tab dots) unmounts,
    // but the unread badge on the Chat button persists — at least one
    // session is still unread.
    await page.goto("/wiki");
    await expect(page.getByTestId(`session-tab-${SESSION_B.id}`)).toBeHidden();
    await expect(chatBtn.getByTestId("session-count-unread")).toBeVisible();
  });
});
