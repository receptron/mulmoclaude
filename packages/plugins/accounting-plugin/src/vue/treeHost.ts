// A host's network and pub/sub for ONE component tree.
//
// `configureAccountingHost` installs one network client and one transport for
// the whole app. A host that shows a card from another server (MulmoTerminal's
// remote cells) needs that card's requests to go THERE while every other surface
// keeps the global ones, so it provides a pair around the card's subtree. Nothing
// provided, everything below resolves to the global pair, exactly as before.

import { inject, provide, type InjectionKey } from "vue";
import { hostApiCall, hostSubscribe, type AccountingApiCall, type AccountingSubscribe } from "./hostContext";

export interface AccountingTreeHost {
  apiCall: AccountingApiCall;
  subscribe: AccountingSubscribe;
}

const TREE_HOST: InjectionKey<AccountingTreeHost> = Symbol("accounting-tree-host");

const GLOBAL_HOST: AccountingTreeHost = { apiCall: hostApiCall, subscribe: hostSubscribe };

/** Send this subtree's requests and subscriptions through `host` instead of the
 *  global ones. Call from setup, ABOVE the accounting View. */
export function provideAccountingHost(host: AccountingTreeHost): void {
  provide(TREE_HOST, host);
}

/** The pair a host provided around this component, or null when none did. */
export function providedAccountingHost(): AccountingTreeHost | null {
  return inject(TREE_HOST, null);
}

/** The pair this component's requests and subscriptions go through. */
export function useAccountingHost(): AccountingTreeHost {
  return providedAccountingHost() ?? GLOBAL_HOST;
}
