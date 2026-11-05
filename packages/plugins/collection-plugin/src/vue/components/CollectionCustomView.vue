<template>
  <div class="custom-view-container">
    <div v-if="error" class="custom-view-message" role="alert" data-testid="collection-custom-view-error">
      {{ t("collectionsView.customViewError", { error }) }}
    </div>
    <div v-else-if="loading" class="custom-view-message" data-testid="collection-custom-view-loading">
      {{ t("collectionsView.customViewLoading") }}
    </div>
    <!-- Sandboxed: NO `allow-same-origin`, so the view keeps an opaque origin
         and cannot read the parent's token / localStorage — its data reaches it
         only via the scoped token injected into __MC_VIEW. `allow-popups` +
         `allow-popups-to-escape-sandbox` let a view open an external link
         (`<a target="_blank">` / `window.open`) as a normal new tab — e.g. a
         feed card linking to its article. Opening requires a user gesture and
         `target="_blank"` defaults to `noopener`, so the popup can't reach back
         into the view; the token stays isolated. `allow-downloads` lets a view
         save files (e.g. an .ics iCalendar export) — without it the browser
         silently blocks any download the frame initiates. -->
    <iframe
      v-else-if="srcdoc"
      ref="iframeEl"
      :key="view.id"
      data-testid="collection-custom-view-iframe"
      :title="view.label"
      :srcdoc="srcdoc"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads"
      class="w-full h-full border-0"
      @load="onFrameLoad"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { useCollectionI18n } from "../lang";
import { customViewFieldsFrom, customViewSendsChat, errorMessage } from "@mulmoclaude/core/collection";
import type { CollectionCustomView } from "@mulmoclaude/core/collection";
import { useCollectionUi } from "../scopedUi";
import { decideSearchChannelClaim, type SearchChannelState } from "../searchChannelPolicy";

const { t } = useCollectionI18n();

const props = defineProps<{
  slug: string;
  view: CollectionCustomView;
  /** Live text in the host's STANDARD table search box, relayed into the
   *  sandboxed view so a collection needs only one search box (#2959). */
  searchQuery?: string;
}>();

const emit = defineEmits<{
  /** The view called `__MC_VIEW.openItem(id, mode)` — open the record in the
   *  host's shared modal. */
  openItem: [payload: { id: string; mode: "view" | "edit" }];
  /** The view called `__MC_VIEW.startChat(prompt, role)` — open a new chat with
   *  `prompt`; `role` is honoured only when it names a role the host allows —
   *  known, and not a debug role — and opens in the general role otherwise.
   *  `send` carries the view's DECLARED intent (`allowSendChat`): false ⇒ prefill
   *  it as an editable draft, true ⇒ run it. */
  startChat: [payload: { prompt: string; role?: string | undefined; send: boolean }];
}>();

const loading = ref(true);
const error = ref<string | null>(null);
const srcdoc = ref<string | null>(null);
const iframeEl = ref<HTMLIFrameElement | null>(null);

// The live search channel into the current frame (see "Host search box → view"
// below). Declared up here because `load()` closes it, and the watch that calls
// `load()` runs during setup — a `let` declared further down would still be in
// its temporal dead zone.
let searchPort: MessagePort | null = null;

// Rebuilds already granted since the user last switched view or collection,
// and where the channel stands. The rule itself lives in
// `decideSearchChannelClaim` — pure, so it is covered exhaustively by unit
// tests rather than by racing an async iframe rebuild.
let frameReclaims = 0;
let searchState: SearchChannelState = "idle";

