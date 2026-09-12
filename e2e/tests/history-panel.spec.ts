// E2E for the session-history side panel. Covers:
// - toggle opens / closes the panel
// - opening the panel triggers a fresh /api/sessions fetch
// - clicking a session row navigates to /chat/:id
// - filter pill bar: active-class for current pill, per-origin filter
//   behavior, reset on close-then-reopen
//
// Scope-matching note: the panel used to live at /history. That route
// is gone — the filter bar is now panel-local state, and tests that
// asserted URL shape have been retired in favor of DOM assertions.

import { test, expect, type Page, type Route } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { SESSION_A, SESSION_B, makeSessionEntries } from "../fixtures/sessions";

function urlEndsWith(suffix: string): (url: URL) => boolean {
  return (url) => url.pathname === suffix;
}

test.describe("session-history side panel", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("toggling the button opens the panel with server sessions", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Panel is closed initially — session items should not be in DOM.
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeHidden();

    await page.getByTestId("session-history-toggle-off").click();

    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_B.id}`)).toBeVisible();
  });

  test("clicking a session navigates to /chat/:id and closes nothing", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    await page.getByTestId("session-history-toggle-off").click();
    await page.getByTestId(`session-item-${SESSION_A.id}`).click();

    await expect(page).toHaveURL(new RegExp(`/chat/${SESSION_A.id}`));
  });

  test("toggle click triggers a fresh /api/sessions fetch", async ({ page }) => {
    // Count /api/sessions GETs so we can verify opening the panel
    // fires a lazy fetch on top of the initial onMount one.
    let sessionFetchCount = 0;
    await page.route(urlEndsWith("/api/sessions"), (route: Route) => {
      if (route.request().method() === "GET") {
        sessionFetchCount++;
      }
      return route.fulfill({
        json: {
          sessions: [SESSION_A, SESSION_B],
          cursor: "v1:0",
          deletedIds: [],
        },
      });
    });

    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();
    // Wait for the onMount /api/sessions GET to land before snapshotting the baseline.
    await expect.poll(() => sessionFetchCount).toBeGreaterThan(0);
    const countAfterMount = sessionFetchCount;

    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();

    // One additional fetch should have happened on panel open.
    expect(sessionFetchCount).toBeGreaterThan(countAfterMount);
  });

  test("filter bar is visible with All/Unread/Human/Scheduler/Skill/Bridge buttons", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("app-title")).toBeVisible();

    await page.getByTestId("session-history-toggle-off").click();

    const filterBar = page.getByTestId("session-filter-bar");
    await expect(filterBar).toBeVisible();

    await expect(page.getByTestId("session-filter-all")).toBeVisible();
    await expect(page.getByTestId("session-filter-unread")).toBeVisible();
    await expect(page.getByTestId("session-filter-human")).toBeVisible();
    await expect(page.getByTestId("session-filter-scheduler")).toBeVisible();
    await expect(page.getByTestId("session-filter-skill")).toBeVisible();
    await expect(page.getByTestId("session-filter-bridge")).toBeVisible();
  });
});

// Hold `GET /api/sessions/<sessionId>` open until the returned release()
// is called, so a test can inspect the UI while the transcript is still
// in flight. Register after mockAllApis — Playwright checks routes in
// reverse registration order.
async function gateTranscript(page: Page, sessionId: string): Promise<() => void> {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === `/api/sessions/${sessionId}`,
    async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await gate;
      return route.fulfill({ json: makeSessionEntries(sessionId) });
    },
  );
  return release;
}

test.describe("session selection feedback", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("the clicked row highlights before its transcript arrives", async ({ page }) => {
    // Regression guard for #2809: loadSession used to write
    // currentSessionId only after `GET /api/sessions/:id` resolved, so
    // the selection border waited on the round trip.
    const releaseTranscript = await gateTranscript(page, SESSION_A.id);

    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    // SESSION_B is the newer fixture, so boot resumes into B and A
    // starts unselected — asserted rather than assumed, since the
    // whole test hinges on A not already carrying the border.
    const row = page.getByTestId(`session-item-${SESSION_A.id}`);
    await expect(row).toBeVisible();
    await expect(row).not.toHaveClass(/border-blue-500/);

    await row.click();

    // Still gated — nothing has come back from the server yet.
    await expect(row).toHaveClass(/border-blue-500/);

    releaseTranscript();
    await expect(page).toHaveURL(new RegExp(`/chat/${SESSION_A.id}`));
  });

  test("a slow transcript landing after a newer click does not steal the view", async ({ page }) => {
    // Optimistic selection makes the out-of-order case reachable by
    // impatient clicking: A (slow) then B (already in memory, instant).
    // When A finally arrives it must be cached, not activated.
    const releaseSlowA = await gateTranscript(page, SESSION_A.id);

    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    const rowA = page.getByTestId(`session-item-${SESSION_A.id}`);
    const rowB = page.getByTestId(`session-item-${SESSION_B.id}`);
    await expect(rowA).toBeVisible();

    await rowA.click();
    await expect(rowA).toHaveClass(/border-blue-500/);
    await rowB.click();
    await expect(rowB).toHaveClass(/border-blue-500/);

    const slowResponse = page.waitForResponse((response) => response.url().endsWith(`/api/sessions/${SESSION_A.id}`));
    releaseSlowA();
    await slowResponse;

    // Negative assertion: the absence of a navigation has no signal to
    // synchronise on, so give the handler a beat to run.
    // eslint-disable-next-line sonarjs/no-fixed-wait-in-tests -- see above
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(new RegExp(SESSION_B.id));
    await expect(rowB).toHaveClass(/border-blue-500/);
    await expect(rowA).not.toHaveClass(/border-blue-500/);
  });
});

test.describe("session selection failure handling", () => {
  test("a transcript that fails to load leaves the row unread and the selection where it was", async ({ page }) => {
    // The optimistic selection reaches the unread watcher before the
    // load resolves. A transcript that 500s while its meta sidecar is
    // healthy would let mark-read succeed, dropping the badge for a
    // session that never opened.
    const unreadA = { ...SESSION_A, hasUnread: true };
    await mockAllApis(page, { sessions: [unreadA, SESSION_B] });
    let markReadCalls = 0;
    await page.route(
      (url) => url.pathname.startsWith(`/api/sessions/${SESSION_A.id}`),
      (route: Route) => {
        if (route.request().method() === "POST") {
          markReadCalls++;
          return route.fulfill({ json: { ok: true } });
        }
        return route.fulfill({ status: 500, json: { error: "unreadable transcript" } });
      },
    );

    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    const rowA = page.getByTestId(`session-item-${SESSION_A.id}`);
    await expect(rowA).toBeVisible();
    // Unread rows render bold via previewClasses.
    await expect(rowA.locator("p")).toHaveClass(/font-bold/);

    await rowA.click();

    // Negative assertions: neither the badge dropping nor a navigation
    // has a signal to synchronise on, so give the failure path a beat.
    // eslint-disable-next-line sonarjs/no-fixed-wait-in-tests -- see above
    await page.waitForTimeout(500);
    await expect(rowA.locator("p")).toHaveClass(/font-bold/);
    await expect(rowA).not.toHaveClass(/border-blue-500/);
    await expect(page).toHaveURL(new RegExp(SESSION_B.id));
    expect(markReadCalls).toBe(0);
  });
});

test.describe("session-history filter pills", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("All is active when the panel first opens", async ({ page }) => {
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();

    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
    // Class derived in the component: active pill gets bg-blue-600.
    await expect(page.getByTestId("session-filter-all")).toHaveClass(/bg-blue-600/);
  });

  test("clicking Unread highlights the pill", async ({ page }) => {
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();

    await page.getByTestId("session-filter-unread").click();

    await expect(page.getByTestId("session-filter-unread")).toHaveClass(/bg-blue-600/);
    await expect(page.getByTestId("session-filter-all")).not.toHaveClass(/bg-blue-600/);
  });

  test("Human pill keeps default-origin sessions visible", async ({ page }) => {
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();

    await page.getByTestId("session-filter-human").click();

    await expect(page.getByTestId("session-filter-human")).toHaveClass(/bg-blue-600/);
    // Default-origin sessions (no `origin` field) render as `human`
    // per `originOf`, so they remain visible under the Human filter.
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
  });

  test("switching filters updates the visible session set", async ({ page }) => {
    // Cover bridge → scheduler → all transitions, not just one pill.
    // Subsumes the older single-Bridge case from the panel describe.
    await page.route(urlEndsWith("/api/sessions"), (route: Route) =>
      route.fulfill({
        json: {
          sessions: [
            { ...SESSION_A, origin: "bridge" },
            { ...SESSION_B, origin: "scheduler" },
          ],
          cursor: "v1:0",
          deletedIds: [],
        },
      }),
    );

    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_B.id}`)).toBeVisible();

    await page.getByTestId("session-filter-bridge").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_B.id}`)).toBeHidden();

    await page.getByTestId("session-filter-scheduler").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeHidden();
    await expect(page.getByTestId(`session-item-${SESSION_B.id}`)).toBeVisible();

    await page.getByTestId("session-filter-all").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_B.id}`)).toBeVisible();
  });

  test("closing and reopening the panel resets the filter to All", async ({ page }) => {
    // Panel-local filter state on purpose: reopening should land you
    // on the familiar "everything" view rather than remembering the
    // last narrow filter, which can be surprising after a break.
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await page.getByTestId("session-filter-unread").click();
    await expect(page.getByTestId("session-filter-unread")).toHaveClass(/bg-blue-600/);

    // Close (dock toggle in panel header).
    await page.getByTestId("session-history-toggle-on").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeHidden();

    // Reopen.
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId("session-filter-all")).toHaveClass(/bg-blue-600/);
  });
});
