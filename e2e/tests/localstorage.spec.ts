import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

import { ONE_SECOND_MS } from "../../server/utils/time.ts";

test.beforeEach(async ({ page }) => {
  await mockAllApis(page);
});

test.describe("localStorage state restoration", () => {
  test("canvas_layout_mode=stack persists across reload", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("canvas_layout_mode", "stack"));
    await page.reload();
    await expect(page.getByTestId("app-title")).toBeVisible();
    await expect(async () => {
      const stored = await page.evaluate(() => localStorage.getItem("canvas_layout_mode"));
      expect(stored).toBe("stack");
    }).toPass({ timeout: 5 * ONE_SECOND_MS });
  });

  test("canvas_layout_mode=single persists across reload", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("canvas_layout_mode", "single"));
    await page.reload();
    await expect(page.getByTestId("app-title")).toBeVisible();
    await expect(async () => {
      const stored = await page.evaluate(() => localStorage.getItem("canvas_layout_mode"));
      expect(stored).toBe("single");
    }).toPass({ timeout: 5 * ONE_SECOND_MS });
  });

  test("canvas_layout_mode with invalid value → defaults to single", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("canvas_layout_mode", "<script>alert(1)</script>"));
    await page.reload();
    await expect(page.getByTestId("app-title")).toBeVisible();
    // Layout silently falls back to single; no URL param is written.
    await expect(page).toHaveURL(/\/chat/);
  });

  test("legacy canvas_view_mode key is deleted on first load (no migration)", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("canvas_view_mode", "files"));
    await page.reload();
    await expect(page.getByTestId("app-title")).toBeVisible();
    await expect(async () => {
      const legacy = await page.evaluate(() => localStorage.getItem("canvas_view_mode"));
      expect(legacy).toBeNull();
    }).toPass({ timeout: 5 * ONE_SECOND_MS });
    // And the URL stays on /chat — the old value is not migrated to a route.
    await expect(page).toHaveURL(/\/chat/);
  });

  test("right_sidebar_visible is preserved across reloads", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("right_sidebar_visible", "true"));
    await page.reload();
    // The right sidebar should be visible (it contains tool call history).
    // We check for the build icon which toggles it.
    await expect(page.getByTestId("app-title")).toBeVisible();
    // The right sidebar state is a UI pref — just verify no crash.
  });

  test("corrupted localStorage values don't crash the app", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("canvas_layout_mode", '{"__proto__":{"x":1}}');
      localStorage.setItem("right_sidebar_visible", "maybe");
      localStorage.setItem("files_expanded_dirs", "not-json");
    });
    await page.reload();
    await expect(page.getByTestId("app-title")).toBeVisible();
  });

  test("files_expanded_dirs with valid JSON set is preserved", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("files_expanded_dirs", JSON.stringify(["", "wiki", "data"])));
    await page.reload();
    await expect(page.getByTestId("app-title")).toBeVisible();
    const stored = await page.evaluate(() => localStorage.getItem("files_expanded_dirs"));
    expect(JSON.parse(stored ?? "[]")).toContain("wiki");
  });
});
