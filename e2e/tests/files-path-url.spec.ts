// E2E coverage for the path-based Files URL (#632 / PR #633).
//
// The switch from `/files?path=foo.md` to `/files/foo.md` moves the
// captured file path from a query param to a Vue Router catch-all
// param. The router encodes each segment independently, so any bug
// in the param-array push path, the back-compat redirect, or the
// watcher would silently break deep links — especially for names
// with multi-byte or reserved ASCII characters.
//
// Coverage strategy: rather than re-test every weird character, pick
// one representative per distinct URL-encoding code path. Each entry
// below targets a different escape rule the router has to get right:
//
//   * ASCII baseline      → no escape, control case
//   * spaces in basename  → %20 (most common encoded char)
//   * percent literal     → %25 (escape-the-escape, easy to forget)
//   * Japanese kanji+kana → multibyte UTF-8 (%E6%97%A5…)
//   * emoji + ASCII       → surrogate pair + space mix
//
// The picks above cover every encoding class. A bug in the
// query→param shape (e.g. forgetting to decode) would fail one of
// these five regardless of which specific reserved char triggers it.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { API_ROUTES } from "../../src/config/apiRoutes";

import { ONE_SECOND_MS } from "../../server/utils/time.ts";

const WEIRD_NAMES: readonly { label: string; path: string }[] = [
  { label: "ASCII baseline", path: "artifacts/documents/17c48329.md" },
  { label: "spaces in basename", path: "notes/my cool notes.md" },
  { label: "percent literal", path: "artifacts/docs/100%done.md" },
  { label: "Japanese (kanji + kana)", path: "wiki/日本語ノート.md" },
  { label: "emoji + space mix", path: "notes/🎉party 📝plan.md" },
];

// Body of the mocked response. Kept distinct per-path so the DOM
// assertion ("does the fetched content show up?") proves the URL
// survived the round trip unmangled. Deliberately plain text with no
// markdown syntax so the rendered DOM contains the sentinel verbatim
// (a leading `#` would be stripped into an h1's text content and
// break `getByText` matches).
function bodyFor(path: string): string {
  return `SENTINEL-BODY ${path}`;
}

// ── Shared mock installation ────────────────────────────────────

async function installFileMocks(page: Page, fixtures: readonly { path: string }[]): Promise<void> {
  await mockAllApis(page);

  // Tree: empty but valid — the deep-link tests don't click through
  // the tree, they navigate straight to the URL. We still need a
  // 200 response or FilesView.vue surfaces a tree error banner.
  await page.route(
    (url) => url.pathname === API_ROUTES.files.tree,
    (route) =>
      route.fulfill({
        json: { name: "", path: "", type: "dir", children: [] },
      }),
  );
  await page.route(
    (url) => url.pathname === API_ROUTES.files.dir,
    (route) =>
      route.fulfill({
        json: { name: "", path: "", type: "dir", children: [] },
      }),
  );

  // Playwright matches routes in REVERSE registration order (last
  // registered is checked first). Register the 404 catch-all FIRST
  // so it runs LAST — if a fixture doesn't match its specific route,
  // we get a clean 404 instead of a silent fallthrough.
  await page.route(
    (url) => url.pathname === API_ROUTES.files.content,
    (route) => route.fulfill({ status: 404, json: { error: "not found" } }),
  );

  // Content endpoint: exact-match each fixture path. The client hits
  // `/api/files/content?path=<decoded>` — if the router mangled the
  // param (e.g. didn't decode UTF-8, or collapsed a `/`), the lookup
  // key would miss and we'd fall through to the 404 above.
  for (const { path } of fixtures) {
    await page.route(
      (url) => url.pathname === API_ROUTES.files.content && url.searchParams.get("path") === path,
      (route) =>
        route.fulfill({
          json: {
            kind: "text",
            path,
            content: bodyFor(path),
            size: bodyFor(path).length,
            modifiedMs: Date.now(),
          },
        }),
    );
  }
}

