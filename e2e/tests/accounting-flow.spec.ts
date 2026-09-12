// Functional flow for the accounting plugin. Mounts <AccountingApp>
// via an injected tool_result envelope and drives the canvas against
// the in-memory mock from e2e/fixtures/accounting.ts.
//
// The production LLM path is `createBook → openBook(bookId)`: openBook
// requires a non-empty, existing bookId (else 400/404). The first
// test below pins that path against a seeded book; the second pins
// the defensive first-run fallback the View still renders when the
// book list comes back empty (a stale envelope or out-of-band delete
// — not reachable from the LLM).

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { mockAccountingApi, makeAccountingToolResult, type AccountingSeedBook } from "../fixtures/accounting";

const SESSION_ID = "accounting-session";

interface SetupOpts {
  books?: readonly AccountingSeedBook[] | undefined;
  envelope: { bookId: string | null; initialTab?: string };
}

async function setupSession(page: Page, opts: SetupOpts): Promise<void> {
  await mockAllApis(page, {
    sessions: [
      {
        id: SESSION_ID,
        title: "Accounting Session",
        roleId: "general",
        startedAt: "2026-04-14T10:00:00Z",
        updatedAt: "2026-04-14T10:05:00Z",
      },
    ],
  });

  await mockAccountingApi(page, { books: opts.books });

  await page.route(
    (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
    (route) =>
      route.fulfill({
        json: [
          { type: "session_meta", roleId: "general", sessionId: SESSION_ID },
          { type: "text", source: "user", message: "Open my books" },
          makeAccountingToolResult(opts.envelope),
        ],
      }),
  );
}

test.describe("accounting plugin — flow", () => {
  test("openBook envelope with a real bookId mounts <AccountingApp> on that book", async ({ page }) => {
    const SEED_BOOK_ID = "book-seeded-1";
    await setupSession(page, {
      books: [{ id: SEED_BOOK_ID, name: "Seeded Book" }],
      envelope: { bookId: SEED_BOOK_ID },
    });

    await page.goto(`/chat/${SESSION_ID}`);
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Production path: <AccountingApp> mounts on the seeded book and
    // shows the regular chrome (header + tabs). The first-run form
    // must NOT render — that branch is reserved for an empty book
    // list, which can't happen when openBook resolves a real id.
    await expect(page.getByTestId("accounting-app")).toBeVisible();
    await expect(page.getByTestId("accounting-tabs")).toBeVisible();
    await expect(page.getByTestId("accounting-new-book-firstrun")).not.toBeVisible();
    await expect(page.getByTestId("accounting-no-book")).not.toBeVisible();
  });

  test("Journal-tab inline New Entry form exposes the per-line tax-registration ID input when a 14xx account is picked", async ({ page }) => {
    const SEED_BOOK_ID = "book-tax-id-1";
    // `withEmptyOpening: true` lets us land on a book whose
    // opening-gate is already satisfied — without it, the View
    // hides every tab except `opening` and `settings` until the
    // user saves an opening, so the Journal tab (which now hosts
    // the "+ New entry" button) wouldn't render.
    await setupSession(page, {
      books: [{ id: SEED_BOOK_ID, name: "Seeded Book", withEmptyOpening: true }],
      envelope: { bookId: SEED_BOOK_ID },
    });

    await page.goto(`/chat/${SESSION_ID}`);
    await expect(page.getByTestId("accounting-app")).toBeVisible();
    await expect(page.getByTestId("accounting-tabs")).toBeVisible();
    // The New Entry form lives inline on the Journal tab now —
    // open it via the "+ New entry" button, not a tab click.
    await page.getByTestId("accounting-journal-new-entry").click();
    await expect(page.getByTestId("accounting-journal-inline-form")).toBeVisible();

    // The tax-registration ID input is gated by `isTaxAccountCode`
    // — it only renders on lines whose account is in the 14xx
    // input-tax band (see
    // src/plugins/accounting/components/accountNumbering.ts). On a
    // fresh form every line's accountCode is "", so the column
    // and input are hidden until the user picks a 14xx account.
    const taxIdInput = page.getByTestId("accounting-entry-line-tax-registration-id-0");
    await expect(taxIdInput).toHaveCount(0);
    await page.getByTestId("accounting-entry-line-account-0").selectOption("1400");

    await expect(taxIdInput).toBeVisible();
    await taxIdInput.fill("T1234567890123");
    await expect(taxIdInput).toHaveValue("T1234567890123");

    // Switching the line back to a non-tax account must hide the
    // input again. (The "typed value is dropped on submit" guarantee
    // is enforced in `toApiLines` — gated by `isTaxLine` — but
    // verifying that requires a network round-trip that's out of
    // scope for this UI smoke test.)
    await page.getByTestId("accounting-entry-line-account-0").selectOption("1000");
    await expect(taxIdInput).toHaveCount(0);

    // Pin the negative-side rule introduced in PR #1137: 24xx
    // output-tax accounts (e.g. 2400 Sales Tax Payable) must NOT
    // surface the T-number column. Without this assertion a
    // regression that re-broadened `isTaxAccountCode` back to
    // `["14", "24"]` would slip through e2e — the existing 1000
    // check above only proves a non-tax account hides the input,
    // not that 24xx specifically does.
    await page.getByTestId("accounting-entry-line-account-0").selectOption("2400");
    await expect(taxIdInput).toHaveCount(0);
  });

  test("Journal-tab inline form: open / cancel / re-open from row Edit", async ({ page }) => {
    // Pin the inline-form contract introduced when the New Entry tab
    // was retired in favour of an inline form on the Journal tab:
    //   • The "+ New entry" button replaces its toolbar slot when
    //     clicked, mounting the form in place.
    //   • The form's Cancel button dismisses the panel and the
    //     toolbar button reappears.
    //   • Clicking Edit on a row mounts the same form prefilled.
    const SEED_BOOK_ID = "book-inline-form";
    await setupSession(page, {
      books: [{ id: SEED_BOOK_ID, name: "Inline Form Book", withEmptyOpening: true }],
      envelope: { bookId: SEED_BOOK_ID },
    });

    await page.goto(`/chat/${SESSION_ID}`);
    await expect(page.getByTestId("accounting-app")).toBeVisible();

    // Default state: button visible, form not mounted.
    const newEntryButton = page.getByTestId("accounting-journal-new-entry");
    const inlineForm = page.getByTestId("accounting-journal-inline-form");
    await expect(newEntryButton).toBeVisible();
    await expect(inlineForm).toHaveCount(0);

    // Open the form. The button slot is replaced by the form panel,
    // so the button itself goes away while the form is up.
    await newEntryButton.click();
    await expect(inlineForm).toBeVisible();
    await expect(newEntryButton).toHaveCount(0);

    // Submit a balanced two-line entry against the seeded chart.
    await page.getByTestId("accounting-entry-line-account-0").selectOption("1000");
    await page.getByTestId("accounting-entry-line-debit-0").fill("100");
    await page.getByTestId("accounting-entry-line-account-1").selectOption("4000");
    await page.getByTestId("accounting-entry-line-credit-1").fill("100");
    await page.getByTestId("accounting-entry-submit").click();

    // Form dismisses on submit; the journal table re-renders with the
    // posted row and the toolbar button is back.
    await expect(inlineForm).toHaveCount(0);
    await expect(newEntryButton).toBeVisible();
    const journalTable = page.getByTestId("accounting-journal-table");
    await expect(journalTable).toBeVisible();

    // Edit / Void now live inside the row's expanded detail panel —
    // collapsed rows expose neither button. Locate the just-posted
    // normal entry's row by exclusion (skip the opening row + any
    // voided row) and expand it.
    const normalRow = page.locator("[data-testid^='accounting-journal-row-']:not([data-testid*='accounting-journal-row-voided-'])").last();
    await expect(normalRow).toBeVisible();
    await normalRow.click();

    // Inside the now-expanded panel: normal-entry Edit (the opening
    // row uses the distinct `accounting-edit-opening-…` testid and
    // a different handler — it switches to the Opening tab).
    const normalEditButtons = page.locator("[data-testid^='accounting-edit-']:not([data-testid*='accounting-edit-opening-'])");
    await expect(normalEditButtons.first()).toBeVisible();

    // Click Edit on the just-posted row → the JournalEntryForm
    // mounts in-place inside the expanded detail panel (NOT in the
    // top-bar, which stays reserved for "+ New entry"), prefilled
    // from the row.
    await normalEditButtons.first().click();
    await expect(inlineForm).toHaveCount(0);
    const inPlaceEdit = page.locator("[data-testid^='accounting-journal-detail-edit-']");
    await expect(inPlaceEdit).toHaveCount(1);
    // The date input should hold the posted date (today by default).
    const dateInput = page.getByTestId("accounting-entry-date");
    await expect(dateInput).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);

    // Cancel from in-place edit drops the form back to the read-
    // only detail view for the same row; the top-bar "+ New entry"
    // button stays visible the whole time (it was never replaced).
    await page.getByTestId("accounting-entry-cancel-edit").click();
    await expect(inPlaceEdit).toHaveCount(0);
    await expect(inlineForm).toHaveCount(0);
    await expect(newEntryButton).toBeVisible();
  });

  test("Accounts tab rows are keyboard-accessible (Enter / Space activate)", async ({ page }) => {
    // a11y regression guard for #1140 review: rows in the new
    // Accounts tab must be operable without a mouse so the
    // Accounts → Ledger handoff is keyboard-reachable.
    const SEED_BOOK_ID = "book-a11y-accounts";
    await setupSession(page, {
      books: [{ id: SEED_BOOK_ID, name: "A11y Book", withEmptyOpening: true }],
      envelope: { bookId: SEED_BOOK_ID, initialTab: "accounts" },
    });

    await page.goto(`/chat/${SESSION_ID}`);
    await expect(page.getByTestId("accounting-app")).toBeVisible();
    await expect(page.getByTestId("accounting-accounts-list")).toBeVisible();

    // Pick a row from the seeded chart and verify it carries the
    // accessibility primitives mouse-only rows would lack.
    const cashRow = page.getByTestId("accounting-account-row-1000");
    await expect(cashRow).toBeVisible();
    await expect(cashRow).toHaveAttribute("tabindex", "0");
    await expect(cashRow).toHaveAttribute("role", "button");

    // Enter on the focused row routes to the Ledger tab with the
    // selected account preselected — same effect as a mouse click.
    await cashRow.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("accounting-ledger")).toBeVisible();
    await expect(page.getByTestId("accounting-ledger-account")).toHaveValue("1000");

    // Space on a different row works the same way (verifying both
    // activation keys, not just one).
    await page.getByTestId("accounting-tab-accounts").click();
    const apRow = page.getByTestId("accounting-account-row-2000");
    await apRow.focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("accounting-ledger")).toBeVisible();
    await expect(page.getByTestId("accounting-ledger-account")).toHaveValue("2000");
  });

  test("deleting a book with siblings shows the deleted-notice panel; tabs are disabled until the user picks another book", async ({ page }) => {
    // Issue #1126 (1): after deleting one of multiple books, the
    // canvas must NOT silently snap to books[0]. Instead it shows a
    // "<book> deleted" panel; the only path forward is the
    // BookSwitcher dropdown.
    const KEEP_ID = "book-keep";
    const DOOMED_ID = "book-doomed";
    await setupSession(page, {
      books: [
        { id: KEEP_ID, name: "Keep", withEmptyOpening: true },
        { id: DOOMED_ID, name: "Doomed", withEmptyOpening: true },
      ],
      envelope: { bookId: DOOMED_ID, initialTab: "settings" },
    });

    await page.goto(`/chat/${SESSION_ID}`);
    await expect(page.getByTestId("accounting-app")).toBeVisible();
    await expect(page.getByTestId("accounting-settings")).toBeVisible();

    // Reveal the Delete book section — it sits behind an "Advanced…"
    // disclosure so the destructive control isn't a single click away.
    await page.getByTestId("accounting-settings-advanced").click();

    // Type the doomed book's name into the confirm field, then delete.
    await page.getByTestId("accounting-settings-delete-confirm").fill("Doomed");
    await page.getByTestId("accounting-settings-delete").click();

    // The deleted-notice panel must surface the deleted book's name.
    await expect(page.getByTestId("accounting-deleted-notice")).toBeVisible();
    await expect(page.getByTestId("accounting-deleted-notice-title")).toContainText("Doomed");

    // Tab strip is rendered but disabled — clicking a tab does
    // nothing while the notice is up. Verify by clicking journal and
    // confirming the notice stays. `force: true` is required because
    // the whole point of this assertion is to drive a click at the
    // DOM regardless of Playwright's actionability check — the
    // expected behaviour is that the disabled tab swallows the click
    // and the notice stays.
    // eslint-disable-next-line sonarjs/no-forced-browser-interaction -- intentional: probing a disabled-state guard
    await page.getByTestId("accounting-tab-journal").click({ force: true });
    await expect(page.getByTestId("accounting-deleted-notice")).toBeVisible();

    // Picking the surviving book from the dropdown clears the notice
    // and re-enables the tab strip.
    await page.getByTestId("accounting-book-select").selectOption(KEEP_ID);
    await expect(page.getByTestId("accounting-deleted-notice")).not.toBeVisible();
    await expect(page.getByTestId("accounting-tab-journal")).toBeVisible();
  });

  test("creating a new book from the BookSwitcher auto-switches the canvas to the new book", async ({ page }) => {
    // Issue #1126 (2): with one or more existing books, picking
    // "+ New book" from the dropdown and submitting must move the
    // canvas onto the freshly-created book — not leave it pointing
    // at the previously-active one.
    const EXISTING_ID = "book-existing";
    await setupSession(page, {
      books: [{ id: EXISTING_ID, name: "Existing", withEmptyOpening: true }],
      envelope: { bookId: EXISTING_ID },
    });

    await page.goto(`/chat/${SESSION_ID}`);
    await expect(page.getByTestId("accounting-app")).toBeVisible();
    await expect(page.getByTestId("accounting-book-select")).toHaveValue(EXISTING_ID);

    // Trigger the "+ New book" sentinel option and fill the modal.
    await page.getByTestId("accounting-book-select").selectOption("__new__");
    await expect(page.getByTestId("accounting-new-book-modal")).toBeVisible();
    await page.getByTestId("accounting-new-book-name").fill("Brand New");
    await page.getByTestId("accounting-new-book-submit").click();

    // Modal closes and the dropdown's selection follows to the new
    // book. Pin both: the option text contains "Brand New", and
    // the option's underlying value is NOT the previous book's id.
    await expect(page.getByTestId("accounting-new-book-modal")).not.toBeVisible();
    const select = page.getByTestId("accounting-book-select");
    await expect(select).not.toHaveValue(EXISTING_ID);
    const selectedLabel = await select.locator("option:checked").textContent();
    expect(selectedLabel).toContain("Brand New");
  });

  test("renders full-page first-run form when the workspace is empty (defensive fallback)", async ({ page }) => {
    // openBook now 400s on a missing bookId, so this state is no
    // longer reachable from the LLM. The View still renders the
    // full-page first-run form when refetchBooks() returns an empty
    // list — defensive against a stale envelope or an out-of-band
    // delete between mount and book fetch. Pin that behavior here.
    await setupSession(page, { envelope: { bookId: null } });

    await page.goto(`/chat/${SESSION_ID}`);
    await expect(page.getByTestId("app-title")).toBeVisible();

    await expect(page.getByTestId("accounting-app")).toBeVisible();
    await expect(page.getByTestId("accounting-new-book-modal")).toBeVisible();
    await expect(page.getByTestId("accounting-new-book-firstrun")).toBeVisible();
    await expect(page.getByTestId("accounting-tabs")).not.toBeVisible();
    await expect(page.getByTestId("accounting-no-book")).not.toBeVisible();
  });
});
