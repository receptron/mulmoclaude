// E2E coverage for multi-file ChatInput attachment (#1666, follow-up to
// PR #1660). #1660 added multi-file attach but the Vue-component test infra
// wasn't in place, so the coverage was deferred. These drive the real app
// (attachment state lives in the App.vue parent, fed via `pastedFiles`).
//
// Scenarios (from the issue):
//   1. Happy path across ALL three entry points — picker, paste, drop —
//      each attaching several supported files → a chip per file.
//   2. 10-file cap — 11 files → tooManyFiles error, capped at 10 chips.
//   3. Failure recovery — a later drop containing an oversized file is
//      rejected WITHOUT wiping the already-attached chips (snapshot kept).
//   4. Race — two back-to-back drops both land (the fileQueue serialisation
//      in ChatInput keeps the second from clobbering the first).

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

interface FileSpec {
  name: string;
  type: string;
  content: string;
  /** Build a zero-filled body of this size in the page instead of `content`. */
  sizeBytes?: number;
}

const chips = (page: Page) => page.getByTestId("chat-attachment-preview");

const OVER_CAP_BYTES = 31 * 1024 * 1024;

// The drop target is the wrapper two levels up from the textarea — the same
// anchor the sibling chatinput-attach spec drops onto. Kept in one helper so
// the DOM-hierarchy coupling lives in a single place (Sourcery review).
async function dropFiles(page: Page, files: FileSpec[]): Promise<void> {
  const dropTarget = page.locator("[data-testid=user-input]").locator("..").locator("..");
  await dropTarget.evaluate((element, specs) => {
    const transfer = new DataTransfer();
    for (const spec of specs) transfer.items.add(new File([spec.sizeBytes ? new Uint8Array(spec.sizeBytes) : spec.content], spec.name, { type: spec.type }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, files);
}

// Paste files onto the textarea via a synthesised ClipboardEvent. The Chromium
// ClipboardEvent constructor doesn't accept `clipboardData`, so we attach a
// DataTransfer directly — `onPasteFile` only reads `event.clipboardData.items`.
async function pasteFiles(page: Page, files: FileSpec[]): Promise<void> {
  await page.getByTestId("user-input").evaluate((element, specs) => {
    const transfer = new DataTransfer();
    for (const spec of specs) transfer.items.add(new File([spec.content], spec.name, { type: spec.type }));
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    element.dispatchEvent(event);
  }, files);
}

test.describe("ChatInput multi-file attachment (#1666)", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
    await page.goto("/");
  });

  test("happy path (file picker): selecting several files shows a chip for each", async ({ page }) => {
    // The hidden <input type="file" multiple> feeds onFilePicked → addFiles.
    await page.getByTestId("file-input").setInputFiles([
      { name: "a.png", mimeType: "image/png", buffer: Buffer.from("a") },
      { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("b") },
      { name: "c.pdf", mimeType: "application/pdf", buffer: Buffer.from("c") },
    ]);
    await expect(chips(page)).toHaveCount(3);
    await expect(page.getByTestId("file-error")).toHaveCount(0);
  });

  test("happy path (paste): pasting several files shows a chip for each", async ({ page }) => {
    await pasteFiles(page, [
      { name: "a.png", type: "image/png", content: "a" },
      { name: "b.txt", type: "text/plain", content: "b" },
    ]);
    await expect(chips(page)).toHaveCount(2);
    await expect(page.getByTestId("file-error")).toHaveCount(0);
  });

  test("happy path (drop): dropping several supported files at once shows a chip for each", async ({ page }) => {
    await dropFiles(page, [
      { name: "a.png", type: "image/png", content: "a" },
      { name: "b.txt", type: "text/plain", content: "b" },
      { name: "c.pdf", type: "application/pdf", content: "c" },
    ]);
    await expect(chips(page)).toHaveCount(3);
    await expect(page.getByTestId("file-error")).toHaveCount(0);
  });

  test("10-file cap: dropping 11 files caps at 10 chips and surfaces the tooManyFiles error", async ({ page }) => {
    await dropFiles(
      page,
      Array.from({ length: 11 }, (_unused, i) => ({ name: `f${i}.txt`, type: "text/plain", content: String(i) })),
    );
    // Capped at MAX_ATTACHMENTS (10), with the over-cap notice.
    await expect(chips(page)).toHaveCount(10);
    const banner = page.getByTestId("file-error");
    await expect(banner).toBeVisible();
    expect((await banner.textContent()) ?? "").toContain("10");
  });

  test("failure recovery: a later invalid drop does NOT wipe already-attached files", async ({ page }) => {
    await dropFiles(page, [
      { name: "a.png", type: "image/png", content: "a" },
      { name: "b.txt", type: "text/plain", content: "b" },
    ]);
    await expect(chips(page)).toHaveCount(2);

    // A later drop carrying an oversized file: the batch is rejected and the
    // error surfaces, but the first two chips must remain (snapshot intact).
    await dropFiles(page, [{ name: "huge.pdf", type: "application/pdf", content: "", sizeBytes: OVER_CAP_BYTES }]);
    await expect(page.getByTestId("file-error")).toBeVisible();
    await expect(chips(page)).toHaveCount(2);
  });

  test("race: two back-to-back drops both attach (fileQueue serialisation)", async ({ page }) => {
    // Fire two drops in the same tick without awaiting between them. If the
    // per-file processing weren't serialised through fileQueue, the second
    // emit (computed off a stale pastedFiles) could clobber the first.
    await page
      .locator("[data-testid=user-input]")
      .locator("..")
      .locator("..")
      .evaluate((element) => {
        const drop = (name: string) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([name], name, { type: "text/plain" }));
          element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        };
        drop("one.txt");
        drop("two.txt");
      });
    // Both files survive → two chips.
    await expect(chips(page)).toHaveCount(2);
  });
});