// How many documents this frame has loaded since the host installed its srcdoc.
// The srcdoc is one; anything beyond it is the VIEW NAVIGATING ITSELF, which
// nothing in the sandbox or the CSP prevents (the bootstrap's own docs say so).
// The replacement document keeps the frame's `contentWindow`, so it still
// passes the `event.source` check below and could drive the host with this
// view's declared privileges — verified by loading a foreign page into the
// frame and watching it start an agent turn. It is a different document from
// the one the declaration authorises, so its actions are dropped.
//
// WHAT THIS DOES NOT CATCH, because counting cannot: a redirect that runs while
// the srcdoc is still PARSING. The srcdoc's own load never fires, so the
// foreign document's load is the first one and the count reads 1. Also verified.
// Closing it needs the action message to prove which document sent it — either
// carrying the injected `cspNonce`, which only the srcdoc can read, or
// travelling over the MessageChannel port the bootstrap already creates (a port
// is bound to its document, which is why the search channel uses one). Both are
// changes to the three bootstrap copies plus a protocol bump, so they are a
// follow-up rather than part of #3062.
//
// Note what both cases have in common: the VIEW'S OWN document has to perform
// the navigation. A view that wanted to run turns could simply call `startChat`,
// which its declaration already permits — so this is containment after the
// frame stops being the view, not a trust boundary the declaration did not
// already cross.
let frameDocuments = 0;

function onFrameLoad(event: Event): void {
  // Only THIS frame's loads count. Defensive rather than a fix for an observed
  // bug: switching away mid-load destroys the old frame, so its pending `load`
  // was never seen to arrive here — but if one ever did, after the reset below,
  // it would take the new view straight to 2 and silently refuse its own
  // buttons. Comparing the target costs nothing and removes the dependency on
  // that teardown detail.
  if (event.target !== iframeEl.value) return;
  frameDocuments += 1;
}

/** False once the frame holds a document the host did not install. */
function frameIsTheInstalledView(): boolean {
  return frameDocuments <= 1;
}

function closeSearchPort(): void {
  searchPort?.close();
  searchPort = null;
}

// Resolved once in setup: inside a chat card this is the card's project-scoped
// binding, elsewhere the global one. Captured here because the loads below run
// outside setup, where the scope can no longer be injected.
const cui = useCollectionUi();

// The injected token expires (VIEW_TOKEN_TTL_MS, 1h). The sandboxed view can't
// re-mint itself (it has no global bearer), so a view left mounted past expiry
// would 401 on its next read/write. Schedule a re-mint + reload shortly before
// `exp` so the iframe always holds a fresh token.
const REMINT_LEAD_MS = 60_000;
const MIN_REMINT_DELAY_MS = 10_000;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function clearRefresh(): void {
  if (refreshTimer !== undefined) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
}

function scheduleRefresh(expMs: number): void {
  clearRefresh();
  const delay = Math.max(expMs - Date.now() - REMINT_LEAD_MS, MIN_REMINT_DELAY_MS);
  refreshTimer = setTimeout(() => void load(), delay);
}

// Monotonic load id: a switch/refresh that starts a newer load() must win, so
// a slower in-flight load can't clobber the current view's srcdoc when it
// finally resolves. Each load captures its id and bails on every commit if a
// newer load has started.
let loadSeq = 0;

async function load(): Promise<void> {
  clearRefresh();
  closeSearchPort(); // the frame this port belonged to is being replaced
  frameDocuments = 0; // a fresh srcdoc is about to be installed
  // Non-connectable until the new srcdoc is actually installed: the awaits
  // below are network round trips, and the OLD document sits in the frame for
  // all of them. `exhausted` outranks this and is not cleared here.
  if (searchState !== "exhausted") searchState = "rebuilding";
  const seq = ++loadSeq;
  const stale = (): boolean => seq !== loadSeq;
  loading.value = true;
  error.value = null;
  srcdoc.value = null;
  const binding = cui;
  try {
    // 1. Mint a scoped token for this view's declared capabilities.
    const mint = await binding.mintViewToken(props.slug, props.view.id);
    if (stale()) return;
    if (!mint.ok) {
      error.value = mint.error;
      return;
    }
    // Re-mint + reload before this token expires (the iframe can't do it itself).
    scheduleRefresh(mint.data.exp);
    // 2. Fetch the view's HTML (global-bearer; attached by the host).
    const resp = await binding.fetchViewHtml(props.slug, props.view.id);
    if (stale()) return;
    if (!resp.ok) {
      error.value = `HTTP ${resp.status}`;
      return;
    }
    // 3. Pull the translation dict (already locale-picked server-side).
    // Always queried — when the view has no `i18n` declared the server returns
    // the empty contract `{ locale: "", dict: {} }`, so the iframe-side
    // `__MC_VIEW.t(key)` falls back to the key. A network failure is also
    // soft — the view renders without translations rather than 404'ing.
    const i18n = await binding.fetchViewI18n(props.slug, props.view.id, binding.localeTag());
    if (stale()) return;
    const i18nBoot = i18n.ok ? i18n.data : { locale: "", dict: {} };
    // 4. Render it sandboxed with the token + CSP + dict injected.
    // The frame is the host's again from here, so its view may claim.
    if (searchState === "rebuilding") searchState = "idle";
    srcdoc.value = binding.buildViewSrcdoc(resp.html, {
      slug: props.slug,
      token: mint.data.token,
      dataUrl: mint.data.dataUrl,
      origin: window.location.origin,
      locale: i18nBoot.locale,
      dict: i18nBoot.dict,
      fields: customViewFieldsFrom(mint.data.fields),
    });
  } catch (err) {
    if (!stale()) error.value = errorMessage(err);
  } finally {
    if (!stale()) loading.value = false;
  }
}

