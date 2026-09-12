// E2E for the manageSkills plugin — list rendering, markdown body,
// delete/edit, and the external catalog. The server's /api/skills
// endpoint is mocked via page.route so tests run without a real
// ~/.claude/skills/ tree.

import { test, expect, type Page, type Route } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

function urlEndsWith(suffix: string): (url: URL) => boolean {
  return (url) => url.pathname === suffix;
}

async function setupSkillsSession(page: Page) {
  await mockAllApis(page, {
    sessions: [
      {
        id: "skills-session",
        title: "Skills Session",
        roleId: "general",
        startedAt: "2026-04-14T10:00:00Z",
        updatedAt: "2026-04-14T10:05:00Z",
      },
    ],
  });

  // Session transcript with a manageSkills tool_result so the View
  // is reachable by clicking the sidebar entry.
  await page.route(
    (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
    (route) =>
      route.fulfill({
        json: [
          {
            type: "session_meta",
            roleId: "general",
            sessionId: "skills-session",
          },
          { type: "text", source: "user", message: "Show my skills" },
          {
            type: "tool_result",
            source: "tool",
            result: {
              uuid: "skills-result-1",
              toolName: "manageSkills",
              title: "Skills",
              message: "Found 2 skills.",
              data: {
                skills: [
                  {
                    name: "ci_enable",
                    description: "Enable CI for a repository",
                    source: "user",
                  },
                  {
                    name: "publish",
                    description: "Publish an npm package",
                    source: "user",
                  },
                ],
              },
            },
          },
        ],
      }),
  );

  // List endpoint used by the plugin execute() — same shape the
  // transcript already has, but the View reads detail from the
  // per-name endpoint below.
  await page.route(urlEndsWith("/api/skills"), (route) =>
    route.fulfill({
      json: {
        skills: [
          {
            name: "ci_enable",
            description: "Enable CI for a repository",
            source: "user",
          },
          {
            name: "publish",
            description: "Publish an npm package",
            source: "user",
          },
        ],
      },
    }),
  );

  // Detail endpoint. Return a different body per name so we can
  // assert the Run message reflects the selected skill.
  await page.route(
    (url) => url.pathname.startsWith("/api/skills/") && url.pathname !== "/api/skills",
    (route: Route) => {
      const name = route.request().url().split("/api/skills/").pop() ?? "";
      const bodies: Record<string, string> = {
        ci_enable: "## CI Enable\n\n1. Add workflow\n2. Open PR",
        publish: "## Publish\n\n1. Bump version\n2. yarn publish",
      };
      const body = bodies[decodeURIComponent(name)];
      if (!body) {
        return route.fulfill({
          status: 404,
          json: { error: `skill not found: ${name}` },
        });
      }
      return route.fulfill({
        json: {
          skill: {
            name: decodeURIComponent(name),
            description: name === "ci_enable" ? "Enable CI" : "Publish",
            body,
            source: "user",
            path: `/fake/${name}/SKILL.md`,
          },
        },
      });
    },
  );
}

test.describe("manageSkills plugin", () => {
  test.beforeEach(async ({ page }) => {
    await setupSkillsSession(page);
  });

  test("sidebar preview renders the skill list count", async ({ page }) => {
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    // Preview renders "2 skills" somewhere in the sidebar.
    await expect(page.getByText("2 skills").first()).toBeVisible();
  });

  test("View renders the full skill list when selected", async ({ page }) => {
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();

    // Click the tool-result preview in the sidebar to open the View.
    await page.getByText("2 skills").first().click();
    await expect(page.getByTestId("skill-item-ci_enable")).toBeVisible();

    // Both skills appear in the list pane (data-testid per item).
    await expect(page.getByTestId("skill-item-publish")).toBeVisible();
  });

  test("selecting a skill loads its detail body from the API", async ({ page }) => {
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("2 skills").first().click();
    await expect(page.getByTestId("skill-item-ci_enable")).toBeVisible();

    // The first skill is auto-selected; its body should be visible.
    await expect(page.getByTestId("skill-body-rendered")).toContainText("CI Enable");

    // Click the second skill → body swaps.
    await page.getByTestId("skill-item-publish").click();
    await expect(page.getByTestId("skill-body-rendered")).toContainText("Publish");
  });

  test("skill body is rendered as formatted HTML, not raw markdown", async ({ page }) => {
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("2 skills").first().click();
    await expect(page.getByTestId("skill-item-ci_enable")).toBeVisible();

    const rendered = page.getByTestId("skill-body-rendered");
    await expect(rendered).toBeVisible();
    // The `## CI Enable` heading should render as an <h2>, and the
    // ordered list items as <li>. Raw `##` or `1.` shouldn't appear.
    await expect(rendered.locator("h2")).toContainText("CI Enable");
    await expect(rendered.locator("li").first()).toContainText("Add workflow");
  });

  // The in-view Run button was removed — skill execution is no longer
  // offered from the Skills surface (invoke a skill via its `/<name>`
  // slash command in chat instead).
});

// ---- Delete (phase 1) ----------------------------------------------

async function setupSkillsWithProjectScope(page: Page) {
  await mockAllApis(page, {
    sessions: [
      {
        id: "skills-session",
        title: "Skills Session",
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
            sessionId: "skills-session",
          },
          { type: "text", source: "user", message: "Show my skills" },
          {
            type: "tool_result",
            source: "tool",
            result: {
              uuid: "skills-result-1",
              toolName: "manageSkills",
              title: "Skills",
              message: "Found 2 skills.",
              data: {
                skills: [
                  {
                    name: "user-only",
                    description: "Read-only user skill",
                    source: "user",
                  },
                  {
                    name: "my-project-skill",
                    description: "Captured from a chat",
                    source: "project",
                  },
                ],
              },
            },
          },
        ],
      }),
  );

  await page.route(
    (url) => url.pathname.startsWith("/api/skills/") && url.pathname !== "/api/skills",
    (route: Route) => {
      const method = route.request().method();
      const name = decodeURIComponent(route.request().url().split("/api/skills/").pop() ?? "").split("?")[0] ?? "";
      if (method === "DELETE") {
        // Stubbed delete response — phase 1 server returns
        // { deleted: true, name } on success.
        return route.fulfill({ json: { deleted: true, name } });
      }
      const sources: Record<string, "user" | "project"> = {
        "user-only": "user",
        "my-project-skill": "project",
      };
      const source = sources[name];
      if (!source) {
        return route.fulfill({
          status: 404,
          json: { error: `skill not found: ${name}` },
        });
      }
      return route.fulfill({
        json: {
          skill: {
            name,
            description: source === "user" ? "Read-only user skill" : "Captured from a chat",
            body: `## ${name}\n\nbody`,
            source,
            path: `/fake/${name}/SKILL.md`,
          },
        },
      });
    },
  );
}

