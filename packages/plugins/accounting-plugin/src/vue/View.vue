<template>
  <!-- Full <AccountingApp> mounted via the openBook tool result.
       Talks to /api/accounting directly for browse / form ops; only
       the entry gate (this mount) runs through the LLM. Pub/sub
       refetches keep multi-tab / sibling-window views in sync. -->
  <div class="h-full bg-white flex flex-col" data-testid="accounting-app">
    <NewBookForm v-if="showFirstRunForm" first-run full-page @created="onFirstBookCreated" />
    <template v-else>
      <header class="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-100 shrink-0">
        <div class="flex items-center gap-2 min-w-0">
          <span class="material-icons text-gray-600">account_balance</span>
          <h2 class="text-lg font-semibold text-gray-800">{{ t("pluginAccounting.title") }}</h2>
        </div>
        <BookSwitcher
          v-if="initialLoadDone"
          :model-value="activeBookId ?? ''"
          :books="books"
          @update:model-value="onBookSelected"
          @books-changed="refetchBooks"
          @book-created="onBookCreated"
        />
      </header>
      <nav class="flex items-center gap-0.5 px-3 py-1.5 border-b border-gray-100 shrink-0 overflow-x-auto" data-testid="accounting-tabs">
        <button
          v-for="tab in visibleTabs"
          :key="tab.key"
          :class="[
            'h-8 px-2.5 flex items-center gap-1 rounded text-sm whitespace-nowrap',
            deletedNoticeName !== null
              ? 'text-gray-400 cursor-not-allowed'
              : currentTab === tab.key
                ? 'bg-blue-50 text-blue-600 font-medium'
                : 'text-gray-600 hover:bg-gray-50',
          ]"
          :data-testid="`accounting-tab-${tab.key}`"
          :disabled="deletedNoticeName !== null"
          @click="currentTab = tab.key"
        >
          <span class="material-icons text-base">{{ tab.icon }}</span>
          <span>{{ t(tab.labelKey) }}</span>
        </button>
      </nav>
      <main class="flex-1 overflow-auto p-4">
        <div
          v-if="deletedNoticeName !== null"
          class="text-center text-sm text-gray-600 flex flex-col gap-2 items-center justify-center h-full"
          data-testid="accounting-deleted-notice"
        >
          <span class="material-icons text-gray-400" style="font-size: 48px">delete_outline</span>
          <p class="font-medium" data-testid="accounting-deleted-notice-title">
            {{ t("pluginAccounting.deletedNotice.title", { bookName: deletedNoticeName }) }}
          </p>
          <p class="text-xs text-gray-500">{{ t("pluginAccounting.deletedNotice.body") }}</p>
        </div>
        <p v-else-if="loadingBooks && !initialLoadDone" class="text-sm text-gray-400">{{ t("pluginAccounting.common.loading") }}</p>
        <p v-else-if="bookLoadError" class="text-sm text-red-500" data-testid="accounting-load-error">
          {{ t("pluginAccounting.common.error", { error: bookLoadError }) }}
        </p>
        <p v-else-if="!activeBookId" class="text-sm text-gray-500" data-testid="accounting-no-book">{{ t("pluginAccounting.noBook") }}</p>
        <template v-else-if="activeBookId">
          <JournalList
            v-if="currentTab === 'journal'"
            :book-id="activeBookId"
            :accounts="accounts"
            :currency="activeCurrency"
            :country="activeCountry"
            :version="bookVersion"
            :fiscal-year-end="activeFiscalYearEnd"
            :opening-date="activeOpeningDate"
            :preselect-entry-id="journalPreselectEntryId"
            @edit-opening="currentTab = 'opening'"
            @preselect-consumed="journalPreselectEntryId = undefined"
          />
          <OpeningBalancesForm
            v-else-if="currentTab === 'opening'"
            :book-id="activeBookId"
            :accounts="accounts"
            :currency="activeCurrency"
            :version="bookVersion"
            @submitted="onEntrySubmitted"
          />
          <AccountsList v-else-if="currentTab === 'accounts'" :book-id="activeBookId" :accounts="accounts" @select-account="onAccountSelected" />
          <Ledger
            v-else-if="currentTab === 'ledger'"
            :book-id="activeBookId"
            :accounts="accounts"
            :currency="activeCurrency"
            :version="bookVersion"
            :fiscal-year-end="activeFiscalYearEnd"
            :opening-date="activeOpeningDate"
            :preselect-account-code="ledgerPreselectAccountCode"
          />
          <BalanceSheet
            v-else-if="currentTab === 'balanceSheet'"
            :book-id="activeBookId"
            :currency="activeCurrency"
            :version="bookVersion"
            @select-account="onAccountSelected"
          />
          <ProfitLoss
            v-else-if="currentTab === 'profitLoss'"
            :book-id="activeBookId"
            :currency="activeCurrency"
            :version="bookVersion"
            :fiscal-year-end="activeFiscalYearEnd"
            :opening-date="activeOpeningDate"
            @select-account="onAccountSelected"
          />
          <BookSettings
            v-else-if="currentTab === 'settings'"
            :book-id="activeBookId"
            :book-name="activeBookName"
            :currency="activeCurrency"
            :country="activeCountry"
            :fiscal-year-end="activeFiscalYearEnd"
            @deleted="onBookDeleted"
            @books-changed="refetchBooks"
          />
        </template>
      </main>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAccountingI18n } from "./lang";
