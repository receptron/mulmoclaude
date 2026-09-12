import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

// Bounded path validator — `[\w-]+` doesn't overlap with anything
// else in the pattern, so the optional capture group can't trigger
// catastrophic backtracking on adversarial input. eslint-plugin-
// security flags any `(...)+` shape generically; rationale captured
// here so future readers don't try to "harden" it into a slower form.
// eslint-disable-next-line security/detect-unsafe-regex -- bounded, no nested-quantifier overlap
const VALID_CHAT_PATH = /^\/chat(\/[\w-]+)?$/;

test.beforeEach(async ({ page }) => {
  await mockAllApis(page);
});

test.describe("URL injection defence", () => {
  test("XSS in path → app renders normally (no crash)", async ({ page }) => {
    // Even with a garbage path, the app should not crash.
    // The catch-all redirect sends it to /chat.
    await page.goto("/chat/<script>alert(1)</script>");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // URL must resolve to a valid /chat path — no script tags in decoded pathname
    const pathname = decodeURIComponent(new URL(page.url()).pathname);
    expect(pathname).toMatch(VALID_CHAT_PATH);
    expect(pathname).not.toContain("<script>");
  });

  test("path traversal → app renders normally", async ({ page }) => {
    await page.goto("/chat/..%2F..%2Fetc%2Fpasswd");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // URL must resolve to a valid /chat path, not a traversed location
    const { pathname } = new URL(page.url());
    expect(pathname).toMatch(VALID_CHAT_PATH);
  });

  test("extremely long path segment → app renders normally", async ({ page }) => {
    const longStr = "a".repeat(200);
    await page.goto(`/chat/${longStr}`);
    await expect(page.getByTestId("app-title")).toBeVisible();
  });

  test("unknown route → redirected to /chat, app loads", async ({ page }) => {
    await page.goto("/admin/secret");
    await expect(page.getByTestId("app-title")).toBeVisible();
    const { pathname } = new URL(page.url());
    expect(pathname).toMatch(VALID_CHAT_PATH);
  });

  test("special chars in path → app does not crash", async ({ page }) => {
    await page.goto('/chat/test"onmouseover="alert(1)');
    await expect(page.getByTestId("app-title")).toBeVisible();
  });
});
