// Marked `code` renderer override that gives every non-mermaid fenced
// block a copy control in its top-right corner. The click behaviour is
// NOT here — `codeCopyClipboard.ts` installs one delegated listener for
// the whole document. This file stays pure (marked + the zero-dep
// `@mulmoclaude/common` leaf) so tests can assert the html shape without
// a browser.
//
// Why the renderer and not a post-render DOM scan (the shape
// `useMermaidRenderer` uses): a viewer's `renderedHtml` is a computed
// over streaming text, so `v-html` replaces the container's innerHTML on
// every chunk. A scan-and-attach pass would re-insert a button into every
// block on every chunk, and an "already attached" marker cannot prevent
// it because the nodes it marked are gone after the next patch. Markup
// emitted here rides along in the string Vue already writes.
//
// Why the button floats over a wrapper instead of sitting in a header
// strip above the block: `pre` is styled by UNLAYERED css in at least
// three places (`.markdown-content pre` in `src/index.css`, plus scoped
// `:deep(pre)` in textResponse's and skill's Views). Unlayered rules beat
// Tailwind's `@layer utilities` outright, so a utility on the `pre` could
// not flatten its bottom corners — a header strip would mean editing the
// global stylesheet in two packages. A wrapper the existing selectors do
// not name collides with none of it. The button lives on the WRAPPER, not
// inside the `pre`, so it stays put when a wide block scrolls sideways.
//
// Registration order (see setup.ts): AFTER `markedHighlightExtension`,
// BEFORE `mermaidExtension`. Later `.use()` calls wrap earlier ones, so
// mermaid ends up outermost and a `mermaid` fence short-circuits into its
// placeholder without reaching this wrapper; every other fence falls
// through to here. Registering after highlight is what lets us emit the
// finished block: highlight's `walkTokens` has already rewritten
// `token.text` to highlighted html and stamped `token.escaped`.

import type { MarkedExtension, Tokens } from "marked";
import { escapeHtml } from "@mulmoclaude/common";

/** Accessible names for the copy control. Resolved at render time through
 *  the provider below, never captured at module load. */
export interface CodeCopyLabels {
  /** Idle state, e.g. "Copy code". */
  copy: string;
  /** Post-click confirmation, e.g. "Copied". */
  copied: string;
}

const DEFAULT_LABELS: CodeCopyLabels = { copy: "Copy code", copied: "Copied" };

let labelProvider: () => CodeCopyLabels = () => DEFAULT_LABELS;

/**
 * Point the renderer at the app's i18n. The provider is called on every
 * render rather than once, so a host whose provider reads a REACTIVE
 * locale gets live translations for free: the read lands inside the
 * `renderedHtml` computed's evaluation and Vue re-runs it on locale
 * change. Mirrors `setEmbedLocaleProvider`.
 */
export function setCodeCopyLabelProvider(provider: () => CodeCopyLabels): void {
  labelProvider = provider;
}

/** Test seam — restores the built-in English labels. */
export function _resetCodeCopyLabelsForTests(): void {
  labelProvider = () => DEFAULT_LABELS;
}

/** Marks the button for the delegated click listener. Its VALUE is a
 *  per-document nonce, and the listener copies nothing without a match.
 *
 *  The attribute cannot be a bare marker: `marked` passes an author's raw
 *  HTML straight through, DOMPurify's defaults keep `<button>` and every
 *  `data-*`, and the listener is document-wide. A bare marker therefore
 *  lets any rendered markdown — a cloned repository's README, which is
 *  exactly what `sanitizeMarkdownHtml` exists for — mint a working copy
 *  control and put text of its choosing on the clipboard. Verified: the
 *  spoof reached `clipboard.writeText`, and with a `display:none` decoy
 *  block the user saw `npm install` while the clipboard took
 *  `curl … | bash`. Structure cannot be the check, because an author can
 *  reproduce any structure; only a secret they cannot read works, and
 *  they cannot read this one because the sanitizer strips scripts. */
export const CODE_COPY_ATTR = "data-code-copy";

