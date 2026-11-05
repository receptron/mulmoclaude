// Build the sandboxed-iframe `srcdoc` for a custom collection view (see
// plans/done/feat-collections-custom-views.md). Pure (takes the server origin
// explicitly instead of reading `window`), so it's unit-testable and keeps
// the script-tag string out of the .vue SFC source.
//
// Injected at the START of <head> so the bootstrap runs before any of the
// view's own scripts:
//   1. a CSP <meta> with connect-src = the server origin (the view may fetch
//      its data endpoint but no third party), and
//   2. `window.__MC_VIEW = { slug, token, dataUrl, origin, onChange, openItem,
//      startChat, searchQuery, onSearchQueryChange }` — the scoped capability
//      token + the absolute data URL the view reads, plus an `onChange(cb)`
//      live-refresh subscription, an `openItem(id, mode)` helper that asks the
//      host to open a record in its shared modal, a `startChat(prompt, role)`
//      helper that asks the host to open a new chat seeded with `prompt`, and
//      the host search box's live text (see below).

import type { CustomViewFields } from "@mulmoclaude/core/collection";
import { buildCustomViewCsp, type CspExtraHosts } from "./previewCsp";

/** Debounce (ms) for the in-iframe live-refresh helper — collapses a burst of
 *  parent change-pings (e.g. a bulk write) into a single `onChange` callback. */
const ONCHANGE_DEBOUNCE_MS = 150;

/** Debounce (ms) for `onSearchQueryChange` — collapses a typed word into one
 *  callback instead of one per keystroke. `__MC_VIEW.searchQuery` itself is
 *  updated immediately, so a view re-reading it mid-render is never stale. */
const SEARCH_QUERY_DEBOUNCE_MS = 150;

/** The in-iframe bootstrap appended after `window.__MC_VIEW = {…}`. It installs
 *  the view↔host bridge:
 *
 *  - `onChange(cb)`: the view author's one-line opt-in to live refresh. The host
 *    parent (`CollectionCustomView.vue`) relays a `{ type: "mc-collection-changed",
 *    slug }` message into the iframe whenever the collection's data changes; this
 *    validates the message came from the parent, is for THIS collection,
 *    debounces, and invokes every registered callback. The message carries no
 *    secret and only triggers a re-fetch through the token the view already holds.
 *  - `openItem(id, mode)`: posts a `{ type: "mc-open-item", slug, id, mode }`
 *    ping up to the parent, which opens the record in the host's shared modal.
 *    The payload carries no secret (slug + id are already known to the view) and
 *    is sent to the known parent origin (`v.origin`). Opening the host's own
 *    modal is a user action through trusted UI, so it needs no `write`
 *    capability even for `mode: "edit"` — the save still goes through the host.
 *  - `startChat(prompt, role)`: posts a `{ type: "mc-start-chat", slug, prompt,
 *    role }` ping up to the parent, which opens a NEW chat session seeded with
 *    `prompt`. By default it is prefilled in the composer as an editable draft —
 *    the user reviews / edits / sends (or clears) it, so the view's code can only
 *    propose text and no capability is required. A view whose `views[]` entry
 *    declares `allowSendChat` is SENT instead; that decision is read off the
 *    schema by the parent, never from this message, so the sandbox cannot grant
 *    itself the send. `role` is optional and resolves to the general role when it
 *    names no known one. Sent to `v.origin`, no secret.
 *  - `searchQuery` / `onSearchQueryChange(cb)`: the host relays the STANDARD
 *    table view's search text so a custom view can react to the one search box
 *    the user already sees instead of shipping a second one (#2959).
 *    `v.searchQuery` updates synchronously; callbacks are debounced and receive
 *    the query. Host → view only — the view cannot write the host's box.
 *
 *    It travels over a **MessageChannel port**, not `postMessage` on the
 *    window: the bootstrap creates the channel, keeps `port1` and hands `port2`
 *    up with an `mc-view-ready` ping. A window post has to name a target
 *    origin, and this frame's origin is opaque — so the only usable target is
 *    `"*"`, which keeps delivering after the view navigates ITSELF away
 *    (nothing in the sandbox or CSP stops `location = "https://elsewhere"`),
 *    handing the user's typed text to whatever document replaced it. A port is
 *    bound to the document that received it, so navigation severs the channel
 *    on its own. This bootstrap runs before any of the view's own scripts, so
 *    the first claim on a fresh frame is always the real view; the host answers
 *    a LATER claim by reinstalling the view rather than handing the channel to
 *    a document it cannot identify.
 *  - CSP-violation reporter: a `securitypolicyviolation` listener posts a
 *    `{ type: "mc-csp-violation", slug, blockedURI, violatedDirective }` ping
 *    to the host (#1989) so a blocked resource (e.g. a Google Maps embed the
 *    user hasn't allowed in `config/csp.json`) surfaces as an actionable
 *    notice instead of failing silently. Informational only, carries no secret.
 *
 *  Self-contained string (no `</script>` sequence, no `<`, no `${`). */
