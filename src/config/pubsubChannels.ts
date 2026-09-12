// Single source of truth for every WebSocket pub/sub channel name
// the app publishes to or subscribes to. Keeping these in one file
// means:
//
//   - a rename is one edit instead of a grep-and-edit across
//     server + client
//   - typo-wise, publisher and subscriber can't drift (both import
//     the same const / factory)
//   - a new channel gets declared here first, then wired — the
//     declaration serves as a lightweight registry / audit list
//
// **Aggregator shape**: plugins that own static channels declare
// them in their `meta.ts` under `staticChannels` and the host
// auto-merges via `BUILT_IN_PLUGIN_METAS`. Channel factories
// (e.g. `bookChannel(bookId)`) stay as named exports in each
// plugin's meta.ts because their signatures are plugin-specific —
// re-exported below under the existing public names.
//
// First slice of issue #289 (item 6: pub-sub channels).

import { BUILT_IN_PLUGIN_METAS, defineHostAggregate, type BuiltInPluginMetas, type HostPluginCollision, type IntraPluginCollision } from "../plugins/metas";
import { isRecord, isUnknownArray } from "../utils/types";

/**
 * Channel for the per-session event stream. One per chat session.
 * Publishers: `server/session-store/index.ts` (tool results, status,
 * text chunks, switch-role, session_finished, …).
 * Subscribers: `src/App.vue` (one subscription per actively-viewed
 * session).
 */
export function sessionChannel(chatSessionId: string): string {
  return `session.${chatSessionId}`;
}

/**
 * Channel for "this workspace file just changed". One per workspace-
 * relative path. The path is normalised to POSIX separators so a
 * Windows publisher and a Linux subscriber agree on the channel name
 * (the workspace is per-machine, but tests, fixtures, and future
 * remote editing all benefit from a portable contract).
 *
 * Publishers: any route that writes to disk and wants the UI to
 * re-render — currently `presentHtml` (POST + PUT) and the markdown
 * `updateMarkdown` route.
 * Subscribers: `useFileChange(filePath)` — wired from
 * `presentHtml/View.vue` and `markdown/View.vue`.
 */
/** Normalise a workspace-relative path to the POSIX form used as both
 *  the `fileChannel` suffix and the `FileChannelPayload.path`. Exposed
 *  separately so publishers can share one normalised string between the
 *  channel name and the payload — keeping them in sync is the contract. */
export function toPosixWorkspacePath(workspaceRelativePath: string): string {
  // Replace backslashes too — covers both Windows (`\`) and any
  // pre-normalised mixed separators from upstream code.
  return workspaceRelativePath.split(/[\\/]/g).filter(Boolean).join("/");
}

export function fileChannel(workspaceRelativePath: string): string {
  return `file:${toPosixWorkspacePath(workspaceRelativePath)}`;
}

/**
 * Per-collection record-change channel — one per collection slug. Fires when
 * a record is created / updated / deleted, regardless of writer (the agent's
 * `manageCollection`, the UI's `/api/collections` routes, a feed refresh, or
 * a host-driven `spawn` successor). A "refetch" ping: the payload carries no
 * record bodies, just the changed ids.
 *
 * Publisher: `server/events/collection-change.ts` (bridged from the package's
 * `publishCollectionChange`, fired in `io.ts#writeItem`/`deleteItem`).
 * Subscribers: `CollectionView.vue` (debounced refetch) and
 * `CollectionCustomView.vue` (relays into the sandboxed iframe), both via the
 * host's `subscribeChanges` capability in `composables/collections/uiHost.ts`.
 */
const CHANNEL_SEPARATORS = /[/:]/;

/** A channel-name component, refused if it could spell a different channel.
 *
 *  A slug is `[a-zA-Z0-9_-]` upstream, so `app/salon/tasks` can never BE a slug
 *  — but a channel name is an identity, and an identity function that takes
 *  such a claim on trust is how a collection ends up able to name its way into
 *  another app's channel. Cheap to make true rather than inherited. */
function channelPart(value: string, field: string): string {
  if (CHANNEL_SEPARATORS.test(value)) throw new Error(`collectionChannel: ${field} "${value}" contains a channel separator`);
  return value;
}

export function collectionChannel(slug: string, aid?: string): string {
  // A collection's identity is `(root, slug)` locally and `(aid, cid)` when it
  // is shared, so the NAME alone cannot key the fan-out: a shared `tasks` in
  // one app, a shared `tasks` in another, and this workspace's own `tasks`
  // would all land here and refresh each other's open views.
  //
  // The local form is unchanged, byte for byte — MulmoClaude is one workspace,
  // so a local change never carries a root and this is the same channel it has
  // always been. A ROOT deliberately has no form here: it is an absolute path,
  // the channel name reaches the browser, and a path must not (a multi-root
  // host scopes its own fan-out; see the INVARIANT on `CollectionHost`).
  //
  // The separators are rejected rather than assumed absent (see `channelPart`).
  const name = channelPart(slug, "slug");
  const app = aid === undefined ? undefined : channelPart(aid, "app id");
  return app === undefined ? `collection:${name}` : `collection:app/${app}/${name}`;
}

/** Payload published on `collectionChannel(...)`. `ids` lists the changed
 *  record ids when known (subscribers may ignore them and refetch the whole
 *  collection); `op` is advisory. No record bodies — safe to relay into an
 *  opaque-origin custom-view iframe. */
export interface CollectionChannelPayload {
  slug: string;
  /** The shared app, when this change is about a shared collection. Absent for
   *  a collection in the workspace, which is every one MulmoClaude has today.
   *  Safe to relay: an `aid` is an id committed in a repository, not a path. */
  aid?: string;
  ids?: string[];
  op?: "upsert" | "delete";
}

