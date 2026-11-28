// Subscribe to per-book accounting events.
//
// Returns a `version` ref that bumps every time the server publishes a
// change for the given bookId — addEntries, voidEntry,
// setOpeningBalances, upsertAccount, snapshot rebuild completion. View
// components watch `version` to drive `refetch` calls.
//
// `bookId` is reactive: switching the active book in BookSwitcher
// flips it; the composable unsubscribes from the old channel and
// subscribes to the new one.
//
// `onPayload` is an optional fine-grained hook for callers that want to
// inspect the event kind (e.g. show a "rebuilding…" indicator on
// `kind: "snapshots-rebuilding"`).
//
// The raw pub/sub transport is host-injected via `hostSubscribe`, or per tree via `provideAccountingHost`
// (see hostContext.ts) — the channel NAMES come from this package's
// own `./shared` so publisher and subscriber stay in lockstep.

import { computed, ref, watch, onUnmounted, type Ref } from "vue";
import { bookChannel, booksChannel, BOOK_EVENT_KINDS, type BookChannelPayload } from "../shared";
import { useAccountingHost, useProjectScope } from "./treeHost";

const BOOK_EVENT_KIND_VALUES = Object.values(BOOK_EVENT_KINDS);

/** The host hands subscribers an `unknown`, so rebuild the payload from
 *  the fields we can prove rather than trusting the publisher's type. */
function toBookChannelPayload(data: unknown): BookChannelPayload | null {
  if (typeof data !== "object" || data === null || !("kind" in data)) return null;
  const kind = BOOK_EVENT_KIND_VALUES.find((candidate) => candidate === data.kind);
  if (kind === undefined) return null;
  const period = "period" in data && typeof data.period === "string" ? data.period : undefined;
  return period === undefined ? { kind } : { kind, period };
}

export interface UseAccountingChannelReturn {
  /** Bumps on every per-book event for the current bookId. Resets to
   *  0 when bookId changes. */
  version: Ref<number>;
}

/** The project a subscription belongs to: a fixed value, a getter for
 *  one that can change (the selected card's), or omitted to follow
 *  whatever project the host currently considers active. */
export type AccountingChannelScope = string | null | (() => string | null);

/** Resolves the scope REACTIVELY, so a subscription re-binds instead of
 *  sitting on a channel that stopped being the caller's. A host whose
 *  `projectScope` getter reads reactive state gets that for free on the
 *  host-following path too; one that does not simply never changes. */
function resolveScope(scope: AccountingChannelScope | undefined): Ref<string | null> {
  const fallback = useProjectScope();
  return computed(() => (scope === undefined ? fallback() : typeof scope === "function" ? scope() : scope));
}

/** `scope` binds the subscription to one project — pass the scope the
 *  surface was opened for. Omit it and the channel follows whatever
 *  project the host currently considers active, which is right for a
 *  surface the host itself scopes and always `null` on a single-root
 *  host. */
export function useAccountingChannel(
  bookId: Ref<string | null>,
  onPayload?: (payload: BookChannelPayload) => void,
  scope?: AccountingChannelScope,
): UseAccountingChannelReturn {
  const channelScope = resolveScope(scope);
  const { subscribe } = useAccountingHost();
  const version = ref(0);
  let unsubscribe: (() => void) | null = null;

  function bind(nextBookId: string | null): void {
    unsubscribe?.();
    unsubscribe = null;
    version.value = 0;
    if (!nextBookId) return;
    // Scoped by the host's opaque project id (null for a single-root
    // host, which keeps the name `accounting:<bookId>`): a bookId is
    // unique within a root, so without it a write in one project would
    // refresh an open view of the same-named book in another.
    unsubscribe = subscribe(bookChannel(nextBookId, channelScope.value), (data) => {
      version.value += 1;
      const event = toBookChannelPayload(data);
      if (event) onPayload?.(event);
    });
  }

  // The scope is watched alongside the book: a card retargeted at
  // another project must leave the old project's channel, not keep
  // receiving its events under the same bookId.
  watch([bookId, channelScope], ([nextBookId]) => bind(nextBookId), { immediate: true });
  onUnmounted(() => {
    unsubscribe?.();
    unsubscribe = null;
  });
  return { version };
}

/** Subscribe to "the list of books changed" events. Use in
 *  BookSwitcher.vue to refetch the dropdown contents when a sibling
 *  tab adds / deletes a book. Re-binds on a scope change, like
 *  `useAccountingChannel`. */
export function useAccountingBooksChannel(onChange: () => void, scope?: AccountingChannelScope): void {
  const channelScope = resolveScope(scope);
  const { subscribe } = useAccountingHost();
  let unsubscribe: (() => void) | null = null;
  watch(
    channelScope,
    (nextScope) => {
      unsubscribe?.();
      unsubscribe = subscribe(booksChannel(nextScope), onChange);
    },
    { immediate: true },
  );
  onUnmounted(() => {
    unsubscribe?.();
    unsubscribe = null;
  });
}
