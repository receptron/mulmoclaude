// Host-provided UI capabilities the collection view layer needs but a package
// can't own: data fetching over the host's collection REST API, and the host's
// asset-URL scheme. Each host (MulmoClaude, MulmoTerminal) configures this once
// at app startup via `configureCollectionUi`; the view layer reads it through
// `collectionUi()`. Mirrors the server-side `configureCollectionHost` binding.
//
// This grows as more of the View moves into the package (navigation, chat,
// confirm, …) as components migrate.

import type { Component } from "vue";
import type { TranslateTransport } from "@mulmoclaude/core/translation/client";
import type { RemoteViewMutateRequest, RemoteViewPage, RemoteViewPageRequest } from "@mulmoclaude/core/remote-view";
// Registry Discover-catalog contract — single-sourced in core (browser-safe
// subpath) so a server-side shape change is a compile error here, not silent
// drift (#2407). Re-exported below for this plugin's own consumers.
import type { RegistryEntry, RegistrySummary, RegistryListResponse, RegistryImportResponse } from "@mulmoclaude/core/collection/registry";
import type {
  CollectionDetailResponse,
  ItemMutationResponse,
  CollectionNotifySeverity,
  CollectionsListResponse,
  CollectionOntologyResponse,
  FeedsListResponse,
  CollectionShortcutInfo,
  CollectionItem,
  CustomViewFields,
} from "@mulmoclaude/core/collection";

/** Result of a host data fetch — structurally a subset of the host's own
 *  `ApiResult` (so the host can pass `apiGet` straight through). The view layer
 *  treats `ok: false` as a skip, never throwing on one failed target. */
export type CollectionFetchResult<T> = { ok: true; data: T } | { ok: false };

/** Result of a host write (delete / create / update / action) — the normalised
 *  `ApiResult` shape, so the host passes `apiDelete`/`apiPost`/… straight through.
 *  Carries the host's error string on failure for inline display. */
export type CollectionMutationResult = { ok: true } | { ok: false; error: string };

/** Full host `ApiResult<T>` (data on success, error + HTTP status on failure) —
 *  matches the host's `ApiResult` exactly, so `apiGet`/`apiPost`/`apiPut` pass
 *  straight through. `status` lets the view distinguish 404 (not-found) from a
 *  generic failure. */
export type CollectionApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

/** A collection / item action's result, one variant per action kind:
 *  `kind: "chat"` returns the seed prompt + role for the client to start
 *  a new chat; `kind: "agent"` returns `dispatched: true` (the server
 *  launched the hidden worker itself — the client just shows the running
 *  state); `kind: "mutate"` returns `written: true` + the written record
 *  so the client can update the open panel in place. */
export type CollectionActionResult =
  | { prompt: string; role: string; dispatched?: undefined; written?: undefined }
  | { dispatched: true; prompt?: undefined; role?: undefined; written?: undefined }
  | { written: true; itemId: string; item: CollectionItem; prompt?: undefined; role?: undefined; dispatched?: undefined };

/** A collection refresh's result — counts + per-source errors. `dispatched` is
 *  true for agent ingest (a worker was launched; records update async).
 *  `chatId` is the visible worker's session (manual Refresh) so the client can
 *  open it to watch the run. */
export interface CollectionRefreshResult {
  refreshed: boolean;
  written: number;
  errors: string[];
  /** Records a `googleCalendar` sync deleted (the event was cancelled in
   *  Google). Absent for a feed refresh, which never removes records. */
  removed?: number;
  dispatched?: boolean;
  chatId?: string;
}

/** A Collection → Google Calendar push (#2598). `conflicts` and `localDeletes`
 *  are reported, never acted on: a both-sides edit would destroy one version,
 *  and a Google delete removes the event for every attendee. */
