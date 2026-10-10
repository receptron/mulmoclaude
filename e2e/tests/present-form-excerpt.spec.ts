// presentForm's `excerpt` field (#3426): the passage under discussion renders
// inside the form, its highlighted phrase marked, right above the questions
// about it — and the submission carries only the answers, never the passage.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { ONE_SECOND_MS } from "../../server/utils/time.ts";

const SESSION_ID = "form-excerpt-session";

const FORM_DATA = {
  title: "Review comments",
  fields: [
    {
      id: "c1_excerpt",
      type: "excerpt",
      label: "Comment 1",
      text: "The release ships next week.\nIt include several fixes.",
      highlights: ["It include"],
      description: "Subject-verb agreement.",
    },
    { id: "c1_choice", type: "radio", label: "Comment 1: fix", choices: ["A: It includes", "B: It will include"], required: true },
    { id: "c1_note", type: "textarea", label: "Comment 1: note" },
  ],
};

async function setupFormSession(page: Page): Promise<void> {
  await mockAllApis(page, {
    sessions: [{ id: SESSION_ID, title: "Form", roleId: "general", startedAt: "2026-10-10T10:00:00Z", updatedAt: "2026-10-10T10:05:00Z" }],
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
    (route) =>
      route.fulfill({
        json: [
          { type: "session_meta", roleId: "general", sessionId: SESSION_ID },
          { type: "text", source: "user", message: "Review my draft" },
          {
            type: "tool_result",
            source: "tool",
            result: { uuid: "form-result-1", toolName: "presentForm", title: "Review comments", message: "Form created", data: FORM_DATA, jsonData: FORM_DATA },
          },
        ],
      }),
  );
}

async function captureAgentRuns(page: Page): Promise<string[]> {
  const messages: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/agent",
    (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      messages.push(route.request().postData() ?? "");
      return route.fulfill({ status: 202, json: { chatSessionId: SESSION_ID } });
    },
  );
  return messages;
}

test.describe("presentForm excerpt", () => {
  test("shows the passage with its phrase marked, above the questions", async ({ page }) => {
    await setupFormSession(page);
    await page.goto(`/chat/${SESSION_ID}`);

    const excerpt = page.getByTestId("form-excerpt");
    await expect(excerpt).toBeVisible();
    await expect(excerpt.locator("mark")).toHaveText("It include");
    await expect(excerpt).toContainText("Subject-verb agreement.");

    const excerptBox = await excerpt.boundingBox();
    const choiceBox = await page.getByText("A: It includes").boundingBox();
    expect(excerptBox && choiceBox && excerptBox.y < choiceBox.y).toBe(true);
  });

  test("submits the answers without the passage", async ({ page }) => {
    await setupFormSession(page);
    const agentRuns = await captureAgentRuns(page);
    await page.goto(`/chat/${SESSION_ID}`);

    await page.getByText("A: It includes").click();
    await page
      .getByTestId("present-form-view")
      .getByRole("button", { name: /submit/i })
      .click();

    await expect.poll(() => agentRuns.length, { timeout: 2 * ONE_SECOND_MS }).toBe(1);
    expect(agentRuns[0]).toContain("Comment 1: fix: A: It includes");
    expect(agentRuns[0]).not.toContain("several fixes");
    expect(agentRuns[0]).not.toContain("Comment 1: (none)");
  });
});
