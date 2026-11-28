// A host can send one card's requests and subscriptions somewhere other than the
// global client (MulmoTerminal's remote cells). These pin that a provided pair
// reaches every way the View talks to the server, that the project a request or
// channel names comes from the provided host rather than the global one, and that
// nothing provided leaves every request on the global client, as before.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSSRApp, defineComponent, h, ref, type Component } from "vue";
import { renderToString } from "vue/server-renderer";

import { provideAccountingApi, useAccountingApi, type AccountingApi } from "../src/vue/api";
import { configureAccountingHost, type AccountingApiCall, type ApiResult } from "../src/vue/hostContext";
import { provideAccountingHost, type AccountingTreeHost } from "../src/vue/treeHost";
import { useAccountingBooksChannel, useAccountingChannel } from "../src/vue/useAccountingChannel";
import { ACCOUNTING_PROJECT_FIELD } from "../src/shared";

interface Sent {
  who: string;
  body: Record<string, unknown>;
}

const sent: Sent[] = [];
const subscriptions: string[] = [];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const recordingCall =
  (who: string): AccountingApiCall =>
  <T>(_path: string, opts: { body?: unknown }): Promise<ApiResult<T>> => {
    sent.push({ who, body: isRecord(opts.body) ? opts.body : {} });
    return Promise.resolve({ ok: true, data: { books: [] } as T });
  };

const recordingSubscribe =
  (who: string) =>
  (channel: string): (() => void) => {
    subscriptions.push(`${who}:${channel}`);
    return () => {};
  };

const configureGlobal = (projectScope: string | null): void =>
  configureAccountingHost({
    apiCall: recordingCall("global"),
    subscribe: recordingSubscribe("global"),
    localeTag: () => "en",
    projectScope: () => projectScope,
  });

beforeEach(() => {
  sent.length = 0;
  subscriptions.length = 0;
  configureGlobal(null);
});

const remoteHost = (projectScope?: string): AccountingTreeHost => ({
  apiCall: recordingCall("remote"),
  subscribe: recordingSubscribe("remote"),
  ...(projectScope === undefined ? {} : { projectScope: () => projectScope }),
});

const withHost = (inner: Component, host: AccountingTreeHost): Component =>
  defineComponent({
    setup() {
      provideAccountingHost(host);
      return () => h(inner);
    },
  });

/** A component outside any View's binding: reads the client, subscribes with no scope of its own. */
function looseReader(seen: { api?: AccountingApi }): Component {
  return defineComponent({
    setup() {
      seen.api = useAccountingApi();
      useAccountingChannel(ref("main"));
      useAccountingBooksChannel(() => {});
      return () => h("i");
    },
  });
}

/** The View's shape: it binds the card's project, and a child reads the client and subscribes. */
function viewTree(seen: { bound?: AccountingApi; child?: AccountingApi }, scope: string | null): Component {
  const Child = defineComponent({
    setup() {
      seen.child = useAccountingApi();
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
      seen.bound = provideAccountingApi(() => scope);
      return () => h(Child);
    },
  });
}

describe("a View under a provided host", () => {
  it("sends its requests and subscriptions through the provided pair", async () => {
    const seen: { bound?: AccountingApi; child?: AccountingApi } = {};
    await renderToString(createSSRApp(withHost(viewTree(seen, null), remoteHost())));
    await seen.bound?.getBooks();
    await seen.child?.getBooks();
    assert.deepEqual(sent, [
      { who: "remote", body: { action: "getBooks" } },
      { who: "remote", body: { action: "getBooks" } },
    ]);
    assert.deepEqual(subscriptions, ["remote:accounting:main", "remote:accounting:books"]);
  });

  it("keeps the card's project on the provided client", async () => {
    const seen: { bound?: AccountingApi } = {};
    await renderToString(createSSRApp(withHost(viewTree(seen, "proj-a"), remoteHost())));
    await seen.bound?.getBooks();
    assert.deepEqual(sent, [{ who: "remote", body: { action: "getBooks", [ACCOUNTING_PROJECT_FIELD]: "proj-a" } }]);
  });
});

describe("a component under a provided host that names no project", () => {
  it("names none, though the global host has an active project", async () => {
    configureGlobal("global-proj");
    const seen: { api?: AccountingApi } = {};
    await renderToString(createSSRApp(withHost(looseReader(seen), remoteHost())));
    await seen.api?.getBooks();
    assert.deepEqual(sent, [{ who: "remote", body: { action: "getBooks" } }]);
    assert.deepEqual(subscriptions, ["remote:accounting:main", "remote:accounting:books"]);
  });

  it("names the provided host's project when it has one", async () => {
    configureGlobal("global-proj");
    const seen: { api?: AccountingApi } = {};
    await renderToString(createSSRApp(withHost(looseReader(seen), remoteHost("remote-proj"))));
    await seen.api?.getBooks();
    assert.deepEqual(sent, [{ who: "remote", body: { action: "getBooks", [ACCOUNTING_PROJECT_FIELD]: "remote-proj" } }]);
    assert.deepEqual(subscriptions, ["remote:accounting:remote-proj:main", "remote:accounting:remote-proj:#books"]);
  });
});

describe("a tree nobody provided a client for", () => {
  it("uses the global client, transport and active project, as before", async () => {
    configureGlobal("global-proj");
    const seen: { api?: AccountingApi } = {};
    await renderToString(createSSRApp(looseReader(seen)));
    await seen.api?.getBooks();
    assert.deepEqual(sent, [{ who: "global", body: { action: "getBooks", [ACCOUNTING_PROJECT_FIELD]: "global-proj" } }]);
    assert.deepEqual(subscriptions, ["global:accounting:global-proj:main", "global:accounting:global-proj:#books"]);
  });

  it("sends a View's requests and subscriptions through the global pair", async () => {
    const seen: { bound?: AccountingApi; child?: AccountingApi } = {};
    await renderToString(createSSRApp(viewTree(seen, null)));
    await seen.bound?.getBooks();
    assert.deepEqual(sent, [{ who: "global", body: { action: "getBooks" } }]);
    assert.deepEqual(subscriptions, ["global:accounting:main", "global:accounting:books"]);
  });
});