export interface CollectionPushResult {
  pushed: boolean;
  created: number;
  updated: number;
  conflicts: number;
  localDeletes: number;
  /** Of those, how many were deleted in Google too. `0` unless the collection
   *  opted in with `propagateDeletes`; optional so an older host, whose body
   *  does not carry the key, still parses (#3234). */
  deletedInGoogle?: number;
  /** Records that could not be pushed as they stand, each with its reason. */
  skipped: string[];
  /** Deletions left standing in Google, each with its reason. Apart from
   *  `skipped` because a refused deletion is not a failed push; optional so an
   *  older host, whose body does not carry the key, still parses (#3272). */
  keptInGoogle?: string[];
  errors: string[];
}

/** Scoped capability token for a sandboxed custom view (mirrors the host's mint
 *  response) — the iframe reads/writes the collection through it. */
export interface CollectionViewToken {
  token: string;
  exp: number;
  dataUrl: string;
  capabilities: string[];
  /** Schema-derived field metadata (#2169). Untyped on purpose: an older host
   *  omits it, so the consumer narrows it with `customViewFieldsFrom`. */
  fields?: unknown;
}

/** Result of fetching a custom view's HTML — status-only failure (the host
 *  attaches the global bearer; a non-2xx is surfaced as `HTTP <status>`). */
export type CollectionViewHtmlResult = { ok: true; html: string } | { ok: false; status: number };

/** Inputs the host needs to wrap a custom view's HTML into a sandboxed srcdoc
 *  (token + data URL injected, CSP applied — the host owns the CSP policy). */
export interface CollectionViewSrcdocBoot {
  slug: string;
  token: string;
  dataUrl: string;
  origin: string;
  /** Active app locale the dict was picked for (e.g. `"en"`, `"ja"`); empty
   *  when the view has no `i18n` declared or no locale block matched. The
   *  bootstrap surfaces this as `__MC_VIEW.locale`. */
  locale?: string;
  /** Host-picked, locale-filtered flat string map (vue-i18n locale-message
   *  shape). The iframe sees ONLY this locale's strings via `__MC_VIEW.dict`
   *  and the `__MC_VIEW.t(key, named?)` helper (vue-i18n-style named
   *  interpolation). Optional — when omitted, the helper falls back to the
   *  key. */
  dict?: Record<string, string>;
  /** Enum metadata from the collection schema, surfaced as `__MC_VIEW.fields`
   *  so a view's dropdowns follow `schema.json`. Optional — omitted means `{}`. */
  fields?: CustomViewFields;
}

/** Server response for `fetchRemoteView` — a mobile (`target: "mobile"`)
 *  custom view already wrapped HOST-side into its sandboxed srcdoc (CSP +
 *  postMessage bootstrap; `@mulmoclaude/core/remote-view`), exactly what the
 *  phone client receives over the command channel. `bytes` is the srcdoc's
 *  UTF-8 size, surfaced against the 1 MiB command-document budget while the
 *  user iterates on the view. */
export interface CollectionRemoteViewResult {
  view: { id: string; label: string; icon?: string; target: "mobile" };
  srcdoc: string;
  bytes: number;
}

/** Server response for `mutateRemoteView` — the applied mutate echoed back:
 *  the merged record for an update, the removed id for a delete. Mirrors the
 *  command channel's `mutateRemoteViewItem` result so the phone-frame preview
 *  and the phone client see the identical shape
 *  (plans/done/feat-remote-writable-view.md). */
export type CollectionRemoteViewMutateResult = { op: "update"; item: CollectionItem } | { op: "delete"; id: string };

/** Server response for `fetchRemoteViewItems` — one page of a mobile view's
 *  records with its declared `imageFields` already inlined as `data:` URL
 *  thumbnails host-side. `inlined` / `omitted` count how many images fit the
 *  per-page byte budget (surfaced while the user iterates on the view).
 *  Mirrors the command channel's `getRemoteViewItems` result so preview ===
 *  phone (plans/done/feat-remote-view-images.md). */