import type { ToolResultComplete } from "gui-chat-protocol/vue";
import BookSwitcher from "./components/BookSwitcher.vue";
import NewBookForm from "./components/NewBookForm.vue";
import JournalList from "./components/JournalList.vue";
import OpeningBalancesForm from "./components/OpeningBalancesForm.vue";
import AccountsList from "./components/AccountsList.vue";
import Ledger from "./components/Ledger.vue";
import BalanceSheet from "./components/BalanceSheet.vue";
import ProfitLoss from "./components/ProfitLoss.vue";
import BookSettings from "./components/BookSettings.vue";
import { provideAccountingApi, type Account, type BookSummary } from "./api";
import { useProjectScope } from "./treeHost";
import { ACCOUNTING_ACTIONS } from "../shared";
import { useAccountingChannel, useAccountingBooksChannel } from "./useAccountingChannel";
import { errorMessage } from "../shared/errors";

const { t } = useAccountingI18n();

interface AccountingAppPayload {
  kind?: string;
  bookId?: string;
  initialTab?: string;
  /** Dispatch verb stamped onto every accounting tool-result envelope
   *  (server/api/routes/accounting.ts dispatch()). We read it here to
   *  pick the canvas tab + journal preselect for each PREVIEW action. */
  action?: string;
  /** Present on `addEntries` envelopes — the freshly-built journal
   *  entries returned by the service. Each carries a server-stamped
   *  `id` we use to highlight the row in JournalList. */
  entries?: { id?: string }[];
  /** The host's opaque project id, stamped by the server on the
   *  envelope that opened this card — `null` meaning the default root.
   *  It pins the card to the project it was opened for; see `cardScope`
   *  below. */
  scope?: string | null;
  /** Present on `voidEntry` envelopes — the kind="void-marker" row
   *  posted alongside the reversing entry. We surface this row (not
   *  the reverseEntry) because the marker is the visual "this entry
   *  was voided here" indicator the user is looking for. */
  markerEntry?: { id?: string };
}

const props = defineProps<{ selectedResult?: ToolResultComplete<AccountingAppPayload, AccountingAppPayload> }>();

const TAB_KEYS = ["journal", "opening", "accounts", "ledger", "balanceSheet", "profitLoss", "settings"] as const;
type TabKey = (typeof TAB_KEYS)[number];

interface TabDef {
  key: TabKey;
  icon: string;
  labelKey: string;
}