test.describe("manageSkills plugin — delete (phase 1)", () => {
  test.beforeEach(async ({ page }) => {
    await setupSkillsWithProjectScope(page);
  });

  test("Delete button is hidden for user-scope skills", async ({ page }) => {
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("2 skills").first().click();
    await expect(page.getByTestId("skill-item-user-only")).toBeVisible();

    // First skill (user-only) is auto-selected on mount; Delete
    // button should not appear.
    await page.getByTestId("skill-item-user-only").click();
    await expect(page.getByTestId("skill-body-rendered")).toContainText("user-only");
    await expect(page.getByTestId("skill-delete-btn")).toHaveCount(0);
  });

  test("Delete button is visible for project-scope skills", async ({ page }) => {
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("2 skills").first().click();
    await expect(page.getByTestId("skill-item-user-only")).toBeVisible();

    await page.getByTestId("skill-item-my-project-skill").click();
    await expect(page.getByTestId("skill-body-rendered")).toContainText("my-project-skill");
    await expect(page.getByTestId("skill-delete-btn")).toBeVisible();
  });

  test("clicking Delete fires DELETE /api/skills/:name and removes the row", async ({ page }) => {
    // Auto-accept the native confirm() dialog the View shows.
    page.on("dialog", (dialog) => dialog.accept());

    let deletedName: string | null = null;
    await page.route(
      (url) => url.pathname.startsWith("/api/skills/") && url.pathname !== "/api/skills",
      (route: Route) => {
        if (route.request().method() === "DELETE") {
          const name = decodeURIComponent(route.request().url().split("/api/skills/").pop() ?? "").split("?")[0] ?? "";
          deletedName = name;
          return route.fulfill({ json: { deleted: true, name } });
        }
        return route.fallback();
      },
    );

    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("2 skills").first().click();
    await expect(page.getByTestId("skill-item-user-only")).toBeVisible();

    await page.getByTestId("skill-item-my-project-skill").click();
    await expect(page.getByTestId("skill-delete-btn")).toBeVisible();

    await page.getByTestId("skill-delete-btn").click();

    // The DELETE call landed with the right name.
    await expect.poll(() => deletedName).toBe("my-project-skill");

    // Row is removed from the left list — only the user skill remains.
    await expect(page.getByTestId("skill-item-my-project-skill")).toHaveCount(0);
    await expect(page.getByTestId("skill-item-user-only")).toBeVisible();
  });

  test("Edit button opens edit mode, saves changes, and returns to view mode", async ({ page }) => {
    // Mock PUT /api/skills/my-project-skill to return success.
    await page.route(
      (url) => url.pathname === "/api/skills/my-project-skill",
      (route: Route) => {
        if (route.request().method() === "PUT") {
          return route.fulfill({
            json: { updated: true, path: "/fake/path" },
          });
        }
        return route.fallback();
      },
    );

    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("2 skills").first().click();
    await expect(page.getByTestId("skill-item-user-only")).toBeVisible();

    // Select the project-scope skill — Edit button should be visible.
    await page.getByTestId("skill-item-my-project-skill").click();
    await expect(page.getByTestId("skill-body-rendered")).toContainText("my-project-skill");
    await expect(page.getByTestId("skill-edit-btn")).toBeVisible();

    // Click Edit → description input + body textarea should appear.
    await page.getByTestId("skill-edit-btn").click();
    await expect(page.getByTestId("skill-edit-description")).toBeVisible();
    await expect(page.getByTestId("skill-edit-body")).toBeVisible();

    // Edit the description.
    await page.getByTestId("skill-edit-description").fill("Updated desc");

    // Click Save.
    await page.getByTestId("skill-save-btn").click();

    // After save: edit mode should close, rendered body should show.
    await expect(page.getByTestId("skill-body-rendered")).toBeVisible();
    await expect(page.getByTestId("skill-edit-description")).toHaveCount(0);
  });
});

