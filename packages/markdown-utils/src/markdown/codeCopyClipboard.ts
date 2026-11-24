// Click behaviour for the copy buttons `codeCopyExtension` emits.
//
// ONE delegated listener for the whole document, not a listener per
// viewer: the buttons live inside `v-html`, so Vue cannot bind `@click`
// to them, and they are destroyed and recreated on every streamed chunk.
// Delegation is indifferent to both — the listener is attached to a node
// that outlives every re-render, and a button that appears mid-stream
// works without anyone re-running an attach pass.
//
// It takes no labels. Only the FIRST install on a document keeps its
// listener (host and plugin bundles both call this), so any provider
// captured here would caption the other bundle's buttons too. The
// renderer writes both label states into each button instead, which also
// keeps them following the locale for free: a language switch re-renders
// the markdown, and the new markup carries the new strings.

import {
  CODE_COPY_ATTR,
  CODE_COPY_BLOCK_ATTR,
  CODE_COPY_ICON,
  CODE_COPIED_ICON,
  CODE_COPY_IDLE_LABEL_ATTR,
  CODE_COPY_COPIED_LABEL_ATTR,
  CODE_COPY_NONCE_UNAVAILABLE,
  codeCopyNonce,
  setCodeCopyNonce,
} from "./codeCopyExtension.js";

/** How long the button stays in its "copied" state before reverting. */
const FEEDBACK_DURATION_MS = 2000;
/** Applied on success and removed on revert — the whole visual delta. */
const COPIED_TINT_CLASS = "text-green-600";

/** Guards against a second listener when two bundles install the handler
 *  into one document (host + a plugin package). The flag lives on the
 *  DOCUMENT rather than in module state precisely because there can be
 *  two module instances, and only the document is shared between them. */
interface InstallTarget extends Document {
  __mulmoclaudeCodeCopyInstalled?: boolean;
  __mulmoclaudeCodeCopyNonce?: string;
}

/** Pairs a document with the renderer, and returns the nonce they agree on.
 *
 *  The value lives on the DOCUMENT for the same reason the install flag
 *  does: host and plugin each have their own module instance, and the
 *  document is the only thing they share.
 *
 *  A document that has none adopts the RENDERER's current value rather
 *  than minting its own, and that direction is the whole point. The
 *  renderer's nonce is module state with no idea which document it is
 *  rendering for, so minting per document lets the two drift: pair A,
 *  pair B, then re-render A, and A's buttons carry B's nonce while A's
 *  listener still demands A's. Adopting makes every document in a realm
 *  converge on one value, which costs nothing — the nonce defends against
 *  markup that cannot read ANY of them (codex round 2, P3). */
function ensureNonce(doc: Document): string {
  const target: InstallTarget = doc;
  const existing = target.__mulmoclaudeCodeCopyNonce;
  if (existing !== undefined) return existing;
  const adopted = codeCopyNonce();
  target.__mulmoclaudeCodeCopyNonce = adopted;
  return adopted;
}

// `nodeType`, not `instanceof Element`: this package is browser-SAFE, not
// browser-ONLY, and the Node + jsdom harness installs `window`/`document`
// as globals without the DOM constructors — where a bare `Element` is a
// ReferenceError. Same reason `sanitizeMarkdownHtml` in core discriminates
// this way. nodeType 1 is the DOM standard's own element discriminant.
const ELEMENT_NODE = 1;
const isElement = (value: unknown): value is Element => typeof value === "object" && value !== null && "nodeType" in value && value.nodeType === ELEMENT_NODE;
// An element that can carry `classList` / `innerHTML` — everything the
// feedback swap touches. `Element` alone lacks them.
const isHtmlElement = (value: unknown): value is HTMLElement => isElement(value) && "classList" in value && "innerHTML" in value;

/**
 * Reads the raw source a block should copy: `textContent` of the
 * `<code>`, so highlight.js's `<span>` markup never reaches the
 * clipboard. Exported for the tests.
 */
export function codeTextOf(button: Element): string | null {
  const block = button.closest(`[${CODE_COPY_BLOCK_ATTR}]`);
  const code = block?.querySelector("pre > code");
  const text = code?.textContent;
  if (text === undefined || text === null) return null;
  // Since marked 18.2.1 both block styles keep the last line's terminator
  // whenever it is there (an indented block always, a fence only when it
  // ends in a blank line), so dropping one recovers the author's lines.
  return stripTrailingNewline(text);
}

function stripTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** The accessible name and the tooltip are the same string; setting them
 *  in one place is what stops the two drifting apart. */
function setLabel(button: HTMLElement, label: string | null): void {
  if (label === null) return;
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

// One pending revert per button. Without this, clicking again while the
// confirmation is up leaves the FIRST timer running: it fires on the old
// schedule and clears the second click's feedback early. Keyed weakly so
// a button removed by the next streamed re-render is collectable.
const pendingReverts = new WeakMap<HTMLElement, number>();

function showCopied(button: HTMLElement): void {
  const view = button.ownerDocument.defaultView;
  // No window means a detached document nobody is looking at. Bail
  // before mutating, rather than leaving a confirmation that can never
  // revert because there is no timer to schedule.
  if (view === null || view === undefined) return;
  setLabel(button, button.getAttribute(CODE_COPY_COPIED_LABEL_ATTR));
  button.innerHTML = CODE_COPIED_ICON;
  button.classList.add(COPIED_TINT_CLASS);
  const pending = pendingReverts.get(button);
  if (pending !== undefined) view.clearTimeout(pending);
  const handle: number = view.setTimeout(() => {
    // Identity check, not just `clearTimeout`: a stale callback that
    // still runs — a timer already dispatched when the second click
    // cancelled it — must not clear the live confirmation.
    if (pendingReverts.get(button) !== handle) return;
    pendingReverts.delete(button);
    button.innerHTML = CODE_COPY_ICON;
    button.classList.remove(COPIED_TINT_CLASS);
    setLabel(button, button.getAttribute(CODE_COPY_IDLE_LABEL_ATTR));
  }, FEEDBACK_DURATION_MS);
  pendingReverts.set(button, handle);
}

// `composedPath()`, not `event.target.closest`: a click inside a shadow root
// reaches this document-level listener retargeted to the shadow HOST, so
// walking up from `target` never meets the button. Must run before the
// first `await` — the path is emptied once dispatch finishes.
function copyButtonOf(event: Event): Element | undefined {
  return event.composedPath().find((node): node is Element => isElement(node) && node.hasAttribute(CODE_COPY_ATTR));
}

async function handleClick(event: Event): Promise<void> {
  const button = copyButtonOf(event);
  if (!isHtmlElement(button)) return;
  // The marker's VALUE is the check, not its presence. Author markup can
  // carry the attribute — marked passes raw HTML through and DOMPurify
  // keeps `data-*` — so a bare marker would let a rendered README drive
  // the clipboard. An empty nonce never matches, which is what makes the
  // no-CSPRNG case inert instead of guessable.
  const expected = ensureNonce(button.ownerDocument);
  if (expected === CODE_COPY_NONCE_UNAVAILABLE) return;
  if (button.getAttribute(CODE_COPY_ATTR) !== expected) return;
  const text = codeTextOf(button);
  if (text === null) return;
  const clipboard = button.ownerDocument.defaultView?.navigator?.clipboard;
  if (clipboard === undefined) return;
  try {
    await clipboard.writeText(text);
  } catch {
    // A denied clipboard permission is the user's answer, not an app
    // error: leave the button in its idle state so the icon never claims
    // a copy that did not happen. Nothing to log — the page is not the
    // place to report a permission the user controls.
    return;
  }
  showCopied(button);
}

/**
 * Attach the delegated listener. Idempotent — a second call on the same
 * document is a no-op, so the host and a plugin bundle can both ask.
 */
export function installCodeCopyHandler(doc: Document): void {
  const target: InstallTarget = doc;
  // Before the install guard, and on EVERY call: the second bundle's
  // listener install is a no-op, but its renderer still has to learn the
  // nonce the first bundle's listener will demand.
  setCodeCopyNonce(ensureNonce(doc));
  if (target.__mulmoclaudeCodeCopyInstalled === true) return;
  target.__mulmoclaudeCodeCopyInstalled = true;
  doc.addEventListener("click", (event) => void handleClick(event));
}

/** Test seam — lets an isolated test install into a fresh document twice. */
export function _resetCodeCopyHandlerForTests(doc: Document): void {
  const target: InstallTarget = doc;
  target.__mulmoclaudeCodeCopyInstalled = false;
  delete target.__mulmoclaudeCodeCopyNonce;
}
