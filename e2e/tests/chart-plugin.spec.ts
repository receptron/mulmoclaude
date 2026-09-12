import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

// Serves a fake session whose only tool_result is a `presentChart`
// document with two charts (line + bar). The View renders them via
// ECharts; we verify both cards and their canvases are in the DOM
// and that each has a PNG download button.

async function setupChartSession(page: Page) {
  await mockAllApis(page, {
    sessions: [
      {
        id: "chart-session",
        title: "Chart Session",
        roleId: "general",
        startedAt: "2026-04-14T10:00:00Z",
        updatedAt: "2026-04-14T10:05:00Z",
      },
    ],
  });

  await page.route(
    (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
    (route) =>
      route.fulfill({
        json: [
          {
            type: "session_meta",
            roleId: "general",
            sessionId: "chart-session",
          },
          { type: "text", source: "user", message: "Chart this" },
          {
            type: "tool_result",
            source: "tool",
            result: {
              uuid: "result-chart-1",
              toolName: "presentChart",
              message: "Chart ready",
              title: "Sales Overview",
              data: {
                title: "Sales Overview",
                filePath: "charts/sales-overview-123.chart.json",
                document: {
                  title: "Sales Overview",
                  charts: [
                    {
                      title: "Monthly revenue",
                      type: "line",
                      option: {
                        xAxis: {
                          type: "category",
                          data: ["Jan", "Feb", "Mar"],
                        },
                        yAxis: { type: "value" },
                        series: [{ type: "line", data: [100, 120, 150] }],
                      },
                    },
                    {
                      title: "Units sold",
                      type: "bar",
                      option: {
                        xAxis: { type: "category", data: ["A", "B", "C"] },
                        yAxis: { type: "value" },
                        series: [{ type: "bar", data: [30, 45, 20] }],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      }),
  );
}

test.describe("chart plugin rendering", () => {
  test.beforeEach(async ({ page }) => {
    await setupChartSession(page);
  });

  test("renders both charts in the canvas", async ({ page }) => {
    await page.goto("/chat/chart-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Click the preview for the chart result to open it in the canvas.
    // The sidebar preview component shows the document title.
    await page.getByText("Sales Overview").first().click();

    await expect(page.locator('[data-testid="chart-card-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="chart-card-1"]')).toBeVisible();

    // Each card has a mount point div that ECharts will replace with
    // canvas content. The div itself is what we selector-check; the
    // fact that ECharts mounted without throwing is proven by the PNG
    // button being present.
    await expect(page.locator('[data-testid="chart-canvas-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="chart-canvas-1"]')).toBeVisible();

    await expect(page.locator('[data-testid="chart-export-png-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="chart-export-png-1"]')).toBeVisible();
  });

  test("PNG export button triggers a download", async ({ page }) => {
    await page.goto("/chat/chart-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("Sales Overview").first().click();
    await expect(page.locator('[data-testid="chart-export-png-0"]')).toBeVisible();

    // Click the PNG button and confirm a download is initiated.
    const downloadPromise = page.waitForEvent("download");
    await page.locator('[data-testid="chart-export-png-0"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
  });
});