const TABS: readonly TabDef[] = [
  { key: "journal", icon: "list", labelKey: "pluginAccounting.tabs.journal" },
  { key: "opening", icon: "play_arrow", labelKey: "pluginAccounting.tabs.opening" },
  { key: "accounts", icon: "list_alt", labelKey: "pluginAccounting.tabs.accounts" },
  { key: "ledger", icon: "menu_book", labelKey: "pluginAccounting.tabs.ledger" },
  { key: "balanceSheet", icon: "balance", labelKey: "pluginAccounting.tabs.balanceSheet" },
  { key: "profitLoss", icon: "trending_up", labelKey: "pluginAccounting.tabs.profitLoss" },
  { key: "settings", icon: "settings", labelKey: "pluginAccounting.tabs.settings" },
];

function isTabKey(value: string | undefined): value is TabKey {
  return TAB_KEYS.some((key) => key === value);
}

const initialPayload = computed<AccountingAppPayload>(() => props.selectedResult?.data ?? props.selectedResult?.jsonData ?? {});

// The project this card belongs to — taken from the ENVELOPE that
// opened it, not from whatever the host considers active. A multi-root
// host can change its active project while this card stays open, and
// following that would silently repoint the card's reads and writes at
// another project's books under the same bookId.
//
// PRESENCE, not truthiness: `null` is a real scope (the host's default
// root) and binds like any other. Only a genuinely absent field — a
// host that declared no scoping, or a card made before the server
// stamped it — falls back to what the host considers active, which on a
// single-root host is always `null` anyway.
// The fallback is the provided host's project when a host bound this card to another server.
const fallbackScope = useProjectScope();
const cardScope = computed<string | null>(() => {
  const payload = initialPayload.value;
  return "scope" in payload ? (payload.scope ?? null) : fallbackScope();
});
// Binds every child component's api client to that project too, and
// follows the card this View is showing: `selectedResult` can be
// retargeted at another result without remounting.
const api = provideAccountingApi(() => cardScope.value);
const initialTab = computed<TabKey>(() => (isTabKey(initialPayload.value.initialTab) ? initialPayload.value.initialTab : "journal"));

const currentTab = ref<TabKey>(initialTab.value);
const books = ref<BookSummary[]>([]);
const activeBookId = ref<string | null>(null);
const accounts = ref<Account[]>([]);
const loadingBooks = ref(true);
// Sticky once the first books fetch lands. Lets the BookSwitcher stay
// mounted across subsequent refetches (delete, create, pubsub-driven)
// so the user sees the dropdown smoothly update its selection rather
// than having the whole component flash in and out via `v-if`.
const initialLoadDone = ref(false);
// First-run flow: when the user opens the app on a fresh
// workspace (zero books), we render NewBookForm in full-page
// mode in place of the regular chrome (header + tabs + main),
// so the user MUST pick a name + currency before proceeding —
// no popup, no dismiss. Distinct from the modal opened via
// BookSwitcher's "+ New book" sentinel option, which reuses the
// same component but with the overlay layout.
const showFirstRunForm = ref(false);
const firstRunHandled = ref(false);
// Distinct from "books is empty" so we don't show the "+ New
// book" CTA when the real problem is a transport / server failure
// fetching the list.
const bookLoadError = ref<string | null>(null);
// Tracks whether the active book has an opening entry on file.
// `null` = unknown / loading; the gate only activates on an
// explicit `false` so we don't disable tabs during the cold load
// while the first getOpeningBalances request is still in flight.
const hasOpening = ref<boolean | null>(null);
// Date of the active book's opening entry, plumbed down to the
// DateRangePicker via the children so "All" can resolve to
// (openingDate → today). `undefined` while loading / for books
// without an opening on file (the opening gate prevents any tab
// that would care from being shown in that state).
const activeOpeningDate = ref<string | undefined>(undefined);
// Special "you just deleted this book" UI state. When set to a
// non-null book name, the entire tab strip + main content are
// replaced by an explicit "<book> has been deleted — pick another
// from the dropdown" panel. Cleared the moment the user picks a
// book from the BookSwitcher (or creates a new one). The View does
// NOT auto-route to books[0] because that hides the fact that the
// previously-active book is gone — issue #1126 (1) calls this
// experience "very confusing".
const deletedNoticeName = ref<string | null>(null);