// ---- Delete: post-delete selection advance --------------------------
// A 3-project-skill fixture so deleting the MIDDLE row can distinguish the
// neighbour-advance fix from the old "bounce to the first row" clobber:
// with only two rows, first == neighbour and the bug is invisible.

const THREE_PROJECT_SKILLS = ["alpha-skill", "beta-skill", "gamma-skill"] as const;

async function setupThreeProjectSkills(page: Page) {
  await mockAllApis(page, {
    sessions: [
      {
        id: "skills-session",
        title: "Skills Session",
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
          { type: "session_meta", roleId: "general", sessionId: "skills-session" },
          { type: "text", source: "user", message: "Show my skills" },
          {
            type: "tool_result",
            source: "tool",
            result: {
              uuid: "skills-result-3",
              toolName: "manageSkills",
              title: "Skills",
              message: "Found 3 skills.",
              data: {
                skills: THREE_PROJECT_SKILLS.map((name) => ({
                  name,
                  description: `${name} description`,
                  source: "project",
                })),
              },
            },
          },
        ],
      }),
  );

  await page.route(
    (url) => url.pathname.startsWith("/api/skills/") && url.pathname !== "/api/skills",
    (route: Route) => {
      const method = route.request().method();
      const name = decodeURIComponent(route.request().url().split("/api/skills/").pop() ?? "").split("?")[0] ?? "";
      if (method === "DELETE") {
        return route.fulfill({ json: { deleted: true, name } });
      }
      if (!(THREE_PROJECT_SKILLS as readonly string[]).includes(name)) {
        return route.fulfill({ status: 404, json: { error: `skill not found: ${name}` } });
      }
      return route.fulfill({
        json: {
          skill: { name, description: `${name} description`, body: `## ${name}\n\nbody`, source: "project", path: `/fake/${name}/SKILL.md` },
        },
      });
    },
  );
}

test.describe("manageSkills plugin — post-delete selection", () => {
  test.beforeEach(async ({ page }) => {
    await setupThreeProjectSkills(page);
    page.on("dialog", (dialog) => dialog.accept());
  });

  test("deleting the selected middle skill advances to the neighbour, not the first row", async ({ page }) => {
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("3 skills").first().click();
    await expect(page.getByTestId("skill-item-beta-skill")).toBeVisible();

    // Select the middle row and delete it.
    await page.getByTestId("skill-item-beta-skill").click();
    await expect(page.getByTestId("skill-body-rendered")).toContainText("beta-skill");
    await page.getByTestId("skill-delete-btn").click();

    // The deleted row is gone.
    await expect(page.getByTestId("skill-item-beta-skill")).toHaveCount(0);

    // Selection advanced to the next neighbour (gamma-skill), NOT the
    // alphabetical first row (alpha-skill).
    await expect(page.getByTestId("skill-body-rendered")).toContainText("gamma-skill");
    await expect(page.getByTestId("skill-item-gamma-skill")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("skill-item-alpha-skill")).toHaveAttribute("aria-pressed", "false");
  });

  test("deleting the selected last skill advances to the new last row", async ({ page }) => {
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("3 skills").first().click();
    await expect(page.getByTestId("skill-item-gamma-skill")).toBeVisible();

    await page.getByTestId("skill-item-gamma-skill").click();
    await expect(page.getByTestId("skill-body-rendered")).toContainText("gamma-skill");
    await page.getByTestId("skill-delete-btn").click();

    await expect(page.getByTestId("skill-item-gamma-skill")).toHaveCount(0);
    // Falls back to the previous neighbour (now the last row), not alpha.
    await expect(page.getByTestId("skill-body-rendered")).toContainText("beta-skill");
    await expect(page.getByTestId("skill-item-beta-skill")).toHaveAttribute("aria-pressed", "true");
  });
});

