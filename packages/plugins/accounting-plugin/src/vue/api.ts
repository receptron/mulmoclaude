// Typed wrapper around POST /api/accounting. Centralises the action
// names and the response shapes so the View / sub-components don't
// repeat the cast at every call site.
//
// Every helper returns `ApiResult<T>` (the discriminated union mirrored
// in hostContext.ts) — callers pattern-match on `.ok`. There is no
// separate error-throwing path; all surfaces (network, HTTP, app
// validation) flow through the same shape. The actual network client is
// host-injected (see hostContext.ts) so the package stays host-agnostic.

import { inject, provide, type InjectionKey } from "vue";

import { hostApiCall, hostProjectScope, type AccountingApiCall, type ApiResult } from "./hostContext";
import { providedAccountingHost, useAccountingHost, useProjectScope } from "./treeHost";
import {
  ACCOUNTING_ACTIONS,
  ACCOUNTING_API,
  ACCOUNTING_PROJECT_FIELD,
  type SupportedCountryCode,
  type FiscalYearEnd,
  type TimeSeriesGranularity,
  type TimeSeriesMetric,
  type Account,
  type AccountBalance,
  type AccountType,
  type BalanceSheet,
  type BalanceSheetSection,
  type BookSummary,
  type JournalEntry,
  type JournalEntryKind,
  type JournalLine,
  type Ledger,
  type LedgerRow,
  type ProfitLoss,
  type ReportPeriod,
} from "../shared";

// The domain + report shapes are single-sourced in ../shared/types.ts so
// the server and this client can't drift (see #2411). Re-exported here so
// the View / sub-components keep importing both the API function and its
// result type from this one module (`../api`).
export type {
  Account,
  AccountBalance,
  AccountType,
  BalanceSheet,
  BalanceSheetSection,
  BookSummary,
  JournalEntry,
  JournalEntryKind,
  JournalLine,
  Ledger,
  LedgerRow,
  ProfitLoss,
  ReportPeriod,
};

export interface OpenAppPayload {
  kind: "accounting-app";
  /** The host's opaque project id for the root this book lives under,
   *  stamped by the server on an `openBook` result. `null` is the
   *  default root; the field is absent only on a host that declared no
   *  scoping. A host that renders cards from more than one project keys
   *  them by `(scope, bookId)` — a bookId is unique within a root and
   *  nowhere else. */
  scope?: string | null;
  /** `null` when the workspace has zero books — the View renders the
   *  empty state and prompts for book creation. */
  bookId: string | null;
  initialTab?: string | undefined;
}

// The single dispatch route this plugin owns — shared with the server
// router via `ACCOUNTING_API` so the two can't drift.
const DISPATCH_URL = ACCOUNTING_API.dispatch.path;
const DISPATCH_METHOD = ACCOUNTING_API.dispatch.method;

export interface AddEntriesItemInput {
  date: string;
  lines: JournalLine[];
  memo?: string | undefined;
  /** When set, marks this entry as the replacement posted via the
   *  "edit" flow. The caller is expected to have voided
   *  `replacesEntryId` separately just before this call — there is
   *  no atomic transaction. */
  replacesEntryId?: string | undefined;
}

export interface TimeSeriesPoint {
  label: string;
  from: string;
  to: string;
  value: number;
}

export interface TimeSeriesInput {
  bookId: string;
  metric: TimeSeriesMetric;
  granularity: TimeSeriesGranularity;
  /** Inclusive YYYY-MM-DD lower bound. The first bucket is the one
   *  CONTAINING this date — it can extend earlier. */
  from: string;
  /** Inclusive YYYY-MM-DD upper bound. The last bucket is the one
   *  CONTAINING this date — it can extend later. */
  to: string;
  /** Required when metric === "accountBalance"; forbidden otherwise.
   *  The server returns a 400 either way. */
  accountCode?: string | undefined;
}

export interface TimeSeriesResult {
  bookId: string;
  metric: TimeSeriesMetric;
  granularity: TimeSeriesGranularity;
  from: string;
  to: string;
  accountCode?: string | undefined;
  points: TimeSeriesPoint[];
}

/** The dispatch seam every helper below is written against. */
type Call = <T>(action: string, args?: Record<string, unknown>) => Promise<ApiResult<T>>;

