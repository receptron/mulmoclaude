// A host can send one card's requests and subscriptions somewhere other than the
// global client (MulmoTerminal's remote cells). These pin that a provided pair
// reaches every way the View talks to the server, and that nothing provided
// leaves every request on the global client, as before.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSSRApp, defineComponent, h, ref, type Component } from "vue";
import { renderToString } from "vue/server-renderer";

import { provideAccountingApi, useAccountingApi, type AccountingApi } from "../src/vue/api";
import { configureAccountingHost, type AccountingApiCall, type ApiResult } from "../src/vue/hostContext";
import { provideAccountingHost } from "../src/vue/treeHost";
import { useAccountingBooksChannel, useAccountingChannel } from "../src/vue/useAccountingChannel";

const calls: string[] = [];
const subscriptions: string[] = [];

const recordingCall =
  (who: string): AccountingApiCall =>
  <T>(_path: string, opts: { body?: unknown }): Promise<ApiResult<T>> => {
    calls.push(`${who}:${JSON.stringify(opts.body)}`);
    return Promise.resolve({ ok: true, data: { books: [] } as T });
  };

const recordingSubscribe =
  (who: string) =>
  (channel: string): (() => void) => {
    subscriptions.push(`${who}:${channel}`);
    return () => {};
  };

beforeEach(() => {
  calls.length = 0;
  subscriptions.length = 0;
  configureAccountingHost({ apiCall: recordingCall("global"), subscribe: recordingSubscribe("global"), localeTag: () => "en" });
});

/** What the View's tree holds once mounted: the client it bound, and the one a child reads. */
interface Captured {
  bound?: AccountingApi;
  child?: AccountingApi;
}

// The View's shape: it binds the card's project, and a child reads the client and subscribes.
function viewTree(captured: Captured, scope: string | null): Component {
  const Child = defineComponent({
    setup() {
      captured.child = useAccountingApi();
      useAccountingChannel(ref("main"), undefined, () => scope);
      useAccountingBooksChannel(
        () => {},
        () => scope,
      );
      return () => h("i");
    },
  });
  return defineComponent({
    setup() {
      captured.bound = provideAccountingApi(() => scope);
      return () => h(Child);
    },
  });
}

const withHost = (inner: Component, who: string): Component =>
  defineComponent({
    setup() {
      provideAccountingHost({ apiCall: recordingCall(who), subscribe: recordingSubscribe(who) });
      return () => h(inner);
    },
  });

describe("a tree the host provided a client for", () => {
  it("sends the View's requests and subscriptions through the provided pair", async () => {
    const captured: Captured = {};
    await renderToString(createSSRApp(withHost(viewTree(captured, null), "remote")));
    await captured.bound?.getBooks();
    await captured.child?.getBooks();
    assert.deepEqual(calls, ['remote:{"action":"getBooks"}', 'remote:{"action":"getBooks"}']);
    assert.deepEqual(subscriptions, ["remote:accounting:main", "remote:accounting:books"]);
  });

  it("keeps the card's project on the provided client", async () => {
    const captured: Captured = {};
    await renderToString(createSSRApp(withHost(viewTree(captured, "proj-a"), "remote")));
    await captured.bound?.getBooks();
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.startsWith("remote:"));
    assert.ok(calls[0]?.includes("proj-a"));
  });

  it("reaches a component outside the View's own binding", async () => {
    let read: AccountingApi | undefined;
    const Loose = defineComponent({
      setup() {
        read = useAccountingApi();
        return () => h("i");
      },
    });
    await renderToString(createSSRApp(withHost(Loose, "remote")));
    await read?.getBooks();
    assert.deepEqual(calls, ['remote:{"action":"getBooks"}']);
  });
});

describe("a tree nobody provided a client for", () => {
  it("uses the global client and transport, as before", async () => {
    const captured: Captured = {};
    await renderToString(createSSRApp(viewTree(captured, null)));
    await captured.bound?.getBooks();
    await captured.child?.getBooks();
    assert.deepEqual(calls, ['global:{"action":"getBooks"}', 'global:{"action":"getBooks"}']);
    assert.deepEqual(subscriptions, ["global:accounting:main", "global:accounting:books"]);
  });
});
