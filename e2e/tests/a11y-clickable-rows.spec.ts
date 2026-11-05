// E2E regression guard for the session-history row's keyboard contract.
// The row card itself is not a control: opening the session, toggling
// its bookmark and opening its menu are sibling native <button>s, so no
// interactive element nests inside another and each one is its own tab
// stop. A key pressed on one of them must not fire another's action.

import { test, expect, type Page, type Route } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { SESSION_A, SESSION_B } from "../fixtures/sessions";
import { urlEndsWith } from "../fixtures/pubsub";

async function openSidePanel(page: Page): Promise<void> {
  await page.goto("/chat");
  await page.getByTestId("session-history-toggle-off").click();
  await expect(page.getByTestId("session-history-side-panel")).toBeVisible();
}

test.describe("session-history row keyboard contract", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  for (const key of ["Enter", "Space"]) {
    test(`${key} on the focused open button loads the session`, async ({ page }) => {
      await openSidePanel(page);
      const open = page.getByTestId(`session-row-open-${SESSION_A.id}`);
      await open.focus();
      await page.keyboard.press(key);

      await expect(page).toHaveURL(new RegExp(`/chat/${SESSION_A.id}`));
    });
  }

  test("the row card is not a control and nests none; its controls are native buttons", async ({ page }) => {
    await openSidePanel(page);
    const row = page.getByTestId(`session-item-${SESSION_A.id}`);
    await expect(row).not.toHaveAttribute("role", /./);
    await expect(row).not.toHaveAttribute("tabindex", /./);

    // A button may hold only phrasing content, so no block element or second control inside it.
    const invalidButtonContent = await row.evaluate((rowEl) => rowEl.querySelectorAll("button :is(button, p, div), [role=button] button").length);
    expect(invalidButtonContent).toBe(0);

    const open = page.getByTestId(`session-row-open-${SESSION_A.id}`);
    expect(await open.evaluate((element) => element.tagName)).toBe("BUTTON");
    expect(await open.getAttribute("aria-label")).toBeTruthy();
    const bookmark = page.getByTestId(`session-row-icon-bookmark-${SESSION_A.id}`);
    expect(await bookmark.evaluate((element) => element.tagName)).toBe("BUTTON");
    await expect(bookmark).toHaveAttribute("aria-pressed", "false");
  });

  test("Tab walks a row's controls in reading order: bookmark, open, menu", async ({ page }) => {
    await openSidePanel(page);
    await page.getByTestId(`session-row-icon-bookmark-${SESSION_A.id}`).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId(`session-row-open-${SESSION_A.id}`)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId(`session-row-menu-${SESSION_A.id}`)).toBeFocused();
  });

  test("Enter on the focused bookmark toggle bookmarks without opening the session", async ({ page }) => {
    const bookmarkBodies: unknown[] = [];
    await page.route(urlEndsWith(`/api/sessions/${SESSION_A.id}/bookmark`), (route: Route) => {
      bookmarkBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await openSidePanel(page);
    const bookmark = page.getByTestId(`session-row-icon-bookmark-${SESSION_A.id}`);
    await bookmark.focus();
    await page.keyboard.press("Enter");

    await expect.poll(() => bookmarkBodies).toEqual([{ bookmarked: true }]);
    await expect(bookmark).toHaveAttribute("aria-pressed", "true");
    // A toggle's name stays put; aria-pressed alone carries the state.
    await expect(bookmark).toHaveAttribute("aria-label", "Bookmark");
    await expect(page).not.toHaveURL(new RegExp(`/chat/${SESSION_A.id}`));
  });

  test("Enter on the focused menu button opens the menu without opening the session", async ({ page }) => {
    await openSidePanel(page);
    await page.getByTestId(`session-row-menu-${SESSION_A.id}`).focus();
    await page.keyboard.press("Enter");

    await expect(page.getByTestId(`session-row-menu-popover-${SESSION_A.id}`)).toBeVisible();
    await expect(page).not.toHaveURL(new RegExp(`/chat/${SESSION_A.id}`));
  });

  test("opening a session from the keyboard closes another row's open menu", async ({ page }) => {
    await openSidePanel(page);
    await page.getByTestId(`session-row-menu-${SESSION_B.id}`).click();
    const popover = page.getByTestId(`session-row-menu-popover-${SESSION_B.id}`);
    await expect(popover).toBeVisible();

    await page.getByTestId(`session-row-open-${SESSION_A.id}`).focus();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(new RegExp(`/chat/${SESSION_A.id}`));
    await expect(popover).toBeHidden();
  });
});