interface RandomSource {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

const isRandomSource = (value: unknown): value is RandomSource => typeof value === "object" && value !== null;

const NONCE_BYTES = 16;
const HEX_RADIX = 16;
const HEX_PAIR = 2;

/** Returned when no CSPRNG is reachable. The listener refuses it, so the
 *  copy button goes inert rather than becoming guessable — a feature that
 *  quietly stops working is recoverable, a clipboard anyone can drive is
 *  not. Every environment this ships to has one (browsers, Node >= 19,
 *  jsdom), so this is the unreachable branch, not a supported mode. */
export const CODE_COPY_NONCE_UNAVAILABLE = "";

/** A value author-supplied markup cannot guess. Static text is the whole
 *  threat: it never executes, so it can neither read nor predict this.
 *  CSPRNG only — `Math.random` is not a fallback here, it is a weaker
 *  version of the thing being defended. */
export function createCodeCopyNonce(): string {
  const source: unknown = globalThis.crypto;
  if (!isRandomSource(source)) return CODE_COPY_NONCE_UNAVAILABLE;
  if (typeof source.randomUUID === "function") return source.randomUUID();
  if (typeof source.getRandomValues !== "function") return CODE_COPY_NONCE_UNAVAILABLE;
  const bytes = source.getRandomValues(new Uint8Array(NONCE_BYTES));
  return Array.from(bytes, (byte) => byte.toString(HEX_RADIX).padStart(HEX_PAIR, "0")).join("");
}

// Seeded so a renderer used without the click handler still emits a value
// no author can guess: the pairing then simply fails closed.
let nonce: string = createCodeCopyNonce();

/** Point the renderer at the document's nonce. `installCodeCopyHandler`
 *  calls this on EVERY invocation, including the ones whose listener
 *  install is a no-op, so a second bundle's renderer agrees with the one
 *  listener that is actually running. */
export function setCodeCopyNonce(value: string): void {
  nonce = value;
}

/** The value the renderer is currently stamping. */
export function codeCopyNonce(): string {
  return nonce;
}
/** Marks the wrapper the listener searches for the block's `<code>`. Its
 *  VALUE is the block style; the copy no longer branches on it, because
 *  marked 18.2.1 made both styles end their text the same way. */
export const CODE_COPY_BLOCK_ATTR = "data-code-copy-block";
/** Value of the above for a 4-space block. */
export const CODE_BLOCK_STYLE_INDENTED = "indented";
/** Value for every fenced block. */
export const CODE_BLOCK_STYLE_FENCED = "fenced";

/** The button carries BOTH label states, so the delegated listener needs
 *  no label provider of its own. It cannot have a correct one: only the
 *  first install on a document keeps its listener, so a plugin's buttons
 *  would otherwise be captioned by whichever provider registered first. */
export const CODE_COPY_IDLE_LABEL_ATTR = "data-code-copy-idle";
export const CODE_COPY_COPIED_LABEL_ATTR = "data-code-copy-copied";

// A fence tag is author-controlled text that lands in a class attribute,
// so anything outside the shape marked already treats as a language name
// is dropped rather than escaped — a tag is a word, and a "language"
// holding markup is a typo at best.
const SAFE_LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9+#._-]{0,31}$/;

const languageOf = (token: Tokens.Code): string => {
  const lang = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
  return SAFE_LANGUAGE.test(lang) ? lang : "";
};

// Two overlapping rounded rectangles — the copy glyph every editor and
// chat app uses. Inline rather than a `material-icons` class because the
// icon font is imported by the HOST (`src/main.ts`), while this markup
// also ships inside a plugin package a different host may load.
const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** The idle glyph. Exported so the click handler can swap it back. */
export const CODE_COPY_ICON = [
  `<svg class="h-4 w-4" ${ICON_ATTRS}>`,
  '<rect x="9" y="9" width="13" height="13" rx="2"></rect>',
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
  "</svg>",
].join("");

/** The confirmation glyph shown for a moment after a successful copy. */
export const CODE_COPIED_ICON = [`<svg class="h-4 w-4" ${ICON_ATTRS}>`, '<path d="M20 6 9 17l-5-5"></path>', "</svg>"].join("");

/** Idle button classes. The handler tints the button on success rather
 *  than rewriting this list, so both states stay greppable. */
export const CODE_COPY_BUTTON_CLASS = [
  "absolute top-2 right-2 z-10 inline-flex items-center justify-center",
  "rounded-md border border-gray-300 bg-white/90 p-1.5 text-gray-600 shadow-sm",
  "transition-colors hover:bg-gray-100 hover:text-gray-900",
  "focus-visible:outline-2 focus-visible:outline-offset-2",
].join(" ");

export const codeCopyExtension: MarkedExtension = {
  renderer: {
    code(token: Tokens.Code): string {
      const language = languageOf(token);
      // `escaped` is markedHighlight's flag that `text` is already html.
      // Re-escaping it would turn `&quot;` into `&amp;quot;` and print the
      // entity to the reader — the same trap documented in
      // `mermaidExtension.ts`. Escape only when nobody has.
      const body = token.escaped === true ? token.text : escapeHtml(token.text);
      // Reproduces marked-highlight's own class shape (`langPrefix:
      // "hljs language-"`, `emptyLangClass: "hljs"`) because this renderer
      // replaces it rather than wrapping it — nothing calls through to
      // highlight's renderer once we return a string.
      const codeClass = language === "" ? "hljs" : `hljs language-${language}`;
      const labels = labelProvider();
      const idle = escapeHtml(labels.copy);
      const copied = escapeHtml(labels.copied);
      const style = token.codeBlockStyle === "indented" ? CODE_BLOCK_STYLE_INDENTED : CODE_BLOCK_STYLE_FENCED;
      return [
        `<div class="relative" ${CODE_COPY_BLOCK_ATTR}="${style}">`,
        `<button type="button" ${CODE_COPY_ATTR}="${escapeHtml(nonce)}" ${CODE_COPY_IDLE_LABEL_ATTR}="${idle}" ${CODE_COPY_COPIED_LABEL_ATTR}="${copied}" class="${CODE_COPY_BUTTON_CLASS}" aria-label="${idle}" title="${idle}">`,
        CODE_COPY_ICON,
        "</button>",
        // `dir="ltr"` isolates the block from an author's `dir="rtl"`
        // wrapper. Without it the code renders right-aligned and a long
        // line's LEFT end — where a payload would sit — scrolls out of
        // view while the clipboard still takes the whole logical string.
        // Measured: the rendered pixels change, the clipboard does not
        // (codex round 2). Isolating the block rather than stripping the
        // author's `dir` keeps legitimate right-to-left prose working.
        `<pre dir="ltr"><code class="${codeClass}">${body}</code></pre>`,
        "</div>\n",
      ].join("");
    },
  },
};