const activeBook = computed(() => books.value.find((book) => book.id === activeBookId.value) ?? null);
const activeBookName = computed(() => activeBook.value?.name ?? "");
const activeCurrency = computed(() => activeBook.value?.currency ?? "USD");
const activeCountry = computed(() => activeBook.value?.country);
const activeFiscalYearEnd = computed(() => activeBook.value?.fiscalYearEnd);

// Single sync signal: every mutating service function publishes on
// the accounting book channel after its write, so the sender's own
// SSE round-trip drives the table/report refetch. No parallel
// localVersion bump — it only ever fired the same watchers a second
// time in the same tick.
const { version: bookVersion } = useAccountingChannel(activeBookId, undefined, () => cardScope.value);
useAccountingBooksChannel(
  () => void refetchBooks(),
  () => cardScope.value,
);

function pickInitialBookId(): string | null {
  // Priority: explicit `initialPayload.bookId` (carried in the
  // tool-result envelope by openBook / createBook / addEntries / …) →
  // first book in the list → null (empty workspace). The candidate
  // is validated against the live book list so a stale id from a
  // deleted book doesn't poison the View.
  const [firstBook] = books.value;
  if (!firstBook) return null;
  const requested = initialPayload.value.bookId;
  if (requested && books.value.some((book) => book.id === requested)) return requested;
  return firstBook.id;
}

async function refetchBooks(): Promise<void> {
  loadingBooks.value = true;
  bookLoadError.value = null;
  // Capture the current active book BEFORE the fetch so we can
  // surface its name in the deleted-notice panel if the fetch
  // reveals it's gone. Without this snapshot, an SSE-driven refetch
  // racing ahead of the local deleteBook HTTP response would resolve
  // with `activeBook` already pointing at a now-stale entry.
  const previousActive = activeBook.value;
  try {
    const result = await api.getBooks();
    if (!result.ok) {
      // Surface load failures as a distinct error state so the user
      // doesn't see "No books yet" (and the auto-open modal) when
      // the real cause is a transport / server problem.
      bookLoadError.value = result.error;
      return;
    }
    books.value = result.data.books;
    // Sticky-true once a successful fetch lands. Setting it here (in
    // the success branch) rather than in `finally` means a first-load
    // transport / 5xx failure leaves BookSwitcher hidden — the user
    // sees only the `accounting-load-error` message rather than an
    // empty dropdown with a live "+ New book" path that has nothing
    // to fall back on.
    initialLoadDone.value = true;
    // While the deleted-notice panel is already up, leave activeBookId
    // alone — the user has to pick the next book themselves via
    // the BookSwitcher (and onBookSelected then clears the notice).
    // Otherwise pickInitialBookId would silently re-select books[0]
    // and undo the entire deletion-state UX.
    if (deletedNoticeName.value === null) {
      const stillExists = activeBookId.value !== null && books.value.some((book) => book.id === activeBookId.value);
      if (!stillExists) {
        // The active book just disappeared from the server's list.
        // Race-source possibilities, all converging here:
        //   • local deleteBook → publishBooksChanged → SSE arrives
        //     before the HTTP response handler can call onBookDeleted;
        //   • a sibling tab / LLM tool deleted the book out-of-band.
        // In all cases the user needs to know what happened — show
        // the deleted-notice panel keyed off the previously-active
        // book's name, rather than silently snapping to books[0].
        // Falls back to the previous pickInitialBookId behaviour only
        // when there was no active book to lose (cold start).
        if (previousActive) {
          activeBookId.value = null;
          deletedNoticeName.value = previousActive.name;
        } else {
          activeBookId.value = pickInitialBookId();
        }
      }
    }
    // Auto-open the New Book modal exactly once on first arrival
    // when the workspace is empty. After that, the user can still
    // open it manually via the "+ New book" button.
    if (!firstRunHandled.value && books.value.length === 0) {
      firstRunHandled.value = true;
      showFirstRunForm.value = true;
    }
  } catch (err) {
    bookLoadError.value = errorMessage(err);
  } finally {
    loadingBooks.value = false;
  }
}