export interface CollectionRemoteViewItemsResult {
  page: RemoteViewPage;
  inlined: number;
  omitted: number;
}

/** Server response shape for `fetchViewI18n` — already locale-picked + flat.
 *  `locale === ""` means no translations were available (view has no `i18n`
 *  declared, file missing, or neither the requested locale nor `"en"` had a
 *  block). The `dict` matches the `CollectionViewSrcdocBoot.dict` shape so
 *  the host can pass it through `buildViewSrcdoc` unchanged. */
export interface CollectionViewI18nResult {
  locale: string;
  dict: Record<string, string>;
}

/** Options for the host's confirm dialog — structurally matches the host's own
 *  `ConfirmOptions`, so `confirm` can forward to `useConfirm().openConfirm`. */
export interface CollectionConfirmOptions {
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "primary" | "success" | "danger";
}

// The Discover-catalog registry contract (entry / summary / list / import
// response) is owned by `@mulmoclaude/core/collection/registry` and re-exported
// here so this plugin's consumers keep importing it from one place.
export type { RegistryEntry, RegistrySummary, RegistryListResponse, RegistryImportResponse };

export interface CollectionUi {
  /** Fetch a collection's detail (schema + records) by slug — backs both the
   *  View's own load (reads `status` for 404 → not-found) and ref/embed
   *  resolution (treats `!ok` as a skip). Replaces `apiGet(…collections.detail)`. */
  fetchCollectionDetail: (slug: string) => Promise<CollectionApiResult<CollectionDetailResponse>>;
  /** Browser-loadable URL for a file/image asset value (an html/svg artifact),
   *  or null when the value isn't a renderable asset path. Replaces
   *  `isValidFilePath` + `htmlPreviewUrlFor`/`svgPreviewUrlFor`. */
  fileAssetUrl: (value: unknown) => string | null;
  /** In-app File-Explorer route for a workspace file path (the fallback for
   *  `file` values that aren't a directly-served artifact), or null when the
   *  value isn't a valid in-workspace path. */
  fileRoutePath: (value: unknown) => string | null;
  /** Browser `<img src>` for a stored image value (a workspace file path), via
   *  the host's raw-file endpoint. Replaces the host's `resolveImageSrc`. */
  imageSrc: (imageData: string) => string;
  /** Open the host's confirm dialog; resolves true if confirmed. Replaces
   *  `useConfirm().openConfirm`. */
  confirm: (options: CollectionConfirmOptions) => Promise<boolean>;
  /** Delete a collection's custom view by id. Replaces the host's
   *  `apiDelete(API_ROUTES.collections.viewDelete)`. */
  deleteView: (slug: string, viewId: string) => Promise<CollectionMutationResult>;
  /** Mint a scoped capability token for a custom view (host: `apiPost` over
   *  `API_ROUTES.collections.viewToken`). */
  mintViewToken: (slug: string, viewId: string) => Promise<CollectionApiResult<CollectionViewToken>>;
  /** Fetch a custom view's raw HTML (host: `apiFetchRaw` over
   *  `API_ROUTES.collections.viewFile`, global bearer attached). */
  fetchViewHtml: (slug: string, viewId: string) => Promise<CollectionViewHtmlResult>;
  /** Fetch the translation dict for one custom view, already locale-picked
   *  server-side (host: `apiGet` over `API_ROUTES.collections.viewI18n`,
   *  global bearer attached). Returns `{ locale: "", dict: {} }` when the
   *  view has no `i18n` declared or the file is missing / malformed — the
   *  iframe-side `__MC_VIEW.t(key)` then echoes the key. */
  fetchViewI18n: (slug: string, viewId: string, locale: string) => Promise<CollectionApiResult<CollectionViewI18nResult>>;
  /** Fetch a mobile custom view wrapped into its sandboxed srcdoc (host:
   *  `apiGet` over `API_ROUTES.collections.remoteView`, global bearer
   *  attached) — the phone-frame preview's data source. Optional: a host
   *  without the remote-view route omits it and mobile views are hidden from
   *  the view selector (purely additive, like `subscribeChanges`). */
  fetchRemoteView?: (slug: string, viewId: string, locale: string) => Promise<CollectionApiResult<CollectionRemoteViewResult>>;
  /** Apply one update/delete requested by a mobile view, authorized by that
   *  view's declared editableFields / allowDelete and enforced host-side
   *  (`apiPost` over `API_ROUTES.collections.remoteViewMutate`, global bearer).
   *  The phone-frame preview's write channel — same builder + policy the phone
   *  client's `mutateRemoteViewItem` uses, so preview === phone. Optional +
   *  paired with `fetchRemoteView`: a host without the remote-view surface omits
   *  both. */
  mutateRemoteView?: (slug: string, viewId: string, request: RemoteViewMutateRequest) => Promise<CollectionApiResult<CollectionRemoteViewMutateResult>>;
  /** Page a mobile view's records with its declared `imageFields` inlined as
   *  `data:` URL thumbnails host-side (`apiGet` over
   *  `API_ROUTES.collections.remoteViewItems`, global bearer) — the phone-frame
   *  preview's paging source (it cannot resize/read the workspace itself, so it
   *  fetches the same host page the phone will). Optional + paired with
   *  `fetchRemoteView`. */
  fetchRemoteViewItems?: (slug: string, viewId: string, request: RemoteViewPageRequest) => Promise<CollectionApiResult<CollectionRemoteViewItemsResult>>;
  /** Wrap a custom view's HTML in a sandboxed `<iframe srcdoc>` with the token +
   *  data URL injected and the host's CSP applied. Replaces the host's
   *  `buildCustomViewSrcdoc`. */
  buildViewSrcdoc: (html: string, boot: CollectionViewSrcdocBoot) => string;