// Build the URL the browser bar would show, matching what the router
// produces via `router.push({ params: { pathMatch: path.split("/") } })`.
// Each segment gets `encodeURIComponent` (which encodes `?#%&+=` among
// others) and the slashes between segments stay raw.
function buildPathUrl(path: string): string {
  return `/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// ── Direct deep-link round-trip ─────────────────────────────────
//
// For every representative encoding class: navigate straight to
// /files/<encoded>, check the mocked content renders (proving the
// param survived the decode and reached the content endpoint intact).

test.describe("deep link / files/<path>: character round-trip", () => {
  test.beforeEach(async ({ page }) => {
    await installFileMocks(page, WEIRD_NAMES);
  });

  for (const { label, path } of WEIRD_NAMES) {
    test(`opens file with ${label}`, async ({ page }) => {
      await page.goto(buildPathUrl(path));
      await expect(page.getByText(bodyFor(path)).first()).toBeVisible({
        timeout: 5 * ONE_SECOND_MS,
      });
    });
  }
});

// ── Back-compat: old ?path= form ────────────────────────────────
//
// Bookmarks, pasted links, and doc cross-refs from before the switch
// should keep working. The guard rewrites `/files?path=foo` to
// `/files/foo` with replace:true — verify both the final URL and
// the content render.

test.describe("back-compat: /files?path= redirects to /files/<path>", () => {
  test.beforeEach(async ({ page }) => {
    await installFileMocks(page, WEIRD_NAMES);
  });

  for (const { label, path } of WEIRD_NAMES) {
    test(`redirects for ${label}`, async ({ page }) => {
      // The old URL form uses query-string encoding, which handles
      // the raw characters fine — the browser escapes them for us.
      await page.goto(`/files?path=${encodeURIComponent(path)}`);
      // Content renders → proves the redirect + decode worked.
      await expect(page.getByText(bodyFor(path)).first()).toBeVisible({
        timeout: 5 * ONE_SECOND_MS,
      });
      // Final URL should NOT still carry `?path=`; the guard stripped
      // it and moved the value into the path.
      await expect(async () => {
        const parsed = new URL(page.url());
        expect(parsed.searchParams.get("path")).toBeNull();
        expect(parsed.pathname.startsWith("/files/")).toBe(true);
      }).toPass({ timeout: 5 * ONE_SECOND_MS });
    });
  }
});

// ── Security: traversal / absolute-path rejection ───────────────
//
// The guard must reject `..` segments and leading `/`, redirecting
// to the empty `/files` state without selecting anything. The guard
// runs against BOTH the legacy query form (back-compat redirect → new
// form → traversal check) and the direct path form.

test.describe("rejections", () => {
  test.beforeEach(async ({ page }) => {
    await installFileMocks(page, WEIRD_NAMES);
  });

  // Raw `../` segments in a URL are normalised by the browser before
  // the request leaves (the URL spec mandates this), so `page.goto`
  // with `/files/../../../etc/passwd` never reaches our guard — the
  // browser collapses it to `/etc/passwd` first. The realistic attack
  // vector is percent-encoded `..` (`%2E%2E`), which survives browser
  // normalisation and is decoded by the router, at which point the
  // guard's `.includes("..")` check catches it.
  const BAD_PATHS: readonly { label: string; url: string }[] = [
    { label: "leading-slash path form (absolute)", url: "/files//etc/passwd" },
    { label: "parent traversal (percent-encoded)", url: "/files/..%2F..%2Fetc%2Fpasswd" },
    { label: "legacy query with traversal", url: "/files?path=../../../etc/passwd" },
    { label: "legacy query with absolute path", url: "/files?path=/etc/passwd" },
  ];

  for (const { label, url } of BAD_PATHS) {
    test(`rejects ${label}`, async ({ page }) => {
      await page.goto(url);
      await expect(page.getByTestId("app-title")).toBeVisible();
      await expect(async () => {
        const parsed = new URL(page.url());
        expect(parsed.searchParams.get("path")).toBeNull();
        // Guard redirects to /files (empty pathMatch). Trailing slash
        // variants are both acceptable — `replace:true` with empty
        // array may yield either `/files` or `/files/` depending on
        // how the browser normalises.
        expect(parsed.pathname).toMatch(/^\/files\/?$/);
      }).toPass({ timeout: 5 * ONE_SECOND_MS });
    });
  }
});

// ── Navigation: back/forward preserves state ────────────────────
//
// Selecting one file, then another, must create history entries we
// can step through. `router.push` (not `replace`) is used for
// `selectFile`, so browser Back should restore the previous file.

test("browser back restores the previous file selection", async ({ page }) => {
  await installFileMocks(page, WEIRD_NAMES);

  // Pick the ASCII + emoji representatives — they're the two extremes
  // of the encoding spectrum, so the history-entry round-trip is
  // exercised across both ends.
  const first = "artifacts/documents/17c48329.md";
  const second = "notes/🎉party 📝plan.md";

  await page.goto(buildPathUrl(first));
  await expect(page.getByText(bodyFor(first)).first()).toBeVisible({
    timeout: 5 * ONE_SECOND_MS,
  });

  await page.goto(buildPathUrl(second));
  await expect(page.getByText(bodyFor(second)).first()).toBeVisible({
    timeout: 5 * ONE_SECOND_MS,
  });

  await page.goBack();
  await expect(page.getByText(bodyFor(first)).first()).toBeVisible({
    timeout: 5 * ONE_SECOND_MS,
  });

  await page.goForward();
  await expect(page.getByText(bodyFor(second)).first()).toBeVisible({
    timeout: 5 * ONE_SECOND_MS,
  });
});
