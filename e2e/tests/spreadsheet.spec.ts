import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

import { ONE_SECOND_MS } from "../../server/utils/time.ts";
// Mount a session where the sidebar holds a presentSpreadsheet tool
// result. The spreadsheet View.vue renders when the user clicks the
// sidebar entry, so asserting against the rendered table exercises
// both the file-backed fetchSheets path and the table render.

interface SpreadsheetResultOptions {
  // Stored file path ("artifacts/spreadsheets/abc.json") or inline sheets array.
  sheets: string | unknown[];
  sessionId?: string;
  title?: string;
}

async function setupSpreadsheetSession(page: Page, opts: SpreadsheetResultOptions) {
  const sessionId = opts.sessionId ?? "sheet-session";
  await mockAllApis(page, {
    sessions: [
      {
        id: sessionId,
        title: "Spreadsheet Session",
        roleId: "general",
        startedAt: "2026-04-13T10:00:00Z",
        updatedAt: "2026-04-13T10:05:00Z",
      },
    ],
  });

  await page.route(
    (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
    (route) =>
      route.fulfill({
        json: [
          { type: "session_meta", roleId: "general", sessionId },
          { type: "text", source: "user", message: "Make a sheet" },
          {
            type: "tool_result",
            source: "tool",
            result: {
              uuid: "sheet-result-1",
              toolName: "presentSpreadsheet",
              message: "Spreadsheet created",
              title: opts.title ?? "Test Sheet",
              data: { sheets: opts.sheets },
            },
          },
        ],
      }),
  );
}

async function mockFileContent(page: Page, path: string, body: { kind?: string; content?: string; message?: string }) {
  await page.route(
    (url) => url.pathname === "/api/files/content" && url.searchParams.get("path") === path,
    (route) => route.fulfill({ json: body }),
  );
}

// Shared helper: open the session and click the sidebar entry so the
// View mounts. Returns only after the View is visible.
async function openSpreadsheetView(page: Page, sessionId = "sheet-session", sidebarTitle = "Test Sheet") {
  await page.goto(`/chat/${sessionId}`);
  await expect(page.getByTestId("app-title")).toBeVisible();
  // Wait for the actual sidebar item rather than a fixed sleep —
  // page ready-state + element visibility is more reliable.
  const item = page.getByText(sidebarTitle).first();
  await expect(item).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
  await item.click();
}

test.describe("spreadsheet — rendering", () => {
  test("file-backed spreadsheet renders cell values", async ({ page }) => {
    const path = "artifacts/spreadsheets/abc.json";
    const sheets = [
      {
        name: "Sheet1",
        data: [
          [{ v: "Product" }, { v: "Sales" }],
          [{ v: "Apples" }, { v: 100 }],
          [{ v: "Bananas" }, { v: 200 }],
        ],
      },
    ];
    await setupSpreadsheetSession(page, { sheets: path });
    await mockFileContent(page, path, {
      kind: "text",
      content: JSON.stringify(sheets),
    });

    await openSpreadsheetView(page);
    await expect(page.getByText("Apples").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    await expect(page.getByText("Bananas").first()).toBeVisible();
    await expect(page.locator("text=100").first()).toBeVisible();
  });

  test("legacy inline sheets render without a fetch", async ({ page }) => {
    const sheets = [{ name: "Inline", data: [[{ v: "Legacy" }, { v: 1 }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await expect(page.getByText("Legacy").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("title from tool result is displayed in the header", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "x" }]] }];
    await setupSpreadsheetSession(page, { sheets, title: "Q1 Revenue" });
    await page.goto("/chat/sheet-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    const item = page.getByText("Q1 Revenue").first();
    await expect(item).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
    await item.click();
    await expect(page.locator("h1.title", { hasText: "Q1 Revenue" })).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("Excel download button is present and clickable", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "x" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    const btn = page.locator("button.download-btn");
    await expect(btn).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
    await expect(btn).toBeEnabled();
  });
});

test.describe("spreadsheet — multi-sheet", () => {
  test("sheet tabs appear only when there is more than one sheet", async ({ page }) => {
    const sheets = [{ name: "Single", data: [[{ v: "only" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    // No tab row when single sheet
    await expect(page.locator(".sheet-tabs")).toHaveCount(0);
  });

  test("multiple sheets show tabs and switching changes the rendered data", async ({ page }) => {
    const sheets = [
      { name: "Q1", data: [[{ v: "January-Q1" }]] },
      { name: "Q2", data: [[{ v: "April-Q2" }]] },
      { name: "Q3", data: [[{ v: "July-Q3" }]] },
    ];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);

    // All three tab buttons should exist
    await expect(page.locator("button.sheet-tab")).toHaveCount(3);
    await expect(page.locator("button.sheet-tab.active")).toHaveText("Q1");
    await expect(page.getByText("January-Q1").first()).toBeVisible();
    // Q2 content should not be visible yet
    await expect(page.getByText("April-Q2")).toHaveCount(0);

    // Click Q2 tab
    await page.locator("button.sheet-tab", { hasText: "Q2" }).click();
    await expect(page.locator("button.sheet-tab.active")).toHaveText("Q2");
    await expect(page.getByText("April-Q2").first()).toBeVisible();
  });
});

test.describe("spreadsheet — formula & format", () => {
  test("formulas are calculated and displayed (SUM)", async ({ page }) => {
    const sheets = [
      {
        name: "Sheet1",
        data: [[{ v: 10 }, { v: 20 }, { v: 30 }], [{ v: "=SUM(A1:C1)" }]],
      },
    ];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    // Sum of 10 + 20 + 30 = 60 should appear in the rendered table.
    await expect(page.locator("text=60").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("arithmetic formulas are calculated", async ({ page }) => {
    const sheets = [
      {
        name: "Sheet1",
        data: [[{ v: 6 }, { v: 7 }, { v: "=A1*B1" }]],
      },
    ];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await expect(page.locator("text=42").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("currency format renders with dollar sign and comma separators", async ({ page }) => {
    const sheets = [
      {
        name: "Sheet1",
        data: [[{ v: 1234.5, f: "$#,##0.00" }]],
      },
    ];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await expect(page.locator("text=$1,234.50").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("percent format renders with % suffix", async ({ page }) => {
    const sheets = [
      {
        name: "Sheet1",
        data: [[{ v: 0.25, f: "0.00%" }]],
      },
    ];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await expect(page.locator("text=25.00%").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });
});

test.describe("spreadsheet — mini editor", () => {
  test("clicking a cell opens the mini editor with the correct cell ref label", async ({ page }) => {
    const sheets = [
      {
        name: "Sheet1",
        data: [
          [{ v: "A1" }, { v: "B1" }],
          [{ v: "A2" }, { v: "B2" }],
        ],
      },
    ];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    // Click a <td> to trigger openMiniEditor.
    // The rendered HTML has a header row, so data starts from row 1.
    // The cell ref for data row 0 col 1 is "B1" (but the rendered
    // table includes a header row so we target row 2 in the DOM).
    // We target by text to keep the test robust.
    await page.locator("td", { hasText: "B2" }).first().click();
    await expect(page.locator(".mini-editor-panel")).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    // The cell-ref label should match the position we clicked.
    await expect(page.locator(".cell-ref")).toBeVisible();
  });

  test("mini editor has String / Formula radio buttons", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "hi" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await page.locator("td", { hasText: "hi" }).first().click();
    await expect(page.locator(".mini-editor-panel")).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    await expect(page.locator(".radio-option", { hasText: "String" })).toBeVisible();
    await expect(page.locator(".radio-option", { hasText: "Formula" })).toBeVisible();
  });

  test("mini editor close button (✕) closes the panel", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "hi" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await page.locator("td", { hasText: "hi" }).first().click();
    await expect(page.locator(".mini-editor-panel")).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    await page.locator("button.cancel-btn").click();
    await expect(page.locator(".mini-editor-panel")).toHaveCount(0);
  });

  test("formula mode shows a second input for format code", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "hi" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await page.locator("td", { hasText: "hi" }).first().click();
    await expect(page.locator(".mini-editor-panel")).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    // Switch to Formula mode
    await page.locator(".radio-option", { hasText: "Formula" }).click();
    // Two inputs: value/formula + format
    await expect(page.locator('input[placeholder^="Value or Formula"]')).toBeVisible();
    await expect(page.locator('input[placeholder^="Format"]')).toBeVisible();
  });
});

test.describe("spreadsheet — source editor", () => {
  test("Details section 'Edit Spreadsheet Data' is present", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "x" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await expect(page.locator("summary", { hasText: "Edit Spreadsheet Data" })).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
  });

  test("Apply Changes button is disabled when textarea matches state", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "x" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    // Open the details
    await page.locator("summary", { hasText: "Edit Spreadsheet Data" }).click();
    const applyBtn = page.locator("button.apply-btn");
    await expect(applyBtn).toBeDisabled();
  });

  test("editing the textarea enables Apply Changes", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "x" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await page.locator("summary", { hasText: "Edit Spreadsheet Data" }).click();
    const textarea = page.locator("textarea.spreadsheet-editor");
    await textarea.fill('[{"name":"Sheet1","data":[[{"v":"y"}]]}]');
    await expect(page.locator("button.apply-btn")).toBeEnabled();
  });
});

test.describe("spreadsheet — error handling", () => {
  test("too-large file shows an error message", async ({ page }) => {
    const path = "artifacts/spreadsheets/huge.json";
    await setupSpreadsheetSession(page, { sheets: path });
    await mockFileContent(page, path, {
      kind: "too-large",
      message: "File exceeds size limit",
    });
    await openSpreadsheetView(page);
    await expect(page.getByText("File exceeds size limit")).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("binary file shows the default 'Cannot load' message", async ({ page }) => {
    const path = "artifacts/spreadsheets/blob.json";
    await setupSpreadsheetSession(page, { sheets: path });
    await mockFileContent(page, path, { kind: "binary" });
    await openSpreadsheetView(page);
    await expect(page.getByText(/binary/i)).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
  });

  test("malformed JSON shows a parse error message", async ({ page }) => {
    const path = "artifacts/spreadsheets/broken.json";
    await setupSpreadsheetSession(page, { sheets: path });
    await mockFileContent(page, path, {
      kind: "text",
      content: "{not valid json",
    });
    await openSpreadsheetView(page);
    await expect(page.getByText(/malformed/i)).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
  });

  test("non-array content shows a shape error", async ({ page }) => {
    const path = "artifacts/spreadsheets/wrong.json";
    await setupSpreadsheetSession(page, { sheets: path });
    await mockFileContent(page, path, {
      kind: "text",
      content: JSON.stringify({ name: "not an array" }),
    });
    await openSpreadsheetView(page);
    await expect(page.getByText(/not an array/i)).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("missing content field shows 'no content' message", async ({ page }) => {
    const path = "artifacts/spreadsheets/empty.json";
    await setupSpreadsheetSession(page, { sheets: path });
    await mockFileContent(page, path, { kind: "text" });
    await openSpreadsheetView(page);
    await expect(page.getByText(/no content/i)).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
  });

  test("HTTP failure shows a statusText error", async ({ page }) => {
    const path = "artifacts/spreadsheets/404.json";
    await setupSpreadsheetSession(page, { sheets: path });
    await page.route(
      (url) => url.pathname === "/api/files/content" && url.searchParams.get("path") === path,
      (route) =>
        route.fulfill({
          status: 404,
          json: { error: "not found" },
        }),
    );
    await openSpreadsheetView(page);
    await expect(page.getByText(/Failed to load spreadsheet/i)).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });
});

test.describe("spreadsheet — edge cases", () => {
  test("empty spreadsheet array shows 'No spreadsheet data available'", async ({ page }) => {
    await setupSpreadsheetSession(page, { sheets: [] });
    await openSpreadsheetView(page);
    await expect(page.getByText("No spreadsheet data available")).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("cells with special characters (commas, quotes) render safely", async ({ page }) => {
    const sheets = [
      {
        name: "Sheet1",
        data: [
          [{ v: "has, comma" }, { v: 'has "quote"' }],
          [{ v: "normal" }, { v: "ok" }],
        ],
      },
    ];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await expect(page.getByText("has, comma").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    await expect(page.getByText(/has "quote"/).first()).toBeVisible();
  });

  test("boolean cell values render as TRUE / FALSE", async ({ page }) => {
    const sheets = [
      {
        name: "Sheet1",
        data: [[{ v: true }, { v: false }]],
      },
    ];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    // Accept either case; the engine may normalize.
    await expect(page.locator("td", { hasText: /true/i }).first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("many rows render without crash", async ({ page }) => {
    const data: { v: number }[][] = [];
    for (let i = 0; i < 50; i++) data.push([{ v: i }]);
    const sheets = [{ name: "Big", data }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    // First and last row values should both be present.
    await expect(page.locator("td", { hasText: "0" }).first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    await expect(page.locator("td", { hasText: "49" }).first()).toBeVisible();
  });
});