  // ── record CRUD + actions (host: api{Post,Put,Delete} over API_ROUTES.collections) ──
  /** Create a record (`apiPost` over `…collections.items`). */
  createItem: (slug: string, record: CollectionItem) => Promise<CollectionApiResult<ItemMutationResponse>>;
  /** Update a record (`apiPut` over `…collections.item`). */
  updateItem: (slug: string, itemId: string, record: CollectionItem) => Promise<CollectionApiResult<ItemMutationResponse>>;
  /** Delete a record (`apiDelete` over `…collections.item`). */
  deleteItem: (slug: string, itemId: string) => Promise<CollectionMutationResult>;
  /** Delete a whole collection (`apiDelete` over `…collections.detail`). */
  deleteCollection: (slug: string) => Promise<CollectionMutationResult>;
  /** Delete a feed via the project-scope feed-delete route (`…feeds.detail`). */
  deleteFeed: (slug: string) => Promise<CollectionMutationResult>;
  /** Run a per-record action (`apiPost` over `…collections.itemAction`).
   *  `params` carries a mutate action's mini-form values (omitted for the
   *  other kinds / param-less mutations). */
  runItemAction: (slug: string, itemId: string, actionId: string, params?: Record<string, unknown>) => Promise<CollectionApiResult<CollectionActionResult>>;
  /** Run a collection-level action (`apiPost` over `…collections.collectionAction`). */
  runCollectionAction: (slug: string, actionId: string) => Promise<CollectionApiResult<CollectionActionResult>>;
  /** Refresh a feed-backed collection (`apiPost` over `…collections.refresh`). */
  refreshCollection: (slug: string) => Promise<CollectionApiResult<CollectionRefreshResult>>;
  /** Push local records to the declared Google calendar
   *  (`apiPost` over `…collections.calendarPush`). */
  pushCalendarCollection: (slug: string) => Promise<CollectionApiResult<CollectionPushResult>>;

