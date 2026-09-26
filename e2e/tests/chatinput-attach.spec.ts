// E2E coverage for ChatInput attachment discoverability (#499, PR #598).
//
// Two behaviours we care about:
//  1. The paperclip button is present + wired to a hidden <input type="file">
//     with no `accept` filter, so any file can be picked.
//  2. Dropping a file whose content we cannot read attaches it as a file
//     only (the chip says so) instead of refusing it.
//
// The placeholder used to spell out "drop / paste / attach", but was
// shortened to "Message Claude…" — discoverability now rides on the
// paperclip button (title) and the drop-overlay (`dropHint`), both
// covered below.

import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

test.describe("ChatInput attach discoverability", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
    await page.goto("/");
  });

  test("paperclip attach button is present with a title", async ({ page }) => {
    const button = page.getByTestId("attach-file-btn");
    await expect(button).toBeVisible();
    // Title is the accessible tooltip; empty/missing would regress discoverability.
    const title = await button.getAttribute("title");
    expect(title && title.length > 0).toBeTruthy();
  });

  test("hidden file input has no accept filter, so any file can be picked", async ({ page }) => {
    const input = page.getByTestId("file-input");
    // Exists in DOM but hidden — Playwright's default `toBeVisible` would
    // fail, so assert presence via locator count + attribute reads.
    await expect(input).toHaveCount(1);
    expect(await input.getAttribute("accept")).toBeNull();
  });

  test("clicking the attach button opens the picker (fires a click on the hidden input)", async ({ page }) => {
    // Can't reliably drive the OS file chooser across platforms, but
    // we can verify the button wires through to input.click() by
    // listening for a filechooser event from Playwright.
    const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 2000 }), page.getByTestId("attach-file-btn").click()]);
    expect(chooser).toBeTruthy();
  });

  test("dropping a file of an unreadable type attaches it as a file only", async ({ page }) => {
    const dropTarget = page.locator("[data-testid=user-input]").locator("..").locator("..");
    // `.mpp` arrives with an empty MIME type in the browser — the case
    // that used to be refused outright.
    await dropTarget.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["payload"], "schedule.mpp", { type: "" }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(page.getByTestId("chat-attachment-preview")).toHaveCount(1);
    await expect(page.getByTestId("chat-attachment-file-only")).toBeVisible();
    await expect(page.getByTestId("file-error")).toHaveCount(0);
  });

  test("a readable type carries no file-only note", async ({ page }) => {
    const dropTarget = page.locator("[data-testid=user-input]").locator("..").locator("..");
    await dropTarget.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["a,b"], "data.csv", { type: "text/csv" }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(page.getByTestId("chat-attachment-preview")).toHaveCount(1);
    await expect(page.getByTestId("chat-attachment-file-only")).toHaveCount(0);
  });

  test("dropping an oversized accepted file still shows the too-large error (regression)", async ({ page }) => {
    // The size cap still applies to every type, readable or not.
    const dropTarget = page.locator("[data-testid=user-input]").locator("..").locator("..");
    await dropTarget.evaluate((element) => {
      const bigPayload = new Uint8Array(31 * 1024 * 1024); // 31 MB — over the 30 MB cap
      const transfer = new DataTransfer();
      transfer.items.add(new File([bigPayload], "huge.pdf", { type: "application/pdf" }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    const banner = page.getByTestId("file-error");
    await expect(banner).toBeVisible();
    const text = (await banner.textContent()) ?? "";
    // Message body is i18n'd; both EN and JA mention "30" (the cap).
    expect(text).toContain("30");
  });
});

test.describe("ChatInput drop-target affordance (#1289 Step 1 + Step 2)", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
    await page.goto("/");
  });

  test("file dragenter reveals the overlay, drop clears it", async ({ page }) => {
    const dropTarget = page.locator("[data-testid=user-input]").locator("..").locator("..");
    const overlay = page.getByTestId("chat-drop-overlay");

    // Pre-condition: overlay is not present before the drag starts.
    await expect(overlay).toHaveCount(0);

    // Fire a synthetic dragenter carrying a File. The handler should
    // flip `isDragging` true and render the overlay.
    await dropTarget.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["payload"], "thing.txt", { type: "text/plain" }));
      element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(overlay).toBeVisible();

    // A drop must clear the overlay — the counter is forced to zero
    // even if the synthetic events skipped a paired dragleave.
    await dropTarget.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["payload"], "thing.txt", { type: "text/plain" }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(overlay).toHaveCount(0);
  });

  test("a text-selection drag (no 'Files' type) does NOT trigger the overlay", async ({ page }) => {
    const dropTarget = page.locator("[data-testid=user-input]").locator("..").locator("..");
    const overlay = page.getByTestId("chat-drop-overlay");

    // Dragging selected text inside the page populates dataTransfer
    // with `text/plain` only. The Files-only guard must keep the
    // overlay hidden for these.
    await dropTarget.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "some selected words");
      element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(overlay).toHaveCount(0);
  });

  test("window-leave dragleave (no Files type) clears the stuck overlay", async ({ page }) => {
    // Regression for the Codex review on #1327: some browsers strip
    // `Files` from `dataTransfer.types` when the dragleave event
    // crosses a window boundary. The old handler bailed early on
    // that case → counter stayed at 1 → overlay stuck `true` until
    // the next drop.
    const dropTarget = page.locator("[data-testid=user-input]").locator("..").locator("..");
    const overlay = page.getByTestId("chat-drop-overlay");

    // Enter with a real file drag → overlay shows.
    await dropTarget.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["payload"], "thing.txt", { type: "text/plain" }));
      element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(overlay).toBeVisible();

    // Leave the window — Firefox / WebKit sometimes deliver this
    // dragleave with `relatedTarget === null` and an empty
    // `dataTransfer.types`. Reproduce that shape.
    await dropTarget.evaluate((element) => {
      const transfer = new DataTransfer(); // no items / no types
      element.dispatchEvent(
        new DragEvent("dragleave", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          relatedTarget: null,
        }),
      );
    });

    // Overlay must clear — the leave handler decrements regardless
    // of the missing `Files` type once the counter is positive.
    await expect(overlay).toHaveCount(0);
  });

  test("window-level drop outside the wrapper resets the overlay", async ({ page }) => {
    // Belt-and-suspenders: if the user releases the file on a part
    // of the page that ISN'T the chat input, the wrapper never sees
    // a `drop`. The window-level `drop` listener catches it.
    const dropTarget = page.locator("[data-testid=user-input]").locator("..").locator("..");
    const overlay = page.getByTestId("chat-drop-overlay");

    await dropTarget.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["payload"], "thing.txt", { type: "text/plain" }));
      element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(overlay).toBeVisible();

    // Drop somewhere on document body (not inside the wrapper).
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["payload"], "thing.txt", { type: "text/plain" }));
      window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });

    await expect(overlay).toHaveCount(0);
  });

  // The "counter pattern absorbs child enter/leave pairs without
  // flicker" test used to live here. The counter implementation is
  // not an observable user contract — what matters is the overlay
  // staying visible through real drag-over transitions, which the
  // panel-wide drop tests below already cover end-to-end. Asserting
  // on the counter math directly was implementation-detail coupling.

  test("Step 2: dragging onto the chat-sidebar (panel-wide) shows the overlay and attaches on drop", async ({ page }) => {
    // The panel-wide drop zone (#1289 Step 2) wires the handlers on
    // the chat-sidebar div instead of the ChatInput wrapper.
    // Dragging onto an element above the input (i.e. the sessions
    // list region) should now reveal the overlay, and a drop there
    // should still route the file through ChatInput.readFile().
    const panel = page.getByTestId("chat-sidebar");
    const overlay = page.getByTestId("chat-drop-overlay");

    await expect(overlay).toHaveCount(0);

    await panel.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["payload"], "thing.txt", { type: "text/plain" }));
      element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(overlay).toBeVisible();

    // Dropping at the panel level attaches the SAME way the textarea-drop
    // path does — verifies App.vue actually routes the dropped file into
    // ChatInput.
    await panel.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["payload"], "thing.zip", { type: "application/zip" }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(overlay).toHaveCount(0);
    await expect(page.getByTestId("chat-attachment-file-only")).toBeVisible();
  });
});
