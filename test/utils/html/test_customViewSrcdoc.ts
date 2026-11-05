// Unit tests for the custom-view srcdoc builder (see
// plans/done/feat-collections-custom-views.md). Pure — the builder takes the
// origin explicitly, so no DOM/window is needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCustomViewSrcdoc } from "../../../src/utils/html/customViewSrcdoc.js";

const boot = {
  slug: "plans",
  token: "abc.def",
  dataUrl: "/api/collections/plans/view-data",
  origin: "http://localhost:3001",
};

describe("buildCustomViewSrcdoc", () => {
  it("injects __MC_VIEW with an absolutised dataUrl after <head>", () => {
    const out = buildCustomViewSrcdoc("<html><head><title>x</title></head><body></body></html>", boot);
    assert.match(out, /window\.__MC_VIEW=/);
    assert.match(out, /"dataUrl":"http:\/\/localhost:3001\/api\/collections\/plans\/view-data"/);
    assert.match(out, /"token":"abc\.def"/);
    assert.match(out, /"slug":"plans"/);
    // injected right after the opening head tag, before the title
    assert.ok(out.indexOf("__MC_VIEW") < out.indexOf("<title>"));
  });

  it("sets a CSP meta with connect-src = the server origin", () => {
    const out = buildCustomViewSrcdoc("<head></head>", boot);
    assert.match(out, /Content-Security-Policy/);
    assert.match(out, /connect-src http:\/\/localhost:3001/);
  });

  it("locks connect-src to the origin (the exfiltration channel) but allows CDN resource loads", () => {
    const out = buildCustomViewSrcdoc("<head></head>", boot);
    // connect-src (fetch/XHR/WebSocket/beacon) is the channel that could stream
    // the token/records to an attacker — it must be the origin only, never '*'.
    assert.match(out, /connect-src http:\/\/localhost:3001/);
    assert.ok(!/connect-src[^;]*\*/.test(out), "connect-src must not be wildcard");
    // Resource loads may use the curated CDN allowlist (charting libs, fonts) —
    // those hosts don't relay request data to attackers.
    assert.match(out, /script-src[^;]*cdn\.jsdelivr\.net/);
  });

  it("wraps a fragment that has no <head>", () => {
    const out = buildCustomViewSrcdoc("<div>hi</div>", boot);
    assert.match(out, /^<!DOCTYPE html><html><head>/);
    assert.match(out, /<body><div>hi<\/div><\/body>/);
  });

  it("escapes < in the injected JSON so a hostile value can't break out", () => {
    const out = buildCustomViewSrcdoc("<head></head>", { ...boot, token: "</script><x>" });
    assert.ok(!out.includes("</script><x>"));
    assert.match(out, /\\u003c/);
  });

  it("leaves an already-absolute dataUrl unchanged", () => {
    const out = buildCustomViewSrcdoc("<head></head>", { ...boot, dataUrl: "http://example.test/data" });
    assert.match(out, /"dataUrl":"http:\/\/example\.test\/data"/);
  });

  it("injects the onChange live-refresh bootstrap into the same script", () => {
    const out = buildCustomViewSrcdoc("<head></head>", boot);
    // The helper is defined on the existing __MC_VIEW global…
    assert.match(out, /v\.onChange=function/);
    // …and only reacts to the parent's collection-changed message.
    assert.match(out, /mc-collection-changed/);
    assert.match(out, /e\.source!==window\.parent/);
    // It lives inside the single bootstrap <script>, before the view's own code.
    assert.ok(out.indexOf("onChange") < out.indexOf("</head>"));
  });

  it("injects the openItem bridge + origin so the view can open the host modal", () => {
    const out = buildCustomViewSrcdoc("<head></head>", boot);
    // The origin is injected so openItem can target the parent frame's origin.
    assert.match(out, /"origin":"http:\/\/localhost:3001"/);
    // openItem posts an mc-open-item message up to the parent.
    assert.match(out, /v\.openItem=function/);
    assert.match(out, /mc-open-item/);
    assert.match(out, /window\.parent\.postMessage\(/);
    // Targets the known parent origin, never '*'.
    assert.ok(out.includes("},v.origin)"), "openItem must post to the parent origin, not '*'");
  });

  it("injects the startChat bridge so the view can draft a new chat", () => {
    const out = buildCustomViewSrcdoc("<head></head>", boot);
    // startChat posts an mc-start-chat message up to the parent.
    assert.match(out, /v\.startChat=function/);
    assert.match(out, /mc-start-chat/);
    // Carries the prompt (+ optional role); targets the known parent origin, never '*'.
    assert.match(out, /type:'mc-start-chat'/);
    assert.ok(out.includes("},v.origin)"), "startChat must post to the parent origin, not '*'");
  });

  it("injects the search-query channel so the host's search box can drive the view", () => {
    const out = buildCustomViewSrcdoc("<head></head>", boot);
    // Always empty in the boot JSON — the live value arrives over the port, so
    // that a keystroke never rebuilds the srcdoc (token re-mint + reload).
    assert.match(out, /"searchQuery":""/);
    assert.match(out, /mc-search-query/);
    assert.match(out, /v\.onSearchQueryChange=function/);
    // A MessageChannel, not a window post: the query is the user's own text and
    // an opaque origin can only be addressed as "*", which survives the view
    // navigating itself elsewhere.
    assert.match(out, /new MessageChannel\(\)/);
    assert.match(out, /mc-view-ready/);
  });

  it("keeps the onChange bootstrap free of a </script> breakout sequence", () => {
    const out = buildCustomViewSrcdoc("<head></head>", boot);
    // The bootstrap is inlined in a <script>; a literal </script> inside it would
    // close the tag early. The only </script> must be the intended closer.
    assert.equal(out.match(/<\/script>/gi)?.length, 1);
  });

  it("the injected bootstrap script body contains no raw < (no parser surprises)", () => {
    // Isolate the bootstrap <script>…</script> and assert its body has no `<` at
    // all — the contract that lets it be inlined safely (Sourcery suggestion).
    const out = buildCustomViewSrcdoc("<head></head>", boot);
    const body = out.slice(out.indexOf("<script>") + "<script>".length, out.indexOf("</script>"));
    assert.ok(body.length > 0);
    assert.ok(!body.includes("<"), "inlined bootstrap must not contain a raw '<'");
  });

  describe("i18n injection (vue-i18n-shaped dict + t() helper)", () => {
    it("emits __MC_VIEW.locale + __MC_VIEW.dict when the boot carries them", () => {
      const out = buildCustomViewSrcdoc("<head></head>", { ...boot, locale: "ja", dict: { hello: "こんにちは {name}", next: "次へ" } });
      assert.match(out, /"locale":"ja"/);
      assert.match(out, /"dict":\{"hello":"こんにちは \{name\}","next":"次へ"\}/);
    });

    it("falls back to empty contract when the boot omits locale + dict", () => {
      const out = buildCustomViewSrcdoc("<head></head>", boot);
      // Empty `locale` + `{}` dict is the documented "no translations" contract;
      // the iframe-side `t()` then echoes the key.
      assert.match(out, /"locale":""/);
      assert.match(out, /"dict":\{\}/);
    });

    it("installs a vue-i18n-shaped t(key, named?) helper alongside the existing bridge", () => {
      const out = buildCustomViewSrcdoc("<head></head>", boot);
      assert.match(out, /v\.t=function/);
      // Named interpolation: {paramName} → named[paramName]
      assert.match(out, /\\\{\(\\w\+\)\\\}/);
    });

    it("escapes < in dict values so a hostile translation can't break out of the bootstrap <script>", () => {
      const out = buildCustomViewSrcdoc("<head></head>", { ...boot, dict: { evil: "</script><img onerror=alert(1)>" } });
      // The defence escapes ONLY `<` (to `<`); a leftover `>` from the
      // hostile string is fine because what closes a <script> tag is `</`
      // (an open angle + slash), which we've broken into `</`. Assert
      // both halves: no extra `</script>` parser would see, AND the literal
      // appears in its escaped form inside the JSON.
      const scripts = out.match(/<\/script>/gi);
      assert.equal(scripts?.length, 1, "only the bootstrap's own closing </script> may appear");
      assert.match(out, /\\u003c\/script>/);
    });
  });

  describe("field metadata injection (#2169)", () => {
    it("emits __MC_VIEW.fields with each enum's values when the boot carries them", () => {
      const out = buildCustomViewSrcdoc("<head></head>", { ...boot, fields: { status: { type: "enum", values: ["要レビュー", "確認済み"] } } });
      assert.match(out, /"fields":\{"status":\{"type":"enum","values":\["要レビュー","確認済み"\]\}\}/);
    });

    it("emits an empty fields object when the boot omits it", () => {
      const out = buildCustomViewSrcdoc("<head></head>", boot);
      assert.match(out, /"fields":\{\}/);
    });

    it("escapes < in enum values so a hostile value can't break out of the bootstrap <script>", () => {
      const out = buildCustomViewSrcdoc("<head></head>", { ...boot, fields: { status: { type: "enum", values: ["</script><b>"] } } });
      assert.equal(out.match(/<\/script>/gi)?.length, 1, "only the bootstrap's own closing </script> may appear");
    });
  });
});

// ── The bridge, actually running ──
// Everything above asserts the SHAPE of a hand-written one-line script string,
// which cannot tell a working listener from a typo in it. These evaluate the
// injected bootstrap for real, in a vm with a fake window, so the host→view
// channels are covered by behaviour.

/** The subset of `window.__MC_VIEW` the bootstrap installs at runtime. */
interface ViewBridge {
  slug: string;
  searchQuery: string;
  onChange: (callback: () => void) => () => void;
  onSearchQueryChange: (callback: (query: string) => void) => () => void;
}

interface FakeMessage {
  source: unknown;
  data: unknown;
}

/** Minimal MessagePort pair — delivery is synchronous so the fake clock stays
 *  the only source of ordering in these tests. */
interface FakePort {
  peer?: FakePort;
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (data: unknown) => void;
  close: () => void;
}

function makePort(): FakePort {
  const port: FakePort = {
    onmessage: null,
    postMessage: (data) => port.peer?.onmessage?.({ data }),
    close: () => {},
  };
  return port;
}

/** What the bootstrap handed up to the parent, port included. */
interface ReadyPing {
  data: { type?: unknown; slug?: unknown };
  origin: unknown;
  port: FakePort | undefined;
}

interface FakeClock {
  setTimeout: (task: () => void) => number;
  clearTimeout: (timerId: number) => void;
  /** Run every pending timer — the clock's only tick. */
  flush: () => void;
}

function makeFakeClock(): FakeClock {
  const pending = new Map<number, () => void>();
  let nextTimerId = 1;
  return {
    setTimeout: (task) => {
      const timerId = nextTimerId++;
      pending.set(timerId, task);
      return timerId;
    },
    clearTimeout: (timerId) => {
      pending.delete(timerId);
    },
    flush: () => {
      const due = [...pending.values()];
      pending.clear();
      due.forEach((task) => task());
    },
  };
}

interface Harness {
  view: ViewBridge;
  /** The `mc-view-ready` handshake, as the host would receive it. */
  ready: ReadyPing;
  /** Send a search query the way the host does — over the port it was given. */
  search: (query: unknown) => void;
  /** Deliver a window message. `fromParent: false` fakes a foreign sender. */
  send: (data: unknown, options?: { fromParent?: boolean }) => void;
  flush: () => void;
}

/** Pull the bootstrap out of the built srcdoc — it is the whole <script> body,
 *  `window.__MC_VIEW = {…}` assignment included. */
function extractBootstrap(srcdoc: string): string {
  return srcdoc.slice(srcdoc.indexOf("<script>") + "<script>".length, srcdoc.indexOf("</script>"));
}

/** Run the injected bootstrap against a fake window + clock. It reads only
 *  `window`, `document`, `setTimeout`, `clearTimeout` and `MessageChannel`, so
 *  passing those as parameters is enough to sandbox it. */
function runBootstrap(win: object, clock: FakeClock): void {
  const bootstrapSource = extractBootstrap(buildCustomViewSrcdoc("<head></head>", boot));
  const channel = function (this: { port1: FakePort; port2: FakePort }) {
    const [port1, port2] = [makePort(), makePort()];
    [port1.peer, port2.peer] = [port2, port1];
    [this.port1, this.port2] = [port1, port2];
  };
  // eslint-disable-next-line sonarjs/code-eval -- running the generated bridge IS the test: the bootstrap ships to the browser as a hand-written one-line string, and shape assertions can't tell a working listener from a typo (proved by mutation: every deliberate break goes red here, ~0 in the string checks). The source is this repo's own builder output, and the globals it touches are passed in as parameters.
  new Function("window", "document", "setTimeout", "clearTimeout", "MessageChannel", bootstrapSource)(
    win,
    { addEventListener: (): void => {} },
    clock.setTimeout,
    clock.clearTimeout,
    channel,
  );
}

function mountBridge(): Harness {
  const listeners: ((event: FakeMessage) => void)[] = [];
  const handshakes: ReadyPing[] = [];
  const clock = makeFakeClock();
  const parent = {
    postMessage: (data: { type?: unknown; slug?: unknown }, origin: unknown, transfer?: FakePort[]) => handshakes.push({ data, origin, port: transfer?.[0] }),
  };
  const win: { __MC_VIEW?: ViewBridge; parent: unknown; addEventListener: (type: string, callback: (event: FakeMessage) => void) => void } = {
    parent,
    addEventListener: (type, callback) => {
      if (type === "message") listeners.push(callback);
    },
  };
  runBootstrap(win, clock);
  const view = win.__MC_VIEW;
  assert.ok(view, "the bootstrap must install window.__MC_VIEW");
  const ready = handshakes.find((ping) => ping.data.type === "mc-view-ready");
  assert.ok(ready, "the bootstrap must hand a search port up to the host");
  return {
    view,
    ready,
    search: (query) => ready.port?.postMessage({ type: "mc-search-query", slug: boot.slug, query }),
    send: (data, options = {}) => {
      const source = options.fromParent === false ? {} : parent;
      listeners.forEach((callback) => callback({ source, data }));
    },
    flush: clock.flush,
  };
}

describe("the injected bridge at runtime — search query (#2959)", () => {
  it("hands its port up to the host's own origin, never to `*`", () => {
    const host = mountBridge();
    assert.equal(host.ready.origin, boot.origin);
    assert.notEqual(host.ready.origin, "*");
    assert.equal(host.ready.data.slug, boot.slug);
    assert.ok(host.ready.port, "the ready ping must transfer a port");
    // Deliberately carries no secret: anything injected into a view can be
    // forwarded by that view to the page it navigates to, so the host
    // authenticates nothing here — it reinstalls the view on a second claim.
    assert.deepEqual(Object.keys(host.ready.data).sort(), ["slug", "type"]);
  });

  it("updates searchQuery immediately and fires subscribers on the debounce", () => {
    const host = mountBridge();
    const seen: string[] = [];
    host.view.onSearchQueryChange((query) => seen.push(query));
    host.search("kafka");
    // Immediate, so a view re-reading it mid-render is never a keystroke behind…
    assert.equal(host.view.searchQuery, "kafka");
    // …while the callback waits for the burst to settle.
    assert.deepEqual(seen, []);
    host.flush();
    assert.deepEqual(seen, ["kafka"]);
  });

  it("collapses a typed word into one callback carrying the final query", () => {
    const host = mountBridge();
    const seen: string[] = [];
    host.view.onSearchQueryChange((query) => seen.push(query));
    ["k", "ka", "kaf", "kafk", "kafka"].forEach((query) => host.search(query));
    host.flush();
    assert.deepEqual(seen, ["kafka"], "one callback per settled burst, not one per keystroke");
  });

  it("relays a cleared box (empty query) rather than swallowing it", () => {
    const host = mountBridge();
    const seen: string[] = [];
    host.search("kafka");
    host.flush();
    host.view.onSearchQueryChange((query) => seen.push(query));
    host.search("");
    host.flush();
    assert.deepEqual(seen, [""]);
    assert.equal(host.view.searchQuery, "");
  });

  it("does NOT accept a search query over the window — only over the port", () => {
    // The regression guard for the leak: a window post has to name a target
    // origin, and an opaque origin can only be addressed as "*", which keeps
    // delivering after the view navigates itself elsewhere. Nothing but the
    // port may move the user's typed text.
    const host = mountBridge();
    const seen: string[] = [];
    host.view.onSearchQueryChange((query) => seen.push(query));
    host.send({ type: "mc-search-query", slug: boot.slug, query: "kafka" });
    host.flush();
    assert.equal(host.view.searchQuery, "");
    assert.deepEqual(seen, []);
  });

  it("coerces a non-string query to empty instead of leaking the raw value", () => {
    const host = mountBridge();
    host.search(42);
    assert.equal(host.view.searchQuery, "");
  });

  it("stops calling back after unsubscribe", () => {
    const host = mountBridge();
    const seen: string[] = [];
    const unsubscribe = host.view.onSearchQueryChange((query) => seen.push(query));
    unsubscribe();
    host.search("kafka");
    host.flush();
    assert.deepEqual(seen, []);
    assert.equal(host.view.searchQuery, "kafka", "the value still tracks — only the callback is gone");
  });

  it("keeps onChange and onSearchQueryChange on separate wires", () => {
    const host = mountBridge();
    const changes: string[] = [];
    const queries: string[] = [];
    host.view.onChange(() => changes.push("change"));
    host.view.onSearchQueryChange((query) => queries.push(query));

    host.send({ type: "mc-collection-changed", slug: boot.slug });
    host.flush();
    assert.deepEqual(changes, ["change"]);
    assert.deepEqual(queries, [], "a data change is not a search change");

    host.search("kafka");
    host.flush();
    assert.deepEqual(queries, ["kafka"]);
    assert.deepEqual(changes, ["change"], "a search change must not force a refetch");
  });

  it("still honours the sender + slug checks on the change wire", () => {
    const host = mountBridge();
    const changes: string[] = [];
    host.view.onChange(() => changes.push("change"));
    host.send({ type: "mc-collection-changed", slug: "other-collection" });
    host.send({ type: "mc-collection-changed", slug: boot.slug }, { fromParent: false });
    host.flush();
    assert.deepEqual(changes, []);
  });
});