async function onFirstBookCreated(book: BookSummary): Promise<void> {
  showFirstRunForm.value = false;
  await refetchBooks();
  activeBookId.value = book.id;
}

// Optimistically insert the new book and set the selection
// BEFORE the refetch round-trip. Two reasons this beats the
// previous await-refetch-then-select shape:
//   1. The pubsub handler `useAccountingBooksChannel` fires its
//      own concurrent `refetchBooks` the instant the server
//      publishes books-changed. With await-then-select, that
//      concurrent refetch's stillExists guard reads the OLD
//      activeBookId (we haven't updated it yet) and — because
//      OLD is still in the books list — leaves the selection
//      pointing at OLD. Our update lands AFTER, but BookSwitcher
//      remounts under `v-if="!loadingBooks"` mid-flight, so the
//      user sees the dropdown stick on OLD.
//   2. With activeBookId already set to NEW and books pre-
//      populated to include NEW, every concurrent refetch's
//      stillExists check passes for NEW and leaves the selection
//      alone — order-independent by construction.
async function onBookCreated(book: BookSummary): Promise<void> {
  if (!books.value.some((existing) => existing.id === book.id)) {
    books.value = [...books.value, book];
  }
  activeBookId.value = book.id;
  // Creating a new book is also the "exit" out of the deleted-notice
  // panel — the user explicitly chose the new book, so re-enable the
  // tab strip and let the opening-gate watcher route them to Opening.
  deletedNoticeName.value = null;
  // currentTab may be on "settings" (the user opened the create
  // modal from there) — reset to journal so the openingGateActive
  // watcher's "if (currentTab.value === 'opening') return" gate
  // doesn't strand the user on settings while the gate is active.
  currentTab.value = "journal";
  await refetchBooks();
}

async function refetchAccounts(): Promise<void> {
  if (!activeBookId.value) {
    accounts.value = [];
    return;
  }
  const result = await api.getAccounts(activeBookId.value);
  if (!result.ok) return;
  accounts.value = result.data.accounts;
}

async function refetchOpening(): Promise<void> {
  if (!activeBookId.value) {
    hasOpening.value = null;
    activeOpeningDate.value = undefined;
    return;
  }
  const result = await api.getOpeningBalances(activeBookId.value);
  if (!result.ok) return;
  hasOpening.value = result.data.opening !== null;
  activeOpeningDate.value = result.data.opening?.date;
}

// A book without an opening on file is in "gated" mode: the user
// must save an opening (empty is fine — see OpeningBalancesForm)
// before journal / report tabs unlock. Settings stays accessible
// so the user can delete the book if they don't want to proceed.
const openingGateActive = computed(() => activeBookId.value !== null && hasOpening.value === false);

// Gated → only Opening + Settings render in the strip. Ungated →
// Opening hides itself; users reach the form via the Edit button
// on the active opening row in the journal, which transiently
// switches `currentTab` to "opening" (kept visible while there).
const visibleTabs = computed<readonly TabDef[]>(() => {
  if (openingGateActive.value) return TABS.filter((tab) => tab.key === "opening" || tab.key === "settings");
  return TABS.filter((tab) => tab.key !== "opening" || currentTab.value === "opening");
});

function onBookSelected(bookId: string): void {
  activeBookId.value = bookId;
  // Picking a book from the dropdown is the explicit "I'm done
  // looking at the deleted notice" exit. Clear it so the tab strip
  // re-enables for the freshly selected book.
  deletedNoticeName.value = null;
}

// Entry id to surface in JournalList after an `addEntries` tool
// result lands — the LLM just posted a journal entry and we want
// the user's eye on the new row. Multi-entry batches highlight the
// LAST entry only (matches the "you ended up here" intent of a
// scroll-to-cursor).
const journalPreselectEntryId = ref<string | undefined>(undefined);

// Account preselected by the Accounts tab → click handoff. Cleared
// once the user picks a different account from the Ledger's own
// dropdown so a stale preselection doesn't override later edits.
const ledgerPreselectAccountCode = ref<string | undefined>(undefined);