  // ── routing (host: the vue-router instance) ──
  /** Current route's `:slug` param (standalone page), or undefined. */
  routeSlug: () => string | undefined;
  /** Current route's `?selected=` query (deep-linked record), or undefined. */
  routeSelectedId: () => string | undefined;
  /** True when the standalone page is the feeds route (vs collections). */
  isFeedRoute: () => boolean;
  /** Set/clear the `?selected=` deep-link (router.replace, no history entry). */
  setSelectedId: (itemId: string | null) => void;
  /** Navigate to the collections / feeds index after a delete. */
  gotoIndex: (kind: "collection" | "feed") => void;
  /** Navigate to a specific collection / feed detail page (from an index card). */
  gotoDetail: (kind: "collection" | "feed", slug: string) => void;
  /** Navigate to a record in another collection — a `ref`/embed hop (the bare
   *  `<router-link>` the components used to render). A router host pushes
   *  `/collections/:slug?selected=:id`; a router-less host switches its own view
   *  state. `recordId` omitted ⇒ the "create it in that collection" target. */
  navigateToRecord: (targetSlug: string, recordId?: string) => void;
  /** Optional `href` for the same target, so router hosts keep real links
   *  (middle-click / accessibility). Router-less hosts return `undefined` and the
   *  components fall back to a plain click handler. */
  recordHref?: (targetSlug: string, recordId?: string) => string | undefined;
  /** Navigate to an arbitrary in-app host path (used by `file`-field values that
   *  link into the host's File Explorer via `fileRoutePath`). A router host does
   *  `router.push(path)`; router-less hosts that return null from `fileRoutePath`
   *  never render the link, so this can be a no-op there. */
  navigate?: (path: string) => void;

  // ── index pages (the browsable /collections + /feeds lists) ──
  /** List skill-backed collections (`apiGet` over `…collections.list`). */
  listCollections: () => Promise<CollectionApiResult<CollectionsListResponse>>;
  /** List feed-backed collections (`apiGet` over `…feeds.list`). */
  listFeeds: () => Promise<CollectionApiResult<FeedsListResponse>>;
  /** Fetch the raw workspace-ontology entries for the Map tab (`apiGet` over
   *  `…collections.ontology`); the tab builds the graph client-side via the
   *  shared `buildOntologyGraph`. Optional: a host without the route omits it
   *  and the Map tab is hidden (purely additive, like `subscribeChanges`). */
  fetchOntology?: () => Promise<CollectionApiResult<CollectionOntologyResponse>>;
  /** List the curated registry's collections for the Discover tab (`apiGet` over
   *  `…collectionsRegistry.list`). */
  listRegistry: () => Promise<CollectionApiResult<RegistryListResponse>>;
  /** Import a registry collection by author+slug. `registry` (the source
   *  registry's name from the entry the user clicked) disambiguates when more
   *  than one registry publishes the same author/slug; pass null for
   *  best-match. (`apiPost` over `…collectionsRegistry.import`). */
  importRegistry: (author: string, slug: string, registry: string | null) => Promise<CollectionApiResult<RegistryImportResponse>>;
  /** Bulk-reconcile pinned launcher shortcuts of one kind against the
   *  authoritative list — prune dead slugs, refresh stale labels
   *  (`useShortcuts().reconcile`). */
  reconcileShortcuts: (kind: "collection" | "feed", live: CollectionShortcutInfo[]) => Promise<void>;

