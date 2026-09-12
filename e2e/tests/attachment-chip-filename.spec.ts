// #2308 — the chat history used to label every attachment with the stored
// hex id (`b458a5d0.csv`), so reopening a conversation told you nothing
// about which file you had handed over. The chip now shows the original
// filename when the turn recorded one.
//
// Loading a session is the case worth pinning end-to-end: the live send
// path already has the name in hand, but the reload path has to read it
// back off the jsonl — and that same jsonl still holds bare path strings
// for every turn recorded before this shipped. Both shapes are in the
// fixture below, in one conversation, for exactly that reason.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const SESSION_ID = "attachment-session";
const STORED_CSV = "data/attachments/2026/07/b458a5d02a184ac2.csv";
const ORIGINAL_CSV = "商品カタログ_v2.csv";
const LEGACY_PDF = "data/attachments/2026/04/3c7bdd20ec494f8f.pdf";

async function setupAttachmentSession(page: Page) {
  await mockAllApis(page, {
    sessions: [
      {
        id: SESSION_ID,
        title: "Attachment Session",
        roleId: "general",
        startedAt: "2026-07-30T10:00:00Z",
        updatedAt: "2026-07-30T10:05:00Z",
      },
    ],
  });

  await page.route(
    (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
    (route) =>
      route.fulfill({
        json: [
          { type: "session_meta", roleId: "general", sessionId: SESSION_ID },
          // Recorded before #2308: a bare path string.
          { type: "text", source: "user", message: "read this contract", attachments: [LEGACY_PDF] },
          { type: "text", source: "assistant", message: "Sure." },
          // Recorded after: an object carrying the original filename.
          { type: "text", source: "user", message: "now this one", attachments: [{ path: STORED_CSV, filename: ORIGINAL_CSV }] },
          { type: "text", source: "assistant", message: "Done." },
        ],
      }),
  );
}

test.describe("attachment chip filename (#2308)", () => {
  test.beforeEach(async ({ page }) => {
    await setupAttachmentSession(page);
  });

  test("a turn recorded with an original filename shows it instead of the stored hex id", async ({ page }) => {
    await page.goto(`/chat/${SESSION_ID}`);
    await expect(page.getByTestId("app-title")).toBeVisible();
    await expect(page.getByTestId("tool-results-scroll").getByText("now this one")).toBeVisible();

    await expect(page.getByTestId("sent-attachment-chip").filter({ hasText: ORIGINAL_CSV }).first()).toBeVisible();
    // The id must not be what the user reads.
    await expect(page.getByTestId("sent-attachment-chip").filter({ hasText: "b458a5d02a184ac2.csv" })).toHaveCount(0);
  });

  test("hovering reveals the stored id so the file stays findable on disk", async ({ page }) => {
    await page.goto(`/chat/${SESSION_ID}`);
    await expect(page.getByTestId("tool-results-scroll").getByText("now this one")).toBeVisible();

    const chip = page.getByTestId("sent-attachment-chip").filter({ hasText: ORIGINAL_CSV }).first();
    await expect(chip).toHaveAttribute("title", `${ORIGINAL_CSV} (b458a5d02a184ac2.csv)`);
  });

  test("a turn recorded before #2308 still renders, falling back to the stored basename", async ({ page }) => {
    // The pre-#2308 shape is a bare string, not an object. Reading it as one
    // would render an empty chip — or drop the row entirely.
    await page.goto(`/chat/${SESSION_ID}`);
    await expect(page.getByTestId("tool-results-scroll").getByText("read this contract")).toBeVisible();

    await expect(page.getByTestId("sent-attachment-chip").filter({ hasText: "3c7bdd20ec494f8f.pdf" }).first()).toBeVisible();
  });
});