// ── #1383 PR-C2: hierarchical external-skill catalog ──────────────

interface StarCall {
  source?: string;
  repoId?: string;
  skillFolder?: string;
  slug?: string;
}
interface InstallCall {
  url?: string;
  subpath?: string;
}

async function setupExternalCatalog(page: Page, calls: { star: StarCall[]; install: InstallCall[]; deleted: string[] }) {
  await setupSkillsSession(page);

  // Registered AFTER setupSkillsSession so these win over its
  // `/api/skills/` catch-all (Playwright matches last-registered first).
  await page.route(urlEndsWith("/api/skills/catalog"), (route) =>
    route.fulfill({
      json: {
        entries: [
          { slug: "mc-foo", name: "mc-foo", description: "a preset", source: "preset", alreadyActive: false },
          {
            slug: "anthropics-pdf",
            name: "anthropics-pdf",
            description: "Fill PDFs",
            source: "external",
            alreadyActive: false,
            repoId: "anthropics-skills",
            skillFolder: "pdf",
            repoUrl: "https://github.com/anthropics/skills",
          },
          {
            slug: "anthropics-xlsx",
            name: "anthropics-xlsx",
            description: "Build spreadsheets",
            source: "external",
            alreadyActive: true,
            repoId: "anthropics-skills",
            skillFolder: "xlsx",
            repoUrl: "https://github.com/anthropics/skills",
          },
        ],
      },
    }),
  );
  await page.route(urlEndsWith("/api/skills/external/repos"), (route) => {
    if (route.request().method() === "POST") {
      calls.install.push(route.request().postDataJSON() as InstallCall);
      return route.fulfill({ json: { installed: true, repoId: "foo-bar" } });
    }
    return route.fulfill({
      json: {
        repos: [
          {
            repoId: "anthropics-skills",
            url: "https://github.com/anthropics/skills",
            subpath: "skills",
            sha: "a".repeat(40),
            installedAt: "2026-05-16T00:00:00Z",
          },
        ],
      },
    });
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/skills/external/repos/"),
    (route) => {
      if (route.request().method() === "DELETE") {
        calls.deleted.push(decodeURIComponent(route.request().url().split("/api/skills/external/repos/").pop() ?? ""));
        return route.fulfill({ json: { uninstalled: true, repoId: "anthropics-skills" } });
      }
      return route.fallback();
    },
  );
  await page.route(urlEndsWith("/api/skills/external/suggestions"), (route) =>
    route.fulfill({
      json: {
        suggestions: [{ url: "https://github.com/anthropics/skills", subpath: "skills", displayName: "Anthropic skills", description: "Official collection" }],
      },
    }),
  );
  await page.route(urlEndsWith("/api/skills/catalog/preview"), (route) =>
    route.fulfill({ json: { detail: { slug: "anthropics-pdf", source: "external", description: "Fill PDFs", body: "## PDF\n\nstep one" } } }),
  );
  await page.route(urlEndsWith("/api/skills/catalog/star"), (route) => {
    calls.star.push(route.request().postDataJSON() as StarCall);
    return route.fulfill({ json: { starred: true, slug: "anthropics-pdf" } });
  });
}

test.describe("manageSkills plugin — external catalog (#1383 PR-C2)", () => {
  test("renders installed repos as collapsible subgroups + add-repo button", async ({ page }) => {
    const calls = { star: [] as StarCall[], install: [] as InstallCall[], deleted: [] as string[] };
    await setupExternalCatalog(page, calls);
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("2 skills").first().click();

    const repo = page.getByTestId("skill-catalog-repo-anthropics-skills");
    await expect(repo).toBeVisible();
    // Both external entries visible while expanded.
    await expect(page.getByTestId("skill-catalog-item-anthropics-skills/pdf")).toBeVisible();
    await expect(page.getByTestId("skill-catalog-item-anthropics-skills/xlsx")).toBeVisible();
    // Starred external entry shows the ★ indicator.
    await expect(page.getByTestId("skill-catalog-starred-indicator-anthropics-skills/xlsx")).toBeVisible();

    // Collapse the repo → rows hidden.
    await page.getByTestId("skill-catalog-repo-toggle-anthropics-skills").click();
    await expect(page.getByTestId("skill-catalog-item-anthropics-skills/pdf")).toBeHidden();

    await expect(page.getByTestId("skill-catalog-add-repo")).toBeVisible();
  });

  // Regression: the installed-repo LIST load and the catalog load run
  // concurrently. A repo-list failure used to write the shared
  // `catalogError`, which the sibling catalog SUCCESS then nulled — the
  // error vanished and the repo groups silently disappeared. The repo-list
  // failure now has its own channel that the catalog success can't clobber.
  test("a repo-list load failure surfaces its own error, not clobbered by catalog success", async ({ page }) => {
    const calls = { star: [] as StarCall[], install: [] as InstallCall[], deleted: [] as string[] };
    await setupExternalCatalog(page, calls);
    // Override the repo-list GET to fail; catalog GET still succeeds.
    await page.route(urlEndsWith("/api/skills/external/repos"), (route) => {
      if (route.request().method() === "POST") return route.fallback();
      return route.fulfill({ status: 500, json: { error: "repo registry corrupt" } });
    });
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("2 skills").first().click();

    // The catalog load resolving (presets render) is the very event that
    // used to null the shared error — assert it happened, then that the
    // repo-list error survived it in its own channel.
    await expect(page.getByTestId("skill-catalog-item-mc-foo")).toBeVisible();
    await expect(page.getByTestId("skill-catalog-repo-list-error")).toBeVisible();
  });

  test("selecting an external entry loads detail and Star sends external params", async ({ page }) => {
    const calls = { star: [] as StarCall[], install: [] as InstallCall[], deleted: [] as string[] };
    await setupExternalCatalog(page, calls);
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("2 skills").first().click();

    await page.getByTestId("skill-catalog-item-anthropics-skills/pdf").click();
    await expect(page.getByTestId("skill-catalog-detail-pane")).toContainText("Fill PDFs");
    await page.getByTestId("skill-catalog-detail-star-btn").click();

    await expect.poll(() => calls.star.length).toBe(1);
    expect(calls.star[0]).toMatchObject({ source: "external", repoId: "anthropics-skills", skillFolder: "pdf" });
  });

  test("add-repo modal installs from a suggestion; uninstall confirms + fires DELETE", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());
    const calls = { star: [] as StarCall[], install: [] as InstallCall[], deleted: [] as string[] };
    await setupExternalCatalog(page, calls);
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("2 skills").first().click();

    await page.getByTestId("skill-catalog-add-repo").click();
    await expect(page.getByTestId("skill-add-repo-modal")).toBeVisible();

    // The repo link opens GitHub in a new tab and must NOT install.
    const link = page.getByTestId("skill-add-repo-suggestion-link-https://github.com/anthropics/skills");
    await expect(link).toHaveAttribute("href", "https://github.com/anthropics/skills");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);

    // Clicking a suggestion prefills the form — it must NOT install.
    await page.getByTestId("skill-add-repo-suggestion-https://github.com/anthropics/skills").click();
    await expect(page.getByTestId("skill-add-repo-url")).toHaveValue("https://github.com/anthropics/skills");
    await expect(page.getByTestId("skill-add-repo-subpath")).toHaveValue("skills");
    expect(calls.install).toHaveLength(0);

    // Explicit Install is what actually installs.
    await page.getByTestId("skill-add-repo-submit").click();
    await expect.poll(() => calls.install.length).toBe(1);
    expect(calls.install[0]).toMatchObject({ url: "https://github.com/anthropics/skills", subpath: "skills" });

    await page.getByTestId("skill-catalog-repo-uninstall-anthropics-skills").click();
    await expect.poll(() => calls.deleted).toContain("anthropics-skills");
  });

  test("Update button re-installs with the repo's recorded url/subpath", async ({ page }) => {
    const calls = { star: [] as StarCall[], install: [] as InstallCall[], deleted: [] as string[] };
    await setupExternalCatalog(page, calls);
    await page.goto("/chat/skills-session");
    await expect(page.getByTestId("app-title")).toBeVisible();
    await page.getByText("2 skills").first().click();

    await page.getByTestId("skill-catalog-repo-update-anthropics-skills").click();
    await expect.poll(() => calls.install.length).toBe(1);
    expect(calls.install[0]).toMatchObject({ url: "https://github.com/anthropics/skills", subpath: "skills" });
  });
});
