// Runtime side of the "copy code" affordance: scans a rendered
// markdown container for `<pre><code>` blocks (as produced by
// `markedHighlightExtension`) and appends a small copy button to each
// one that isn't already wired up. Mirrors `mermaidRender.ts`'s
// scan-and-mutate shape so every markdown viewer can post-process the
// same `v-html` output through one shared composable.
//
// A mermaid fence never matches here: `mermaidExtension` renders it as
// a bare `<pre class="mermaid">…</pre>` with no nested `<code>`, and
// once it's rendered to SVG the `<pre>` is gone entirely.

/** Localised strings for the button's accessible name / tooltip.
 *  Callers (composables) resolve `t("markdownCodeCopy.…")` at
 *  component-setup time. Defaults keep the pure module testable
 *  without an i18n runtime. */
export interface CodeCopyLabels {
  copyLabel: string;
  copiedLabel: string;
}

const DEFAULT_LABELS: CodeCopyLabels = {
  copyLabel: "Copy code",
  copiedLabel: "Copied!",
};

// How long the button shows its "copied" state before reverting.
const COPIED_RESET_MS = 2000;

// Marks a `<pre>` as already wired up so a re-render of the same
// container (e.g. a streaming assistant reply growing) doesn't stack
// a second button on top of the first.
const ATTACHED_ATTR = "data-code-copy-attached";

const BUTTON_STYLE =
  "position:absolute;top:0.5rem;right:0.5rem;display:flex;align-items:center;" +
  "justify-content:center;width:1.75rem;height:1.75rem;padding:0;border:none;" +
  "border-radius:0.25rem;background:rgba(255,255,255,0.85);color:#374151;" +
  "cursor:pointer;line-height:1;z-index:1;";

function unattachedCodeBlocks(root: Element | Document): HTMLElement[] {
  // `Element.parentElement` is `HTMLElement | null` in the DOM lib, and the
  // selector guarantees a `<pre>` parent — no runtime `instanceof` check
  // needed, which keeps this callable against any HTMLElement-like `root`
  // (jsdom included) without also requiring the global constructor.
  return Array.from(root.querySelectorAll<HTMLElement>("pre > code")).filter((code) => {
    const pre = code.parentElement;
    return pre !== null && !pre.hasAttribute(ATTACHED_ATTR);
  });
}

function createCopyButton(labels: CodeCopyLabels, readText: () => string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "material-icons code-copy-btn";
  button.style.cssText = BUTTON_STYLE;
  button.style.fontSize = "1rem";
  button.textContent = "content_copy";
  button.setAttribute("aria-label", labels.copyLabel);
  button.title = labels.copyLabel;

  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  const showCopied = () => {
    button.textContent = "check";
    button.setAttribute("aria-label", labels.copiedLabel);
    button.title = labels.copiedLabel;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      button.textContent = "content_copy";
      button.setAttribute("aria-label", labels.copyLabel);
      button.title = labels.copyLabel;
    }, COPIED_RESET_MS);
  };

  button.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(readText())
      .then(showCopied)
      .catch(() => {
        // Clipboard API blocked (insecure context, denied permission,
        // sandboxed iframe) — leave the button in its default state,
        // mirroring `useClipboardCopy`'s swallow-and-stay-quiet
        // behaviour rather than surfacing an error the user can't act on.
      });
  });

  return button;
}

/** Attach a copy button to every unprocessed `<pre><code>` block under
 *  `root`. Safe to call repeatedly on the same container — already
 *  wired blocks are skipped via `data-code-copy-attached`. `labels`
 *  defaults to English fallbacks so the pure module is callable from
 *  tests / node environments without an i18n runtime. */
export function attachCodeCopyButtons(root: Element | Document | null | undefined, labels: CodeCopyLabels = DEFAULT_LABELS): void {
  if (!root) return;
  for (const code of unattachedCodeBlocks(root)) {
    const pre = code.parentElement;
    if (!pre) continue;
    pre.setAttribute(ATTACHED_ATTR, "1");
    // The button is positioned absolutely against the `<pre>`; give it
    // a positioning context unless the surrounding stylesheet already
    // set one.
    if (!pre.style.position) pre.style.position = "relative";
    pre.appendChild(createCopyButton(labels, () => code.textContent ?? ""));
  }
}