/** Payload published on `fileChannel(...)`. `mtimeMs` is the post-write
 *  `fs.stat().mtimeMs`; subscribers use it both as a cache-buster and
 *  as a monotonic clock to drop out-of-order events. */
export interface FileChannelPayload {
  path: string; // workspace-relative POSIX, matches the channel suffix
  mtimeMs: number;
}

/** Payload published on `PUBSUB_CHANNELS.sessions`.
 *  - Empty `{}` for ordinary "something changed, refetch" hints
 *    (run/finish, mark-read, bookmark toggle).
 *  - `{ deletedIds }` when sessions have been hard-deleted, so
 *    subscribers can drop them from their local caches without a
 *    full refetch (cursor diffs don't carry deletions). */
export interface SessionsChannelPayload {
  deletedIds?: string[];
}

/** Read `deletedIds` out of a `PUBSUB_CHANNELS.sessions` payload that arrives
 *  as `unknown`. Malformed entries are dropped, never the whole batch — this is
 *  the only cross-tab signal that a session is gone, so one bad id must not
 *  leave every other deleted session on screen. Shared so the sidebar list and
 *  the live session map can't prune on different rules (#2365). */
export function readSessionDeletedIds(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const { deletedIds } = payload;
  if (!isUnknownArray(deletedIds)) return [];
  return deletedIds.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Per-book accounting change channels (`accounting:<bookId>`) and the
 * book-list channel (`PUBSUB_CHANNELS.accountingBooks`) are now owned
 * by `@mulmoclaude/accounting-plugin` — the channel factory + event
 * kinds live in its `./shared` surface, the publisher in `./server`,
 * and the subscriber (`useAccountingChannel`) in `./vue`. The host no
 * longer re-exports them here; only the static channel name flows
 * through the META aggregator below.
 */
// Plugin-owned static channel names auto-merged from each plugin's
// META. Mapped type preserves the literal channel string (e.g.
// `"accounting:books"`) so consumers get string-literal types.
//
// Distributive conditional types collapse the union of per-plugin
// records into an INTERSECTION so consumers see the merged shape
// (`{ accountingBooks: "..." } & { ... }`) rather than the
// per-plugin union (which TS won't let you index into safely).
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

// `Record<never, never>` (no index signature), not
// `Record<string, never>` — the latter's index signature collapses
// `keyof` of the merged intersection back to `string`, breaking
// literal-key consumers. Same trap as `PluginWorkspaceDirsContribution`.
type PluginStaticChannelsContribution<M> = M extends { readonly staticChannels: infer C } ? { readonly [K in keyof C]: C[K] } : Record<never, never>;

type PluginStaticChannelsMap<T extends BuiltInPluginMetas> = UnionToIntersection<PluginStaticChannelsContribution<T[number]>>;

const HOST_STATIC_CHANNELS = {
  /** Sidebar "a session updated, please refetch" notification.
   *  Publisher: `server/session-store/index.ts#publishSessionsChanged`.
   *  Subscribers: `useSessionHistory` (purges deletedIds from the
   *  cached list), `useSessionSync` (purges deletedIds from
   *  sessionMap; refetches summaries for live state). */
  sessions: "sessions",
  /** Server-side debug heartbeat — wired through the task-manager
   *  demo counter. Useful for sanity-checking that the WS pipe is
   *  alive end-to-end. */
  debugBeat: "debug.beat",
  /** Dev plugin (`--dev-plugin <path>`) `dist/` changed — debounced.
   *  Publisher: `server/plugins/dev-watcher.ts` after fs.watch fires.
   *  Subscriber: `src/composables/useDevPluginReload.ts` triggers
   *  `location.reload()` so the author sees their save without ⌘R.
   *  Payload: `{ name: string, changedFiles: string[], serverSideChange: boolean }`. */
  devPluginChanged: "dev-plugin-changed",
  /** Notifier state-change events (`published` / `updated` / `cleared`
   *  / `cancelled`) as a discriminated union. Single global channel;
   *  subscribers filter by `pluginPkg` client-side. Publisher:
   *  `server/notifier/engine.ts` after persistence succeeds.
   *  Payload: `NotifierEvent`. */
  notifier: "notifier",
} as const;

// First-write-wins host+plugin aggregate (see `defineHostAggregate`):
// host keys win on collision, second-claiming plugin wins are
// dropped, both diagnostic lists are exposed for boot warnings.
const PUBSUB_CHANNELS_AGGREGATE = defineHostAggregate<string, typeof HOST_STATIC_CHANNELS, PluginStaticChannelsMap<BuiltInPluginMetas>>(BUILT_IN_PLUGIN_METAS, {
  label: "PUBSUB_CHANNELS",
  hostRecord: HOST_STATIC_CHANNELS,
  extract: (meta) => meta.staticChannels,
  dimension: "staticChannels",
});
export const PUBSUB_CHANNELS_HOST_COLLISIONS: readonly HostPluginCollision[] = PUBSUB_CHANNELS_AGGREGATE.hostCollisions;
export const PUBSUB_CHANNELS_INTRA_COLLISIONS: readonly IntraPluginCollision[] = PUBSUB_CHANNELS_AGGREGATE.intraCollisions;

/** Static pub/sub channel names. Factories for parameterised channels
 *  (e.g. `sessionChannel(id)`) live alongside as named helpers. */
export const PUBSUB_CHANNELS = PUBSUB_CHANNELS_AGGREGATE.merged;

export type StaticPubSubChannel = (typeof PUBSUB_CHANNELS)[keyof typeof PUBSUB_CHANNELS];