// Reload (re-mint + re-fetch) whenever the selected view or collection changes
// — and also whenever the active app locale flips, so a sandboxed view picks
// up freshly-translated strings without the user having to switch view +
// back. `localeTag()` is documented as reactive (the binding doc on
// `CollectionUi.localeTag`); reading it inside the watch source array lets
// Vue track that dep transparently.
//
// The WHOLE declaration, not just its id: a schema refetch can replace this
// entry in place, and everything the host derives from it is baked into the
// document already in the frame — the HTML `file`, the minted token's
// `capabilities`, the injected `dict`, and `allowSendChat`, which the message
// handler below re-reads live. Keying on the id alone leaves the old document
// mounted while the new policy governs it, so flipping an open view to
// `allowSendChat: true` would let the PREVIOUS build's buttons send. Comparing
// the serialized entry makes "the document in the frame was built from the
// declaration being enforced" true by construction; the object is a handful of
// scalar fields, so the stringify costs nothing.
watch(
  [() => props.slug, () => JSON.stringify(props.view), () => cui.localeTag()],
  () => {
    frameReclaims = 0;
    searchState = "idle";
    void load();
  },
  { immediate: true },
);

// ── Live updates ──
// The sandboxed iframe can't open its own authenticated pub/sub socket, so the
// host parent subscribes (via the optional `subscribeChanges` capability) and
// relays a `{ type: "mc-collection-changed", slug }` message into the iframe on
// every record change. The injected `window.__MC_VIEW.onChange(cb)` helper
// validates + debounces it and re-fetches through the token the view already
// holds. The message carries no secret. If the host omits `subscribeChanges`,
// custom views simply keep their fetch-on-load behaviour.
let changeUnsub: (() => void) | null = null;

function relayChange(): void {
  // `"*"` target is safe: the payload is just a refetch ping (no token/data),
  // and the iframe-side handler verifies the message came from `window.parent`.
  iframeEl.value?.contentWindow?.postMessage({ type: "mc-collection-changed", slug: props.slug }, "*");
}

watch(
  () => props.slug,
  (slug) => {
    changeUnsub?.();
    changeUnsub = null;
    const subscribe = cui.subscribeChanges;
    if (slug && subscribe) changeUnsub = subscribe(slug, relayChange);
  },
  { immediate: true },
);

// ── Host search box → view ──
// The standard table's search box stays visible while a custom view renders, so
// the user reasonably expects the one box to drive both (#2959). The iframe has
// an opaque origin and cannot read the parent, so the host pushes the text in.
// Host → view only: the view reacts to the query, it never writes it back.
//
// Over a MessageChannel port rather than `contentWindow.postMessage`, because
// the query is the user's own typed text. A window post must name a target
// origin, and an opaque origin can only be addressed as `"*"` — which keeps
// delivering after the view navigates ITSELF elsewhere (nothing stops
// `location = "https://elsewhere"`), handing the replacement document every
// later keystroke. A port belongs to the document that received it, so that
// navigation severs the channel instead. `relayChange` above stays on `"*"`:
// its payload is a bare refetch ping whose slug the view already knows.
function postSearchQuery(query: string): void {
  searchPort?.postMessage({ type: "mc-search-query", slug: props.slug, query });
}