function viewBridgeBootstrap(): string {
  // One line on purpose — it's inlined into the iframe's bootstrap <script>.
  // Uses single quotes throughout (no `</script>`, no `<`, no `${`) so it stays
  // intact inside the template literal and inside the script element.
  // `cbs.slice()` snapshots the listeners before dispatch so a callback that
  // unsubscribes itself can't shift the array and skip the next one.
  //
  // `v.t(key, named)` is a tiny **vue-i18n-compatible** translation helper.
  // The on-disk dict shape mirrors vue-i18n's locale messages so an author can
  // copy their app's locale JSON verbatim, and the iframe API mirrors
  // vue-i18n's `t('msg', { name: 'x' })` signature:
  //   - lookup `v.dict[key]` (host-picked, locale-filtered server-side);
  //   - substitute `{name}` placeholders from `named` (vue-i18n "named
  //     interpolation"; numeric `{0}` works too — same `\w+` token);
  //   - fall back to the key itself when the dict is missing or the entry
  //     isn't a string.
  // v1 scope: named interpolation only — no pluralization, no linked
  // messages, no formatter. Most view-level UIs need exactly this, and
  // shipping the full vue-i18n runtime into every sandboxed iframe (~50KB)
  // would dominate the page weight. Authors who need plurals can pre-pick
  // per-count keys client-side.
  return `(function(){var v=window.__MC_VIEW,cbs=[],t,qcbs=[],qt;function fire(){t=undefined;cbs.slice().forEach(function(cb){try{cb()}catch(e){}});}function fireQuery(){qt=undefined;var q=v.searchQuery;qcbs.slice().forEach(function(cb){try{cb(q)}catch(e){}});}window.addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.type!=='mc-collection-changed'||d.slug!==v.slug)return;if(t)clearTimeout(t);t=setTimeout(fire,${ONCHANGE_DEBOUNCE_MS});});var qch=new MessageChannel();qch.port1.onmessage=function(e){var d=e.data;if(!d||d.type!=='mc-search-query')return;v.searchQuery=typeof d.query==='string'?d.query:'';if(qt)clearTimeout(qt);qt=setTimeout(fireQuery,${SEARCH_QUERY_DEBOUNCE_MS});};window.parent.postMessage({type:'mc-view-ready',slug:v.slug},v.origin,[qch.port2]);v.onChange=function(cb){if(typeof cb!=='function')return function(){};cbs.push(cb);return function(){var i=cbs.indexOf(cb);if(i>=0)cbs.splice(i,1);};};v.onSearchQueryChange=function(cb){if(typeof cb!=='function')return function(){};qcbs.push(cb);return function(){var i=qcbs.indexOf(cb);if(i>=0)qcbs.splice(i,1);};};v.openItem=function(id,mode){window.parent.postMessage({type:'mc-open-item',slug:v.slug,id:String(id),mode:mode==='edit'?'edit':'view'},v.origin);};v.startChat=function(prompt,role){window.parent.postMessage({type:'mc-start-chat',slug:v.slug,prompt:String(prompt),role:typeof role==='string'?role:undefined},v.origin);};v.dict=v.dict||{};v.t=function(key,named){var s=v.dict[key];if(typeof s!=='string')return typeof key==='string'?key:String(key);if(!named||typeof named!=='object')return s;return s.replace(/\\{(\\w+)\\}/g,function(m,n){var x=named[n];return x==null?m:String(x);});};document.addEventListener('securitypolicyviolation',function(e){window.parent.postMessage({type:'mc-csp-violation',slug:v.slug,nonce:v.cspNonce,blockedURI:e.blockedURI,violatedDirective:e.violatedDirective,effectiveDirective:e.effectiveDirective},v.origin);});})();`;
}

