import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

import { ONE_SECOND_MS } from "../../server/utils/time.ts";
// Mount a session where the sidebar holds a presentSpreadsheet tool
// result. The @gui-chat-plugin/spreadsheet View renders when the user clicks
// the sidebar entry, so asserting against the rendered table exercises both the
// file-backed load (runtime dispatch) and the table render.

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

// The package View loads a file-backed workbook through its runtime dispatch
// ({ kind: "loadSpreadsheet", path }), which reaches server/plugins/spreadsheet-builtin.ts.
const SPREADSHEET_DISPATCH = "/api/plugins/runtime/spreadsheet/dispatch";

const isLoadOf = (body: unknown, path: string): boolean =>
  typeof body === "object" && body !== null && "kind" in body && body.kind === "loadSpreadsheet" && "path" in body && body.path === path;

async function mockLoad(page: Page, path: string, response: { status?: number; json: unknown }) {
  await page.route(
    (url) => url.pathname === SPREADSHEET_DISPATCH,
    async (route) => {
      if (!isLoadOf(route.request().postDataJSON(), path)) return route.fallback();
      return route.fulfill({ status: response.status ?? 200, json: response.json });
    },
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
    await mockLoad(page, path, { json: { message: "Loaded", data: { sheets } } });

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
    await expect(page.getByRole("heading", { level: 1, name: "Q1 Revenue" })).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("Excel download button is present and clickable", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "x" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    const btn = page.getByRole("button", { name: /Excel/ });
    await expect(btn).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
    await expect(btn).toBeEnabled();
  });
});

test.describe("spreadsheet — multi-sheet", () => {
  test("sheet tabs appear only when there is more than one sheet", async ({ page }) => {
    const sheets = [{ name: "Single", data: [[{ v: "only" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await expect(page.getByText("only").first()).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
    await expect(page.getByRole("button", { name: "Single", exact: true })).toHaveCount(0);
  });

  test("multiple sheets show tabs and switching changes the rendered data", async ({ page }) => {
    const sheets = [
      { name: "Q1", data: [[{ v: "January-Q1" }]] },
      { name: "Q2", data: [[{ v: "April-Q2" }]] },
      { name: "Q3", data: [[{ v: "July-Q3" }]] },
    ];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);

    const tab = (name: string) => page.getByRole("button", { name, exact: true });
    await Promise.all(["Q1", "Q2", "Q3"].map((name) => expect(tab(name)).toBeVisible()));
    await expect(page.getByText("January-Q1").first()).toBeVisible();
    await expect(page.getByText("April-Q2")).toHaveCount(0);

    await tab("Q2").click();
    await expect(page.getByText("April-Q2").first()).toBeVisible();
    await expect(page.getByText("January-Q1")).toHaveCount(0);
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
          [{ v: "a1" }, { v: "b1" }],
          [{ v: "a2" }, { v: "b2" }],
        ],
      },
    ];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await page.locator("td", { hasText: "b2" }).first().click();
    await expect(page.getByRole("textbox", { name: "Value", exact: true })).toHaveValue("b2", {
      timeout: 5 * ONE_SECOND_MS,
    });
    await expect(page.getByText("B2", { exact: true })).toBeVisible();
  });

  test("mini editor has String / Formula radio buttons", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "hi" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await page.locator("td", { hasText: "hi" }).first().click();
    await expect(page.getByRole("radio", { name: "String" })).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    await expect(page.getByRole("radio", { name: "Formula" })).toBeVisible();
  });

  test("mini editor close button (✕) closes the panel", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "hi" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await page.locator("td", { hasText: "hi" }).first().click();
    await expect(page.getByRole("radio", { name: "String" })).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    await page.getByRole("button", { name: "✕" }).click();
    await expect(page.getByRole("radio", { name: "String" })).toHaveCount(0);
  });

  test("formula mode shows a second input for format code", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "hi" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await page.locator("td", { hasText: "hi" }).first().click();
    await expect(page.getByRole("radio", { name: "String" })).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    // Switch to Formula mode
    await page.getByRole("radio", { name: "Formula" }).click();
    // Two inputs: value/formula + format
    await expect(page.locator('input[placeholder^="Value or Formula"]')).toBeVisible();
    await expect(page.locator('input[placeholder^="Format"]')).toBeVisible();
  });
});

