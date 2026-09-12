import { test, expect, type Page } from "@playwright/test";
import { mockAllApis, enableFilesShowSystem } from "../fixtures/api";
import { API_ROUTES } from "../../src/config/apiRoutes";

import { ONE_SECOND_MS } from "../../server/utils/time.ts";
// Override the lazy-expand endpoint with a small fixture tree. Each
// directory returns its immediate children only — recursion is
// emulated by the client via subsequent fetches on expand.
async function mockFileTree(page: Page) {
  await page.route(
    (url) => url.pathname === API_ROUTES.files.dir,
    (route) => {
      const path = new URL(route.request().url()).searchParams.get("path") ?? "";
      if (path === "") {
        return route.fulfill({
          json: {
            name: "",
            path: "",
            type: "dir",
            children: [{ name: "wiki", path: "wiki", type: "dir" }],
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
              {
                name: "hello.md",
                path: "wiki/hello.md",
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

  // Mock file content for wiki/hello.md
  await page.route(
    (url) => url.pathname === API_ROUTES.files.content && url.searchParams.get("path") === "wiki/hello.md",
    (route) =>
      route.fulfill({
        json: {
          kind: "text",
          path: "wiki/hello.md",
          content: "# Hello\n\nThis is a test.",
          size: 42,
          modifiedMs: Date.now(),
        },
      }),
  );
}

test.beforeEach(async ({ page }) => {
  await mockAllApis(page);
  await mockFileTree(page);
  await enableFilesShowSystem(page);
});

test.describe("file explorer path in URL", () => {
  test("selecting a file pushes /files/<path> onto the URL", async ({ page }) => {
    await page.goto("/files");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Wait for the root dir's shallow listing to land — with lazy
    // expand (#200 phase 2), the tree only renders children after
    // `/api/files/dir?path=` resolves.
    await expect(page.locator('[data-testid="file-tree-dir-wiki"]')).toBeVisible();

    // Expand the wiki dir and click hello.md. FileTree dirs start
    // collapsed; click toggles expand + triggers a lazy-fetch of
    // wiki's children (resolved by the mockFileTree dispatcher).
    await page.locator('[data-testid="file-tree-dir-wiki"]').click();
    await expect(page.locator('[data-testid="file-tree-file-hello.md"]')).toBeVisible();
    await page.locator('[data-testid="file-tree-file-hello.md"]').click();

    // URL should now be `/files/wiki/hello.md` (path form, PR #633).
    await expect(async () => {
      const url = new URL(page.url());
      expect(url.pathname).toBe("/files/wiki/hello.md");
      expect(url.searchParams.get("path")).toBeNull();
    }).toPass({ timeout: 5 * ONE_SECOND_MS });
  });

  test("direct URL /files/<path> opens the file", async ({ page }) => {
    await page.goto("/files/wiki/hello.md");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // The file content should be visible
    await expect(page.getByText("This is a test.")).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("legacy /files?path= is redirected to /files/<path>", async ({ page }) => {
    await page.goto("/files?path=wiki/hello.md");
    await expect(page.getByText("This is a test.")).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    // Guard rewrites to the canonical form.
    await expect(async () => {
      const url = new URL(page.url());
      expect(url.pathname).toBe("/files/wiki/hello.md");
      expect(url.searchParams.get("path")).toBeNull();
    }).toPass({ timeout: 5 * ONE_SECOND_MS });
  });

  test("encoded-traversal attempt is stripped by guard", async ({ page }) => {
    // Raw `../` segments are browser-normalised before the request
    // leaves, so they never reach our guard. Percent-encoded `..`
    // survives the browser and is decoded by the router, which is
    // when our `.includes("..")` check fires.
    await page.goto("/files/..%2F..%2Fetc%2Fpasswd");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Guard redirects to /files (empty pathMatch).
    await expect(async () => {
      const url = new URL(page.url());
      expect(url.pathname).toMatch(/^\/files\/?$/);
      expect(url.searchParams.get("path")).toBeNull();
    }).toPass({ timeout: 5 * ONE_SECOND_MS });
  });

  test("legacy ?path= with traversal is stripped by guard", async ({ page }) => {
    await page.goto("/files?path=../../../etc/passwd");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await expect(async () => {
      const url = new URL(page.url());
      expect(url.pathname).toMatch(/^\/files\/?$/);
      expect(url.searchParams.get("path")).toBeNull();
    }).toPass({ timeout: 5 * ONE_SECOND_MS });
  });

  test("absolute path attempt is stripped by guard", async ({ page }) => {
    await page.goto("/files//etc/passwd");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await expect(async () => {
      const url = new URL(page.url());
      expect(url.pathname).toMatch(/^\/files\/?$/);
    }).toPass({ timeout: 5 * ONE_SECOND_MS });
  });

  test("editing a markdown file via the rendered-mode editor saves via PUT /api/files/content", async ({ page }) => {
    // Capture the PUT request body so we can assert on exactly what
    // the editor sent to the server.
    const putRequests: { path: string; content: string }[] = [];
    await page.route(
      (url) => url.pathname === API_ROUTES.files.content,
      async (route, req) => {
        if (req.method() === "PUT") {
          const body = req.postDataJSON() as {
            path: string;
            content: string;
          };
          putRequests.push(body);
          await route.fulfill({
            json: {
              path: body.path,
              size: body.content.length,
              modifiedMs: Date.now(),
            },
          });
          return;
        }
        // Non-PUT → fall through to the earlier GET mock.
        await route.fallback();
      },
    );

    await page.goto("/files/wiki/hello.md");

    // Open the collapsible editor — it hangs off the bottom of the
    // rendered markdown pane. The textarea is seeded with the raw
    // on-disk source (not the rewritten display text), so edits
    // round-trip through PUT /api/files/content unmodified.
    const summary = page.getByTestId("text-response-edit-summary");
    await expect(summary).toBeVisible({ timeout: 5 * ONE_SECOND_MS });
    await summary.click();

    const textarea = page.getByTestId("text-response-edit-textarea");
    await expect(textarea).toHaveValue("# Hello\n\nThis is a test.");

    const apply = page.getByTestId("text-response-apply-btn");
    await expect(apply).toBeDisabled();

    await textarea.fill("# Hello\n\nEdited by the test.");
    await expect(apply).toBeEnabled();
    await apply.click();

    await expect(() => {
      expect(putRequests).toHaveLength(1);
      expect(putRequests).toMatchObject([{ path: "wiki/hello.md", content: "# Hello\n\nEdited by the test." }]);
    }).toPass({ timeout: 5 * ONE_SECOND_MS });
  });

  test("closing a file drops the path segment from the URL", async ({ page }) => {
    await page.goto("/files/wiki/hello.md");
    await expect(page.getByText("This is a test.")).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });

    // Click the close button
    await expect(page.getByTestId("close-file-btn")).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    await page.getByTestId("close-file-btn").click();

    // URL should collapse to /files (no selected file in the path).
    await expect(async () => {
      const url = new URL(page.url());
      expect(url.pathname).toMatch(/^\/files\/?$/);
      expect(url.searchParams.get("path")).toBeNull();
    }).toPass({ timeout: 5 * ONE_SECOND_MS });

    // "Select a file" placeholder should be visible
    await expect(page.getByText("Select a file")).toBeVisible();
  });
});
