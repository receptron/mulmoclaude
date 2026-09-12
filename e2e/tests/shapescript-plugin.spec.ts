import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

// Serves a fake session whose only tool_result is a `presentShapeScript`
// document. The View parses the ShapeScript and renders it with Three.js;
// we verify the result is previewable in the sidebar, opens in the canvas,
// and that the parser did not reject the script.

const SCRIPT = `define count 4
for i in 1 to count {
    cube {
        position (i * 2 - 5) 0 0
        size 1
        color (i / count) 0.5 (1 - i / count)
    }
}`;

async function setupShapeScriptSession(page: Page) {
  await mockAllApis(page, {
    sessions: [
      {
        id: "shapescript-session",
        title: "ShapeScript Session",
        roleId: "artist",
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
          { type: "session_meta", roleId: "artist", sessionId: "shapescript-session" },
          { type: "text", source: "user", message: "Draw four cubes" },
          {
            type: "tool_result",
            source: "tool",
            result: {
              uuid: "result-shapescript-1",
              toolName: "presentShapeScript",
              message: "Created 3D visualization: Cube Row",
              title: "Cube Row",
              data: { script: SCRIPT },
            },
          },
        ],
      }),
  );
}

test.describe("shapescript plugin rendering", () => {
  test.beforeEach(async ({ page }) => {
    await setupShapeScriptSession(page);
  });

  test("opens the 3D view from the sidebar preview", async ({ page }) => {
    await page.goto("/chat/shapescript-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    await expect(page.locator('[data-testid="shapescript-preview"]')).toBeVisible();
    await page.getByText("Cube Row").first().click();

    await expect(page.locator('[data-testid="shapescript-view"]')).toBeVisible();
    await expect(page.locator('[data-testid="shapescript-viewport"]')).toBeVisible();
    await expect(page.locator('[data-testid="shapescript-parse-error"]')).toHaveCount(0);
    await expect(page.getByTestId("shapescript-download-usdz")).toBeEnabled();
  });

  test("validates edited geometry and renders completed builders", async ({ page }) => {
    await page.goto("/chat/shapescript-session");
    await page.getByText("Cube Row").first().click();
    const view = page.getByTestId("shapescript-view");
    await view.locator("summary").click();
    const editor = view.locator("textarea");
    const apply = view.locator("button.apply-btn");
    const download = page.getByTestId("shapescript-download-usdz");
    await expect(download).toBeEnabled();
    await editor.fill("cube { size missing }");
    // A dirty editor cannot be exported: the USDZ is built from the APPLIED
    // script, which is what the viewport shows, not from unsaved edits.
    await expect(download).toBeDisabled();
    await apply.click();
    await expect(page.getByTestId("shapescript-parse-error")).toContainText("Undefined variable: missing");
    // Failed edits remain unsaved and can be corrected in place.
    await expect(apply).toBeEnabled();
    for (const script of [
      "loft {\n square\n translate 0 0 2\n circle\n}",
      "hull {\n cube\n cube { position 2 0 0 }\n}",
      "stencil {\n cube { color 1 0 0 }\n cube {\n  position 0.5 0 0\n  color 0 1 0\n }\n}",
    ]) {
      await editor.fill(script);
      await apply.click();
      await expect(page.getByTestId("shapescript-parse-error")).toHaveCount(0);
      await expect(apply).toBeDisabled();
      await expect(download).toBeEnabled();
      await expect(view.locator("canvas")).toBeVisible();
    }
  });
});