export interface CustomViewBootstrap {
  slug: string;
  /** Scoped capability token (Authorization: Bearer <token>). */
  token: string;
  /** Data endpoint URL; absolutised against `origin` when root-relative
   *  (the iframe is `about:srcdoc`, so a relative `/api/...` would not
   *  resolve against the server origin). */
  dataUrl: string;
  /** Explicit server origin — used for both the CSP and the absolute
   *  dataUrl (the sandboxed iframe's own origin is opaque). */
  origin: string;
  /** The locale the dict was picked for (e.g. `"en"`, `"ja"`); empty when the
   *  view has no `i18n` declared or no locale block matched. The bootstrap
   *  always exposes `__MC_VIEW.locale`; an empty string means "no
   *  translations available". */
  locale?: string;
  /** Flat key→string map the host already locale-filtered server-side. The
   *  iframe sees ONLY this locale's strings (never the full multi-locale
   *  JSON). Optional / may be `{}` — the `t()` helper falls back to the key. */
  dict?: Record<string, string>;
  /** Schema-derived enum metadata, keyed by field name (#2169). Optional — the
   *  bootstrap always exposes `__MC_VIEW.fields`, `{}` when omitted. */
  fields?: CustomViewFields;
}

function absoluteDataUrl(dataUrl: string, origin: string): string {
  return dataUrl.startsWith("/") ? `${origin}${dataUrl}` : dataUrl;
}

export function buildCustomViewSrcdoc(html: string, boot: CustomViewBootstrap, cspExtra: CspExtraHosts = {}, cspNonce = ""): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${buildCustomViewCsp(boot.origin, undefined, cspExtra)}">`;
  // `<`-escape the JSON so a hostile token/slug value can't break out of the
  // <script> element. The same escape covers translation strings dropped into
  // `dict` — a malicious author who managed to land a `</script>` literal in
  // a translation value still can't break out of the bootstrap.
  const json = JSON.stringify({
    slug: boot.slug,
    token: boot.token,
    dataUrl: absoluteDataUrl(boot.dataUrl, boot.origin),
    origin: boot.origin, // target origin for openItem's postMessage to the parent
    // Always "": the live value arrives over the transferred MessageChannel
    // port. Baking it in here would rebuild the srcdoc — a token re-mint plus
    // a full iframe reload — on every keystroke (#2959).
    searchQuery: "",
    cspNonce, // echoed in mc-csp-violation so the host can trust the sender (#1989)
    locale: boot.locale ?? "",
    dict: boot.dict ?? {},
    fields: boot.fields ?? {},
  }).replace(/</g, "\\u003c");
  const injection = `${cspMeta}<script>window.__MC_VIEW=${json};${viewBridgeBootstrap()}</script>`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/(<head\b[^>]*>)/i, `$1${injection}`);
  }
  return `<!DOCTYPE html><html><head>${injection}</head><body>${html}</body></html>`;
}
