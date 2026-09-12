// Phase-2 lazy-expand behaviour for the file explorer (#200).
//
// Phase 1 (PR #207) made the server async + added
// `/api/files/dir?path=<rel>` for shallow listings. Phase 2 (this
// branch) switches the client to fetch per-directory on expand.
//
// These tests assert the observable wire contract:
//
//   - on mount, client hits `/api/files/dir?path=` once (root)
//   - expanding a collapsed dir triggers `/api/files/dir?path=<dir>`
//   - collapsing + re-expanding does NOT refetch (cache holds)
//   - deep-link `?path=a/b/c.md` auto-loads ancestor dirs

import { test, expect, type Page, type Route } from "@playwright/test";
import { mockAllApis, enableFilesShowSystem } from "../fixtures/api";

import { ONE_SECOND_MS } from "../../server/utils/time.ts";

interface CountingMock {
  counts: Map<string, number>;
  reset: () => void;
}

async function mockLazyDirs(page: Page): Promise<CountingMock> {
  const counts = new Map<string, number>();

  await page.route(
    (url) => url.pathname === "/api/files/dir",
    (route: Route) => {
      const path = new URL(route.request().url()).searchParams.get("path") ?? "";
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path === "") {
        return route.fulfill({
          json: {
            name: "",
            path: "",
            type: "dir",
            children: [
              { name: "wiki", path: "wiki", type: "dir" },
              { name: "notes", path: "notes", type: "dir" },
            ],
          },
        });
      }
      if (path === "wiki") {
        return route.fulfill({
          json: {
            name: "wiki",
            path: "wiki",
            type: "dir",
            children: [
              { name: "pages", path: "wiki/pages", type: "dir" },
              {
                name: "readme.md",
                path: "wiki/readme.md",
                type: "file",
                size: 10,
              },
            ],
          },
        });
      }
      if (path === "wiki/pages") {
        return route.fulfill({
          json: {
            name: "pages",
            path: "wiki/pages",
            type: "dir",
            children: [
              {
                name: "foo.md",
                path: "wiki/pages/foo.md",
                type: "file",
                size: 42,
              },
            ],
          },
        });
      }
      return route.fulfill({
        json: { name: path, path, type: "dir", children: [] },
      });
    },
  );

  await page.route(
    (url) => url.pathname === "/api/files/content",
    (route) =>
      route.fulfill({
        json: {
          kind: "text",
          path: new URL(route.request().url()).searchParams.get("path") ?? "",
          content: "stub content",
          size: 12,
          modifiedMs: Date.now(),
        },
      }),
  );

  return {
    counts,
    reset: () => counts.clear(),
  };
}

test.beforeEach(async ({ page }) => {
  await mockAllApis(page);
  await mockLazyDirs(page);
  await enableFilesShowSystem(page);
});

test.describe("file explorer lazy expand (#200 phase 2)", () => {
  test("root listing lands once on mount, no subtree fetched yet", async ({ page }) => {
    const mock = await mockLazyDirs(page);
    await page.goto("/files");
    await expect(page.locator('[data-testid="file-tree-dir-wiki"]')).toBeVisible();
    // Only the root fetch should have fired — children of collapsed
    // `wiki` / `notes` must wait for an expand click.
    expect(mock.counts.get("") ?? 0).toBeGreaterThan(0);
    expect(mock.counts.get("wiki") ?? 0).toBe(0);
    expect(mock.counts.get("notes") ?? 0).toBe(0);
  });

  test("clicking a collapsed dir fetches its children exactly once", async ({ page }) => {
    const mock = await mockLazyDirs(page);
    await page.goto("/files");
    await expect(page.locator('[data-testid="file-tree-dir-wiki"]')).toBeVisible();

    await page.locator('[data-testid="file-tree-dir-wiki"]').click();
    // Wait for wiki's contents to surface
    await expect(page.locator('[data-testid="file-tree-file-readme.md"]')).toBeVisible();
    expect(mock.counts.get("wiki")).toBe(1);

    // Collapse + re-expand: should NOT refetch — cache hit.
    await page.locator('[data-testid="file-tree-dir-wiki"]').click();
    await page.locator('[data-testid="file-tree-dir-wiki"]').click();
    await expect(page.locator('[data-testid="file-tree-file-readme.md"]')).toBeVisible();
    expect(mock.counts.get("wiki")).toBe(1);
  });

  test("deep link auto-expands ancestors", async ({ page }) => {
    const mock = await mockLazyDirs(page);
    await page.goto("/files/wiki/pages/foo.md");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Both `wiki` and `wiki/pages` should have been fetched so the
    // tree can reveal the selection.
    await expect.poll(() => mock.counts.get("wiki") ?? 0, { timeout: 3 * ONE_SECOND_MS }).toBeGreaterThan(0);
    await expect.poll(() => mock.counts.get("wiki/pages") ?? 0, { timeout: 3 * ONE_SECOND_MS }).toBeGreaterThan(0);

    // The selected file's content loads.
    await expect(page.getByText("stub content")).toBeVisible();
  });
});
