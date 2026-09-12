import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

// A 1x1 transparent PNG — the placeholder the server writes for a fresh
// openCanvas. Served for the canvas background fetch.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

interface CanvasResult {
  uuid: string;
  imageData: string;
}

async function setupCanvasSession(page: Page, results: CanvasResult[]): Promise<void> {
  await mockAllApis(page, {
    sessions: [{ id: "canvas-session", title: "Canvas Session", roleId: "general", startedAt: "2026-04-14T10:00:00Z", updatedAt: "2026-04-14T10:05:00Z" }],
  });

  await page.route(
    (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
    (route) =>
      route.fulfill({
        json: [
          { type: "session_meta", roleId: "general", sessionId: "canvas-session" },
          { type: "text", source: "user", message: "I want to draw" },
          ...results.map((res) => ({
            type: "tool_result",
            source: "tool",
            result: {
              uuid: res.uuid,
              toolName: "openCanvas",
              message: "Drawing Canvas",
              title: "Drawing Canvas",
              data: { imageData: res.imageData, prompt: "" },
            },
          })),
        ],
      }),
  );

  // Background image fetch for the canvas.
  await page.route(
    (url) => url.pathname === "/api/files/raw",
    (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(TINY_PNG, "base64") }),
  );
}

// Land in stack layout so every openCanvas result mounts a live canvas.
async function useStackLayout(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem("canvas_layout_mode", "stack"));
}

test.describe("canvas plugin", () => {
  test("two canvas results get DISTINCT element ids (no cross-contamination)", async ({ page }) => {
    await useStackLayout(page);
    await setupCanvasSession(page, [
      { uuid: "canvas-a", imageData: "images/canvas-a.png" },
      { uuid: "canvas-b", imageData: "images/canvas-b.png" },
    ]);
    await page.goto("/chat/canvas-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    const canvases = page.locator("canvas[id^='vdc-']");
    await expect(canvases).toHaveCount(2);
    const ids = await canvases.evaluateAll((els) => els.map((node) => node.id));
    // Both are per-instance ids, and they differ — the library's
    // `querySelector('#'+id)` can no longer resolve one canvas for both.
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((elementId) => elementId.startsWith("vdc-"))).toBe(true);
  });

  test("a failed save surfaces the 'not saved' indicator", async ({ page }) => {
    await useStackLayout(page);
    await setupCanvasSession(page, [{ uuid: "canvas-a", imageData: "images/canvas-a.png" }]);
    // Make every image-store PUT fail.
    await page.route(
      (url) => url.pathname === "/api/images/update",
      (route) => route.fulfill({ status: 500, json: { error: "disk full" } }),
    );
    await page.goto("/chat/canvas-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    const canvas = page.locator("canvas[id^='vdc-']").first();
    await expect(canvas).toBeVisible();
    // A stroke end triggers a save; the PUT fails → indicator shows.
    await canvas.dispatchEvent("mouseup");
    await expect(page.getByTestId("canvas-save-failed")).toBeVisible();
  });

  test("Clear PUTs a blank image and remounts the canvas", async ({ page }) => {
    await useStackLayout(page);
    await setupCanvasSession(page, [{ uuid: "canvas-a", imageData: "images/canvas-a.png" }]);
    const puts: string[] = [];
    await page.route(
      (url) => url.pathname === "/api/images/update",
      async (route) => {
        puts.push(route.request().postData() ?? "");
        await route.fulfill({ json: { path: "images/canvas-a.png" } });
      },
    );
    await page.goto("/chat/canvas-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    const idBefore = await page.locator("canvas[id^='vdc-']").first().getAttribute("id");
    // Clear is the red delete-icon button in the toolbar.
    await page.getByTitle("Clear", { exact: true }).click();

    // A PUT (the blank image) must have fired…
    await expect.poll(() => puts.length).toBeGreaterThan(0);
    // …and the canvas must have remounted with a fresh id (renderKey++),
    // so it re-fetches the now-blank file instead of the stale drawing.
    await expect.poll(async () => page.locator("canvas[id^='vdc-']").first().getAttribute("id")).not.toBe(idBefore);
  });
});