function onAccountSelected(code: string): void {
  // Force the ref to a fresh value even when the user clicks the
  // same account a second time — the Ledger's `watch(preselect…)`
  // ignores no-op updates, so we'd otherwise leave the user on a
  // stale Ledger state if they navigated away and clicked back.
  ledgerPreselectAccountCode.value = undefined;
  Promise.resolve().then(() => {
    ledgerPreselectAccountCode.value = code;
  });
  currentTab.value = "ledger";
}

function onEntrySubmitted(): void {
  // After saving an opening, switch to the journal so the user
  // immediately sees the unlocked tabs. The server-side
  // publishBookChange triggers the bookVersion watcher over SSE,
  // which refetches hasOpening, so the gate auto-lifts shortly after
  // the tab switch — no manual unlock needed here. Normal entries
  // are now posted from the inline form inside JournalList; that
  // form drives its own dismissal and the journal repaints in
  // place.
  if (currentTab.value === "opening") {
    currentTab.value = "journal";
  }
}

async function onBookDeleted(deletedName: string): Promise<void> {
  // Reset the tab BEFORE awaiting so a fast delete-then-create
  // can't race: if the new book's gate engages while we're still
  // awaiting refetchBooks, the gate watcher needs to see a
  // non-"settings" currentTab to route the user to Opening.
  currentTab.value = "journal";
  // Drop the active selection so refetchBooks doesn't auto-pick
  // books[0] — the user should see the deleted-notice panel and
  // explicitly switch via the BookSwitcher rather than be silently
  // moved to a different book (issue #1126).
  activeBookId.value = null;
  deletedNoticeName.value = deletedName;
  await refetchBooks();
}

// Refetch the chart of accounts whenever the active book changes
// or any pub/sub / child action bumps bookVersion (e.g. an
// upsertAccount from the Manage Accounts modal, or an LLM-driven
// upsert in another tab). The list is small JSON; the cost of
// over-fetching on entry / void / opening events is negligible
// against the staleness bug it removes.
watch(
  () => [activeBookId.value, bookVersion.value],
  () => {
    if (activeBookId.value) void refetchAccounts();
  },
  { immediate: true },
);

// Drop any leftover Accounts → Ledger preselection when the active
// book changes. Without this, picking account "1000" in book A's
// Accounts tab and then switching to book B would carry the hint
// across, so book B's Ledger would auto-select "1000" (which may
// be an unrelated account in B's chart, or absent entirely).
watch(activeBookId, () => {
  ledgerPreselectAccountCode.value = undefined;
});

// Stash a target bookId that we want to land on but haven't been
// able to apply yet (book not in `books` at the moment the
// tool-result fired). Cleared as soon as the books list catches up.
const pendingTargetBookId = ref<string | null>(null);

function applyTargetBookId(target: string): void {
  if (books.value.some((book) => book.id === target)) {
    activeBookId.value = target;
    pendingTargetBookId.value = null;
    return;
  }
  pendingTargetBookId.value = target;
}

// When the selected tool-result changes (user clicks a different
// preview card in the sidebar), follow the new result's bookId so
// the canvas lands on the book that action just touched. Skipped
// when the new result has no bookId (silent reads / actions that
// don't carry one). When the target isn't in `books` yet — common
// race after a fresh `createBook → openBook(bookId)` handoff where
// the result envelope arrives before refetchBooks completes — the
// id is stashed and applied by the books watcher below as soon as
// the list catches up.
watch(
  () => initialPayload.value.bookId,
  (next) => {
    if (!next) return;
    applyTargetBookId(next);
  },
);

// Drains the pending target once `books` includes it (typically
// after a pub/sub-driven refetch resolves the createBook write).
// No-op when nothing is pending or the target is still missing.
watch(books, () => {
  const pending = pendingTargetBookId.value;
  if (pending) applyTargetBookId(pending);
});