  // ── app integration ──
  /** Start a new chat with a seed prompt + role, SENT (host:
   *  `useAppApi().startNewChat`). Backs collection/record actions, and a custom
   *  view's `__MC_VIEW.startChat` when its `views[]` entry declares
   *  `allowSendChat`. */
  startChat: (prompt: string, role: string) => void;
  /** Open a new chat with `prompt` prefilled in the composer as an editable DRAFT
   *  (NOT sent) — the user reviews / edits / sends it. Backs a custom view's
   *  `__MC_VIEW.startChat` by default, and the new-collection template cards.
   *  `role` is optional, and honoured host-side only when it names a role the
   *  host allows — known, and not a debug role. */
  startNewChatDraft: (prompt: string, role?: string) => void;
  /** The host's active i18n locale tag (e.g. "en", "ja"), read reactively — the
   *  plugin syncs its own self-contained i18n instance to it. */
  localeTag: () => string;
  /** The host's "general" role id, for chats seeded without a specific role. */
  generalRoleId: string;
  /** The host's "personal" role id (the feed-add chat seeds into it). */
  personalRoleId: string;
  /** Remove a pinned launcher shortcut for a 404'd collection/feed
   *  (`useShortcuts().unpin`). */
  unpin: (kind: "collection" | "feed", slug: string) => Promise<boolean>;
  /** Active-notification severity per record id, for accenting flagged rows/cards
   *  (`collectionNotifiedSeverities` over the host's live notifier entries). */
  notifiedSeverities: (slug: string) => Map<string, CollectionNotifySeverity>;
  /** Subscribe to server-side record changes for `slug` — fires `cb` whenever a
   *  record is created / updated / deleted by ANY writer (the agent, the UI, a
   *  feed refresh, or a host-driven `spawn` successor), so a live view can
   *  debounce-refetch. Returns an unsubscribe. Optional: a host without a
   *  pub/sub transport omits it and views fall back to manual refresh (so this
   *  is purely additive — a missing binding never breaks a view). */
  subscribeChanges?: (slug: string, cb: () => void) => () => void;

  // ── injected host component ──
  /** The host's pin/unpin toggle (couples to the host's shortcut store + is
   *  shared with other host views), rendered in the View header via
   *  `<component :is>`. Props: `kind`, `slug`, `title`, `icon`. */
  pinToggle: Component;

  // ── optional host overrides ──
  /** Where the record modal teleports. Defaults to `"body"`; a Shadow-DOM host
   *  (e.g. MulmoTerminal) points it at an in-shadow node so the injected styles
   *  still apply to the teleported modal.
   *
   *  `ShadowRoot` is in the union because that in-shadow node IS one: Vue's own
   *  `TeleportProps.to` is `string | RendererElement`, which accepts it, and the
   *  modal passes this value straight through. Without it a Shadow-DOM host — the
   *  case this option exists for — cannot satisfy the type without a cast. */
  modalTeleportTarget?: () => string | HTMLElement | ShadowRoot;
  /** Re-bind every capability to ONE project, named by the host's own opaque
   *  scope token (`PresentCollectionData.scope`). A chat card calls this with
   *  the scope it was made in, so it keeps reading that project's records even
   *  when the user moves the app to another one.
   *
   *  Optional and additive: a single-workspace host (MulmoClaude) omits it, and
   *  a card's scope — which such a host never stamps — resolves to this binding,
   *  unchanged. A multi-root host returns a binding whose requests carry the
   *  given project instead of the ambient one. The returned binding is cached
   *  per scope by the view layer, so it may be built eagerly.
   *
   *  The token is host-opaque here: the view layer only ever passes back what the
   *  host stamped. */
  withScope?: (scope: string) => CollectionUi;
  /** Translate a batch of UI strings into the active locale via the host's
   *  `/api/translation` route (host: `apiPost`, global bearer attached). The
   *  contract is host-agnostic (`@mulmoclaude/core/translation/client`); the LLM
   *  step + transport are the host's own. Optional: a host that hasn't wired the
   *  endpoint omits it and translated surfaces (e.g. the new-collection starter
   *  modal) fall back to their English source. */
  translate?: TranslateTransport;
}

let current: CollectionUi | null = null;

/** Wire the collection view layer to a host. Call once at app startup. */
export function configureCollectionUi(capabilities: CollectionUi): void {
  current = capabilities;
}

export function collectionUi(): CollectionUi {
  if (current === null) {
    throw new Error("@mulmoclaude/collection-plugin/vue: configureCollectionUi() was not called by the host");
  }
  return current;
}
