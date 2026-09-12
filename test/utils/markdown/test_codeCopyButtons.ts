// Verifies the DOM-mutation step of the code-copy pipeline against
// real jsdom, mirroring `test_mermaidRender.ts`'s setup so the
// production `attachCodeCopyButtons` runs unmodified against a real
// `document` / `Element` implementation instead of a hand-rolled
// stand-in.

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { attachCodeCopyButtons } from "@mulmoclaude/markdown-utils/markdown/codeCopyButtons";

let dom: JSDOM;

// Node exposes `navigator` as a getter-only property from v21+, so a plain
// assignment throws — `Object.defineProperty` overrides that, matching
// `packages/core/test/plugin-vue/test_useClipboardCopy.ts`'s stub pattern.
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

before(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  const win = dom.window as unknown as { document: Document };
  (globalThis as unknown as { document: Document }).document = win.document;
});

function setBody(html: string): HTMLElement {
  dom.window.document.body.innerHTML = html;
  return dom.window.document.body;
}

function installStubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText } },
    writable: true,
    configurable: true,
  });
}

function restoreNavigator(): void {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
}

describe("attachCodeCopyButtons", () => {
  beforeEach(() => {
    installStubClipboard(async () => {});
  });
  afterEach(() => {
    restoreNavigator();
  });

  it("appends a button to a fenced code block", () => {
    const root = setBody('<pre><code class="hljs language-ts">const x = 1;</code></pre>');
    attachCodeCopyButtons(root);
    const button = root.querySelector("pre button");
    assert.ok(button, "expected a copy button inside <pre>");
    assert.equal(button?.getAttribute("aria-label"), "Copy code");
  });

  it("does not attach a button to inline code (no surrounding <pre>)", () => {
    const root = setBody("<p>Run <code>ls -la</code> in the shell.</p>");
    attachCodeCopyButtons(root);
    assert.equal(root.querySelector("button"), null);
  });

  it("does not attach a button to a mermaid placeholder (no nested <code>)", () => {
    const root = setBody('<pre class="mermaid" data-mermaid-pending="1">graph TB\n  A--&gt;B</pre>');
    attachCodeCopyButtons(root);
    assert.equal(root.querySelector("button"), null);
  });

  it("is idempotent across repeated calls on the same container", () => {
    const root = setBody("<pre><code>echo hi</code></pre>");
    attachCodeCopyButtons(root);
    attachCodeCopyButtons(root);
    assert.equal(root.querySelectorAll("pre button").length, 1);
  });

  it("attaches independently to multiple code blocks", () => {
    const root = setBody("<pre><code>a()</code></pre><p>text</p><pre><code>b()</code></pre>");
    attachCodeCopyButtons(root);
    assert.equal(root.querySelectorAll("pre button").length, 2);
  });

  it("copies the code block's own text and reflects the copied label", async () => {
    const copied: string[] = [];
    installStubClipboard(async (text) => {
      copied.push(text);
    });

    const root = setBody("<pre><code>print('hi')</code></pre>");
    attachCodeCopyButtons(root, { copyLabel: "Copy code", copiedLabel: "Copied!" });
    const button = root.querySelector("pre button") as HTMLButtonElement;
    button.click();
    // The click handler's clipboard write is async; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(copied, ["print('hi')"]);
    assert.equal(button.getAttribute("aria-label"), "Copied!");
  });
});