/** The one call every helper goes through, bound to a scope RESOLVER
 *  rather than a fixed scope, so the host-scoped client tracks a host
 *  that changes its active project while a pinned one does not. Absent
 *  (single-root host) every request body is byte-identical to what it
 *  was before scopes existed. */
function makeCall(getScope: () => string | null, apiCall: AccountingApiCall): Call {
  return function call<T>(action: string, args: Record<string, unknown> = {}): Promise<ApiResult<T>> {
    // The project rides every request, last so a caller cannot shadow it.
    const project = getScope();
    const scopeField = project ? { [ACCOUNTING_PROJECT_FIELD]: project } : {};
    return apiCall<T>(DISPATCH_URL, { method: DISPATCH_METHOD, body: { action, ...args, ...scopeField } });
  };
}

/** Books — the list and its lifecycle. */
function booksApi(call: Call) {
  function getBooks(): Promise<ApiResult<{ books: BookSummary[] }>> {
    return call(ACCOUNTING_ACTIONS.getBooks);
  }

  function createBook(input: {
    name: string;
    currency?: string | undefined;
    country?: SupportedCountryCode | undefined;
    /** Closing month 1-12 — required at the form boundary, but the
     *  server silently defaults an absent value to 12 (December). */
    fiscalYearEnd?: FiscalYearEnd | undefined;
  }): Promise<ApiResult<{ book: BookSummary }>> {
    return call(ACCOUNTING_ACTIONS.createBook, input);
  }

  function updateBook(input: {
    bookId: string;
    name?: string | undefined;
    /** Pass `""` to explicitly clear the country (server treats it as
     *  the "drop the field" sentinel). Any other value must be one of
     *  the curated `SupportedCountryCode`s. */
    country?: SupportedCountryCode | "" | undefined;
    /** Closing month 1-12 — pure metadata, only changes how the
     *  date-range shortcuts resolve. No "clear" path; absence leaves the
     *  existing value untouched. */
    fiscalYearEnd?: FiscalYearEnd | undefined;
  }): Promise<ApiResult<{ book: BookSummary }>> {
    return call(ACCOUNTING_ACTIONS.updateBook, input);
  }

  function deleteBook(bookId: string): Promise<ApiResult<{ deletedBookId: string; deletedBookName: string }>> {
    return call(ACCOUNTING_ACTIONS.deleteBook, { bookId, confirm: true });
  }

  return {
    getBooks,
    createBook,
    updateBook,
    deleteBook,
  };
}

/** The chart of accounts. */
function accountsApi(call: Call) {
  function getAccounts(bookId: string): Promise<ApiResult<{ bookId: string; accounts: Account[] }>> {
    return call(ACCOUNTING_ACTIONS.getAccounts, { bookId });
  }

  function upsertAccount(account: Account, bookId: string): Promise<ApiResult<{ bookId: string; account: Account; accounts: Account[] }>> {
    return call(ACCOUNTING_ACTIONS.upsertAccount, { account, bookId });
  }

  return {
    getAccounts,
    upsertAccount,
  };
}

/** Journal entries and the opening balance. */
function journalApi(call: Call) {
  function addEntries(input: {
    bookId: string;
    /** One or more entries to post. The server validates every entry
     *  before any write, so a single bad entry rejects the whole
     *  batch. Pass a single-element array to post just one entry. */
    entries: AddEntriesItemInput[];
  }): Promise<ApiResult<{ bookId: string; entries: JournalEntry[] }>> {
    return call(ACCOUNTING_ACTIONS.addEntries, input);
  }

  function voidEntry(input: {
    entryId: string;
    reason?: string | undefined;
    bookId: string;
  }): Promise<ApiResult<{ bookId: string; reverseEntry: JournalEntry; markerEntry: JournalEntry }>> {
    return call(ACCOUNTING_ACTIONS.voidEntry, input);
  }

  function getJournalEntries(input: {
    from?: string | undefined;
    to?: string | undefined;
    accountCode?: string | undefined;
    bookId: string;
  }): Promise<ApiResult<{ bookId: string; entries: JournalEntry[]; voidedEntryIds: string[] }>> {
    return call(ACCOUNTING_ACTIONS.getJournalEntries, input);
  }

  function getOpeningBalances(bookId: string): Promise<ApiResult<{ bookId: string; opening: JournalEntry | null }>> {
    return call(ACCOUNTING_ACTIONS.getOpeningBalances, { bookId });
  }

  function setOpeningBalances(input: {
    asOfDate: string;
    lines: JournalLine[];
    memo?: string | undefined;
    bookId: string;
  }): Promise<ApiResult<{ bookId: string; openingEntry: JournalEntry; replacedExisting: boolean }>> {
    return call(ACCOUNTING_ACTIONS.setOpeningBalances, input);
  }

  return {
    addEntries,
    voidEntry,
    getJournalEntries,
    getOpeningBalances,
    setOpeningBalances,
  };
}