// Why a claim is answered this way — and why no secret would help — is in
// `searchChannelPolicy.ts` alongside the rule itself.
function connectSearchPort(port: MessagePort): void {
  searchPort = port;
  searchState = "connected";
  // Seed a frame built after the user had already typed (a view switch, or the
  // token re-mint). Empty is skipped — it is the frame's own initial state, so
  // pushing it would fire every view's callback for nothing.
  const query = props.searchQuery ?? "";
  if (query) postSearchQuery(query);
}

function reinstallView(): void {
  frameReclaims += 1;
  void load(); // sets `rebuilding`, then `idle` once the new frame is installed
}

function acceptSearchPort(port: MessagePort | undefined): void {
  if (!port) return;
  const action = decideSearchChannelClaim(searchState, frameReclaims);
  if (action === "ignore") {
    port.close(); // a rebuild is already under way; keep our own port untouched
    return;
  }
  if (action === "connect") {
    connectSearchPort(port);
    return;
  }
  closeSearchPort();
  if (action === "reinstall") {
    reinstallView();
    return;
  }
  // Terminal: refusing must not read as "disconnected", or the next claim from
  // the same document would be taken for a fresh frame and handed the channel.
  searchState = "exhausted";
}

// Clearing the box must reach the view too, so this one relays "" as well.
watch(
  () => props.searchQuery,
  (query) => postSearchQuery(query ?? ""),
);

// ── View → host action bridge ──
// The view calls `__MC_VIEW.openItem(id, mode)` / `.startChat(prompt, role)`,
// which post an `mc-open-item` / `mc-start-chat` message up to here. Verify it
// came from THIS view's iframe and is for THIS collection, then hand the action
// to the host. The messages carry no secret; the capability token is unaffected.
function handleOpenItem(body: { id?: unknown; mode?: unknown }): void {
  const itemId = typeof body.id === "string" ? body.id : String(body.id ?? "");
  if (!itemId) return;
  emit("openItem", { id: itemId, mode: body.mode === "edit" ? "edit" : "view" });
}

function handleStartChat(body: { prompt?: unknown; role?: unknown }): void {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return;
  // `send` comes from the SCHEMA, never from the message: the iframe composes the
  // text, so letting it also choose whether that text runs unreviewed would put
  // both halves of the decision inside the sandbox.
  const send = customViewSendsChat(props.view);
  emit("startChat", { prompt, role: typeof body.role === "string" ? body.role : undefined, send });
}

/** Anything the sandboxed view may post up. Every field stays `unknown` — the
 *  handlers below validate them; this only says "some object arrived". */
interface BridgeMessage {
  type?: unknown;
  slug?: unknown;
  id?: unknown;
  mode?: unknown;
  prompt?: unknown;
  role?: unknown;
}

function isBridgeMessage(data: unknown): data is BridgeMessage {
  return typeof data === "object" && data !== null;
}

function onWindowMessage(event: MessageEvent): void {
  if (event.source !== iframeEl.value?.contentWindow) return;
  const msg: unknown = event.data;
  if (!isBridgeMessage(msg) || msg.slug !== props.slug) return;
  if (msg.type === "mc-view-ready") {
    acceptSearchPort(event.ports[0]);
    return;
  }
  // Actions are the view's PRIVILEGES, so they belong to the document the host
  // installed and not merely to the frame it sits in.
  if (!frameIsTheInstalledView()) return;
  if (msg.type === "mc-open-item") handleOpenItem({ id: msg.id, mode: msg.mode });
  else if (msg.type === "mc-start-chat") handleStartChat({ prompt: msg.prompt, role: msg.role });
}

onMounted(() => window.addEventListener("message", onWindowMessage));

onBeforeUnmount(() => {
  clearRefresh();
  closeSearchPort();
  changeUnsub?.();
  changeUnsub = null;
  window.removeEventListener("message", onWindowMessage);
});
</script>

<style scoped>
.custom-view-container {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: white;
  overflow: hidden;
}

.custom-view-message {
  padding: 1rem;
  font-size: 0.875rem;
  color: #64748b;
}

[role="alert"].custom-view-message {
  color: #b71c1c;
}
</style>