// Map a PREVIEW action to the canvas tab the user should land on.
// Honours an explicit `initialTab` from the envelope (the LLM's
// stated intent) over the action-default below — only `openBook`
// currently ships initialTab, but the override is plugin-wide.
//
// The `balanceSheet` default for openBook / createBook /
// setOpeningBalances assumes the book has an opening on file. For a
// fresh book without one, the existing `openingGateActive` watcher
// redirects to "opening" — we don't try to short-circuit that here
// because hasOpening hasn't necessarily resolved when this runs.
function pickTabForAction(payload: AccountingAppPayload): TabKey | null {
  if (isTabKey(payload.initialTab)) return payload.initialTab;
  switch (payload.action) {
    case ACCOUNTING_ACTIONS.addEntries:
    case ACCOUNTING_ACTIONS.voidEntry:
      return "journal";
    case ACCOUNTING_ACTIONS.upsertAccount:
      return "accounts";
    case ACCOUNTING_ACTIONS.updateBook:
      return "settings";
    case ACCOUNTING_ACTIONS.openBook:
    case ACCOUNTING_ACTIONS.createBook:
    case ACCOUNTING_ACTIONS.setOpeningBalances:
      return "balanceSheet";
    default:
      return null;
  }
}

// For tool results that should auto-expand a row in JournalList,
// derive the entry id from the action's payload. addEntries picks
// the LAST entry in the batch ("you ended up here" cursor); voidEntry
// picks the void-MARKER (the visual "voided here" indicator), not
// the reversing entry.
function pickJournalPreselectId(payload: AccountingAppPayload): string | undefined {
  if (payload.action === ACCOUNTING_ACTIONS.addEntries) {
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    return entries[entries.length - 1]?.id;
  }
  if (payload.action === ACCOUNTING_ACTIONS.voidEntry) {
    return payload.markerEntry?.id;
  }
  return undefined;
}

// Drive canvas tab + journal preselect from the active tool-result
// envelope. The route handler stamps `data: { action, bookId, … }`
// onto every PREVIEW action's response (server/api/routes/
// accounting.ts dispatch + PREVIEW_ACTIONS). `immediate: true` so a
// cold open with the result already selected (e.g., reload after
// the LLM dispatched) routes to the right surface too.
//
// Preselect is *always* assigned (not `if (preselect)`) so a
// subsequent non-addEntries/voidEntry tool result clears any stale
// id left over from a prior addEntries the user has already seen —
// otherwise the next JournalList remount would replay it. The child
// also emits `preselectConsumed` after expanding for the same
// reason.
watch(
  () => initialPayload.value,
  (payload) => {
    const targetTab = pickTabForAction(payload);
    if (targetTab) currentTab.value = targetTab;
    journalPreselectEntryId.value = pickJournalPreselectId(payload);
  },
  { immediate: true },
);

// Drop the journal preselect on a real book SWITCH — leftover ids
// from the prior book don't exist in the new one. The cold-load
// transition (null → bookId) doesn't qualify: refetchBooks resolves
// activeBookId asynchronously and would otherwise clobber a
// preselect the addEntries watcher just set on initial mount.
watch(activeBookId, (_next, prev) => {
  if (!prev) return;
  journalPreselectEntryId.value = undefined;
});

// Refetch the opening status whenever the active book changes or
// any pub/sub / child action bumps bookVersion (e.g. an opening
// got saved or voided). Clears hasOpening when the book goes null
// so a stale "true" doesn't carry over between books.
watch(
  () => [activeBookId.value, bookVersion.value],
  () => void refetchOpening(),
  { immediate: true },
);

// Force-route to the Opening tab whenever the gate engages.
// Other tabs are hidden from the strip while gated, but this
// watcher handles the programmatic case where currentTab still
// points at a now-hidden tab (book switch, initial mount with a
// no-opening book, LLM-supplied initialTab pointing at a gated
// tab, or fresh-book creation right after deleting from the
// settings tab) — without it, `<main>` would render nothing or
// the user would be stranded on the prior book's settings view.
// We don't exempt "settings" here: the user can still click back
// to it from the (gated) tab strip if they want to delete the
// new book instead of setting it up.
watch(openingGateActive, (active) => {
  if (!active) return;
  if (currentTab.value === "opening") return;
  currentTab.value = "opening";
});

void refetchBooks();
</script>
