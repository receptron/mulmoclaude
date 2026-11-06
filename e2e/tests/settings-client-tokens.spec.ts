// Settings → API tokens (#3637): the issued client tokens with their scopes
// and last use, and revoking one from the page. Issuing stays on the CLI, so
// the page has no way to create one.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

interface TokenRow {
  name: string;
  id: string;
  createdAt: string;
  scopes: string[];
  lastUsedAt: string | null;
}

const INITIAL: TokenRow[] = [
  { name: "n8n", id: "a".repeat(16), createdAt: "2026-11-01T09:00:00.000Z", scopes: ["read", "collection:tasks"], lastUsedAt: "2026-11-06T10:20:00.000Z" },
  { name: "discord", id: "b".repeat(16), createdAt: "2026-11-02T09:00:00.000Z", scopes: ["full"], lastUsedAt: null },
];

/** Stateful mock: DELETE removes the row, so the reload after a revoke shows it gone. */
async function mockClientTokens(page: Page, initial: TokenRow[], unreadableEntryCount = 0): Promise<{ revoked: string[] }> {
  const state = { rows: [...initial], revoked: [] as string[] };
  await page.route(
    (url) => url.pathname === "/api/config/client-tokens",
    (route) => route.fulfill({ json: { tokens: state.rows, unreadableEntryCount } }),
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/config/client-tokens/"),
    async (route) => {
      const url = new URL(route.request().url());
      const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      state.rows = state.rows.filter((row) => row.name !== name);
      state.revoked.push(`${route.request().method()} ${name} id=${url.searchParams.get("id")}`);
      await route.fulfill({ json: { revoked: name } });
    },
  );
  return state;
}

async function openTab(page: Page): Promise<void> {
  await page.goto("/chat");
  await expect(page.getByTestId("app-title")).toBeVisible();
  await page.getByTestId("settings-btn").click();
  await page.getByTestId("settings-tab-clientTokens").click();
  await expect(page.getByTestId("settings-client-tokens-tab")).toBeVisible();
}

test.describe("Settings → API tokens", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("lists each token with its scopes, and a never-used one as such", async ({ page }) => {
    await mockClientTokens(page, INITIAL);
    await openTab(page);
    const n8n = page.getByTestId("settings-client-token-n8n");
    await expect(n8n).toContainText("read, collection:tasks");
    await expect(page.getByTestId("settings-client-token-discord").getByTestId("settings-client-token-last-used")).toHaveText(/never/i);
  });

  test("revoking asks first, then removes only that token", async ({ page }) => {
    const state = await mockClientTokens(page, INITIAL);
    await openTab(page);
    const n8n = page.getByTestId("settings-client-token-n8n");
    await n8n.getByTestId("settings-client-token-revoke-btn").click();
    await expect(page.getByTestId("settings-client-token-confirm-body")).toContainText("n8n");
    // Focus moves to Cancel, the safe choice, and the buttons point at the warning.
    await expect(n8n.getByTestId("settings-client-token-cancel-btn")).toBeFocused();
    await expect(n8n.getByTestId("settings-client-token-confirm-btn")).toHaveAttribute("aria-describedby", "settings-client-token-confirm-body");
    expect(state.revoked).toEqual([]);

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("settings-client-token-confirm-body")).toHaveCount(0);
    await expect(n8n.getByTestId("settings-client-token-revoke-btn")).toBeFocused();
    expect(state.revoked).toEqual([]);

    await n8n.getByTestId("settings-client-token-revoke-btn").click();
    await n8n.getByTestId("settings-client-token-confirm-btn").click();
    await expect(page.getByTestId("settings-client-token-n8n")).toHaveCount(0);
    await expect(page.getByTestId("settings-client-tokens-tab")).toBeFocused();
    await expect(page.getByTestId("settings-client-token-discord")).toBeVisible();
    expect(state.revoked).toEqual([`DELETE n8n id=${"a".repeat(16)}`]);
  });

  test("with no tokens, says so and names the command that issues one", async ({ page }) => {
    await mockClientTokens(page, []);
    await openTab(page);
    await expect(page.getByTestId("settings-client-tokens-empty")).toBeVisible();
    await expect(page.getByTestId("settings-client-tokens-tab")).toContainText("npx mulmoclaude token add <name>");
  });

  test("says when the store has entries this server cannot read", async ({ page }) => {
    await mockClientTokens(page, INITIAL, 2);
    await openTab(page);
    await expect(page.getByTestId("settings-client-tokens-unreadable")).toContainText("2");
  });

  test("a refused revoke is shown and the list is reloaded", async ({ page }) => {
    await mockClientTokens(page, INITIAL);
    await page.route(
      (url) => url.pathname.startsWith("/api/config/client-tokens/"),
      (route) => route.fulfill({ status: 409, json: { error: "that name now belongs to a different token; reload the list" } }),
    );
    await openTab(page);
    const n8n = page.getByTestId("settings-client-token-n8n");
    await n8n.getByTestId("settings-client-token-revoke-btn").click();
    await n8n.getByTestId("settings-client-token-confirm-btn").click();
    await expect(page.getByTestId("settings-client-tokens-revoke-error")).toContainText("different token");
    await expect(page.getByTestId("settings-client-token-n8n")).toBeVisible();
  });

  test("a failed load is shown, not an empty list", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/api/config/client-tokens",
      (route) => route.fulfill({ status: 500, json: { error: "boom" } }),
    );
    await openTab(page);
    await expect(page.getByTestId("settings-client-tokens-error")).toBeVisible();
    await expect(page.getByTestId("settings-client-tokens-empty")).toHaveCount(0);
  });
});