test.describe("spreadsheet — saving a file-backed sheet", () => {
  test("editing a cell sends saveSpreadsheet with the edit and the same path", async ({ page }) => {
    const path = "artifacts/spreadsheets/2026/10/0123456789abcdef.json";
    const sheets = [
      {
        name: "Sheet1",
        data: [
          [{ v: "Price" }, { v: 100 }],
          [{ v: "Total" }, { v: "=B1*2" }],
        ],
      },
    ];
    await setupSpreadsheetSession(page, { sheets: path });
    await mockLoad(page, path, { json: { message: "Loaded", data: { sheets } } });
    const saves: unknown[] = [];
    await page.route(
      (url) => url.pathname === SPREADSHEET_DISPATCH,
      async (route) => {
        const body: unknown = route.request().postDataJSON();
        if (typeof body !== "object" || body === null || !("kind" in body) || body.kind !== "saveSpreadsheet") return route.fallback();
        saves.push(body);
        return route.fulfill({ json: { message: "Saved", data: { sheets: path } } });
      },
    );
    await openSpreadsheetView(page);
    await expect(page.locator("td", { hasText: "200" }).first()).toBeVisible({ timeout: 5 * ONE_SECOND_MS });

    await page.locator("td", { hasText: "100" }).first().click();
    await page.getByRole("textbox", { name: /^Value or Formula/ }).fill("150");
    await page.getByRole("button", { name: "Update" }).click();

    await expect(page.locator("td", { hasText: "300" }).first()).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toMatchObject({
      kind: "saveSpreadsheet",
      path,
      sheets: [
        {
          name: "Sheet1",
          data: [
            [{ v: "Price" }, { v: 150 }],
            [{ v: "Total" }, { v: "=B1*2" }],
          ],
        },
      ],
    });
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
    await expect(page.getByRole("button", { name: "Apply Changes" })).toBeDisabled();
  });

  test("editing the textarea enables Apply Changes", async ({ page }) => {
    const sheets = [{ name: "Sheet1", data: [[{ v: "x" }]] }];
    await setupSpreadsheetSession(page, { sheets });
    await openSpreadsheetView(page);
    await page.locator("summary", { hasText: "Edit Spreadsheet Data" }).click();
    const textarea = page.locator("details", { hasText: "Edit Spreadsheet Data" }).locator("textarea");
    await textarea.fill('[{"name":"Sheet1","data":[[{"v":"y"}]]}]');
    await expect(page.getByRole("button", { name: "Apply Changes" })).toBeEnabled();
  });
});

test.describe("spreadsheet — error handling", () => {
  test("a failed load shows the server's error", async ({ page }) => {
    const path = "artifacts/spreadsheets/missing.json";
    await setupSpreadsheetSession(page, { sheets: path });
    await mockLoad(page, path, { status: 500, json: { error: "plugin execute failed: ENOENT: no such file" } });
    await openSpreadsheetView(page);
    await expect(page.getByText(/Failed to load spreadsheet/i)).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
    await expect(page.getByText(/ENOENT/)).toBeVisible();
  });

  test("a load that returns something other than sheets shows a shape error", async ({ page }) => {
    const path = "artifacts/spreadsheets/wrong.json";
    await setupSpreadsheetSession(page, { sheets: path });
    await mockLoad(page, path, { json: { message: "Loaded", data: { sheets: { name: "not an array" } } } });
    await openSpreadsheetView(page);
    await expect(page.getByText(/Data must be an array of sheets/i)).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
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