/** Reports, series, and snapshot maintenance. */
function reportsApi(call: Call) {
  function getBalanceSheet(period: ReportPeriod, bookId: string): Promise<ApiResult<{ bookId: string; balanceSheet: BalanceSheet }>> {
    return call(ACCOUNTING_ACTIONS.getReport, { kind: "balance", period, bookId });
  }

  function getProfitLoss(period: ReportPeriod, bookId: string): Promise<ApiResult<{ bookId: string; profitLoss: ProfitLoss }>> {
    return call(ACCOUNTING_ACTIONS.getReport, { kind: "pl", period, bookId });
  }

  function getLedger(accountCode: string, period: ReportPeriod | undefined, bookId: string): Promise<ApiResult<{ bookId: string; ledger: Ledger }>> {
    return call(ACCOUNTING_ACTIONS.getReport, { kind: "ledger", accountCode, period, bookId });
  }

  function getTimeSeries(input: TimeSeriesInput): Promise<ApiResult<TimeSeriesResult>> {
    // Spread so the named interface is widened into a fresh object
    // literal — `call()` takes `Record<string, unknown>` which a
    // declared interface doesn't satisfy structurally in TS.
    return call(ACCOUNTING_ACTIONS.getTimeSeries, { ...input });
  }

  function rebuildSnapshots(bookId: string): Promise<ApiResult<{ bookId: string; rebuilt: string[] }>> {
    return call(ACCOUNTING_ACTIONS.rebuildSnapshots, { bookId });
  }

  return {
    getBalanceSheet,
    getProfitLoss,
    getLedger,
    getTimeSeries,
    rebuildSnapshots,
  };
}

/** Build an api client bound to ONE project scope. */
function makeApi(getScope: () => string | null, apiCall: AccountingApiCall = hostApiCall) {
  const call = makeCall(getScope, apiCall);
  return { ...booksApi(call), ...accountsApi(call), ...journalApi(call), ...reportsApi(call) };
}

/** The full accounting client surface, bound to one project. */
export type AccountingApi = ReturnType<typeof makeApi>;

/** A client pinned to one project for good — `null` meaning the host's
 *  default root. Use it for anything whose project is decided once
 *  (a card, a panel); use the tree-injected client (`useAccountingApi`)
 *  inside components. */
export function createAccountingApi(scope: string | null): AccountingApi {
  return makeApi(() => scope);
}

/** Follows whatever project the HOST currently considers active. Used
 *  by any surface mounted outside a scoped tree, and by every
 *  single-root host, where the scope is always `null`. */
const hostScopedApi = makeApi(hostProjectScope);

const API_KEY: InjectionKey<AccountingApi> = Symbol("accounting-api");

/** Bind a component tree to the project its surface belongs to.
 *
 *  A card was opened against the project its server envelope named
 *  (`OpenAppPayload.scope`). If its requests kept resolving the host's
 *  CURRENT project instead, switching projects would silently repoint
 *  an already-open card's reads and writes at another project's books —
 *  same bookId, different company. Call this once in the mounted app's
 *  setup, passing a GETTER: the surface's own scope can change when it
 *  is retargeted at another card, and the tree must follow the card it
 *  is showing rather than the one it first showed. */
export function provideAccountingApi(getScope: () => string | null): AccountingApi {
  // Through the network client a host provided around this tree, if it did.
  const api = makeApi(getScope, useAccountingHost().apiCall);
  provide(API_KEY, api);
  return api;
}

/** The api client for the surrounding tree, falling back to the
 *  host-scoped one for a surface nobody bound (a single-root host's
 *  every surface). */
export function useAccountingApi(): AccountingApi {
  const bound = inject(API_KEY, null);
  if (bound !== null) return bound;
  const host = providedAccountingHost();
  return host === null ? hostScopedApi : makeApi(useProjectScope(), host.apiCall);
}
